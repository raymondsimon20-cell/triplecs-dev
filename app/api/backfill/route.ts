/**
 * POST   /api/backfill   Manually trigger historical reconstruction.
 * DELETE /api/backfill   Purge all synthetic day-keyed snapshots (real ones untouched).
 *
 * POST is idempotent: synthetic snapshots are never written over real ones, and
 * re-running the same date range overwrites existing synthetic days with the
 * latest pricing.
 *
 * DELETE walks the portfolio-snapshots store, inspects each day-* entry, and
 * removes only those flagged `synthetic: true`. Use this to clear the backfilled
 * series once you have enough real captures.
 *
 * POST body:  { days?: number }   (default 90, max 90)
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import { backfillSnapshots } from '@/lib/backfill';
import type { PortfolioSnapshot } from '@/lib/storage';

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

export async function DELETE() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const store = getStore('portfolio-snapshots');
    const { blobs } = await store.list({ prefix: 'day-' });

    // Inspect each day-* entry; delete only ones flagged synthetic.
    // Real captures and the 'latest' key are untouched.
    let deleted = 0;
    let kept = 0;
    await Promise.all(
      blobs.map(async (b) => {
        const snap = (await store.get(b.key, { type: 'json' })) as PortfolioSnapshot | null;
        if (snap?.synthetic) {
          await store.delete(b.key);
          deleted++;
        } else {
          kept++;
        }
      }),
    );

    return NextResponse.json({ ok: true, deleted, kept });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[backfill DELETE] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
