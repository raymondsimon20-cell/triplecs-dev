/**
 * Signal Engine — auto-execute pipeline.
 *
 * After `runSignalsAndStage` has staged the engine's actionable trades into
 * the inbox, this module decides whether to also EXECUTE them — gated by the
 * auto-config blob (mode + caps + circuit breaker).
 *
 * Three execution modes (set via /api/signals/auto-config):
 *   - 'manual'   → no-op. Items stay in the inbox waiting for human approval.
 *   - 'dry-run'  → "would have executed" entries written to the paper-trades
 *                  blob. No Schwab calls. Inbox items stay 'pending' so they
 *                  age out naturally — they're informational only.
 *   - 'auto'     → real Schwab orders via placeOrders. Inbox items get
 *                  marked 'executed' with the resulting orderId. Trade-history
 *                  entries written exactly the way /api/orders does, so both
 *                  manual and auto flows produce identical history records.
 *
 * Guards (apply in both dry-run and auto):
 *   - Daily trade count cap     — total executions today across all rules
 *   - Per-trade dollar cap      — drops any single trade larger than cap
 *   - Net daily exposure cap    — sum of |trade values| ≤ cap% of portfolio
 *   - Intraday-loss breaker     — if today's loss > threshold, trip until
 *                                 next day. Sticky-pause for the rest of today.
 *
 * Anything rejected by a guard stays in the inbox for manual review.
 */

import { getStore } from '@netlify/blobs';

import { getTokens }       from '../storage';
import { placeOrders, type OrderRequest } from '../schwab/orders';
import {
  markExecuted,
  markFailed,
  type InboxItem,
} from '../inbox';

import {
  loadAutoConfig,
  tripCircuitBreaker,
  autoExecuteActive,
  shouldHitSchwab,
  type AutoConfig,
  type AutoMode,
} from './auto-config';
import {
  validateBatch,
  type GuardrailContext,
  type ProposedTrade,
} from '../guardrails';
import { fetchAccountState } from '../portfolio/fetch';

// ─── Trade history shape (mirrors app/api/orders/route.ts TradeHistoryEntry) ──

interface TradeHistoryEntry {
  id:          string;
  timestamp:   string;
  symbol:      string;
  instruction: 'BUY' | 'SELL';
  quantity:    number;
  orderType:   'MARKET' | 'LIMIT';
  price?:      number;
  orderId:     string | null;
  status:      'placed' | 'error';
  message?:    string;
  rationale?:  string;
  aiMode?:     string;
  /** Avg cost basis (USD/share) for SELLs; undefined for BUYs. */
  costBasisPerShare?: number;
  /** Schwab account hash the trade ran against. Optional for backward compat
   *  with entries written before this field shipped. */
  accountHash?: string;
}

interface PaperTrade extends TradeHistoryEntry {
  /** Marks this as a dry-run entry rather than a real placed order. */
  dryRun: true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Count today's executions. With an accountHash, only counts trades placed
 * against THAT account (so per-account daily caps apply per-account). Without,
 * counts the whole trade-history blob (legacy / household-aggregate).
 */
async function countTodaysExecutions(accountHash?: string): Promise<{ count: number; dollars: number }> {
  try {
    const store = getStore('trade-history');
    const log = await store.get('log', { type: 'json' }) as TradeHistoryEntry[] | null;
    if (!Array.isArray(log)) return { count: 0, dollars: 0 };

    const today = isoDate(new Date());
    let count = 0;
    let dollars = 0;
    for (const t of log) {
      if (!t.timestamp.startsWith(today)) continue;
      if (t.status !== 'placed') continue;
      if (accountHash && t.accountHash && t.accountHash !== accountHash) continue;
      count += 1;
      const px = t.price ?? 0;
      dollars += t.quantity * px;
    }
    return { count, dollars };
  } catch {
    return { count: 0, dollars: 0 };
  }
}

async function saveTradeHistoryEntries(entries: TradeHistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const store = getStore('trade-history');
    const existing = await store.get('log', { type: 'json' }) as TradeHistoryEntry[] | null;
    const log = Array.isArray(existing) ? existing : [];
    // Cap matches /api/orders (2000 entries, bumped from 500 in 2026-05
    // so multi-account users don't lose tail history disproportionately).
    const updated = [...entries, ...log].slice(0, 2000);
    await store.setJSON('log', updated);
  } catch (err) {
    console.error('[auto-execute] trade-history write failed:', err);
  }
}

