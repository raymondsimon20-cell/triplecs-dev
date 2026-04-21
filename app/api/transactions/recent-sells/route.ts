/**
 * GET /api/transactions/recent-sells?hash=<accountHash>&days=30
 * Returns TRADE transactions where the user sold shares in the last N days.
 * Used by the wash-sale guard in AI analysis.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHash = searchParams.get('hash');
  const days = parseInt(searchParams.get('days') ?? '30', 10);

  if (!accountHash) {
    return NextResponse.json({ error: 'hash required' }, { status: 400 });
  }

  try {
    const client = await createClient();
    const endDate   = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    const txns = await client.getTransactions(
      accountHash,
      startDate.toISOString(),
      endDate.toISOString(),
      'TRADE',
    );

    // Filter for SELL transactions only (negative quantity = sold)
    const sells = txns
      .filter((t) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tAny = t as any;
        const activity = tAny?.transferItems?.[0] ?? tAny?.transactionItem;
        return activity?.amount < 0 || tAny?.netAmount < 0;
      })
      .map((t) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tAny = t as any;
        const item = tAny?.transferItems?.[0] ?? tAny?.transactionItem ?? {};
        return {
          symbol:    item?.instrument?.symbol ?? tAny?.description ?? 'UNKNOWN',
          soldDate:  tAny?.tradeDate ?? tAny?.transactionDate ?? '',
          amount:    Math.abs(item?.amount ?? tAny?.netAmount ?? 0),
          shares:    Math.abs(item?.amount ?? 0),
        };
      })
      .filter((s) => s.symbol !== 'UNKNOWN');

    return NextResponse.json({ sells });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
