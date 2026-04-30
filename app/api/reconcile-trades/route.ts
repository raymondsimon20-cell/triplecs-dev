/**
 * POST /api/reconcile-trades
 *
 * Triggers reconcileSchwabTrades() on demand — same logic the daily-alert
 * scheduled function runs, but callable from the dashboard so the user
 * doesn't have to wait until 12:00 UTC. Pulls recent Schwab TRADE
 * transactions, backfills missing prices on /api/orders entries, and
 * dedupes any pre-existing /api/orders ↔ schwab-prefixed pairs that an
 * earlier version of the reconciler created.
 *
 * Body (optional): { lookbackDays?: number }  // defaults to 14
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { reconcileSchwabTrades } from '@/lib/reconcile-trades';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let lookbackDays: number | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.lookbackDays === 'number' && body.lookbackDays > 0 && body.lookbackDays <= 365) {
      lookbackDays = body.lookbackDays;
    }
  } catch {
    // ignore — body is optional
  }

  try {
    const result = await reconcileSchwabTrades(lookbackDays ? { lookbackDays } : undefined);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reconcile-trades] manual trigger failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
