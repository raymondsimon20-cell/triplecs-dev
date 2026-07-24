import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient, getAccountNumbers, getTransactions } from '@/lib/schwab/client';
import { getTokens } from '@/lib/storage';

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
}

const CASH_SYMBOLS     = new Set(['CURRENCY_USD', 'USD', 'CASH']);
const CASH_ASSET_TYPES = new Set(['CURRENCY', 'CASH_EQUIVALENT']);

// Schwab transaction types worth showing in a ledger, split into two calls so
// a rejected cash-movement type can't take the core TRADE/DIVIDEND data down
// with it. MEMORANDUM and SMA_ADJUSTMENT are bookkeeping noise — skipped.
const CORE_TYPES = 'TRADE,DIVIDEND_OR_INTEREST';
const CASH_TYPES = 'ACH_RECEIPT,ACH_DISBURSEMENT,CASH_RECEIPT,CASH_DISBURSEMENT,ELECTRONIC_FUND,WIRE_IN,WIRE_OUT,JOURNAL';

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalize(t: any, accountHash: string): NormalizedTransaction | null {
  const txType: string = (t.type ?? t.activityType ?? t.transactionType ?? '').toUpperCase();
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
  if (txType === 'TRADE') {
    category = isOption ? 'Option Trade' : amount >= 0 ? 'Stock Sale' : 'Stock Purchase';
  } else if (txType.includes('DIVIDEND') || txType === 'DIVIDEND_OR_INTEREST') {
    if (/margin interest/i.test(desc)) category = 'Margin Interest';
    else if (!symbol && /interest/i.test(desc)) category = 'Interest';
    else category = 'Dividend';
  } else if (
    txType === 'ACH_RECEIPT' || txType === 'WIRE_IN' || txType === 'CASH_RECEIPT' ||
    (txType === 'ELECTRONIC_FUND' && amount > 0)
  ) {
    category = 'Contribution';
  } else if (
    txType === 'ACH_DISBURSEMENT' || txType === 'WIRE_OUT' || txType === 'CASH_DISBURSEMENT' ||
    (txType === 'ELECTRONIC_FUND' && amount < 0)
  ) {
    category = 'Withdrawal';
  } else if (txType === 'JOURNAL') {
    category = amount < 0 ? 'Withdrawal' : 'Transfer';
  } else {
    category = 'Other';
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

    const perAccount = await Promise.all(
      scoped.map(async ({ hashValue }) => {
        const [core, cash] = await Promise.all([
          getTransactions(freshTokens, hashValue, startDate, endDate, CORE_TYPES).catch((err) => {
            console.warn(`[Transactions] core fetch failed for ${hashValue.slice(0, 6)}…:`, err);
            return [];
          }),
          getTransactions(freshTokens, hashValue, startDate, endDate, CASH_TYPES).catch((err) => {
            console.warn(`[Transactions] cash fetch failed for ${hashValue.slice(0, 6)}…:`, err);
            return [];
          }),
        ]);
        return [...core, ...cash]
          .map((t) => normalize(t, hashValue))
          .filter((t): t is NormalizedTransaction => t !== null);
      }),
    );

    const transactions = perAccount
      .flat()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    return NextResponse.json({ transactions, days });
  } catch (err) {
    console.error('[Transactions API]', err);
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}
