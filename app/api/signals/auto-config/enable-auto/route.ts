/**
 * POST /api/signals/auto-config/enable-auto
 *
 * One-shot helper that flips auto-execute to 'auto' mode with conservative
 * caps designed for first-time graduation from dry-run:
 *
 *   mode:                'auto'
 *   maxTrades/day:       2
 *   maxDollarsPerTrade:  $1000
 *   maxNetExposureShift: 5% of portfolio per day
 *   dailyLossPct:        -2%   (intraday breaker)
 *
 * Only tier-1 items in the inbox will actually fire — that's enforced in
 * lib/signals/auto-execute.ts. The intended graduation path:
 *
 *   1. Hit this endpoint once after a couple weeks of clean dry-run logs.
 *   2. Watch the daily digest for two more weeks in actual auto mode.
 *   3. Tighten or loosen the caps via PATCH /api/signals/auto-config.
 *
 * Idempotent — safe to call multiple times. Always replays the same target
 * caps, so re-hitting it resets back to the conservative defaults.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { loadAutoConfig, saveAutoConfig, type AutoConfig } from '@/lib/signals/auto-config';

export const dynamic = 'force-dynamic';

const CONSERVATIVE_AUTO: Partial<AutoConfig> = {
  mode: 'auto',
  dailyCaps: {
    maxTrades:              2,
    maxDollarsPerTrade:     1000,
    maxNetExposureShiftPct: 5,
  },
  circuitBreaker: {
    dailyLossPct:    -2,
    pausedUntilDate: null,
    pausedReason:    '',
  },
};

export async function POST() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const current = await loadAutoConfig();
  const next: AutoConfig = {
    ...current,
    ...CONSERVATIVE_AUTO,
    dailyCaps:      { ...current.dailyCaps,      ...(CONSERVATIVE_AUTO.dailyCaps ?? {}) },
    circuitBreaker: { ...current.circuitBreaker, ...(CONSERVATIVE_AUTO.circuitBreaker ?? {}) },
    updatedAt:      Date.now(),
  };
  await saveAutoConfig(next);

  return NextResponse.json({
    ok:           true,
    previousMode: current.mode,
    newConfig:    next,
    notes: [
      'Only tier-1 inbox items will be auto-executed (CLM_CRF_TRIM, AIRBAG_SCALE, AFW_TRIGGER, small rebalance trims).',
      'Tier 2 (PILLAR_FILL, MAINTENANCE_RANKED_TRIM, large rebalance trades) still requires manual approval.',
      'Daily-loss circuit breaker is armed at -2%. If the portfolio drops more than 2% intraday, auto-execute pauses until tomorrow.',
      'To revert to manual: PATCH /api/signals/auto-config with {"mode":"manual"}.',
    ],
  });
}

// Browser-friendly: GET works too.
export async function GET() {
  return POST();
}
