"use strict";
/**
 * Trade Inbox — staging area for AI-proposed trades awaiting one-click approval.
 *
 * Phase 2 of the Performance → 40% CAGR loop. Trades from `rebalance-plan`,
 * `option-plan`, and `ai-analysis` endpoints are staged here in addition to
 * being returned to their original UIs (additive — existing modals still work).
 * The TradeInbox component reads this store, lets the user approve in bulk, and
 * routes approved items through `/api/orders` for execution.
 *
 * Storage: `trade-inbox` Netlify Blob, key `log`. Items have a 24h TTL while in
 * `pending` state — `listInbox()` lazily marks expired items on read so we
 * never serve stale recommendations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendInbox = appendInbox;
exports.listInbox = listInbox;
exports.markExecuted = markExecuted;
exports.dismissItem = dismissItem;
exports.rePendItem = rePendItem;
exports.markFailed = markFailed;
exports.dismissAllPending = dismissAllPending;
exports.dismissUntaggedPending = dismissUntaggedPending;
exports.tagUntaggedPending = tagUntaggedPending;
exports.getInboxItem = getInboxItem;
exports.pruneResolvedItems = pruneResolvedItems;
const blobs_1 = require("@netlify/blobs");
// ─── Constants ───────────────────────────────────────────────────────────────
const STORE_NAME = 'trade-inbox';
const STORE_KEY = 'log';
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ITEMS = 500; // cap to avoid unbounded growth
// ─── Helpers ─────────────────────────────────────────────────────────────────
let idCounter = 0;
function generateId() {
    idCounter = (idCounter + 1) % 10000;
    return `inbox-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
async function readAll() {
    const data = await (0, blobs_1.getStore)(STORE_NAME).get(STORE_KEY, { type: 'json' });
    return Array.isArray(data) ? data : [];
}
async function writeAll(items) {
    // Keep newest first, cap at MAX_ITEMS
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
    await (0, blobs_1.getStore)(STORE_NAME).setJSON(STORE_KEY, sorted);
}
/**
 * Read → mutate → write. Returns whatever the mutator returns.
 *
 * The mutator receives the current items and returns:
 *   - `{ items, result }` to commit a new state (writeAll is called).
 *   - `{ result }` (no items field) to skip the write entirely.
 *
 * Note: an earlier version of this function wrapped the RMW cycle in a
 * blob-lock (`lib/blob-lock.ts`) to serialize cron-vs-user writes. That
 * pattern self-deadlocked against Netlify Blobs' eventual consistency —
 * the verify-read after setJSON could return a stale value, making the
 * caller think it lost the race even after a successful write, and the
 * caller's own freshly-written record then blocked all subsequent polls
 * within the TTL window. For a single-user app with one cron/day plus
 * occasional manual clicks, the realistic race window is tiny — going
 * back to unlocked RMW is the right tradeoff. blob-lock.ts is kept in
 * the tree as a reference; do not re-introduce until we have a store
 * with real compare-and-swap.
 *
 * The `holder` parameter is retained as a label argument for symmetry
 * with the previous API; it's used only for the log line below.
 */
async function mutateInbox(fn, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
holder) {
    const current = await readAll();
    const outcome = await fn(current);
    if (outcome.items !== undefined) {
        await writeAll(outcome.items);
    }
    return outcome.result;
}
/** Lazily flip `pending` items past their TTL to `expired`. */
function expireStale(items, now = Date.now()) {
    let changed = false;
    const next = items.map((it) => {
        if (it.status === 'pending' && it.expiresAt <= now) {
            changed = true;
            return { ...it, status: 'expired', resolvedAt: now };
        }
        return it;
    });
    return { items: next, changed };
}
/** Cross-source dedup window: skip if a different source already proposed the
 *  same (symbol, instruction) within this many ms. Tighter than the 24h TTL
 *  because two planners hitting the same action in the same trading day is
 *  the case we want to catch — older items are likely stale anyway. */
const CROSS_SOURCE_DEDUP_MS = 12 * 60 * 60 * 1000;
/**
 * Stage a batch of new items. Two dedup layers:
 *
 *   1. SAME-SOURCE dedup by (source, symbol, instruction, quantity). Prevents
 *      a planner re-staging identical items on repeat runs within the TTL.
 *
 *   2. CROSS-SOURCE dedup by (symbol, instruction) within 12h. Prevents two
 *      different planners (e.g. rebalance-plan AND signal-engine) both
 *      staging "SELL CLM" the same morning, which would risk a double trim
 *      if the user approved both. First-write-wins — the second source's
 *      item is dropped and logged.
 *
 * Returns the items as actually persisted (with assigned ids/timestamps).
 */
