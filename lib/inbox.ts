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

import { getStore } from '@netlify/blobs';
import type { GuardrailViolation } from './guardrails';

// ─── Types ───────────────────────────────────────────────────────────────────

export type InboxSource = 'rebalance' | 'option' | 'ai-rec' | 'signal-engine';

export type InboxStatus = 'pending' | 'executed' | 'dismissed' | 'expired' | 'failed';

export type InboxInstruction =
  | 'BUY' | 'SELL'
  | 'BUY_TO_OPEN' | 'SELL_TO_OPEN'
  | 'BUY_TO_CLOSE' | 'SELL_TO_CLOSE';

/**
 * A single staged trade. Mirrors the Schwab order shape so approving an item
 * is just a pass-through to `/api/orders`. Equity items use `symbol` +
 * `quantity`; option items also carry `occSymbol` + `limitPrice`.
 */
export interface InboxItem {
  id:           string;          // stable id, generated on append
  createdAt:    number;          // ms epoch
  expiresAt:    number;          // ms epoch — 24h after createdAt for `pending`
  source:       InboxSource;
  status:       InboxStatus;
  /** Set when status moves out of `pending`. */
  resolvedAt?:  number;
  /** Schwab orderId returned after successful execution. */
  orderId?:     string | null;
  /** Status message from Schwab (success or error). */
  message?:     string;

  // ── Order spec (mirrors lib/schwab/orders shape) ──────────────────────────
  symbol:       string;          // underlying for options
  instruction:  InboxInstruction;
  quantity:     number;          // shares for equity, contracts for option
  orderType:    'MARKET' | 'LIMIT';
  price?:       number;          // LIMIT price for equity
  /** Option-only fields (when source === 'option'). */
  occSymbol?:   string;
  limitPrice?:  number;

  // ── Context surfaced in the inbox UI ──────────────────────────────────────
  pillar?:      string;
  rationale?:   string;
  aiMode?:      string;
  /** Guardrail violations attached at stage time (warn-level can still be approved). */
  violations:   GuardrailViolation[];
  /** True when at least one violation is severity 'block'. */
  blocked:      boolean;
  /**
   * Phase 5 autopilot tier. 'auto' items are eligible for unattended execution
   * when auto-config.mode === 'auto'. 'approval' items always require a human.
   * 'alert' items aren't tradeable. Optional for backward compatibility with
   * historical inbox items that were staged before tiering shipped.
   */
  tier?:        'auto' | 'approval' | 'alert';

