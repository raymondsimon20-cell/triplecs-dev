/**
 * Signal Engine — persisted state.
 *
 * Single Netlify Blob (`signal-engine-state` / key `current`) holding everything
 * the engine needs to remember across runs. Two categories of fields:
 *
 *   1. GATE FLAGS — `defenseMode` and `killSwitch`. These are read by the OTHER
 *      endpoints (`rebalance-plan`, `option-plan`, `ai-analysis`) before they
 *      stage any trades. When a gate is `active: true`, those endpoints bail
 *      with `paused: true` instead of producing recommendations.
 *
 *   2. ENGINE MEMORY — pivot state, freedom-ratio history, prev-month margin
 *      tracking, AFW-this-month flag. Only the signal engine reads/writes these.
 *
 * Storage shape is versioned with `schemaVersion` so we can migrate cleanly if
 * the engine gets new persisted fields. `loadSignalState()` always returns a
 * fully-populated object, filling defaults for missing keys — callers don't
 * need to null-check.
 */

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'signal-engine-state';
const STORE_KEY  = 'current';
const SCHEMA_VERSION = 1;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DefenseModeState {
  /** True when equityRatio ≤ DEFENSE_EQUITY_RATIO threshold (default 0.40). */
  active:       boolean;
  /** ms epoch when defense mode was most recently entered (null if never). */
  since:        number | null;
  /** Equity ratio at last engine run (rounded to 4 decimals). */
  equityRatio:  number;
}

export interface KillSwitchState {
  /** True when margin debt grew > $500 MoM without an AFW trigger that month. */
  active:    boolean;
  /** ms epoch when kill switch was most recently tripped (null if never). */
  since:     number | null;
  /** Human-readable explanation surfaced to other endpoints when they bail. */
  reason:    string;
}

export interface PivotState {
  /** Tracking low used by the +5% recovery trigger. Null = not yet seeded. */
  spyLowSincePivot:  number | null;
  /** Once user has executed the pivot trade, suppresses further pivot signals. */
  pivotExecuted:     boolean;
}

export interface FreedomRatioPoint {
  /** ISO date (YYYY-MM-DD) of the data point. */
  date:   string;
  /** Freedom ratio = monthly distribution income / monthly expenses. */
  ratio:  number;
}

export interface PrevMonthSnapshot {
  /** YYYY-MM of the prior month. */
  month:   string;
  /** Margin debt (absolute dollars) at end of that month. */
  margin:  number;
}

export interface AfwMonthFlag {
  /** YYYY-MM the flag applies to. Rolls over automatically on month change. */
  month:  string;
  fired:  boolean;
}

export interface SignalEngineState {
  schemaVersion:       number;
  lastRunAt:           number | null;
  defenseMode:         DefenseModeState;
  killSwitch:          KillSwitchState;
  pivot:               PivotState;
  freedomRatioHistory: FreedomRatioPoint[];
  prevMonth:           PrevMonthSnapshot | null;
  afwThisMonth:        AfwMonthFlag;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function defaultSignalState(): SignalEngineState {
  return {
    schemaVersion:       SCHEMA_VERSION,
    lastRunAt:           null,
    defenseMode:         { active: false, since: null, equityRatio: 1 },
    killSwitch:          { active: false, since: null, reason: '' },
    pivot:               { spyLowSincePivot: null, pivotExecuted: false },
    freedomRatioHistory: [],
    prevMonth:           null,
    afwThisMonth:        { month: currentYearMonth(), fired: false },
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load the current signal-engine state, filling defaults for any missing
 * fields. Always returns a fully-populated object — callers don't null-check.
 * Also rolls over `afwThisMonth.fired` when the month changes.
 */
export async function loadSignalState(): Promise<SignalEngineState> {
  const raw = await getStore(STORE_NAME).get(STORE_KEY, { type: 'json' }) as
    Partial<SignalEngineState> | null;

  const defaults = defaultSignalState();
  if (!raw) return defaults;

  const merged: SignalEngineState = {
    ...defaults,
    ...raw,
    defenseMode:  { ...defaults.defenseMode,  ...(raw.defenseMode  ?? {}) },
    killSwitch:   { ...defaults.killSwitch,   ...(raw.killSwitch   ?? {}) },
    pivot:        { ...defaults.pivot,        ...(raw.pivot        ?? {}) },
    afwThisMonth: { ...defaults.afwThisMonth, ...(raw.afwThisMonth ?? {}) },
    freedomRatioHistory: raw.freedomRatioHistory ?? [],
  };

  // Roll the AFW-this-month flag if the calendar month has changed since
  // it was last written.
  const thisMonth = currentYearMonth();
  if (merged.afwThisMonth.month !== thisMonth) {
    merged.afwThisMonth = { month: thisMonth, fired: false };
  }

  return merged;
}

export async function saveSignalState(state: SignalEngineState): Promise<void> {
  await getStore(STORE_NAME).setJSON(STORE_KEY, {
    ...state,
    schemaVersion: SCHEMA_VERSION,
  });
}

// ─── Convenience accessors for other endpoints ───────────────────────────────

/**
 * Read-only check used by `rebalance-plan`, `option-plan`, `ai-analysis`
 * before they stage any trades. Returns true when defense mode is active.
 */
export async function isDefenseModeActive(): Promise<boolean> {
  const state = await loadSignalState();
  return state.defenseMode.active;
}

/**
 * Read-only check used by other endpoints before staging buys.
 * Returns true when the margin kill switch is tripped.
 */
export async function isKillSwitchActive(): Promise<boolean> {
  const state = await loadSignalState();
  return state.killSwitch.active;
}

/**
 * Combined gate state — useful when an endpoint wants to include the reason
 * (and `since` timestamp) in its bail-out response, not just bail silently.
 */
export async function getSignalGates(): Promise<{
  defenseMode: DefenseModeState;
  killSwitch:  KillSwitchState;
}> {
  const state = await loadSignalState();
  return { defenseMode: state.defenseMode, killSwitch: state.killSwitch };
}
