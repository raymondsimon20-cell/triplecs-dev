/**
 * GET /api/expenses
 *
 * Fetches debit (expense) transactions from Schwab for the last 90 days.
 * Looks at JOURNAL and OTHER transaction types for negative netAmount entries.
 * Groups repeated descriptions to detect recurring charges.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient, getAccountNumbers } from '@/lib/schwab/client';
import { getTokens } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export interface ExpenseTransaction {
  date: string;
  description: string;
  amount: number;         // positive dollar amount (absolute value of debit)
  category: string;
  rawType: string;
}

export interface DetectedExpense {
  description: string;
  category: string;
  totalPaid: number;      // sum over the period
  avgMonthly: number;     // totalPaid / months in range
  occurrences: number;
  lastDate: string;
  isRecurring: boolean;   // appeared in 2+ distinct months
}

// ─── Keyword → category mapping ──────────────────────────────────────────────

const TRANSFER_TYPES = new Set([
  'WIRE_OUT', 'ACH_DISBURSEMENT', 'ELECTRONIC_FUND', 'DISBURSEMENT',
  'INTERNAL_TRANSFER', 'TRANSFER', 'MONEYLINK_TRANSFER',
  'DEBIT', 'ACH_DEBIT', 'CHECK', 'AUTO_S1_DEBIT', 'DIRECT_DEBIT',
]);

function isTransferOut(type: string): boolean {
  return TRANSFER_TYPES.has(type.toUpperCase());
}

function categorise(description: string, type: string): string {
  const d = description.toUpperCase();
  const t = type.toUpperCase();
  if (isTransferOut(t))                                                        return 'Transfer Out';
  if (/WIRE OUT|ACH OUT|TRANSFER OUT|FUNDS TRANSFERRED|TRANSFER FUNDS/.test(d)) return 'Transfer Out';
  if (/DEPT EDUCATION|STUDENT LOAN|STUDENT L /.test(d))                        return 'Transfer Out';
  if (/MORTGAGE|RENT PAYMENT|LEASE PAYMENT/.test(d))                           return 'Transfer Out';
  if (/MARGIN INTEREST|INTEREST CHARGE|MARGIN FEE/.test(d))                    return 'Margin Interest';
  if (/ADVISORY FEE|MANAGEMENT FEE|ADVISORY CHARGE/.test(d))                   return 'Advisory Fee';
  if (/SERVICE CHARGE|ACCOUNT FEE|MAINTENANCE FEE/.test(d))                    return 'Account Fee';
  if (/WIRE FEE|TRANSFER FEE|ACH FEE/.test(d))                                 return 'Transfer Fee';
  if (/OPTION|CONTRACT FEE|EXERCISE FEE/.test(d))                              return 'Options Fee';
  if (/TAX WITHHOLDING|BACKUP WITHHOLDING/.test(d))                             return 'Tax Withholding';
  return 'Other Charge';
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const days  = parseInt(searchParams.get('days') ?? '90');
  const now   = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const months = days / 30;

  try {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const accountNums = await getAccountNumbers(tokens);
    if (!accountNums.length) return NextResponse.json({ transactions: [], detected: [] });

    const client = await createClient();

    const allTxns: ExpenseTransaction[] = [];

    // Schwab only accepts one type per request — fetch each separately and merge
    const EXPENSE_TYPES = [
      'JOURNAL',
      'ELECTRONIC_FUND',
      'ACH_DISBURSEMENT',
      'CASH_DISBURSEMENT',
      'WIRE_OUT',
      'RECEIVE_AND_DELIVER',
    ];

    const seen = new Set<string>(); // dedupe by transactionId

    await Promise.all(accountNums.flatMap(({ hashValue }) =>
      EXPENSE_TYPES.map(async (txType) => {
        try {
          const txns = await client.getTransactions(
            hashValue,
            start.toISOString(),
            now.toISOString(),
            txType,
          );

          for (const t of txns) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const raw = t as any;
            const txId: string = raw.transactionId ?? raw.id ?? '';
            if (txId && seen.has(txId)) continue;
            if (txId) seen.add(txId);

            const amount: number = raw.netAmount ?? raw.amount ?? raw.totalAmount ?? 0;
            if (amount >= 0) continue;   // only debits (negative = money leaving account)

            const desc: string    = raw.description ?? raw.transactionDescription ?? '';
            const type: string    = raw.type ?? raw.activityType ?? txType;
            const dateStr: string = raw.time ?? raw.transactionDate ?? raw.tradeDate ?? '';
            const date = dateStr ? dateStr.split('T')[0] : 'UNKNOWN';

            // Skip trade settlements
            if (/BUY|SELL|PURCHASE|REINVEST/.test(desc.toUpperCase())) continue;
            if (type.toUpperCase() === 'TRADE') continue;

            allTxns.push({
              date,
              description: desc || type || 'Unknown charge',
              amount: Math.abs(amount),
              category: categorise(desc, type),
              rawType: type,
            });
          }
        } catch (err) {
          console.warn(`[Expenses] ${txType} fetch error for ${hashValue.slice(0, 6)}:`, err);
        }
      })
    ));

    // Sort newest first
    allTxns.sort((a, b) => b.date.localeCompare(a.date));

    // Group by normalised description to detect recurring charges
    const grouped = new Map<string, { items: ExpenseTransaction[]; months: Set<string> }>();
    for (const t of allTxns) {
      const key = t.description.trim().toLowerCase();
      if (!grouped.has(key)) grouped.set(key, { items: [], months: new Set() });
      grouped.get(key)!.items.push(t);
      grouped.get(key)!.months.add(t.date.slice(0, 7));
    }

    const detected: DetectedExpense[] = [...grouped.values()].map(({ items, months: monthSet }) => {
      const total = items.reduce((s, i) => s + i.amount, 0);
      return {
        description: items[0].description,
        category:    items[0].category,
        totalPaid:   total,
        avgMonthly:  total / months,
        occurrences: items.length,
        lastDate:    items[0].date,
        isRecurring: monthSet.size >= 2,
      };
    }).sort((a, b) => b.totalPaid - a.totalPaid);

    return NextResponse.json({
      transactions: allTxns,
      detected,
      periodDays:  days,
      periodMonths: months,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
