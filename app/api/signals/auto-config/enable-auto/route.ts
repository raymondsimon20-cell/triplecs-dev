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

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require an explicit `?confirm=1` (or {"confirm":true} body) before
  // flipping a manual-mode user into live auto-execute. Previously this
  // endpoint moved straight from manual → auto on a single click and a
  // first-time enable ran at defaults (-2% daily loss breaker, $1k per
  // trade) without surfacing what was about to start happening. The
  // confirmation gate forces the caller to acknowledge the caps.
  const url = new URL(req.url);
  const confirmFromQuery = url.searchParams.get('confirm') === '1';
  let confirmFromBody = false;
  try {
    const body = await req.clone().json();
    confirmFromBody = body?.confirm === true;
  } catch { /* empty body is fine */ }
  const confirmed = confirmFromQuery || confirmFromBody;

  const current = await loadAutoConfig();

  if (!confirmed && current.mode !== 'auto') {
    return NextResponse.json({
      ok:         false,
      requiresConfirmation: true,
      previewConfig: {
        ...current,
        ...CONSERVATIVE_AUTO,
        dailyCaps:      { ...current.dailyCaps,      ...(CONSERVATIVE_AUTO.dailyCaps ?? {}) },
        circuitBreaker: { ...current.circuitBreaker, ...(CONSERVATIVE_AUTO.circuitBreaker ?? {}) },
      },
      message: 'This will enable LIVE auto-execute against your Schwab account. Real orders will fire on the next cron pass for any tier-1 item that clears the caps below. Re-send with ?confirm=1 (or body {"confirm":true}) to proceed.',
      caps: {
        maxTradesPerDay:        CONSERVATIVE_AUTO.dailyCaps!.maxTrades,
        maxDollarsPerTrade:     `$${CONSERVATIVE_AUTO.dailyCaps!.maxDollarsPerTrade}`,
        maxNetExposureShiftPct: `${CONSERVATIVE_AUTO.dailyCaps!.maxNetExposureShiftPct}%`,
        intradayLossBreakerPct: `${CONSERVATIVE_AUTO.circuitBreaker!.dailyLossPct}%`,
      },
      revert: 'PATCH /api/signals/auto-config with {"mode":"manual"} to undo.',
    }, { status: 409 });   // 409 Conflict — caller must re-submit with confirmation
  }

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

// Browser-friendly: GET works too. Same confirm semantics — explicit
// `?confirm=1` query param required for the first transition.
export async function GET(req: Request) {
  return POST(req);
}