async function appendInbox(inputs) {
    if (inputs.length === 0)
        return [];
    return mutateInbox((existing) => {
        const { items: aged } = expireStale(existing);
        // Same-source dedup key — exact match including quantity.
        const sameSourceKey = (it) => `${it.source}|${it.symbol}|${it.instruction}|${it.quantity}`;
        // Cross-source dedup key — symbol + instruction only, source-agnostic.
        const crossSourceKey = (it) => `${it.symbol}|${it.instruction}`;
        const now = Date.now();
        const sameSourceKeys = new Set(aged.filter((it) => it.status === 'pending').map(sameSourceKey));
        // Cross-source map: key → existing pending item, so we can include details
        // in the skip log (which source preempted, when it was staged).
        const crossSourceMap = new Map();
        for (const it of aged) {
            if (it.status !== 'pending')
                continue;
            if (now - it.createdAt > CROSS_SOURCE_DEDUP_MS)
                continue;
            crossSourceMap.set(crossSourceKey(it), it);
        }
        const fresh = [];
        for (const input of inputs) {
            // Layer 1: same-source exact-match.
            const sKey = sameSourceKey(input);
            if (sameSourceKeys.has(sKey))
                continue;
            // Layer 2: cross-source by (symbol, instruction).
            const cKey = crossSourceKey(input);
            const preempting = crossSourceMap.get(cKey);
            if (preempting && preempting.source !== input.source) {
                console.info(`[inbox] cross-source dedup: dropping ${input.source} ${input.instruction} ${input.symbol} ` +
                    `× ${input.quantity} — already pending from '${preempting.source}' since ` +
                    `${new Date(preempting.createdAt).toISOString()}`);
                continue;
            }
            sameSourceKeys.add(sKey);
            const violations = input.violations ?? [];
            const ttl = input.ttlMs ?? PENDING_TTL_MS;
            const item = {
                id: generateId(),
                createdAt: now,
                expiresAt: now + ttl,
                source: input.source,
                status: 'pending',
                symbol: input.symbol,
                instruction: input.instruction,
                quantity: input.quantity,
                orderType: input.orderType,
                price: input.price,
                occSymbol: input.occSymbol,
                limitPrice: input.limitPrice,
                pillar: input.pillar,
                rationale: input.rationale,
                aiMode: input.aiMode,
                violations,
                blocked: violations.some((v) => v.severity === 'block'),
                tier: input.tier,
                accountHash: input.accountHash,
            };
            fresh.push(item);
            // Update cross-source map so duplicates within the same batch are also caught.
            crossSourceMap.set(cKey, item);
        }
        if (fresh.length === 0) {
            // Even with no new items, persist any expirations that happened above.
            return { items: aged, result: [] };
        }
        return { items: [...fresh, ...aged], result: fresh };
    }, 'appendInbox');
}
/**
 * Read the inbox. Lazily expires stale `pending` items on read and persists
 * the change so a follow-up read sees the same state.
 */
async function listInbox(filter) {
    // Unlocked read + in-memory expireStale. NO write lock here — the
    // dashboard fires 3-5 concurrent listInbox calls per page load (Today,
    // DailyPlan, PendingOrders, polling), and serializing all of them behind
    // the same lock as appendInbox / updateItem caused thundering-herd
    // timeouts when contention piled up. Expirations are deterministic
    // (status flips when expiresAt ≤ now), so concurrent in-memory
    // computation produces the same result. The persisted state catches up
    // the next time a user-driven mutation runs through mutateInbox, which
    // calls expireStale before its own dedup logic.
    const raw = await readAll();
    const { items } = expireStale(raw);
    let out = items;
    if (filter?.status) {
        const allowed = new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
        out = out.filter((it) => allowed.has(it.status));
    }
    if (filter?.source) {
        out = out.filter((it) => it.source === filter.source);
    }
    if (filter?.accountHash) {
        const wanted = filter.accountHash;
        // Strict equality — untagged items used to fall through to "every
        // account's view." Auto-execute then bucketed them into the *first*
        // account and fired real Schwab orders against it, so an untagged SELL
        // could land in the wrong account. Untagged items are now invisible to
        // per-account queries; surface them via the dedicated cleanup endpoints
        // (DELETE /api/inbox cleanup=untagged or tag-untagged).
        out = out.filter((it) => it.accountHash === wanted);
    }
    return out;
}
/** Mark an inbox item as executed and attach the Schwab order result. */
async function markExecuted(id, result) {
    return updateItem(id, (it) => ({
        ...it,
        status: 'executed',
        resolvedAt: Date.now(),
        orderId: result.orderId,
        message: result.message,
    }));
}
/** Dismiss an inbox item — user said no, don't surface it again. */
async function dismissItem(id) {
    return updateItem(id, (it) => ({
        ...it,
        status: 'dismissed',
        resolvedAt: Date.now(),
    }));
}
/**
 * Re-pend a previously-failed inbox item so the user (or the next auto-
 * execute pass) can retry it. Only `failed` items qualify — re-pending an
 * already-executed item would risk double-submission, and re-pending a
 * dismissed one would override an explicit user decision. The previous
 * `resolvedAt` is cleared so the dashboard doesn't render stale "failed at
 * Xh ago" chrome on the retried row.
 */
