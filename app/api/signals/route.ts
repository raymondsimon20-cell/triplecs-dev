/**
 * /api/signals — Triple C's Signal Engine endpoint.
 *
 *   GET  → returns the most recent cached result (or `{ cached: false }` if
 *          none exists yet). Does NOT run the engine. Does NOT stage trades.
 *   POST → runs the engine fresh against live Schwab portfolio + Yahoo market
 *          data, saves the updated engine state, caches the result, and stages
 *          actionable BUY/SELL signals into the inbox with source 'signal-engine'.
 *
 * Engine logic lives in `lib/signals/engine.ts` (pure function, no I/O). Run
 * orchestration (fetch + run + persist + stage + cache) lives in
 * `lib/signals/run.ts` and is shared with the daily Netlify scheduled function.
 */

import { NextResponse } from 'next/server';
import { requireAuth }  from '@/lib/session';
import { runSignalsAndStage, loadCache } from '@/lib/signals/run';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// ─── GET — return cached result, read-only ───────────────────────────────────

export async function GET() {
  try { await requireAuth(); } catch { return unauthorized(); }

  const cached = await loadCache();
  if (!cached) {
    return NextResponse.json({ cached: false, message: 'No signal run yet — POST to run.' });
  }
  return NextResponse.json({
    cached:   true,
    cachedAt: cached.cachedAt,
    result:   cached.result,
  });
}

// ─── POST — run engine fresh, persist state, stage to inbox ──────────────────

export async function POST() {
  try { await requireAuth(); } catch { return unauthorized(); }

  try {
    const { result, proposed, staged } = await runSignalsAndStage();
    return NextResponse.json({ ok: true, staged, proposed, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/signals POST]', err);
    return NextResponse.json({ error: 'Signal engine failed', detail: msg }, { status: 500 });
  }
}
