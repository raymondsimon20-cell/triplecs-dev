/**
 * Netlify Scheduled Function — runs daily at 8 AM ET.
 * Reads the latest portfolio snapshot from Blobs, runs compliance checks,
 * and stores alerts so the dashboard can surface them without a live API call.
 */

import type { Config } from '@netlify/functions';
import {
  getLatestPortfolioSnapshot,
  saveAlerts,
  getCornerstoneSnapshot,
  savePortfolioSnapshot,
  appendCashFlows,
  getCashFlows,
  getTokens,
} from '../../lib/storage';
import type { StoredAlert } from '../../lib/storage';
import { getAccountNumbers, createClient } from '../../lib/schwab/client';
import { fetchAccountState, buildSnapshot } from '../../lib/portfolio/fetch';
import { fetchCashFlows } from '../../lib/schwab/transactions';

/**
 * Capture today's portfolio snapshot + SPY benchmark + any new cash flows.
 * Runs before the alert pipeline so the alerts can read fresh data.
 * Failures are logged but do not abort the alert run.
 */
async function captureDailySnapshot(): Promise<void> {
  const tokens = await getTokens();
  if (!tokens) {
    console.warn('[daily-alert] No Schwab tokens — skipping snapshot capture');
    return;
  }

  try {
    const accounts = await getAccountNumbers(tokens);
    if (accounts.length === 0) return;

    // Fetch all account states in parallel
    const states = await Promise.all(
      accounts.map(({ hashValue }) => fetchAccountState(hashValue)),
    );

    // SPY benchmark close — use Schwab's quote (closePrice = previous session close).
    let spyClose: number | undefined;
    try {
      const client = await createClient();
      const quotes = await client.getQuotes(['SPY']);
      const q      = quotes['SPY']?.quote;
      spyClose     = q?.closePrice ?? q?.lastPrice;
    } catch (err) {
      console.warn('[daily-alert] SPY quote fetch failed:', err);
    }

    await savePortfolioSnapshot(buildSnapshot(states, { spyClose }));
    console.log(`[daily-alert] Snapshot saved (totalValue=${states.reduce((s, x) => s + x.totalValue, 0)}, spy=${spyClose ?? 'n/a'})`);
  } catch (err) {
    console.error('[daily-alert] snapshot capture failed:', err);
  }

  // Sync cash flows since the last recorded event (or last 7 days if first run).
  try {
    const existing = await getCashFlows();
    const lastDate = existing.length > 0 ? existing[existing.length - 1].date : null;
    const start = lastDate
      ? new Date(`${lastDate}T00:00:00.000Z`).toISOString()
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const end  = new Date().toISOString();

    const events = await fetchCashFlows(start, end);
    const added  = await appendCashFlows(events);
    console.log(`[daily-alert] Cash flows: scanned ${events.length}, added ${added} new`);
  } catch (err) {
    console.error('[daily-alert] cash-flow sync failed:', err);
  }
}

