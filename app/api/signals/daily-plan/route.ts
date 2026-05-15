/**
 * GET /api/signals/daily-plan
 *
 * Returns a structured DailyPlan from the most recent cached engine result.
 * Groups actions into auto / approval / alert tiers and links each to its
 * inbox item where one exists. Consumed by the dashboard DailyPlanPanel.
 *
 * If there's no cached run yet (engine never ran), returns 404 — the user
 * should kick off `/api/signals` first.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { loadCache } from '@/lib/signals/run';
import { listInbox } from '@/lib/inbox';
import { loadAutoConfig } from '@/lib/signals/auto-config';
import { buildDailyPlan } from '@/lib/signals/daily-plan';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [cache, inbox, autoConfig] = await Promise.all([
      loadCache(),
      listInbox({ status: 'pending' }),
      loadAutoConfig(),
    ]);

    if (!cache) {
      return NextResponse.json(
        { error: 'No engine result cached yet. Run /api/signals first.' },
        { status: 404 },
      );
    }

    const plan = buildDailyPlan(cache.result, inbox, autoConfig);
    return NextResponse.json({ plan, cachedAt: cache.cachedAt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[signals/daily-plan] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
