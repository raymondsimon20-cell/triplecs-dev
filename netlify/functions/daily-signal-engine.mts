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

export default async (): Promise<Response> => {
  const startedAt = Date.now();

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
