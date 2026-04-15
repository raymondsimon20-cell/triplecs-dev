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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDividends(txns: any[]): { date: string; description: string; amount: number; symbol: string; rawType: string }[] {
  const results: { date: string; description: string; amount: number; symbol: string; rawType: string }[] = [];

  for (const t of txns) {
    // ── Determine transaction type from whichever field Schwab uses ──
    const txType: string = (
      t.type ?? t.activityType ?? t.transactionType ?? ''
    ).toUpperCase();

    const desc: string = t.description ?? t.transactionDescription ?? '';

    // ── Check if this looks like a dividend/interest transaction ──
    const isDividendType =
      txType.includes('DIVIDEND') ||
      txType.includes('INTEREST') ||
      txType === 'DIVIDEND_OR_INTEREST' ||
      txType === 'RECEIVE_AND_DELIVER';

    const isDividendDesc = /dividend|distribution|interest|reinvest|drip/i.test(desc);

    if (!isDividendType && !isDividendDesc) continue;

    // ── Extract amount ──
    const amount = t.netAmount ?? t.amount ?? t.totalAmount ?? 0;
    if (amount <= 0) continue; // skip debits/negative amounts

    // ── Extract date ──
    const dateStr: string = t.time ?? t.transactionDate ?? t.tradeDate ?? t.settlementDate ?? '';
    const date = dateStr ? dateStr.split('T')[0] : 'UNKNOWN';

    // ── Extract symbol from transferItems or transactionItems ──
    const items = t.transferItems ?? t.transactionItems ?? [];
    let symbol = 'UNKNOWN';

    if (Array.isArray(items) && items.length > 0) {
      const inst = items[0]?.instrument ?? items[0]?.asset ?? {};
      symbol = inst.symbol ?? inst.cusip ?? 'UNKNOWN';
    }

    // Fall back to a symbol field on the transaction itself
    if (symbol === 'UNKNOWN' && t.symbol) {
      symbol = t.symbol;
    }

    results.push({ date, description: desc, amount, symbol, rawType: txType });
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
    const allDividends = await Promise.all(
      accountNums.map(async ({ hashValue }) => {
        try {
          // Strategy: try DIVIDEND_OR_INTEREST type first, then fall back to
          // fetching ALL transaction types and filtering client-side.
          let txns = await client.getTransactions(hashValue, startDate, endDate, 'DIVIDEND_OR_INTEREST');
          console.log(`[Dividends] Account ${hashValue.slice(0, 6)}… DIVIDEND_OR_INTEREST returned ${txns.length} txns`);

          // If Schwab returned nothing with the specific type, try fetching ALL types
          if (txns.length === 0) {
            console.log(`[Dividends] No DIVIDEND_OR_INTEREST txns — trying ALL types for account ${hashValue.slice(0, 6)}…`);
            txns = await client.getTransactions(hashValue, startDate, endDate, 'TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER,JOURNAL,OTHER');

            console.log(`[Dividends] ALL types returned ${txns.length} txns`);
            if (txns.length > 0) {
              // Log all unique type values to help debug
              const uniqueTypes = [...new Set(txns.map((t: Record<string, unknown>) =>
                (t.type ?? t.activityType ?? t.transactionType ?? 'NO_TYPE') as string
              ))];
              console.log(`[Dividends] Unique transaction types found: ${uniqueTypes.join(', ')}`);
            }
          }

          const divs = extractDividends(txns);
          console.log(`[Dividends] → ${divs.length} dividend/interest transactions extracted`);
          if (divs.length > 0) {
            console.log(`[Dividends] First dividend: ${JSON.stringify(divs[0])}`);
          }

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
