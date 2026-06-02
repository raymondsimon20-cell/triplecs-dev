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
 *
 * 2026-05: per-account auto-config. Each account can run on its own mode
 * (one on `auto`, another on `manual`/`dry-run`) with its own caps and
 * breaker. Per-account configs live at `account:{hash}` and resolve via
 * override → global → defaults. Existing callers without an accountHash
 * see the global config (legacy behaviour).
 */

import { getStore } from '@netlify/blobs';

const STORE_NAME    = 'signal-engine-auto-config';
const GLOBAL_KEY    = 'current';
const ACCOUNT_PREFIX = 'account:';
const SCHEMA_VERSION = 1;

function keyFor(accountHash?: string): string {
  if (!accountHash || accountHash === 'all' || accountHash === 'global') return GLOBAL_KEY;
  return `${ACCOUNT_PREFIX}${accountHash}`;
}

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
      // Raised 3 → 10 alongside the tier-2 auto promotion. With more rules
      // eligible to fire unattended (PILLAR_FILL, MAINTENANCE_RANKED_TRIM,
      // TRIPLES_DIP_LADDER), 3 was too tight — a single laddered dip day
      // could exhaust the budget before the other rules ran.
      maxTrades:              10,
      // Held at $5K alongside AUTO_TIER_MAX_DOLLARS and PILLAR_FILL_MAX_DOLLARS
      // — raising past $5K is a coordinated change across three files. $5K
      // also keeps single-trade AFW impact well below the $10K floor.
      maxDollarsPerTrade:     5000,
      // Raised 10 → 15 for smaller portfolios (<$250K) where the 10% cap
      // bound too early on busy auto days. At $200K: 15% = $30K daily, which
      // accommodates one substantial trim + a full ladder day without binding,
      // while still providing a cumulative governor beyond per-trade caps.
      maxNetExposureShiftPct: 15,
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

function rollBreakerIfStale(config: AutoConfig): AutoConfig {
  const today = isoDate(new Date());
  // Strict-less-than was correct here originally — we only clear breakers
  // whose pause date is in the past. Today's breaker stays armed.
  if (config.circuitBreaker.pausedUntilDate && config.circuitBreaker.pausedUntilDate < today) {
    return {
      ...config,
      circuitBreaker: {
        ...config.circuitBreaker,
        pausedUntilDate: null,
        pausedReason:    '',
      },
    };
  }
  return config;
}

function mergeWithDefaults(raw: Partial<AutoConfig> | null): AutoConfig {
  const defaults = defaultAutoConfig();
  if (!raw) return defaults;
  return {
    ...defaults,
    ...raw,
    dailyCaps:      { ...defaults.dailyCaps,      ...(raw.dailyCaps      ?? {}) },
    circuitBreaker: { ...defaults.circuitBreaker, ...(raw.circuitBreaker ?? {}) },
  };
}

async function rawGet(key: string): Promise<AutoConfig | null> {
  const raw = await getStore(STORE_NAME).get(key, { type: 'json' }) as Partial<AutoConfig> | null;
  if (!raw) return null;
  return rollBreakerIfStale(mergeWithDefaults(raw));
}

/**
 * Load auto-config. With an accountHash, resolves the per-account override
 * (if any) and falls back to global; without, returns global. Always returns
 * a fully-populated object — callers don't null-check. Also auto-clears the
 * circuit breaker when the calendar date has rolled over.
 */
export async function loadAutoConfig(accountHash?: string): Promise<AutoConfig> {
  if (accountHash) {
    const override = await rawGet(keyFor(accountHash));
    if (override) return override;
  }
  return (await rawGet(GLOBAL_KEY)) ?? defaultAutoConfig();
}

/** Persist config. With an accountHash, writes the per-account override. */
export async function saveAutoConfig(config: AutoConfig, accountHash?: string): Promise<void> {
  await getStore(STORE_NAME).setJSON(keyFor(accountHash), {
    ...config,
    schemaVersion: SCHEMA_VERSION,
    updatedAt:     Date.now(),
  });
}

/** Remove a per-account override so the engine falls back to global. */
export async function clearAutoConfigOverride(accountHash: string): Promise<void> {
  if (!accountHash) return;
  try {
    await getStore(STORE_NAME).delete(keyFor(accountHash));
  } catch (err) {
    console.warn(`[auto-config] delete override ${accountHash} failed:`, err);
  }
}

/** Did this account have its own override stored? */
export async function hasAutoConfigOverride(accountHash: string): Promise<boolean> {
  if (!accountHash) return false;
  const raw = await getStore(STORE_NAME).get(keyFor(accountHash), { type: 'json' });
  return raw != null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** True when auto-execute is currently allowed: mode is 'dry-run' or 'auto'
 *  AND the circuit breaker is NOT paused for today or any future date.
 *  Previously this used `===` against today's date — a future pausedUntilDate
 *  (manual schema migration, server-clock skew, or a multi-day sticky pause
 *  written ahead) silently compared unequal and let auto-execute fire anyway.
 *  Now any non-null past-or-future pause counts, and rollBreakerIfStale
 *  clears stale ones on read. */
export function autoExecuteActive(config: AutoConfig): boolean {
  if (config.mode === 'manual') return false;
  const today  = isoDate(new Date());
  const paused = config.circuitBreaker.pausedUntilDate;
  if (paused && paused >= today) return false;
  return true;
}

/** True when actual Schwab orders should fire (not just dry-run logging). */
export function shouldHitSchwab(config: AutoConfig): boolean {
  return autoExecuteActive(config) && config.mode === 'auto';
}

/** Trip the circuit breaker until end of `today`. Used by checkCircuitBreaker
 *  when intraday P&L breaches the dailyLossPct threshold. With an accountHash,
 *  trips ONLY that account's breaker. */
export async function tripCircuitBreaker(reason: string, accountHash?: string): Promise<void> {
  const config = await loadAutoConfig(accountHash);
  const today  = isoDate(new Date());
  await saveAutoConfig({
    ...config,
    circuitBreaker: {
      ...config.circuitBreaker,
      pausedUntilDate: today,
      pausedReason:    reason,
    },
  }, accountHash);
}