async function rePendItem(id) {
    return updateItem(id, (it) => {
        if (it.status !== 'failed')
            return it;
        return {
            ...it,
            status: 'pending',
            resolvedAt: undefined,
            message: undefined,
            orderId: null,
        };
    });
}
/**
 * Mark an inbox item as failed because the broker rejected the order.
 * Distinct from `dismissed` (user said no) and `expired` (TTL elapsed).
 * The next cron will skip `failed` items rather than retry blindly — the
 * user can manually re-pend via PATCH /api/inbox if they want to retry.
 */
async function markFailed(id, reason, message) {
    return updateItem(id, (it) => ({
        ...it,
        status: 'failed',
        resolvedAt: Date.now(),
        message: message ?? reason,
    }));
}
/** Bulk-dismiss all currently `pending` items. Returns the number dismissed. */
async function dismissAllPending() {
    return mutateInbox((items) => {
        const { items: aged } = expireStale(items);
        const now = Date.now();
        let count = 0;
        const next = aged.map((it) => {
            if (it.status === 'pending') {
                count++;
                return { ...it, status: 'dismissed', resolvedAt: now };
            }
            return it;
        });
        return count > 0 ? { items: next, result: count } : { result: 0 };
    }, 'dismissAllPending');
}
/**
 * Dismiss every pending item that has no accountHash. Useful one-shot cleanup
 * for legacy items staged before per-account tagging shipped — those items
 * would otherwise appear in every per-account inbox view (the filter treats
 * untagged items as belonging to the active account).
 */
async function dismissUntaggedPending() {
    return mutateInbox((items) => {
        const { items: aged } = expireStale(items);
        const now = Date.now();
        let count = 0;
        const next = aged.map((it) => {
            if (it.status === 'pending' && !it.accountHash) {
                count++;
                return { ...it, status: 'dismissed', resolvedAt: now };
            }
            return it;
        });
        return count > 0 ? { items: next, result: count } : { result: 0 };
    }, 'dismissUntaggedPending');
}
/**
 * Tag every untagged pending item with the supplied accountHash so they
 * stop appearing in other accounts' views. Returns the number updated.
 * Use when the user knows the legacy items all belonged to one account
 * (typical: items staged before multi-account work shipped were all for
 * the primary account).
 */
async function tagUntaggedPending(accountHash) {
    if (!accountHash)
        return 0;
    return mutateInbox((items) => {
        const { items: aged } = expireStale(items);
        let count = 0;
        const next = aged.map((it) => {
            if (it.status === 'pending' && !it.accountHash) {
                count++;
                return { ...it, accountHash };
            }
            return it;
        });
        return count > 0 ? { items: next, result: count } : { result: 0 };
    }, 'tagUntaggedPending');
}
/** Generic in-place update by id. Internal helper. Atomic via mutateInbox. */
async function updateItem(id, patch) {
    return mutateInbox((items) => {
        const idx = items.findIndex((it) => it.id === id);
        if (idx === -1)
            return { result: null };
        const updated = patch(items[idx]);
        const next = [...items];
        next[idx] = updated;
        return { items: next, result: updated };
    }, `updateItem:${id.slice(0, 12)}`);
}
/**
 * Get a single item by id. Returns null if not found. Does not run the
 * expiration sweep — callers that need accurate status should `listInbox`.
 */
async function getInboxItem(id) {
    const items = await readAll();
    return items.find((it) => it.id === id) ?? null;
}
/**
 * Prune resolved inbox items older than `maxAgeDays`. Pending items are never
 * dropped here — only executed/dismissed/expired/failed entries. Returns the
 * number of items pruned.
 *
 * The MAX_ITEMS cap (500) already bounds the inbox in the worst case; this
 * adds a soft retention policy so the audit trail doesn't grow indefinitely
 * with stale entries.
 */
async function pruneResolvedItems(maxAgeDays = 60) {
    return mutateInbox((items) => {
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const resolvedStatuses = new Set([
            'executed', 'dismissed', 'expired', 'failed',
        ]);
        const next = items.filter((it) => {
            if (!resolvedStatuses.has(it.status))
                return true; // keep pending
            const age = it.resolvedAt ?? it.createdAt;
            return age >= cutoff; // keep recent resolved
        });
        const removed = items.length - next.length;
        return removed > 0 ? { items: next, result: removed } : { result: 0 };
    }, 'pruneResolvedItems');
}
