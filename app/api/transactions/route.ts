import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import { createClient, getAccountNumbers, getTransactions } from '@/lib/schwab/client';
import { getTokens } from '@/lib/storage';
import { isKnownContributionSource } from '@/lib/data/contribution-sources';
import { classifyCashMovement, isMarginInterestDescription } from '@/lib/transactions/cash-category';
import { findExpenseTag, getExpenseTagState } from '@/lib/transactions/expense-tags';

export const dynamic = 'force-dynamic';

/**
 * GET /api/transactions — normalized multi-type transaction ledger.
 *
 * Powers the Transactions page (full ledger) and the Cash Flow page
 * (categorized 30-day aggregation). Fetches TRADE + DIVIDEND_OR_INTEREST +
 * cash-movement types from Schwab, normalizes the messy per-version field
 * names into one flat row shape, and assigns a display category.
 *
 * Query params:
 *   ?days=90            — trailing window (default 90, max 365)
 *   ?accountHash=…      — scope to one account ('all'/absent = every account)
 */

export interface NormalizedTransaction {
  id:          string;
  date:        string;   // YYYY-MM-DD
  category:    string;   // Dividend | Interest | Margin Interest | Stock Sale | Stock Purchase | Option Trade | Contribution | Withdrawal | Transfer | Other
  symbol:      string;   // '' when not security-linked
  description: string;
  amount:      number;   // signed net cash effect
  units:       number;   // share/contract quantity (signed; 0 for cash events)
  fee:         number;
  accountHash: string;
  /**
   * Realized P/L for sales, computed by matching the app's trade-history log
   * (which captures cost basis per share at sale time). Undefined when no
   * matching history entry exists — e.g. manual sales placed outside the app.
   */
  realizedPnl?: number;
  expenseTagged?: boolean;
  expenseCategory?: string;
}

// ─── Persistent ledger ────────────────────────────────────────────────────────
// Schwab's API only serves ~1 year of history, so every fetch is merged into a
// blob-store ledger keyed by transaction id. Over time the ledger accumulates
// true all-time history even after Schwab's window rolls past it.
const LEDGER_STORE = 'txn-ledger';
const LEDGER_KEY   = 'log';
const LEDGER_MAX   = 25_000;

// ─── Realized P/L from trade history ─────────────────────────────────────────
interface HistoryEntry {
  timestamp?: string; symbol?: string; instruction?: string; quantity?: number;
  status?: string; costBasisPerShare?: number; accountHash?: string;
}

/**
 * Attach realizedPnl to sale transactions by matching trade-history entries on
 * symbol + calendar date + share count. `amount` is net proceeds (fees already
 * deducted), so realized = proceeds − basis × shares.
 */
function attachRealizedPnl(txns: NormalizedTransaction[], history: HistoryEntry[]): void {
  const pool = history.filter((h) =>
    h.status === 'placed' &&
    (h.instruction === 'SELL' || h.instruction === 'SELL_TO_CLOSE') &&
    typeof h.costBasisPerShare === 'number' && h.costBasisPerShare > 0 &&
    h.timestamp && h.symbol,
  ).map((h) => ({ ...h, date: (h.timestamp as string).split('T')[0], used: false }));

  for (const t of txns) {
    if (t.category !== 'Stock Sale' && t.category !== 'Option Trade') continue;
    if (t.amount <= 0 || !t.symbol) continue;
    const shares = Math.abs(t.units);
    if (shares <= 0) continue;
    const match = pool.find((h) =>
      !h.used &&
      h.symbol === t.symbol &&
      h.date === t.date &&
      Math.abs((h.quantity ?? 0) - shares) < 0.01 &&
      (!h.accountHash || h.accountHash === t.accountHash),
    );
    if (!match) continue;
    match.used = true;
    // `amount` is broker dollars — for options the ×100 contract multiplier is
    // already applied. `costBasisPerShare` is per-SHARE (it comes from position
    // averages), and `units` for an option trade counts CONTRACTS, so the
    // basis leg needs the same ×100 or a losing option close books as a gain:
    // 1 contract opened at $6.00, closed for $425 → old math said +$419
    // (425 − 6×1); actual is −$175 (425 − 6×100).
    const multiplier = t.category === 'Option Trade' ? 100 : 1;
    t.realizedPnl = Math.round((t.amount - (match.costBasisPerShare as number) * shares * multiplier) * 100) / 100;
  }
}

