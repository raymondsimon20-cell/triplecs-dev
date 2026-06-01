"use strict";
/**
 * Server-side strategy targets store.
 *
 * The SettingsPanel persists user-customized allocation targets to localStorage,
 * which is fine for the dashboard UI but invisible to the daily cron and the
 * signal engine (which run server-side and have no browser context).
 *
 * This module mirrors strategy targets to Netlify Blobs so the engine can
 * read what the user actually wants their allocation to look like.
 *
 * Two-tier scope (2026-05):
 *   • Global default at key `current` — applies to every account that doesn't
 *     have its own override.
 *   • Per-account override at key `account:{accountHash}` — used by that one
 *     account's engine run. Resolution is override → global → DEFAULT_TARGETS.
 *
 * The SettingsPanel writes to both localStorage and `/api/strategy` (POST) on
 * save; the engine reads via `getServerStrategyTargets(accountHash?)`. Calling
 * without an accountHash returns the global default, which is also the
 * behaviour every legacy caller gets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServerStrategyTargets = getServerStrategyTargets;
exports.saveServerStrategyTargets = saveServerStrategyTargets;
exports.clearServerStrategyOverride = clearServerStrategyOverride;
exports.hasServerStrategyOverride = hasServerStrategyOverride;
const blobs_1 = require("@netlify/blobs");
const utils_1 = require("./utils");
const STRATEGY_STORE = 'strategy-targets';
const GLOBAL_KEY = 'current';
const ACCOUNT_PREFIX = 'account:';
function keyFor(accountHash) {
    if (!accountHash)
        return GLOBAL_KEY;
    return `${ACCOUNT_PREFIX}${accountHash}`;
}
async function rawGet(key) {
    try {
        return (await (0, blobs_1.getStore)(STRATEGY_STORE).get(key, { type: 'json' }));
    }
    catch (err) {
        console.warn(`[strategy-store] read ${key} failed:`, err);
        return null;
    }
}
/**
 * Resolve effective targets for a given accountHash. Order:
 *   1. Per-account override (if accountHash provided AND override exists).
 *   2. Global default.
 *   3. DEFAULT_TARGETS (compiled-in safety net).
 *
 * Merges stored values over defaults so future schema additions degrade
 * gracefully when an old blob is missing newer fields.
 */
async function getServerStrategyTargets(accountHash) {
    if (accountHash) {
        const override = await rawGet(keyFor(accountHash));
        if (override)
            return { ...utils_1.DEFAULT_TARGETS, ...override };
    }
    const global = await rawGet(GLOBAL_KEY);
    if (!global)
        return { ...utils_1.DEFAULT_TARGETS };
    return { ...utils_1.DEFAULT_TARGETS, ...global };
}
/**
 * Persist a strategy-targets blob.
 *   - accountHash omitted → writes the global default (mirrors legacy behaviour).
 *   - accountHash provided → writes a per-account override.
 */
async function saveServerStrategyTargets(t, accountHash) {
    const payload = {
        ...utils_1.DEFAULT_TARGETS,
        ...t,
        updatedAt: Date.now(),
    };
    await (0, blobs_1.getStore)(STRATEGY_STORE).setJSON(keyFor(accountHash), payload);
}
/**
 * Remove a per-account override so the next read falls back to global.
 * No-op when called without an accountHash (the global default is never
 * deleted through this path — it's only ever overwritten).
 */
async function clearServerStrategyOverride(accountHash) {
    if (!accountHash)
        return;
    try {
        await (0, blobs_1.getStore)(STRATEGY_STORE).delete(keyFor(accountHash));
    }
    catch (err) {
        console.warn(`[strategy-store] delete ${accountHash} failed:`, err);
    }
}
/**
 * Did this account have its own override stored? Used by the engine loop to
 * decide whether targets were customised — useful for digest narrative.
 */
async function hasServerStrategyOverride(accountHash) {
    if (!accountHash)
        return false;
    const raw = await rawGet(keyFor(accountHash));
    return raw != null;
}
