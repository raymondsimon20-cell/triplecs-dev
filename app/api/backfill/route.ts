/**
 * POST /api/backfill
 *
 * Manually triggers historical reconstruction of daily snapshots. Idempotent:
 * synthetic snapshots are never written over real ones, and re-running the
 * same date range overwrites existing synthetic days with the latest pricing.
 *
 * Body:  { days?: number }   (default 90, max 90)
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { backfillSnapshots } from '@/lib/backfill';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { days?: number } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const days = Math.max(1, Math.min(90, Math.floor(Number(body.days) || 90)));

  try {
    const result = await backfillSnapshots(days);
    return NextResponse.json({
      ok: true,
      ...result,
      caveats: [
        'Cash balances are not reconstructed — synthetic days show equity = market value',
        'Margin balance is not reconstructed — utilization shows as 0%',
        'Option positions are excluded from backfill',
        'Trades older than Schwab\'s ~12-month window are not visible',
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[backfill] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
