"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultSignalState = defaultSignalState;
exports.loadSignalState = loadSignalState;
exports.saveSignalState = saveSignalState;
exports.isDefenseModeActive = isDefenseModeActive;
exports.isKillSwitchActive = isKillSwitchActive;
exports.getSignalGates = getSignalGates;
const blobs_1 = require("@netlify/blobs");
const STORE_NAME = 'signal-engine-state';
const STORE_KEY = 'current';
const SCHEMA_VERSION = 1;
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
    };
}
// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Load the current signal-engine state, filling defaults for any missing
 * fields. Always returns a fully-populated object — callers don't null-check.
 * Also rolls over `afwThisMonth.fired` when the month changes.
 */
async function loadSignalState() {
    const raw = await (0, blobs_1.getStore)(STORE_NAME).get(STORE_KEY, { type: 'json' });
    const defaults = defaultSignalState();
    if (!raw)
        return defaults;
    const merged = {
        ...defaults,
        ...raw,
        defenseMode: { ...defaults.defenseMode, ...(raw.defenseMode ?? {}) },
        killSwitch: { ...defaults.killSwitch, ...(raw.killSwitch ?? {}) },
        pivot: { ...defaults.pivot, ...(raw.pivot ?? {}) },
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
async function saveSignalState(state) {
    await (0, blobs_1.getStore)(STORE_NAME).setJSON(STORE_KEY, {
        ...state,
        schemaVersion: SCHEMA_VERSION,
    });
}
// ─── Convenience accessors for other endpoints ───────────────────────────────
/**
 * Read-only check used by `rebalance-plan`, `option-plan`, `ai-analysis`
 * before they stage any trades. Returns true when defense mode is active.
 */
async function isDefenseModeActive() {
    const state = await loadSignalState();
    return state.defenseMode.active;
}
/**
 * Read-only check used by other endpoints before staging buys.
 * Returns true when the margin kill switch is tripped.
 */
async function isKillSwitchActive() {
    const state = await loadSignalState();
    return state.killSwitch.active;
}
/**
 * Combined gate state — useful when an endpoint wants to include the reason
 * (and `since` timestamp) in its bail-out response, not just bail silently.
 */
async function getSignalGates() {
    const state = await loadSignalState();
    return { defenseMode: state.defenseMode, killSwitch: state.killSwitch };
}
