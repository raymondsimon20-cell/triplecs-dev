/**
 * Netlify Scheduled Function — daily per-account drift rebalance.
 *
 * Cron: `30 21 * * 1-5` (21:30 UTC, weekdays — 15 min AFTER the signal-engine
 * cron at 21:15 so the engine's MAINTENANCE_RANKED_TRIM / PILLAR_FILL signals
 * land in the inbox first; this cron is the "did the signal engine miss
 * anything chunky?" backstop).
 *
 * Loops every linked Schwab account, computes pillar drift against each
 * account's strategy targets, and stages deterministic rebalance trades into
 * the inbox tagged with that account's hash. Skips accounts with drift ≤ 2%
 * or with an existing pending rebalance batch.
 *
 * No auth check inside — runs in Netlify's privileged context.
 */

import type { Config } from '@netlify/functions';
import { runDriftRebalanceForAllAccounts } from '../../lib/rebalance/cron';

export default async (): Promise<Response> => {
  const startedAt = Date.now();

  try {
    const result = await runDriftRebalanceForAllAccounts();
    const elapsedMs = Date.now() - startedAt;

    const stagedTotal = result.accounts.reduce((s, a) => s + a.staged, 0);
    const driftedAccounts = result.accounts.filter((a) => a.drift > 2);

    console.log(
      `[daily-rebalance] ok — checked ${result.accounts.length} account(s), ` +
      `${driftedAccounts.length} drifted, ${stagedTotal} order(s) staged. ` +
      `Took ${elapsedMs}ms.`,
    );
    for (const a of result.accounts) {
      const tag = a.skipped ? `skipped=${a.skipped}` : `staged=${a.staged}`;
      console.log(`  ${a.accountHash.slice(0, 8)}… drift=${a.drift.toFixed(1)}% ${tag}${a.error ? ` error=${a.error}` : ''}`);
    }

    return new Response(
      JSON.stringify({ ok: true, ...result, elapsedMs }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[daily-rebalance] failed:', msg);
    // 200 so Netlify doesn't retry — a Schwab token failure isn't fixable by retry.
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

export const config: Config = {
  schedule: '30 21 * * 1-5',   // 21:30 UTC weekdays — 15 min after signal-engine
};