async function savePaperTradeEntries(entries: PaperTrade[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const store = getStore('signal-engine-paper-trades');
    const existing = await store.get('log', { type: 'json' }) as PaperTrade[] | null;
    const log = Array.isArray(existing) ? existing : [];
    const updated = [...entries, ...log].slice(0, 1000);
    await store.setJSON('log', updated);
  } catch (err) {
    console.error('[auto-execute] paper-trades write failed:', err);
  }
}

// ─── Cap enforcement ─────────────────────────────────────────────────────────

export interface CapDecision {
  allowed: InboxItem[];
  rejected: Array<{ item: InboxItem; reason: string }>;
}

/** Apply the three caps in order. Items rejected by an earlier cap aren't
 *  evaluated against later caps. Items pass through ordered by priority
 *  (high → low) so when we hit a cap we drop the lowest-priority items. */
export function applyCaps(
  items: InboxItem[],
  config: AutoConfig,
  portfolioValue: number,
  todaysExecutions: { count: number; dollars: number },
): CapDecision {
  const caps = config.dailyCaps;
  const allowed: InboxItem[] = [];
  const rejected: Array<{ item: InboxItem; reason: string }> = [];

  let remainingCount = Math.max(0, caps.maxTrades - todaysExecutions.count);
  const maxShiftDollars = caps.maxNetExposureShiftPct * 0.01 * portfolioValue;
  let cumulativeShift = todaysExecutions.dollars;

  for (const it of items) {
    const itemValue = it.quantity * (it.price ?? 0);

    if (remainingCount <= 0) {
      rejected.push({ item: it, reason: `Daily trade count cap reached (${caps.maxTrades})` });
      continue;
    }
    if (itemValue > caps.maxDollarsPerTrade) {
      rejected.push({ item: it, reason:
        `Trade value $${itemValue.toFixed(0)} exceeds per-trade cap $${caps.maxDollarsPerTrade}` });
      continue;
    }
    if (cumulativeShift + itemValue > maxShiftDollars) {
      rejected.push({ item: it, reason:
        `Would exceed daily exposure cap ${caps.maxNetExposureShiftPct}% ` +
        `($${maxShiftDollars.toFixed(0)})` });
      continue;
    }

    allowed.push(it);
    remainingCount -= 1;
    cumulativeShift += itemValue;
  }

  return { allowed, rejected };
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

/**
 * Compares today's portfolio value against the most recent prior snapshot.
 * If today's totalValue dropped more than `dailyLossPct`, trip the breaker
 * (sticky pause until tomorrow) and return true.
 *
 * With an accountHash: prefers per-account snapshots if any exist (per-account
 * snapshot store added 2026-05); falls back to household snapshots so accounts
 * with no per-account history yet still get *some* breaker protection. Trips
 * the per-account breaker only.
 */
export async function checkCircuitBreaker(
  currentPortfolioValue: number,
  config: AutoConfig,
  accountHash?: string,
): Promise<{ tripped: boolean; reason: string }> {
  if (!Number.isFinite(currentPortfolioValue) || currentPortfolioValue <= 0) {
    return { tripped: false, reason: '' };
  }

  let priorValue: number | null = null;
  try {
    const store = getStore('snapshots');
    // Per-account snapshot lookup first; fall back to household log when no
    // per-account history exists yet.
    let log: Array<{ savedAt: number; totalValue: number }> | null = null;
    if (accountHash) {
      log = await store.get(`account:${accountHash}`, { type: 'json' }) as
        Array<{ savedAt: number; totalValue: number }> | null;
    }
    if (!Array.isArray(log) || log.length === 0) {
      log = await store.get('log', { type: 'json' }) as
        Array<{ savedAt: number; totalValue: number }> | null;
    }
    if (Array.isArray(log) && log.length > 0) {
      // Snapshots are saved newest-first. Find the most recent one BEFORE today.
      const today = isoDate(new Date());
      const prior = log.find((s) => !isoDate(new Date(s.savedAt)).startsWith(today));
      priorValue = prior?.totalValue ?? null;
    }
  } catch (err) {
    console.warn('[auto-execute] snapshot read for breaker failed:', err);
    return { tripped: false, reason: '' };
  }

  if (priorValue === null || priorValue <= 0) return { tripped: false, reason: '' };

  const pctChange = ((currentPortfolioValue - priorValue) / priorValue) * 100;
  if (pctChange < config.circuitBreaker.dailyLossPct) {
    const reason =
      `Intraday loss ${pctChange.toFixed(2)}% breached threshold ` +
      `${config.circuitBreaker.dailyLossPct}% (prior $${priorValue.toFixed(0)} → ` +
      `current $${currentPortfolioValue.toFixed(0)}). Auto-execute paused for the rest of today.`;
    await tripCircuitBreaker(reason, accountHash);
    return { tripped: true, reason };
  }

  return { tripped: false, reason: '' };
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface AutoExecuteResult {
  /**
   * Aggregated mode summary. When accounts disagree (e.g. one 'auto', one
   * 'manual'), this reflects the most permissive mode any account ran in
   * (auto > dry-run > manual) so the digest accurately describes the live
   * surface area. The per-account breakdown (when present) tells the full
   * story.
   */
  mode:        'manual' | 'dry-run' | 'auto';
  considered:  number;
  executed:    number;
  rejected:    Array<{ symbol: string; instruction: string; reason: string }>;
  breakerTripped: boolean;
  breakerReason:  string;
  dryRun:      boolean;
  /**
   * 2026-05 per-account autopilot. One entry per Schwab account that had
   * staged items in this run, recording that account's own mode + outcome
   * (so the digest can render "Roth: 2 placed, Taxable: paused (breaker)").
   */
  byAccount?: Array<{
    accountHash:    string;
    mode:           AutoMode;
    considered:     number;
    executed:       number;
    rejectedCount:  number;
    breakerTripped: boolean;
    breakerReason:  string;
  }>;
}

/**
 * Main entry. Takes freshly-staged inbox items + a household portfolio value
 * (and optional per-account totals) and:
 *   1. Groups items by accountHash. Items without one fall through to the
 *      primary (first) account bucket.
 *   2. For EACH account bucket:
 *        a. Loads that account's auto-config (override → global → defaults).
 *        b. If 'manual' → no-op for that bucket.
 *        c. Checks the per-account circuit breaker (against per-account
 *           snapshots when available, else household). If tripped → no-op.
 *        d. Applies that account's caps using THAT account's count of today's
 *           executions (so caps are truly per-account, not household-pooled).
 *        e. If 'dry-run' → paper-trades; if 'auto' → real orders + history.
 *   3. Aggregates all per-account outcomes into one AutoExecuteResult plus
 *      a per-account breakdown.
 */
export async function autoExecute(
  stagedItems: InboxItem[],
  portfolioValue: number,
  perAccountValues?: Map<string, number>,
): Promise<AutoExecuteResult> {
  // Tokens still resolved for downstream order placement; primary-account
  // fallback removed — untagged items are now rejected up-front instead of
  // being silently fired into the first account.
  const tokens = await getTokens();

  // Group items by their target account. Items without an explicit
  // accountHash are NEVER auto-executed — previously they bucketed into the
  // first account (`primaryAccountHash`) and an untagged SELL could fire a
  // real Schwab order against an account that didn't hold the position. They
  // route to `__untagged` so the per-account bucket logic still rejects them
  // (no live tokens for that pseudo-hash, no order placement).
  const byAccount = new Map<string, InboxItem[]>();
  for (const it of stagedItems) {
    const hash = it.accountHash || '__untagged';
    if (!byAccount.has(hash)) byAccount.set(hash, []);
    byAccount.get(hash)!.push(it);
  }

  // Lazy import once — used by the live-mode branches.
  const { fetchCostBasisMap, costBasisFor } = await import('../schwab/cost-basis');

  // Per-account execution. Run buckets in parallel — they're independent
  // (different account hashes, different configs, different breakers).
  const buckets = await Promise.all(
    Array.from(byAccount.entries()).map(async ([accountHash, items]) =>
      executeAccountBucket({
        accountHash,
        items,
        tokens,
        portfolioValue: perAccountValues?.get(accountHash) ?? portfolioValue,
        fetchCostBasisMap,
        costBasisFor,
      }),
    ),
  );

  // ─── Aggregate ──────────────────────────────────────────────────────────
  const allRejected   = buckets.flatMap((b) => b.rejected);
  const totalExecuted = buckets.reduce((s, b) => s + b.executed, 0);
  const totalConsidered = stagedItems.length;
  const anyBreakerTripped = buckets.some((b) => b.breakerTripped);
  const breakerReasons    = buckets
    .filter((b) => b.breakerTripped && b.breakerReason)
    .map((b) => b.breakerReason);
  const modes = new Set(buckets.map((b) => b.mode));
  // Most-permissive aggregate: prefer 'auto' > 'dry-run' > 'manual' so the
  // digest reflects whether ANY account fired live trades.
  const aggregateMode: AutoMode =
    modes.has('auto')     ? 'auto'    :
    modes.has('dry-run')  ? 'dry-run' :
                            'manual';
  const dryRun = aggregateMode === 'dry-run';

  return {
    mode:           aggregateMode,
    considered:     totalConsidered,
    executed:       totalExecuted,
    rejected:       allRejected,
    breakerTripped: anyBreakerTripped,
    breakerReason:  breakerReasons.join(' · '),
    dryRun,
    byAccount: buckets.map((b) => ({
      accountHash:    b.accountHash,
      mode:           b.mode,
      considered:     b.considered,
      executed:       b.executed,
      rejectedCount:  b.rejected.length,
      breakerTripped: b.breakerTripped,
      breakerReason:  b.breakerReason,
    })),
  };
}

/**
 * Run the auto-execute pipeline for a single account's bucket of staged
 * items. Returns a per-bucket outcome; the caller aggregates across buckets.
 */
async function executeAccountBucket(args: {
  accountHash:    string;
  items:          InboxItem[];
  tokens:         Awaited<ReturnType<typeof getTokens>>;
  portfolioValue: number;
  fetchCostBasisMap: (typeof import('../schwab/cost-basis'))['fetchCostBasisMap'];
  costBasisFor:      (typeof import('../schwab/cost-basis'))['costBasisFor'];
}): Promise<{
  accountHash:    string;
  mode:           AutoMode;
  considered:     number;
  executed:       number;
  rejected:       Array<{ symbol: string; instruction: string; reason: string }>;
  breakerTripped: boolean;
  breakerReason:  string;
}> {
  const { accountHash, items, tokens, portfolioValue, fetchCostBasisMap, costBasisFor } = args;

  // __untagged is the synthetic bucket for any inbox item missing an
  // accountHash. Previously these silently routed to the first account; now
  // they're always rejected so a SELL against the wrong account is
  // impossible. The cleanup endpoints (DELETE /api/inbox cleanup=untagged
  // or tag-untagged) let the user resolve legacy entries.
  if (accountHash === '__untagged') {
    return {
      accountHash, mode: 'manual',
      considered: items.length,
      executed: 0,
      rejected: items.map((it) => ({
        symbol: it.symbol, instruction: it.instruction,
        reason: 'No accountHash on item — refusing to route to a fallback account. Use /api/inbox cleanup to tag or dismiss.',
      })),
      breakerTripped: false, breakerReason: '',
    };
  }

  // Load THIS account's auto-config. Override → global → defaults.
  const config = await loadAutoConfig(accountHash);

  // Manual mode: items stay in the inbox for human approval.
  if (config.mode === 'manual') {
    return {
      accountHash, mode: 'manual',
      considered: 0, executed: 0, rejected: [],
      breakerTripped: false, breakerReason: '',
    };
  }

  // Breaker already paused for today.
  if (!autoExecuteActive(config)) {
    return {
      accountHash, mode: config.mode,
      considered: items.length, executed: 0, rejected: [],
      breakerTripped: true,
      breakerReason: config.circuitBreaker.pausedReason || 'Auto-execute paused for today',
    };
  }

  // Live breaker check.
  const breaker = await checkCircuitBreaker(portfolioValue, config, accountHash);
  if (breaker.tripped) {
    return {
      accountHash, mode: config.mode,
      considered: items.length, executed: 0, rejected: [],
      breakerTripped: true, breakerReason: breaker.reason,
    };
  }

  // Per-account daily-cap accounting. Counts trades placed against THIS
  // account today only.
  const todays = await countTodaysExecutions(accountHash);

  const isAutoMode  = config.mode === 'auto';
  const tierGateRejected: Array<{ item: InboxItem; reason: string }> = [];
  const eligible = items.filter((it) => {
    if (it.instruction !== 'BUY' && it.instruction !== 'SELL') return false;
    if (it.status !== 'pending') return false;
    if (isAutoMode && it.tier !== 'auto') {
      tierGateRejected.push({
        item:   it,
        reason: it.tier === 'approval'
          ? 'Tier 2 — requires approval; not eligible for unattended execution'
          : it.tier === 'alert'
          ? 'Tier 3 — alert-only; not tradeable'
          : 'No tier tag (legacy path); defaults to requiring approval',
      });
      return false;
    }
    return true;
  });
  const { allowed: capAllowed, rejected: capRejected } = applyCaps(eligible, config, portfolioValue, todays);

  // ── Guardrail validation ──────────────────────────────────────────────────
  // Critical safety net before placeOrders: catches AFW under-runs, margin
  // cap breaches, concentration violations, etc. Previously this path went
  // straight to Schwab without consulting validateProposedTrade — same bug
  // class that bit the user on options. With tier-2 rules now promoted to
  // auto (MAINTENANCE_RANKED_TRIM, PILLAR_FILL, TRIPLES_DIP_LADDER), the
  // dollar sizes are big enough that we MUST run guardrails before firing.
  //
  // Fail-open on Schwab fetch failure: log + skip the guard rather than
  // block the whole batch. The 50% Schwab margin cap is still enforced at
  // the broker level, so failing open here doesn't lose the hard backstop.
  const guardrailRejected: Array<{ item: InboxItem; reason: string }> = [];
  let allowed = capAllowed;
  try {
    const state = await fetchAccountState(accountHash);
    const ctx: GuardrailContext = {
      totalValue:    state.totalValue,
      equity:        state.equity,
      marginBalance: state.marginBalance,
      afwDollars:    state.afwDollars,
      positions: state.positions.map((p) => ({
        symbol:      p.instrument.symbol,
        pillar:      p.pillar,
        marketValue: p.marketValue,
        shares:      p.longQuantity,
      })),
      pillars:      [],
      // recentTrades omitted — wash-sale isn't relevant for engine-sized
      // auto trades and the daily-count cap already runs upstream in applyCaps.
      recentTrades: [],
    };
    const proposed: ProposedTrade[] = capAllowed.map((it) => ({
      symbol:      it.symbol,
      instruction: it.instruction as ProposedTrade['instruction'],
      shares:      it.quantity,
      // Engine signals stage equity orders with price set; fall back to 0 if
      // somehow missing — checkOrderSize and concentration use price, so a 0
      // would skip those checks. Acceptable: AFW/margin gates still fire on
      // the equity BUY since their math uses ctx.equity − marginBalance.
      price:       it.price ?? 0,
      pillar:      it.pillar ?? 'other',
      // Engine signals are equity-only at the moment — options always tier='approval'.
      // If/when an option signal reaches here, the caller must populate `option`.
    }));
    const { allowed: vAllowed, blocked: vBlocked } = validateBatch(proposed, ctx);
    const allowedKey = new Set(vAllowed.map((t) => `${t.symbol}|${t.instruction}`));
    allowed = capAllowed.filter((it) =>
      allowedKey.has(`${it.symbol}|${it.instruction}`),
    );
    for (const b of vBlocked) {
      const item = capAllowed.find(
        (it) => it.symbol === b.symbol && it.instruction === b.instruction,
      );
      if (!item) continue;
      const reasons = b.violations
        .filter((v) => v.severity === 'block')
        .map((v) => `${v.code}: ${v.message}`)
        .join(' · ');
      guardrailRejected.push({
        item,
        reason: `Guardrail blocked — ${reasons || 'unspecified violation'}`,
      });
    }
  } catch (err) {
    console.warn(
      `[auto-execute] guardrail validation failed (fail-open) for ${accountHash.slice(0, 6)}:`,
      err,
    );
  }

  const rejectedRaw = [...tierGateRejected, ...capRejected, ...guardrailRejected];
  const rejected = rejectedRaw.map((r) => ({
    symbol: r.item.symbol, instruction: r.item.instruction, reason: r.reason,
  }));

  if (allowed.length === 0) {
    return {
      accountHash, mode: config.mode,
      considered: items.length, executed: 0, rejected,
      breakerTripped: false, breakerReason: '',
    };
  }

  // Dry-run: write paper trades, leave inbox alone.
  if (!shouldHitSchwab(config)) {
    const now = Date.now();
    const paperEntries: PaperTrade[] = allowed.map((it, i) => ({
      id:          `${now}-paper-${accountHash.slice(0, 4)}-${i}`,
      timestamp:   new Date().toISOString(),
      symbol:      it.symbol,
      instruction: it.instruction as 'BUY' | 'SELL',
      quantity:    it.quantity,
      orderType:   it.orderType,
      price:       it.price,
      orderId:     null,
      status:      'placed',
      rationale:   it.rationale,
      aiMode:      it.aiMode,
      accountHash,
      dryRun:      true,
    }));
    await savePaperTradeEntries(paperEntries);
    console.log(`[auto-execute] DRY-RUN ${accountHash.slice(0, 6)}: would have placed ${allowed.length} order(s).`);
    return {
      accountHash, mode: 'dry-run',
      considered: items.length, executed: 0, rejected,
      breakerTripped: false, breakerReason: '',
    };
  }

  // Live mode: real Schwab orders.
  if (!tokens) {
    return {
      accountHash, mode: 'auto',
      considered: items.length, executed: 0,
      rejected: [...rejected, ...allowed.map((it) => ({
        symbol: it.symbol, instruction: it.instruction, reason: 'No Schwab tokens',
      }))],
      breakerTripped: false, breakerReason: '',
    };
  }

  const reqs: OrderRequest[] = allowed.map((it) => ({
    symbol:      it.symbol,
    instruction: it.instruction as 'BUY' | 'SELL',
    quantity:    it.quantity,
    orderType:   it.orderType,
    price:       it.price,
  }));
  const hasSell = allowed.some((it) => it.instruction === 'SELL');
  const [results, costBasisMap] = await Promise.all([
    placeOrders(tokens, accountHash, reqs),
    hasSell ? fetchCostBasisMap(tokens, accountHash) : Promise.resolve({} as Record<string, number>),
  ]);

  const now = Date.now();
  const historyEntries: TradeHistoryEntry[] = results.map((r, i) => ({
    id:          `${now}-sig-${accountHash.slice(0, 4)}-${i}`,
    timestamp:   new Date().toISOString(),
    symbol:      r.symbol,
    instruction: allowed[i].instruction as 'BUY' | 'SELL',
    quantity:    allowed[i].quantity,
    orderType:   allowed[i].orderType,
    price:       allowed[i].price,
    orderId:     r.orderId,
    status:      r.status,
    message:     r.message,
    rationale:   allowed[i].rationale,
    aiMode:      'signal_engine_auto',
    costBasisPerShare: costBasisFor(allowed[i].instruction, r.symbol, costBasisMap),
    accountHash,
  }));
  await saveTradeHistoryEntries(historyEntries);

  // Mark each inbox item with the broker outcome.
  let executed = 0;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r.status === 'placed') {
      try {
        await markExecuted(allowed[i].id, { orderId: r.orderId, message: r.message });
        executed += 1;
      } catch (err) {
        console.warn(`[auto-execute] markExecuted failed for ${allowed[i].id}:`, err);
      }
    } else {
      const reason = r.message ?? 'Schwab rejected the order';
      try {
        await markFailed(allowed[i].id, reason, reason);
      } catch (err) {
        console.warn(`[auto-execute] markFailed write failed for ${allowed[i].id}:`, err);
      }
    }
  }

  const erroredSummaries = results
    .map((r, i) => ({ r, item: allowed[i] }))
    .filter(({ r }) => r.status !== 'placed')
    .map(({ r, item }) => ({
      symbol:      item.symbol,
      instruction: item.instruction,
      reason:      `Schwab error: ${r.message ?? 'unknown'} — item marked failed`,
    }));

  console.log(`[auto-execute] AUTO ${accountHash.slice(0, 6)}: placed ${executed}/${allowed.length}.`);
  return {
    accountHash, mode: 'auto',
    considered: items.length, executed,
    rejected: [...rejected, ...erroredSummaries],
    breakerTripped: false, breakerReason: '',
  };
}
