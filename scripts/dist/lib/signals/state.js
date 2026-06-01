"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultSignalState = defaultSignalState;
exports.loadSignalState = loadSignalState;
exports.saveSignalState = saveSignalState;
exports.isDefenseModeActive = isDefenseModeActive;
exports.isKillSwitchActive = isKillSwitchActive;
exports.getSignalGates = getSignalGates;
const blobs_1 = require("@netlify/blobs");
const STORE_NAME = 'signal-engine-state';
const LEGACY_KEY = 'current'; // pre-per-account state
const KEY_PREFIX = 'account:'; // per-account state lives at `${prefix}${hash}`
const SCHEMA_VERSION = 1;
function keyFor(accountHash) {
    if (!accountHash)
        return LEGACY_KEY;
    return `${KEY_PREFIX}${accountHash}`;
}
// ─── Defaults ────────────────────────────────────────────────────────────────
function currentYearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function defaultSignalState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        lastRunAt: null,
        defenseMode: { active: false, since: null, equityRatio: 1 },
        killSwitch: { active: false, since: null, reason: '' },
        pivot: { spyLowSincePivot: null, pivotExecuted: false },
        freedomRatioHistory: [],
        prevMonth: null,
        afwThisMonth: { month: currentYearMonth(), fired: false },
        triplesDipLadder: {},
    };
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function rollAfwMonth(state) {
    const thisMonth = currentYearMonth();
    if (state.afwThisMonth.month !== thisMonth) {
        return { ...state, afwThisMonth: { month: thisMonth, fired: false } };
    }
    return state;
}
function mergeWithDefaults(raw) {
    const defaults = defaultSignalState();
    if (!raw)
        return defaults;
    return {
        ...defaults,
        ...raw,
        defenseMode: { ...defaults.defenseMode, ...(raw.defenseMode ?? {}) },
        killSwitch: { ...defaults.killSwitch, ...(raw.killSwitch ?? {}) },
        pivot: { ...defaults.pivot, ...(raw.pivot ?? {}) },
        afwThisMonth: { ...defaults.afwThisMonth, ...(raw.afwThisMonth ?? {}) },
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
async function loadSignalState(accountHash) {
    const store = (0, blobs_1.getStore)(STORE_NAME);
    if (accountHash) {
        const own = await store.get(keyFor(accountHash), { type: 'json' });
        if (own)
            return rollAfwMonth(mergeWithDefaults(own));
        // Migration fallback: account hasn't been seeded yet — read the legacy
        // global blob so the first per-account run inherits whatever history the
        // pre-per-account engine recorded.
        const legacy = await store.get(LEGACY_KEY, { type: 'json' });
        return rollAfwMonth(mergeWithDefaults(legacy));
    }
    const raw = await store.get(LEGACY_KEY, { type: 'json' });
    return rollAfwMonth(mergeWithDefaults(raw));
}
/**
 * Persist state to the per-account slot, or to the legacy global slot when no
 * accountHash is provided. Each call also stamps schemaVersion.
 */
async function saveSignalState(state, accountHash) {
    await (0, blobs_1.getStore)(STORE_NAME).setJSON(keyFor(accountHash), {
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
async function isDefenseModeActive(accountHash) {
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
async function isKillSwitchActive(accountHash) {
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
async function getSignalGates(accountHash) {
    if (accountHash) {
        const state = await loadSignalState(accountHash);
        return { defenseMode: state.defenseMode, killSwitch: state.killSwitch };
    }
    // Aggregate. List per-account slots, fall back to legacy global.
    const store = (0, blobs_1.getStore)(STORE_NAME);
    const slots = [];
    try {
        const list = await store.list({ prefix: KEY_PREFIX });
        const keys = (list?.blobs ?? []).map((b) => b.key);
        if (keys.length > 0) {
            const raws = await Promise.all(keys.map((k) => store.get(k, { type: 'json' })));
            for (const r of raws)
                slots.push(rollAfwMonth(mergeWithDefaults(r)));
        }
    }
    catch (err) {
        console.warn('[signal-state] list per-account slots failed; falling back to legacy:', err);
    }
    if (slots.length === 0) {
        const legacy = await store.get(LEGACY_KEY, { type: 'json' });
        slots.push(rollAfwMonth(mergeWithDefaults(legacy)));
    }
    const anyDefense = slots.filter((s) => s.defenseMode.active);
    const anyKill = slots.filter((s) => s.killSwitch.active);
    const earliestSince = (arr, pick) => {
        let best = null;
        for (const s of arr) {
            const t = pick(s);
            if (t == null)
                continue;
            if (best == null || t < best)
                best = t;
        }
        return best;
    };
    return {
        defenseMode: {
            active: anyDefense.length > 0,
            since: earliestSince(anyDefense, (s) => s.defenseMode.since),
            // Aggregate equityRatio: the worst (lowest) across active accounts when
            // gate is active, otherwise the worst across all slots.
            equityRatio: (anyDefense.length > 0 ? anyDefense : slots)
                .map((s) => s.defenseMode.equityRatio)
                .reduce((a, b) => Math.min(a, b), 1),
        },
        killSwitch: {
            active: anyKill.length > 0,
            since: earliestSince(anyKill, (s) => s.killSwitch.since),
            reason: anyKill.map((s) => s.killSwitch.reason).filter(Boolean).join(' · '),
        },
    };
}
