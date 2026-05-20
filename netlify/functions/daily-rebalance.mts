/**
 * Netlify Scheduled Function — daily per-account drift rebalance AND the
 * single daily-digest email send point.
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
 * After the rebalance step this function ALSO sends the daily consolidated
 * email digest. It reads:
 *   • Today's archived DailyPlan written by the signal-engine cron at 21:15
 *   • Today's morning alerts written by the daily-alert cron at 12:00 UTC
 *   • Cron health snapshot
 *   • Its own RebalanceCronResult
 * …and passes everything to buildDigest() so the user gets ONE email per
 * weekday with morning alerts, after-close signals, and drift rebalance all
 * in one place. shouldSend() is bypassed — weekdays always send.
 *
 * No auth check inside — runs in Netlify's privileged context.
 */

import type { Config } from '@netlify/functions';
import { runDriftRebalanceForAllAccounts } from '../../lib/rebalance/cron';
import { getArchivedPlan } from '../../lib/signals/plan-archive';
import { getCronHealth } from '../../lib/signals/cron-health';
import { buildDigest } from '../../lib/signals/daily-digest';
import { getAlerts } from '../../lib/storage';
import { sendNotification, notificationsEnabled } from '../../lib/notifications';
import type { DailyPlan } from '../../lib/signals/daily-plan';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Empty plan placeholder used when the signal-engine cron didn't archive a
 * plan today (e.g. token failure, deploy crashed the engine). Keeps the
 * digest renderable so the user still gets an email — with the morning
 * alerts and the rebalance summary — instead of silent failure.
 */
function fallbackPlan(): DailyPlan {
  return {
    generatedAt: Date.now(),
    totalValue: 0,
    marginUtilizationPct: 0,
    afwDollars: undefined,
    autoExecuteMode: 'manual',
    inDefenseMode: false,
    killSwitchActive: false,
    actions: { auto: [], approval: [], alert: [] },
    counts: { total: 0, auto: 0, approval: 0, alert: 0 },
  } as unknown as DailyPlan;
}

export default async (): Promise<Response> => {
  const startedAt = Date.now();
  let rebalanceResult: Awaited<ReturnType<typeof runDriftRebalanceForAllAccounts>> | null = null;
  let rebalanceErr: string | null = null;

  // ── 1. Run the drift rebalance ────────────────────────────────────────────
  try {
    rebalanceResult = await runDriftRebalanceForAllAccounts();
    const elapsedMs = Date.now() - startedAt;

    const stagedTotal = rebalanceResult.accounts.reduce((s, a) => s + a.staged, 0);
    const driftedAccounts = rebalanceResult.accounts.filter((a) => a.drift > 2);

    console.log(
      `[daily-rebalance] ok — checked ${rebalanceResult.accounts.length} account(s), ` +
      `${driftedAccounts.length} drifted, ${stagedTotal} order(s) staged. ` +
      `Took ${elapsedMs}ms.`,
    );
    for (const a of rebalanceResult.accounts) {
      const tag = a.skipped ? `skipped=${a.skipped}` : `staged=${a.staged}`;
      console.log(`  ${a.accountHash.slice(0, 8)}… drift=${a.drift.toFixed(1)}% ${tag}${a.error ? ` error=${a.error}` : ''}`);
    }
  } catch (err) {
    rebalanceErr = err instanceof Error ? err.message : String(err);
    console.error('[daily-rebalance] rebalance step failed:', rebalanceErr);
  }

  // ── 2. Build and send the consolidated daily email ────────────────────────
  //
  // This is the single weekday email send point. Even if the rebalance step
  // above failed, we still want the user to receive the morning alerts and
  // signal-engine plan summary — so we wrap each gather in its own try/catch
  // and degrade gracefully.
  try {
    if (!notificationsEnabled()) {
      console.log('[daily-rebalance] notifications not configured — skipping email');
    } else {
      const today = todayIso();
      const dashboardBase = process.env.URL || process.env.DEPLOY_URL || undefined;

      const [plan, allAlerts, cronHealth] = await Promise.all([
        getArchivedPlan(today).catch(() => null),
        getAlerts().catch(() => []),
        getCronHealth().catch(() => undefined),
      ]);

      // Filter alerts to "today only" so a stale alert from yesterday's
      // morning check doesn't bleed into today's digest.
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const morningAlerts = allAlerts.filter((a) => a.createdAt >= dayStart.getTime());

      const digest = buildDigest({
        plan: plan ?? fallbackPlan(),
        dashboardUrl: dashboardBase ? `${dashboardBase}/dashboard` : undefined,
        cronHealth,
        morningAlerts,
        rebalance: rebalanceResult ?? undefined,
      });

      const sent = await sendNotification(digest);
      if (sent.delivered) {
        console.log(`[daily-rebalance] digest emailed (providerId=${sent.providerId ?? 'n/a'})`);
      } else {
        console.warn('[daily-rebalance] digest not delivered:', sent.reason);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[daily-rebalance] digest send failed (non-fatal):', msg);
  }

  // ── 3. Return ──────────────────────────────────────────────────────────────
  const elapsedMs = Date.now() - startedAt;
  if (rebalanceErr) {
    // 200 so Netlify doesn't retry — a Schwab token failure isn't fixable by retry.
    return new Response(
      JSON.stringify({ ok: false, error: rebalanceErr, elapsedMs }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({ ok: true, ...rebalanceResult, elapsedMs }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

export const config: Config = {
  schedule: '30 21 * * 1-5',   // 21:30 UTC weekdays — 15 min after signal-engine
};
