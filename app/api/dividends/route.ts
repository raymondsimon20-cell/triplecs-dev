import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { getAccountNumbers } from '@/lib/schwab/client';
import { getTokens } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  // Schwab transactions API requires full ISO 8601 datetime strings
  // Ensure the date range is valid — Schwab rejects dates too far in the past
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

    // Fetch dividends for all accounts
    const client = await createClient();
    const allDividends = await Promise.all(
      accountNums.map(async ({ hashValue }) => {
        try {
          const txns = await client.getTransactions(hashValue, startDate, endDate);
          console.log(`[Dividends] Account ${hashValue.slice(0, 6)}… returned ${txns.length} transactions`);
          // Filter for dividend/interest transactions with positive amounts
          const divTxns = txns.filter((t) => {
            const isDividend = t.type === 'DIVIDEND_OR_INTEREST'
              || t.type === 'RECEIVE_AND_DELIVER'
              || (t.description && /dividend|distribution|interest/i.test(t.description));
            return isDividend && t.netAmount > 0;
          });
          console.log(`[Dividends] → ${divTxns.length} dividend/interest transactions found`);
          return divTxns.map((t) => ({
            date: t.time.split('T')[0],
            description: t.description,
            amount: t.netAmount,
            symbol: t.transferItems?.[0]?.instrument?.symbol ?? 'UNKNOWN',
          }));
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