export default async function handler() {
  // Capture snapshot + cash flows BEFORE running alerts so alerts use fresh data.
  await captureDailySnapshot();

  const [snapshot, cornerstoneSnap] = await Promise.all([
    getLatestPortfolioSnapshot().catch(() => null),
    getCornerstoneSnapshot().catch(() => null),
  ]);
  if (!snapshot) return new Response('No snapshot available', { status: 200 });

  const alerts: StoredAlert[] = [];
  const now = Date.now();

  // Margin threshold checks
  const m = snapshot.marginUtilizationPct;
  if (m > 50) {
    alerts.push({ id: `margin-${now}`, createdAt: now, level: 'danger', read: false,
      rule: 'Margin > 50% Emergency', detail: `Margin at ${m.toFixed(1)}% — EMERGENCY. Deleverage immediately.` });
  } else if (m > 30) {
    alerts.push({ id: `margin-${now}`, createdAt: now, level: 'danger', read: false,
      rule: 'Margin > 30% Critical', detail: `Margin at ${m.toFixed(1)}% — sell highest-maintenance positions first.` });
  } else if (m > 20) {
    alerts.push({ id: `margin-${now}`, createdAt: now, level: 'warn', read: false,
      rule: 'Margin > 20% Warning', detail: `Margin at ${m.toFixed(1)}% — monitor closely.` });
  }

  // Pillar drift checks (using Vol 7 defaults as baseline)
  const TARGETS: Record<string, number> = { triples: 10, cornerstone: 20, income: 65, hedge: 5 };
  for (const p of snapshot.pillarSummary) {
    const target = TARGETS[p.pillar];
    if (target == null) continue;
    const drift = p.portfolioPercent - target;
    if (Math.abs(drift) >= 10) {
      alerts.push({
        id: `pillar-${p.pillar}-${now}`, createdAt: now, level: 'danger', read: false,
        rule: `${p.pillar} pillar drift`,
        detail: `${p.pillar} at ${p.portfolioPercent.toFixed(1)}% vs ${target}% target (${drift > 0 ? '+' : ''}${drift.toFixed(1)}%).`,
      });
    } else if (Math.abs(drift) >= 5) {
      alerts.push({
        id: `pillar-${p.pillar}-${now}`, createdAt: now, level: 'warn', read: false,
        rule: `${p.pillar} pillar drift`,
        detail: `${p.pillar} at ${p.portfolioPercent.toFixed(1)}% vs ${target}% target (${drift > 0 ? '+' : ''}${drift.toFixed(1)}%).`,
      });
    }
  }

  // CLM/CRF floor check
  for (const sym of ['CLM', 'CRF']) {
    const pos = snapshot.positions.find((p) => p.symbol === sym);
    if (!pos) {
      alerts.push({ id: `${sym}-missing-${now}`, createdAt: now, level: 'warn', read: false,
        rule: `${sym} missing`, detail: `${sym} not in portfolio — DRIP eligibility lost.` });
    } else if (pos.shares < 3) {
      alerts.push({ id: `${sym}-floor-${now}`, createdAt: now, level: 'danger', read: false,
        rule: `${sym} below 3-share floor`, detail: `${sym} has ${pos.shares} shares — buy to restore DRIP eligibility.` });
    }
  }

  // CLM/CRF premium alerts from stored cornerstone NAV snapshot
  if (cornerstoneSnap) {
    for (const fund of cornerstoneSnap.funds) {
      const p = fund.premiumDiscount;
      if (p >= 30) {
        alerts.push({ id: `${fund.ticker}-premium-${now}`, createdAt: now, level: 'danger', read: false,
          rule: `${fund.ticker} premium ≥30%`,
          detail: `${fund.ticker} trading at ${p.toFixed(1)}% premium to NAV — RO likely. Consider selling down to 3 shares.` });
      } else if (p >= 20) {
        alerts.push({ id: `${fund.ticker}-premium-${now}`, createdAt: now, level: 'warn', read: false,
          rule: `${fund.ticker} premium ≥20%`,
          detail: `${fund.ticker} at ${p.toFixed(1)}% premium — boxing trigger reached. Review position.` });
      }
    }
  }

  // Concentration check (>20% in single position)
  for (const pos of snapshot.positions) {
    const pct = (pos.marketValue / snapshot.totalValue) * 100;
    if (pct > 20) {
      alerts.push({ id: `conc-${pos.symbol}-${now}`, createdAt: now, level: 'danger', read: false,
        rule: `${pos.symbol} >20% concentration`, detail: `${pos.symbol} is ${pct.toFixed(1)}% of portfolio — exceeds 20% cap. Trim required.` });
    }
  }

  if (alerts.length === 0) {
    alerts.push({ id: `ok-${now}`, createdAt: now, level: 'ok', read: false,
      rule: 'All clear', detail: 'No rule violations detected in daily check.' });
  }

  await saveAlerts(alerts);
  return new Response(`Saved ${alerts.length} alert(s)`, { status: 200 });
}

export const config: Config = {
  schedule: '0 12 * * *', // 8 AM ET (UTC-4) = 12:00 UTC
};
