import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { getAccountNumbers } from '@/lib/schwab/client';
import { getTokens } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Robustly extract dividend/interest transactions from Schwab response.
 *
 * Schwab's API can return transactions with varying field names depending
 * on the API version. We check multiple possible fields:
 *   - `type` or `activityType` for the transaction category
 *   - `netAmount` or `amount` for the dollar value
 *   - `time` or `transactionDate` or `settlementDate` for the date
 *   - `transferItems` or `transactionItems` for instrument details
 */
// Symbols / asset types that are the cash leg of a transaction, not the
// security that paid the dividend. Never use these as the contributor id.
const CASH_SYMBOLS = new Set(['CURRENCY_USD', 'USD', 'CASH']);
const CASH_ASSET_TYPES = new Set(['CURRENCY', 'CASH_EQUIVALENT']);

function isUsableSymbol(s: string | undefined | null): boolean {
  if (!s) return false;
  const upper = s.toUpperCase();
  return upper !== 'UNKNOWN' && !CASH_SYMBOLS.has(upper);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDividends(txns: any[], descriptionToSymbol?: Map<string, string>): { activityId: string; date: string; description: string; amount: number; symbol: string; rawType: string }[] {
  const results: { activityId: string; date: string; description: string; amount: number; symbol: string; rawType: string }[] = [];

  for (const t of txns) {
    const txType: string = (
      t.type ?? t.activityType ?? t.transactionType ?? ''
    ).toUpperCase();

    const desc: string = t.description ?? t.transactionDescription ?? '';

    const isDividendType =
      txType.includes('DIVIDEND') ||
      txType.includes('INTEREST') ||
      txType === 'DIVIDEND_OR_INTEREST';

    const isDripDelivery =
      txType === 'RECEIVE_AND_DELIVER' &&
      /dividend|distribution|interest|reinvest|drip/i.test(desc);

    if (!isDividendType && !isDripDelivery) continue;

    // For DRIP reinvestment, netAmount is 0 (cash → shares immediately).
    // Extract the dollar value from transferItems cost instead.
    let amount = t.netAmount ?? t.amount ?? t.totalAmount ?? 0;
    if (amount === 0 && isDripDelivery) {
      const items = t.transferItems ?? t.transactionItems ?? [];
      for (const item of items) {
        const cost = Math.abs(item?.cost ?? 0);
        if (cost > 0) { amount = cost; break; }
      }
    }

    if (amount <= 0) continue;

    const dateStr: string = t.time ?? t.transactionDate ?? t.tradeDate ?? t.settlementDate ?? '';
    const date = dateStr ? dateStr.split('T')[0] : 'UNKNOWN';

    // Symbol resolution priority (the previous code grabbed items[0], which
    // was always the CURRENCY_USD cash leg → "Top contributors" was 100% USD).
    //   1. A non-currency transferItem (DRIP shares-out leg, occasionally cash divs)
    //   2. Transaction-level `t.symbol` if set
    //   3. Description-to-symbol lookup against current holdings
    //   4. First few words of the description as a human-readable fallback
    const items = t.transferItems ?? t.transactionItems ?? [];
    let symbol = 'UNKNOWN';

    if (Array.isArray(items) && items.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const securityItem = items.find((it: any) => {
        const inst = it?.instrument ?? it?.asset ?? {};
        const at   = (inst.assetType ?? '').toUpperCase();
        return inst.symbol && !CASH_ASSET_TYPES.has(at) && !CASH_SYMBOLS.has(String(inst.symbol).toUpperCase());
      });
      if (securityItem) {
        const inst = securityItem.instrument ?? securityItem.asset ?? {};
        symbol = inst.symbol ?? inst.cusip ?? 'UNKNOWN';
      }
    }

    if (!isUsableSymbol(symbol) && t.symbol) symbol = t.symbol;

    if (!isUsableSymbol(symbol) && descriptionToSymbol && desc) {
      const matched = descriptionToSymbol.get(desc.trim().toUpperCase());
      if (matched) symbol = matched;
    }

    if (!isUsableSymbol(symbol) && desc) {
      symbol = desc.trim().split(/\s+/).slice(0, 3).join(' ');
    }

    const activityId: string = t.activityId ?? t.transactionId ?? `${date}-${symbol}-${amount}`;
    results.push({ activityId, date, description: desc, amount, symbol, rawType: txType });
  }

  return results;
}

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const now = new Date();
  const endDate = now.toISOString();
  const defaultStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const startDate = searchParams.get('start') ?? defaultStart.toISOString();

  console.log(`[Dividends API] Fetching from ${startDate} to ${endDate}`);

  try {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const accountNums = await getAccountNumbers(tokens);
    if (!accountNums.length) return NextResponse.json({ dividends: [], total: 0 });

    const client = await createClient();

    // Build a description → symbol map from current holdings so we can attribute
    // cash dividends (whose only transferItem is CURRENCY_USD) to the actual
    // security that paid them. Failure to fetch is non-fatal — we just lose
    // that fallback for matching.
    const descToSym = new Map<string, string>();
    await Promise.all(accountNums.map(async ({ hashValue }) => {
      try {
        const wrapper  = await client.getAccount(hashValue);
        const positions = wrapper?.securitiesAccount?.positions ?? [];
        for (const p of positions) {
          const desc = p.instrument?.description?.trim().toUpperCase();
          const sym  = p.instrument?.symbol;
          if (desc && sym) descToSym.set(desc, sym);
        }
      } catch (err) {
        console.warn(`[Dividends] positions fetch failed for ${hashValue.slice(0, 6)}…:`, err);
      }
    }));
    console.log(`[Dividends] description→symbol map: ${descToSym.size} entries`);

    const allDividends = await Promise.all(
      accountNums.map(async ({ hashValue }) => {
        try {
          // Always fetch both types in parallel: DIVIDEND_OR_INTEREST covers
          // cash dividends; RECEIVE_AND_DELIVER covers DRIP reinvestments where
          // netAmount === 0 (cash immediately converted to shares).
          const [divTxns, dripTxns] = await Promise.all([
            client.getTransactions(hashValue, startDate, endDate, 'DIVIDEND_OR_INTEREST'),
            client.getTransactions(hashValue, startDate, endDate, 'RECEIVE_AND_DELIVER'),
          ]);
          console.log(`[Dividends] Account ${hashValue.slice(0, 6)}… DIV=${divTxns.length} DRIP=${dripTxns.length}`);

          const combined = extractDividends([...divTxns, ...dripTxns], descToSym);

          // Deduplicate by activityId in case the same txn appears in both fetches
          const seen = new Set<string>();
          const divs = combined.filter(d => {
            if (seen.has(d.activityId)) return false;
            seen.add(d.activityId);
            return true;
          });

          console.log(`[Dividends] → ${divs.length} dividend/distribution transactions`);
          return divs;
        } catch (err) {
          console.error(`[Dividends] Error fetching account ${hashValue.slice(0, 6)}…:`, err);
          return [];
        }
      })
    );

    const dividends = allDividends.flat().sort((a, b) => b.date.localeCompare(a.date));
    const total = dividends.reduce((sum, d) => sum + d.amount, 0);

    return NextResponse.json({ dividends, total, startDate, endDate });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Dividends API error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
