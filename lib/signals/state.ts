/**
 * Signal Engine — persisted state.
 *
 * 2026-05: per-account state. Each Schwab account now keeps its own defense
 * mode, kill switch, pivot tracking, freedom-ratio history, prev-month margin
 * snapshot and AFW-this-month flag. Per-account state lives at
 * `signal-engine-state:{accountHash}` in Netlify Blobs.
 *
 * Migration path: the legacy single-account state at `current` is still read as
 * a global fallback for any account that has never written its own state.
 * The next per-account run will overwrite that account's slot, gradually
 * replacing the legacy blob. The legacy slot also continues to back the
 * "household aggregate" view used by gate consumers that don't pass an
 * accountHash.
 *
 * Two categories of fields, unchanged:
 *
 *   1. GATE FLAGS — `defenseMode` and `killSwitch`. Read by the OTHER
 *      endpoints (`rebalance-plan`, `option-plan`, `ai-analysis`) before they
 *      stage trades. When a gate is `active: true`, those endpoints bail
 *      with `paused: true` instead of producing recommendations. Their
 *      callers now pass the relevant accountHash; the legacy global gate is
 *      still consulted when no hash is supplied.
 *
 *   2. ENGINE MEMORY — pivot state, freedom-ratio history, prev-month margin
 *      tracking, AFW-this-month flag. Only the signal engine reads/writes
 *      these.
 */

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'signal-engine-state';
const LEGACY_KEY = 'current';                     // pre-per-account state
const KEY_PREFIX = 'account:';                    // per-account state lives at `${prefix}${hash}`
const SCHEMA_VERSION = 1;

function keyFor(accountHash?: string): string {
  if (!accountHash) return LEGACY_KEY;
  return `${KEY_PREFIX}${accountHash}`;
}

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

/**
 * Per-ticker dip-ladder anchor used by TRIPLES_DIP_LADDER.
 *
 * The rule fires a fixed-size BUY each time the ticker drops a fresh 5%
 * (TRIPLES_DIP_STEP_PCT) below its anchor. Bounces don't refire — only NEW
 * lows past the most-recently-fired step. The anchor self-resets when the
 * ticker prints a new high (price > anchorHigh), so the ladder rearms after
 * a recovery.
 *
 *   - anchorHigh:    last observed all-run-history high for this ticker
 *   - lastFiredStep: integer step number of the most recent fire (0 = none).
 *                    e.g. 1 = first 5% step fired, 2 = -10% step fired, etc.
 */
