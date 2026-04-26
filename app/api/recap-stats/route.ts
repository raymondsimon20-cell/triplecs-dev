/**
 * GET /api/recap-stats
 *
 * Lightweight readiness probe. Returns just the counts that gate Phase 4
 * (decided recs, total outcomes, executed/dismissed split) for 30d/90d
 * windows — no Claude call, no full recap payload.
 *
 * Use this to check whether enough signal has accumulated to act on the
 * AI feedback loop without paying for a performance-review run.
 *
 * Decided = outcome with win !== null (|pnlPct| ≥ 1%). Flat outcomes
 * carry no signal, so they're tracked separately.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { loadRecap } from '@/lib/ai/recap-loader';

export const dynamic = 'force-dynamic';

interface WindowStats {
  windowDays:     number;
  outcomes:       number;
  decided:        number;
  flat:           number;
  wins:           number;
  losses:         number;
  executedCount:  number;
  dismissedCount: number;
}

function summarize(recap: Awaited<ReturnType<typeof loadRecap>>, windowDays: number): WindowStats {
  if (!recap) {
    return {
      windowDays,
      outcomes: 0, decided: 0, flat: 0, wins: 0, losses: 0,
      executedCount: 0, dismissedCount: 0,
    };
  }
  const wins   = recap.outcomes.filter((o) => o.win === true).length;
  const losses = recap.outcomes.filter((o) => o.win === false).length;
  const flat   = recap.outcomes.filter((o) => o.win === null).length;
  return {
    windowDays,
    outcomes:       recap.outcomes.length,
    decided:        wins + losses,
    flat,
    wins,
    losses,
    executedCount:  recap.totals.executedCount,
    dismissedCount: recap.totals.dismissedCount,
  };
}

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [recap30, recap90] = await Promise.all([loadRecap(30), loadRecap(90)]);

  const window30 = summarize(recap30, 30);
  const window90 = summarize(recap90, 90);

  // Gates per the Phase 4 readiness check
  const gates = {
    feedbackBlock:    { needed: 3,  have: window30.decided, met: window30.decided >= 3 },
    performanceReview:{ needed: 30, have: window90.decided, met: window90.decided >= 30 },
  };

  return NextResponse.json({ window30, window90, gates });
}
