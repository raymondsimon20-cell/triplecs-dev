/**
 * GET  /api/strategy   Returns the server-side strategy targets (DEFAULT_TARGETS
 *                      if no override has been saved).
 * POST /api/strategy   Persists a new set of strategy targets. SettingsPanel
 *                      calls this after writing to localStorage so the daily
 *                      cron and signal engine can read what the user wants.
 *
 * Body shape (POST): the full StrategyTargets object — see lib/utils.ts.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  getServerStrategyTargets,
  saveServerStrategyTargets,
} from '@/lib/strategy-store';
import { DEFAULT_TARGETS, type StrategyTargets } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const targets = await getServerStrategyTargets();
  return NextResponse.json({ targets });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Partial<StrategyTargets> = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Coerce + clamp. Anything missing falls through to the existing value.
  const current = await getServerStrategyTargets();
  const merged: StrategyTargets = {
    ...current,
    ...Object.fromEntries(
      Object.entries(body).filter(
        ([k, v]) => k in DEFAULT_TARGETS && typeof v === 'number' && Number.isFinite(v),
      ),
    ),
  };

  // Schwab caps margin utilization at 50% (Reg T initial margin requirement).
  // Configuring margin thresholds above 50% is meaningless — orders fail at
  // the broker regardless. Clamp to keep the user's settings honest.
  const SCHWAB_MARGIN_HARD_CAP = 50;
  const clampPct = (v: number) => Math.max(0, Math.min(v, SCHWAB_MARGIN_HARD_CAP));
  const next: StrategyTargets = {
    ...merged,
    marginLimitPct:         clampPct(merged.marginLimitPct),
    marginWarnPct:          clampPct(merged.marginWarnPct),
    marginTrimTargetPct:    clampPct(merged.marginTrimTargetPct),
    marginNewBuyCeilingPct: clampPct(merged.marginNewBuyCeilingPct),
  };

  await saveServerStrategyTargets(next);
  return NextResponse.json({
    ok:      true,
    targets: next,
    notes: next.marginLimitPct !== merged.marginLimitPct ||
           next.marginNewBuyCeilingPct !== merged.marginNewBuyCeilingPct
      ? [`Margin thresholds clamped to Schwab's 50% hard cap.`]
      : undefined,
  });
}