  /**
   * Schwab account hash this order should target. Optional — when omitted the
   * auto-execute path falls back to the first account. SELLs routed by the
   * signal engine carry the holding's account hash so the order goes against
   * the right position.
   */
  accountHash?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORE_NAME = 'trade-inbox';
const STORE_KEY  = 'log';
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
const MAX_ITEMS  = 500;                        // cap to avoid unbounded growth

// ─── Helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0;
function generateId(): string {
  idCounter = (idCounter + 1) % 10_000;
  return `inbox-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

async function readAll(): Promise<InboxItem[]> {
  const data = await getStore(STORE_NAME).get(STORE_KEY, { type: 'json' });
  return Array.isArray(data) ? data as InboxItem[] : [];
}

async function writeAll(items: InboxItem[]): Promise<void> {
  // Keep newest first, cap at MAX_ITEMS
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
  await getStore(STORE_NAME).setJSON(STORE_KEY, sorted);
}

/**
 * Atomic-ish read → mutate → write. Wraps the cycle in a blob-lock so the
 * daily signal-engine cron, the daily rebalance cron, and concurrent user
 * PATCH/DELETE clicks don't race the same blob and drop each other's
 * writes. Returns whatever the mutator returns.
 *
 * The mutator receives the current items and returns:
 *   - `{ items, result }` to commit a new state (writeAll is called).
 *   - `{ result }` (no items field) to skip the write entirely — useful
 *     for read-only paths that opportunistically expire stale rows but
 *     would prefer not to take a write lock for no reason.
 */
async function mutateInbox<T>(
  fn: (items: InboxItem[]) => { items?: InboxItem[]; result: T } | Promise<{ items?: InboxItem[]; result: T }>,
  holder?: string,
): Promise<T> {
  const { withBlobLock } = await import('./blob-lock');
  return withBlobLock('inbox', async () => {
    const current = await readAll();
    const outcome = await fn(current);
    if (outcome.items !== undefined) {
      await writeAll(outcome.items);
    }
    return outcome.result;
  }, { holder });
}

/** Lazily flip `pending` items past their TTL to `expired`. */
function expireStale(items: InboxItem[], now = Date.now()): { items: InboxItem[]; changed: boolean } {
  let changed = false;
  const next = items.map((it) => {
    if (it.status === 'pending' && it.expiresAt <= now) {
      changed = true;
      return { ...it, status: 'expired' as const, resolvedAt: now };
    }
    return it;
  });
  return { items: next, changed };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface AppendInput {
  source:      InboxSource;
  symbol:      string;
  instruction: InboxInstruction;
  quantity:    number;
  orderType:   'MARKET' | 'LIMIT';
  price?:      number;
  occSymbol?:  string;
  limitPrice?: number;
  pillar?:     string;
  rationale?:  string;
  aiMode?:     string;
  violations?: GuardrailViolation[];
  /** Phase 5 tier metadata — see InboxItem.tier. */
  tier?:       'auto' | 'approval' | 'alert';
  /** Schwab account hash — see InboxItem.accountHash. */
  accountHash?: string;
  /** Override default 24h TTL for this item (rare). */
  ttlMs?:      number;
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
export async function appendInbox(inputs: AppendInput[]): Promise<InboxItem[]> {
  if (inputs.length === 0) return [];

  return mutateInbox<InboxItem[]>((existing) => {
  const { items: aged } = expireStale(existing);

  // Same-source dedup key — exact match including quantity.
  const sameSourceKey = (it: Pick<InboxItem, 'source' | 'symbol' | 'instruction' | 'quantity'>) =>
    `${it.source}|${it.symbol}|${it.instruction}|${it.quantity}`;
  // Cross-source dedup key — symbol + instruction only, source-agnostic.
  const crossSourceKey = (it: Pick<InboxItem, 'symbol' | 'instruction'>) =>
    `${it.symbol}|${it.instruction}`;

  const now = Date.now();

  const sameSourceKeys = new Set(
    aged.filter((it) => it.status === 'pending').map(sameSourceKey),
  );
  // Cross-source map: key → existing pending item, so we can include details
  // in the skip log (which source preempted, when it was staged).
  const crossSourceMap = new Map<string, InboxItem>();
  for (const it of aged) {
    if (it.status !== 'pending') continue;
    if (now - it.createdAt > CROSS_SOURCE_DEDUP_MS) continue;
    crossSourceMap.set(crossSourceKey(it), it);
  }

  const fresh: InboxItem[] = [];
  for (const input of inputs) {
    // Layer 1: same-source exact-match.
    const sKey = sameSourceKey(input);
    if (sameSourceKeys.has(sKey)) continue;

    // Layer 2: cross-source by (symbol, instruction).
    const cKey = crossSourceKey(input);
    const preempting = crossSourceMap.get(cKey);
    if (preempting && preempting.source !== input.source) {
      console.info(
        `[inbox] cross-source dedup: dropping ${input.source} ${input.instruction} ${input.symbol} ` +
        `× ${input.quantity} — already pending from '${preempting.source}' since ` +
        `${new Date(preempting.createdAt).toISOString()}`,
      );
      continue;
    }

    sameSourceKeys.add(sKey);
    const violations = input.violations ?? [];
    const ttl = input.ttlMs ?? PENDING_TTL_MS;
    const item: InboxItem = {
      id:          generateId(),
      createdAt:   now,
      expiresAt:   now + ttl,
      source:      input.source,
      status:      'pending',
      symbol:      input.symbol,
      instruction: input.instruction,
      quantity:    input.quantity,
      orderType:   input.orderType,
      price:       input.price,
      occSymbol:   input.occSymbol,
      limitPrice:  input.limitPrice,
      pillar:      input.pillar,
      rationale:   input.rationale,
      aiMode:      input.aiMode,
      violations,
      blocked:     violations.some((v) => v.severity === 'block'),
      tier:        input.tier,
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
export async function listInbox(filter?: {
  status?:      InboxStatus | InboxStatus[];
  source?:      InboxSource;
  /**
   * Restrict to items destined for a specific Schwab account. An item matches
   * if its own `accountHash` equals the filter OR if it has no accountHash at
   * all (legacy / untagged items fall through to the currently-selected
   * account on approve, so they belong in every per-account view).
   */
  accountHash?: string;
}): Promise<InboxItem[]> {
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
export async function markExecuted(id: string, result: { orderId: string | null; message?: string }): Promise<InboxItem | null> {
  return updateItem(id, (it) => ({
    ...it,
    status:     'executed',
    resolvedAt: Date.now(),
    orderId:    result.orderId,
    message:    result.message,
  }));
}

/** Dismiss an inbox item — user said no, don't surface it again. */
export async function dismissItem(id: string): Promise<InboxItem | null> {
  return updateItem(id, (it) => ({
    ...it,
    status:     'dismissed',
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
export async function rePendItem(id: string): Promise<InboxItem | null> {
  return updateItem(id, (it) => {
    if (it.status !== 'failed') return it;
    return {
      ...it,
      status:     'pending',
      resolvedAt: undefined,
      message:    undefined,
      orderId:    null,
    };
  });
}

/**
 * Mark an inbox item as failed because the broker rejected the order.
 * Distinct from `dismissed` (user said no) and `expired` (TTL elapsed).
 * The next cron will skip `failed` items rather than retry blindly — the
 * user can manually re-pend via PATCH /api/inbox if they want to retry.
 */
export async function markFailed(id: string, reason: string, message?: string): Promise<InboxItem | null> {
  return updateItem(id, (it) => ({
    ...it,
    status:     'failed',
    resolvedAt: Date.now(),
    message:    message ?? reason,
  }));
}

/** Bulk-dismiss all currently `pending` items. Returns the number dismissed. */
export async function dismissAllPending(): Promise<number> {
  return mutateInbox<number>((items) => {
    const { items: aged } = expireStale(items);
    const now = Date.now();
    let count = 0;
    const next = aged.map((it) => {
      if (it.status === 'pending') {
        count++;
        return { ...it, status: 'dismissed' as const, resolvedAt: now };
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
export async function dismissUntaggedPending(): Promise<number> {
  return mutateInbox<number>((items) => {
    const { items: aged } = expireStale(items);
    const now = Date.now();
    let count = 0;
    const next = aged.map((it) => {
      if (it.status === 'pending' && !it.accountHash) {
        count++;
        return { ...it, status: 'dismissed' as const, resolvedAt: now };
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
export async function tagUntaggedPending(accountHash: string): Promise<number> {
  if (!accountHash) return 0;
  return mutateInbox<number>((items) => {
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
async function updateItem(id: string, patch: (it: InboxItem) => InboxItem): Promise<InboxItem | null> {
  return mutateInbox<InboxItem | null>((items) => {
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return { result: null };
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
export async function getInboxItem(id: string): Promise<InboxItem | null> {
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
export async function pruneResolvedItems(maxAgeDays = 60): Promise<number> {
  return mutateInbox<number>((items) => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const resolvedStatuses: ReadonlySet<InboxStatus> = new Set([
      'executed', 'dismissed', 'expired', 'failed',
    ]);
    const next = items.filter((it) => {
      if (!resolvedStatuses.has(it.status)) return true; // keep pending
      const age = it.resolvedAt ?? it.createdAt;
      return age >= cutoff; // keep recent resolved
    });
    const removed = items.length - next.length;
    return removed > 0 ? { items: next, result: removed } : { result: 0 };
  }, 'pruneResolvedItems');
}