const CASH_SYMBOLS     = new Set(['CURRENCY_USD', 'USD', 'CASH']);
const CASH_ASSET_TYPES = new Set(['CURRENCY', 'CASH_EQUIVALENT']);


// Fetch one type per request. Schwab inconsistently accepts comma-separated
// type lists: the batched cash request can return an error/empty result while
// TRADE still works, which made every expense card read $0. Individual calls
// also isolate failures so one unsupported type cannot erase the rest.
const TRANSACTION_TYPES = [
  'TRADE',
  'DIVIDEND_OR_INTEREST',
  'ACH_RECEIPT',
  'ACH_DISBURSEMENT',
  'CASH_RECEIPT',
  'CASH_DISBURSEMENT',
  'ELECTRONIC_FUND',
  'WIRE_IN',
  'WIRE_OUT',
  'JOURNAL',
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalize(t: any, accountHash: string, requestedType = ''): NormalizedTransaction | null {
  const txType: string = (t.type ?? t.activityType ?? t.transactionType ?? requestedType).toUpperCase();
  const desc:   string = t.description ?? t.transactionDescription ?? '';
  const dateStr: string = t.time ?? t.transactionDate ?? t.tradeDate ?? t.settlementDate ?? '';
  const date = dateStr ? dateStr.split('T')[0] : '';
  if (!date) return null;

  const amount: number = t.netAmount ?? t.amount ?? t.totalAmount ?? 0;
  const items: any[] = t.transferItems ?? t.transactionItems ?? [];

  // Security leg: the non-currency item. Fee legs carry a feeType.
  let symbol = '';
  let units  = 0;
  let fee    = 0;
  let isOption = false;
  for (const item of items) {
    const inst = item?.instrument ?? item?.asset ?? {};
    const sym: string = inst.symbol ?? '';
    const assetType: string = (inst.assetType ?? '').toUpperCase();
    const feeType: string = (item?.feeType ?? '').toUpperCase();
    if (feeType && feeType !== 'NONE') {
      fee += Math.abs(item?.cost ?? item?.amount ?? 0);
      continue;
    }
    if (CASH_SYMBOLS.has(sym.toUpperCase()) || CASH_ASSET_TYPES.has(assetType)) continue;
    if (sym && !symbol) {
      symbol = sym;
      units  = item?.amount ?? 0;
      if (assetType === 'OPTION' || sym.includes(' ')) isOption = true;
    }
  }
  if (!symbol && typeof t.symbol === 'string') symbol = t.symbol;

  let category: string;
  if (isKnownContributionSource(desc) && amount > 0) {
    // Payer-name override. Schwab files these under JOURNAL or a generic type,
    // so they were landing as "Transfer" or "Other" — which matters beyond the
    // label: an unrecognised deposit is excluded from Contributions in the
    // equity bridge and falls into the "Market & Other" residual instead,
    // reading as a gain the portfolio never made.
    //
    // Scoped to inbound amounts only, so a payment out to the same counterparty
    // is not mislabelled as money coming in.
    category = 'Contribution';
  } else if (txType === 'TRADE') {
    category = isOption ? 'Option Trade' : amount >= 0 ? 'Stock Sale' : 'Stock Purchase';
  } else if (isMarginInterestDescription(desc)) {
    category = 'Margin Interest';
  } else if (txType.includes('DIVIDEND') || txType === 'DIVIDEND_OR_INTEREST') {
    if (!symbol && /interest/i.test(desc)) category = 'Interest';
    else category = 'Dividend';
  } else {
    const cashMovement = classifyCashMovement({
      txType,
      description: desc,
      amount,
      hasSecurity: Boolean(symbol),
    });
    if (cashMovement) category = cashMovement;
    else category = 'Other';
  }

  return {
    id: String(t.activityId ?? `${date}-${symbol}-${amount}`),
    date,
    category,
    symbol,
    description: desc || symbol,
    amount,
    units,
    fee,
    accountHash,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const days = Math.min(Math.max(Number(searchParams.get('days') ?? 90), 1), 365);
  const now = new Date();
  const endDate   = now.toISOString();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const allAccountNums = await getAccountNumbers(tokens);
    if (!allAccountNums.length) return NextResponse.json({ transactions: [] });

    const accountHashParam = searchParams.get('accountHash');
    const scoped = accountHashParam && accountHashParam !== 'all'
      ? allAccountNums.filter((a) => a.hashValue === accountHashParam)
      : allAccountNums;

    // createClient() validates/refreshes tokens; getTransactions wants raw tokens.
    await createClient();
    const freshTokens = await getTokens();
    if (!freshTokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const failedSources: string[] = [];
    const perAccount = await Promise.all(
      scoped.map(async ({ hashValue }) => {
        const byType = await Promise.all(
          TRANSACTION_TYPES.map(async (requestedType) => {
            try {
              const rows = await getTransactions(
                freshTokens, hashValue, startDate, endDate, requestedType,
              );
              return rows.map((row) => ({ row, requestedType }));
            } catch (err) {
              failedSources.push(`${hashValue.slice(0, 6)}:${requestedType}`);
              console.warn(
                `[Transactions] ${requestedType} fetch failed for ${hashValue.slice(0, 6)}…:`,
                err,
              );
              return [];
            }
          }),
        );
        return byType.flat()
          .map(({ row, requestedType }) => normalize(row, hashValue, requestedType))
          .filter((t): t is NormalizedTransaction => t !== null);
      }),
    );

    const fetched = perAccount.flat();

    // Realized P/L from the app's trade-history log.
    try {
      const log = await getStore('trade-history').get('log', { type: 'json' }) as HistoryEntry[] | null;
      if (Array.isArray(log)) attachRealizedPnl(fetched, log);
    } catch (err) {
      console.warn('[Transactions] trade-history load failed (realized P/L skipped):', err);
    }

    // Merge into the persistent ledger; response = full merged history so the
    // Ledger page grows past Schwab's API window over time.
    let transactions = fetched;
    try {
      const store = getStore(LEDGER_STORE);
      const existing = (await store.get(LEDGER_KEY, { type: 'json' })) as NormalizedTransaction[] | null;
      const byId = new Map<string, NormalizedTransaction>();
      for (const t of existing ?? []) byId.set(t.id, t);
      let added = 0;
      for (const t of fetched) {
        const prev = byId.get(t.id);
        // Fresh fetch wins (it may newly carry realizedPnl), but never
        // downgrade an entry that already has realized data.
        if (!prev || t.realizedPnl !== undefined || prev.realizedPnl === undefined) {
          if (!prev) added += 1;
          byId.set(t.id, { ...prev, ...t });
        }
      }
      transactions = [...byId.values()];
      if (added > 0 || (existing?.length ?? 0) !== transactions.length) {
        const capped = transactions
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .slice(0, LEDGER_MAX);
        await store.setJSON(LEDGER_KEY, capped);
        transactions = capped;
      }
    } catch (err) {
      console.warn('[Transactions] ledger persistence failed (returning fetch only):', err);
    }

    // Optional account scoping of the response (persistence stays household-wide).
    const scopedOut = accountHashParam && accountHashParam !== 'all'
      ? transactions.filter((t) => t.accountHash === accountHashParam)
      : transactions;

    let taggedOut = scopedOut;
    try {
      const tagState = await getExpenseTagState();
      taggedOut = scopedOut.map((transaction) => {
        const tag = findExpenseTag(transaction.id, transaction.description, tagState);
        if (!tag || transaction.category !== 'Transfer') return transaction;
        return {
          ...transaction,
          category: 'Withdrawal',
          expenseTagged: true,
          expenseCategory: tag.expenseCategory,
        };
      });
    } catch (err) {
      console.warn('[Transactions] expense tags unavailable:', err);
    }

    const sorted = [...taggedOut].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return NextResponse.json({
      transactions: sorted,
      days,
      partial: failedSources.length > 0,
      failedSources,
    });
  } catch (err) {
    console.error('[Transactions API]', err);
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}
