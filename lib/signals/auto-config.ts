/**
 * Signal Engine — auto-execute configuration.
 *
 * Persisted in the `signal-engine-auto-config` blob. Controls whether the
 * scheduled signal engine run only stages trades into the inbox (manual mode,
 * the default), simulates auto-execution to a paper-trades log (dry-run), or
 * actually places orders via Schwab (auto).
 *
 *   - mode = 'manual'   (default)  → engine fires → inbox.  User approves.
 *   - mode = 'dry-run'             → engine fires → inbox.  "Would have
 *                                    executed" entries written to the
 *                                    paper-trades blob.  No Schwab calls.
 *   - mode = 'auto'                → engine fires → inbox → guards →
 *                                    placeOrders → trade-history.
 *
 * Guards apply in both 'dry-run' and 'auto' modes — daily trade count cap,
 * dollar-per-trade cap, net daily exposure shift cap, and an intraday loss
 * circuit breaker that auto-reverts to manual for the rest of the day if
 * tripped. The circuit-breaker `pausedUntilDate` is auto-cleared when the
 * date rolls over.
 *
 * Default values are intentionally conservative — flip them up only after
 * 2 weeks of clean dry-run logs.
 */

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'signal-engine-auto-config';
const STORE_KEY  = 'current';
const SCHEMA_VERSION = 1;

// ─── Types ───────────────────────────────────────────────────────────────────

export type AutoMode = 'manual' | 'dry-run' | 'auto';

export interface DailyCaps {
  /** Max number of auto-executed trades per day across all rules. */
  maxTrades:                  number;
  /** Max dollar value per individual trade. */
  maxDollarsPerTrade:         number;
  /** Max sum-of-absolute-trade-values as % of portfolio per day. */
  maxNetExposureShiftPct:     number;
}

export interface CircuitBreakerConfig {
  /** Trip the breaker if intraday P&L falls below this % (e.g. -2 = -2%). */
  dailyLossPct:               number;
  /** ISO date (YYYY-MM-DD) until which auto-execute is paused. null = not tripped. */
  pausedUntilDate:            string | null;
  /** Free-text reason for the pause, surfaced in logs and UI. */
  pausedReason:               string;
}

export interface AutoConfig {
  schemaVersion: number;
  mode:          AutoMode;
  dailyCaps:     DailyCaps;
  circuitBreaker: CircuitBreakerConfig;
  /** ms epoch of last config update — useful for audit trail. */
  updatedAt:     number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export function defaultAutoConfig(): AutoConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode:          'manual',
    dailyCaps: {
      maxTrades:              3,
      maxDollarsPerTrade:     5000,
      maxNetExposureShiftPct: 10,
    },
    circuitBreaker: {
      dailyLossPct:    -2,
      pausedUntilDate: null,
      pausedReason:    '',
    },
    updatedAt: 0,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Load config, filling defaults for any missing fields. Also auto-clears the
 * circuit-breaker `pausedUntilDate` when the calendar date has rolled over.
 * Always returns a fully-populated object — callers don't null-check.
 */
export async function loadAutoConfig(): Promise<AutoConfig> {
  const raw = await getStore(STORE_NAME).get(STORE_KEY, { type: 'json' }) as
    Partial<AutoConfig> | null;

  const defaults = defaultAutoConfig();
  if (!raw) return defaults;

  const merged: AutoConfig = {
    ...defaults,
    ...raw,
    dailyCaps:      { ...defaults.dailyCaps,      ...(raw.dailyCaps      ?? {}) },
    circuitBreaker: { ...defaults.circuitBreaker, ...(raw.circuitBreaker ?? {}) },
  };

  // Roll over breaker pause if the date has changed.
  const today = isoDate(new Date());
  if (merged.circuitBreaker.pausedUntilDate && merged.circuitBreaker.pausedUntilDate < today) {
    merged.circuitBreaker = {
      ...merged.circuitBreaker,
      pausedUntilDate: null,
      pausedReason:    '',
    };
  }

  return merged;
}

export async function saveAutoConfig(config: AutoConfig): Promise<void> {
  await getStore(STORE_NAME).setJSON(STORE_KEY, {
    ...config,
    schemaVersion: SCHEMA_VERSION,
    updatedAt:     Date.now(),
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** True when auto-execute is currently allowed: mode is 'dry-run' or 'auto'
 *  AND the circuit breaker is NOT paused for today. */
export function autoExecuteActive(config: AutoConfig): boolean {
  if (config.mode === 'manual') return false;
  if (config.circuitBreaker.pausedUntilDate === isoDate(new Date())) return false;
  return true;
}

/** True when actual Schwab orders should fire (not just dry-run logging). */
export function shouldHitSchwab(config: AutoConfig): boolean {
  return autoExecuteActive(config) && config.mode === 'auto';
}

/** Trip the circuit breaker until end of `today`. Used by checkCircuitBreaker
 *  when intraday P&L breaches the dailyLossPct threshold. */
export async function tripCircuitBreaker(reason: string): Promise<void> {
  const config = await loadAutoConfig();
  const today  = isoDate(new Date());
  await saveAutoConfig({
    ...config,
    circuitBreaker: {
      ...config.circuitBreaker,
      pausedUntilDate: today,
      pausedReason:    reason,
    },
  });
}
