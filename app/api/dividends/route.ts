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
  // Default: last 12 months of dividends
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = searchParams.get('start') ??
    new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const accountNums = await getAccountNumbers(tokens);
    if (!accountNums.length) return NextResponse.json({ dividends: [], total: 0 });

    // Fetch dividends for all accounts
    const client = await createClient();
    const allDividends = await Promise.all(
      accountNums.map(async ({ hashValue }) => {
        const txns = await client.getTransactions(hashValue, startDate, endDate);
        return txns
          .filter((t) => t.type === 'DIVIDEND_OR_INTEREST' && t.netAmount > 0)
          .map((t) => ({
            date: t.time.split('T')[0],
            description: t.description,
            amount: t.netAmount,
            symbol: t.transferItems?.[0]?.instrument?.symbol ?? 'UNKNOWN',
          }));
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
