/**
 * Netlify Scheduled Function — runs the Triple C's Signal Engine daily.
 *
 * Cron: `15 21 * * 1-5` (21:15 UTC, weekdays only).
 *   - During EDT (Mar-Nov): 5:15 PM ET — 75 min after market close
 *   - During EST (Nov-Mar): 4:15 PM ET — 15 min after market close
 * Both windows are safely AFTER 4:00 PM ET close, so end-of-day prices are
 * settled by the time the engine runs.
 *
 * The function invokes the same orchestration the HTTP route does
 * (`runSignalsAndStage`), so behavior is identical: pulls Schwab portfolio,
 * fetches SPY/VIX, runs rules, persists state, stages BUY/SELL signals into
 * the inbox with source 'signal-engine', caches the result.
 *
 * No auth check inside — the function runs in Netlify's privileged context.
 */

import type { Config } from '@netlify/functions';
import { runSignalsAndStage } from '../../lib/signals/run';
import { recordHeartbeat } from '../../lib/signals/cron-health';

/**
 * 2026-07 — MASTER SWITCH. Engine disabled at the user's request after its
 * trades underperformed: no signal staging, no auto-execution, no dip-ladder
 * buys, nothing. The weekly drift rebalance (daily-rebalance.mts) is now the
 * only automated trading path, and it stages for manual approval.
 *
 * Flip to true (and redeploy) to re-enable. Manual runs via /api/signals and
 * the shadow/backtest endpoints still work for evaluation — only this cron
 * is gated.
 */
const SIGNAL_ENGINE_ENABLED = false;

export default async (): Promise<Response> => {
  const startedAt = Date.now();

  if (!SIGNAL_ENGINE_ENABLED) {
    console.log('[daily-signal-engine] disabled by master switch — no signals run.');
    await recordHeartbeat({
      ranAt:       startedAt,
      durationMs:  0,
      status:      'success',
      signalCount: 0,
      actionable:  0,
    }).catch(() => undefined);
    return new Response(
      JSON.stringify({ ok: true, disabled: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Early "cron entered" heartbeat. runSignalsAndStage records its own
  // success/error beat inside its try/catch, but if an exception escapes
  // that wrapper (top-level import error after deploy, OOM, fatal type
  // error) the only proof that the cron even fired is this beat. Marked
  // status:'error' so the dashboard surfaces it loudly until the real
  // success beat overwrites it.
  await recordHeartbeat({
    ranAt:       startedAt,
    durationMs:  0,
    status:      'error',
    signalCount: 0,
    actionable:  0,
    error:       'cron entered but did not complete',
  }).catch(() => undefined);

  try {
    const { result, proposed, staged } = await runSignalsAndStage();
    const elapsedMs = Date.now() - startedAt;

    console.log(
      `[daily-signal-engine] ok — ${result.signals.length} signals ` +
      `(${result.actionableTrades.length} actionable, ${result.alerts.length} alerts, ` +
      `${result.info.length} info). Inbox: proposed=${proposed} staged=${staged}. ` +
      `Defense=${result.inDefenseMode} KillSwitch=${result.killSwitchActive}. ` +
      `Took ${elapsedMs}ms.`,
    );

    return new Response(
      JSON.stringify({ ok: true, proposed, staged, elapsedMs }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[daily-signal-engine] failed:', msg);
    // Return 200 so Netlify doesn't retry — a Schwab token failure is not the
    // kind of thing a retry fixes. We've logged it.
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

export const config: Config = {
  schedule: '15 21 * * 1-5',   // 21:15 UTC weekdays — see header comment for ET conversion
};