export interface TriplesDipLadderTickerState {
  anchorHigh:     number | null;
  lastFiredStep:  number;
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
  /** Per-ticker dip-ladder anchors. Keyed by symbol (UPRO, TQQQ, ...). */
  triplesDipLadder:    Record<string, TriplesDipLadderTickerState>;
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
    triplesDipLadder:    {},
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rollAfwMonth(state: SignalEngineState): SignalEngineState {
  const thisMonth = currentYearMonth();
  if (state.afwThisMonth.month !== thisMonth) {
    return { ...state, afwThisMonth: { month: thisMonth, fired: false } };
  }
  return state;
}

function mergeWithDefaults(raw: Partial<SignalEngineState> | null): SignalEngineState {
  const defaults = defaultSignalState();
  if (!raw) return defaults;
  return {
    ...defaults,
    ...raw,
    defenseMode:      { ...defaults.defenseMode,  ...(raw.defenseMode  ?? {}) },
    killSwitch:       { ...defaults.killSwitch,   ...(raw.killSwitch   ?? {}) },
    pivot:            { ...defaults.pivot,        ...(raw.pivot        ?? {}) },
    afwThisMonth:     { ...defaults.afwThisMonth, ...(raw.afwThisMonth ?? {}) },
    freedomRatioHistory: raw.freedomRatioHistory ?? [],
    triplesDipLadder: raw.triplesDipLadder ?? {},
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load the signal-engine state for a specific account, or the legacy global
 * state when no accountHash is provided. If the per-account slot is empty,
 * falls back to the legacy `current` blob (for first-time-after-migration
 * runs). Always returns a fully-populated object — callers don't null-check.
 */
export async function loadSignalState(accountHash?: string): Promise<SignalEngineState> {
  const store = getStore(STORE_NAME);

  if (accountHash) {
    const own = await store.get(keyFor(accountHash), { type: 'json' }) as
      Partial<SignalEngineState> | null;
    if (own) return rollAfwMonth(mergeWithDefaults(own));
    // Migration fallback: account hasn't been seeded yet — read the legacy
    // global blob so the first per-account run inherits whatever history the
    // pre-per-account engine recorded.
    const legacy = await store.get(LEGACY_KEY, { type: 'json' }) as
      Partial<SignalEngineState> | null;
    return rollAfwMonth(mergeWithDefaults(legacy));
  }

  const raw = await store.get(LEGACY_KEY, { type: 'json' }) as
    Partial<SignalEngineState> | null;
  return rollAfwMonth(mergeWithDefaults(raw));
}

/**
 * Persist state to the per-account slot, or to the legacy global slot when no
 * accountHash is provided. Each call also stamps schemaVersion.
 */
export async function saveSignalState(state: SignalEngineState, accountHash?: string): Promise<void> {
  await getStore(STORE_NAME).setJSON(keyFor(accountHash), {
    ...state,
    schemaVersion: SCHEMA_VERSION,
  });
}

// ─── Convenience accessors for other endpoints ───────────────────────────────

/**
 * Read-only check used by `rebalance-plan`, `option-plan`, `ai-analysis`
 * before they stage any trades. Returns true when defense mode is active.
 *
 * With per-account state, callers should pass the accountHash they're acting
 * on. Without one, the function returns true if ANY account is in defense
 * mode (conservative — we'd rather bail than stage trades on a household
 * gate flip).
 */
export async function isDefenseModeActive(accountHash?: string): Promise<boolean> {
  if (accountHash) {
    const state = await loadSignalState(accountHash);
    return state.defenseMode.active;
  }
  // No hash: aggregate. Active iff any account is in defense mode.
  const gates = await getSignalGates();
  return gates.defenseMode.active;
}

/**
 * Read-only check used by other endpoints before staging buys.
 * Returns true when the margin kill switch is tripped. Same per-account
 * semantics as `isDefenseModeActive`.
 */
export async function isKillSwitchActive(accountHash?: string): Promise<boolean> {
  if (accountHash) {
    const state = await loadSignalState(accountHash);
    return state.killSwitch.active;
  }
  const gates = await getSignalGates();
  return gates.killSwitch.active;
}

/**
 * Combined gate state — useful when an endpoint wants to include the reason
 * (and `since` timestamp) in its bail-out response, not just bail silently.
 *
 * Per-account: returns that account's gates.
 * Without an accountHash: aggregates across all per-account slots PLUS the
 * legacy global slot. A gate is `active` if ANY underlying state has it
 * active; the returned `since` is the earliest active timestamp and the
 * `reason` cites which account triggered (when known).
 */
export async function getSignalGates(accountHash?: string): Promise<{
  defenseMode: DefenseModeState;
  killSwitch:  KillSwitchState;
}> {
  if (accountHash) {
    const state = await loadSignalState(accountHash);
    return { defenseMode: state.defenseMode, killSwitch: state.killSwitch };
  }
  // Aggregate. List per-account slots, fall back to legacy global.
  const store = getStore(STORE_NAME);
  const slots: SignalEngineState[] = [];
  try {
    const list = await store.list({ prefix: KEY_PREFIX });
    const keys = (list?.blobs ?? []).map((b) => b.key);
    if (keys.length > 0) {
      const raws = await Promise.all(
        keys.map((k) => store.get(k, { type: 'json' }) as Promise<Partial<SignalEngineState> | null>),
      );
      for (const r of raws) slots.push(rollAfwMonth(mergeWithDefaults(r)));
    }
  } catch (err) {
    console.warn('[signal-state] list per-account slots failed; falling back to legacy:', err);
  }
  if (slots.length === 0) {
    const legacy = await store.get(LEGACY_KEY, { type: 'json' }) as Partial<SignalEngineState> | null;
    slots.push(rollAfwMonth(mergeWithDefaults(legacy)));
  }

  const anyDefense = slots.filter((s) => s.defenseMode.active);
  const anyKill    = slots.filter((s) => s.killSwitch.active);

  const earliestSince = (arr: SignalEngineState[], pick: (s: SignalEngineState) => number | null): number | null => {
    let best: number | null = null;
    for (const s of arr) {
      const t = pick(s);
      if (t == null) continue;
      if (best == null || t < best) best = t;
    }
    return best;
  };

  return {
    defenseMode: {
      active:      anyDefense.length > 0,
      since:       earliestSince(anyDefense, (s) => s.defenseMode.since),
      // Aggregate equityRatio: the worst (lowest) across active accounts when
      // gate is active, otherwise the worst across all slots.
      equityRatio: (anyDefense.length > 0 ? anyDefense : slots)
        .map((s) => s.defenseMode.equityRatio)
        .reduce((a, b) => Math.min(a, b), 1),
    },
    killSwitch: {
      active: anyKill.length > 0,
      since:  earliestSince(anyKill, (s) => s.killSwitch.since),
      reason: anyKill.map((s) => s.killSwitch.reason).filter(Boolean).join(' · '),
    },
  };
}
