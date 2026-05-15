/**
 * Cron observability — heartbeat blob written after every engine run.
 *
 * The riskiest assumption in production is "the cron actually runs every
 * trading day." Without instrumentation, a silent failure (Schwab token
 * expired, Yahoo timed out, an unhandled exception in a new rule) would only
 * surface days later when the user notices stale data.
 *
 * After every engine cycle, `recordHeartbeat` writes a small status blob with
 * timestamp, duration, signal count, and error if any. A separate checker
 * (`getCronHealth`) reads it back and decides whether the cron is healthy
 * given the trading-day calendar.
 *
 * The heartbeat blob is keyed `latest`. Older history isn't kept here — the
 * daily plan archive already serves that purpose. The point of this module
 * is binary: "is the engine alive?".
 */

import { getStore } from '@netlify/blobs';
import {
  isTradingDay,
  expectedRunWindowHours,
  lastTradingDay,
  nyDateString,
} from '../market-calendar';

const STORE_NAME = 'signal-engine-health';
const STORE_KEY  = 'latest';

export interface CronHeartbeat {
  ranAt:       number;        // ms epoch
  durationMs:  number;
  status:      'success' | 'error';
  signalCount: number;        // total signals fired across all rules
  actionable:  number;        // BUY/SELL/REBALANCE only
  error?:      string;
}

export interface CronHealth {
  /** Most recent heartbeat, or null if the engine has never run. */
  lastHeartbeat: CronHeartbeat | null;
  /** Hours since lastHeartbeat.ranAt — null when no heartbeat yet. */
  hoursSinceRun: number | null;
  /** Heartbeat we expected by now given the trading-day calendar. */
  expectedWithinHours: number;
  /** True when the engine is overdue OR the last run errored. */
  isStale: boolean;
  /** Human-readable explanation for the dashboard / email digest. */
  reason: string;
}

export async function recordHeartbeat(beat: CronHeartbeat): Promise<void> {
  try {
    await getStore(STORE_NAME).setJSON(STORE_KEY, beat);
  } catch (err) {
    // Heartbeat persistence is best-effort — failing it shouldn't break the
    // cron's primary work.
    console.warn('[cron-health] write failed:', err);
  }
}

export async function loadHeartbeat(): Promise<CronHeartbeat | null> {
  try {
    const beat = (await getStore(STORE_NAME).get(STORE_KEY, { type: 'json' })) as
      | CronHeartbeat
      | null;
    return beat;
  } catch (err) {
    console.warn('[cron-health] read failed:', err);
    return null;
  }
}

/**
 * Read the heartbeat and reason about whether the cron is healthy. Trading-
 * day aware — long weekends and NYSE holidays don't trip the "overdue" alarm.
 */
export async function getCronHealth(now: Date = new Date()): Promise<CronHealth> {
  const beat = await loadHeartbeat();
  const expectedWithinHours = expectedRunWindowHours(now);

  if (!beat) {
    return {
      lastHeartbeat:        null,
      hoursSinceRun:        null,
      expectedWithinHours,
      isStale:              isTradingDay(now),  // only flag on trading days
      reason: isTradingDay(now)
        ? 'No heartbeat recorded yet — the engine has never run (or never persisted health). On a trading day this is unexpected.'
        : 'No heartbeat recorded yet — non-trading day, may be fine to wait for the next session.',
    };
  }

  const hoursSinceRun = (now.getTime() - beat.ranAt) / (60 * 60 * 1000);
  const lastBeatDate = nyDateString(new Date(beat.ranAt));
  const lastTradingDayStr = nyDateString(lastTradingDay(now));

  // Error in last run → always stale, regardless of timing.
  if (beat.status === 'error') {
    return {
      lastHeartbeat:       beat,
      hoursSinceRun,
      expectedWithinHours,
      isStale:             true,
      reason: `Last engine run errored: ${beat.error ?? 'unknown error'} (${lastBeatDate} ${Math.round(hoursSinceRun)}h ago)`,
    };
  }

  // Overdue check — only fire if we missed at least one trading day.
  // "Last beat on or after the most recent trading day" is the healthy case.
  if (lastBeatDate < lastTradingDayStr) {
    return {
      lastHeartbeat:       beat,
      hoursSinceRun,
      expectedWithinHours,
      isStale:             true,
      reason: `Engine hasn't run on ${lastTradingDayStr} (last run was ${lastBeatDate}, ${Math.round(hoursSinceRun)}h ago)`,
    };
  }

  if (hoursSinceRun > expectedWithinHours) {
    return {
      lastHeartbeat:       beat,
      hoursSinceRun,
      expectedWithinHours,
      isStale:             true,
      reason: `Engine last ran ${Math.round(hoursSinceRun)}h ago (expected within ${expectedWithinHours}h given the trading calendar)`,
    };
  }

  return {
    lastHeartbeat:       beat,
    hoursSinceRun,
    expectedWithinHours,
    isStale:             false,
    reason: `Healthy — last run ${Math.round(hoursSinceRun)}h ago, ${beat.signalCount} signal${beat.signalCount === 1 ? '' : 's'} fired.`,
  };
}
