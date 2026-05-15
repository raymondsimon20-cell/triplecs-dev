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
import { getAccountNumbers } from '../schwab/client';
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
} from './auto-config';

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
}

interface PaperTrade extends TradeHistoryEntry {
  /** Marks this as a dry-run entry rather than a real placed order. */
  dryRun: true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function countTodaysExecutions(): Promise<{ count: number; dollars: number }> {
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
    const updated = [...entries, ...log].slice(0, 500);
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

/** Compares today's portfolio value against the most recent prior snapshot.
 *  If today's totalValue dropped more than `dailyLossPct`, trip the breaker
 *  (sticky pause until tomorrow) and return true. */
export async function checkCircuitBreaker(
  currentPortfolioValue: number,
  config: AutoConfig,
): Promise<{ tripped: boolean; reason: string }> {
  if (!Number.isFinite(currentPortfolioValue) || currentPortfolioValue <= 0) {
    return { tripped: false, reason: '' };
  }

  let priorValue: number | null = null;
  try {
    const store = getStore('snapshots');
    const log = await store.get('log', { type: 'json' }) as
      Array<{ savedAt: number; totalValue: number }> | null;
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
    await tripCircuitBreaker(reason);
    return { tripped: true, reason };
  }

  return { tripped: false, reason: '' };
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface AutoExecuteResult {
  mode:        'manual' | 'dry-run' | 'auto';
  considered:  number;
  executed:    number;
  rejected:    Array<{ symbol: string; instruction: string; reason: string }>;
  breakerTripped: boolean;
  breakerReason:  string;
  dryRun:      boolean;
}

/**
 * Main entry. Takes freshly-staged inbox items + portfolio value and:
 *   1. Loads auto-config. If 'manual' → no-op (returns considered=0).
 *   2. Checks circuit breaker. If tripped → no-op + flag.
 *   3. Applies caps. Allowed items proceed; rejected items stay in inbox.
 *   4. If 'dry-run' → write paper-trades, leave inbox items as 'pending'.
 *   5. If 'auto' → place orders, write trade-history, mark inbox 'executed'.
 */
export async function autoExecute(
  stagedItems: InboxItem[],
  portfolioValue: number,
): Promise<AutoExecuteResult> {
  const config = await loadAutoConfig();

  // Manual mode is the default and does nothing.
  if (config.mode === 'manual') {
    return {
      mode: 'manual',
      considered: 0, executed: 0, rejected: [],
      breakerTripped: false, breakerReason: '',
      dryRun: false,
    };
  }

  // If breaker is already paused for today, bail without further checks.
  if (!autoExecuteActive(config)) {
    return {
      mode: config.mode,
      considered: stagedItems.length, executed: 0, rejected: [],
      breakerTripped: true,
      breakerReason: config.circuitBreaker.pausedReason || 'Auto-execute paused for today',
      dryRun: config.mode === 'dry-run',
    };
  }

  // Live breaker check against the latest portfolio value.
  const breaker = await checkCircuitBreaker(portfolioValue, config);
  if (breaker.tripped) {
    return {
      mode: config.mode,
      considered: stagedItems.length, executed: 0, rejected: [],
      breakerTripped: true, breakerReason: breaker.reason,
      dryRun: config.mode === 'dry-run',
    };
  }

  // Apply caps.
  const todays = await countTodaysExecutions();
  // Filter inbox items to only equity BUY/SELL — auto-execute shouldn't touch
  // options or odd instructions. Stable-sort by priority is preserved (engine
  // already sorted by priority before staging).
  //
  // Phase 5 safety gate: when running in real-money 'auto' mode, only items
  // tagged `tier === 'auto'` are eligible for unattended execution. Items
  // missing a tier (legacy stage paths, third-party sources) default to
  // requiring approval — fail-closed. 'dry-run' is permissive so the user can
  // observe tier-2 behavior in paper trades before flipping anything live.
  const isAutoMode  = config.mode === 'auto';
  const tierGateRejected: Array<{ item: InboxItem; reason: string }> = [];
  const eligible = stagedItems.filter((it) => {
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
  const { allowed, rejected: capRejected } = applyCaps(eligible, config, portfolioValue, todays);
  const rejected = [...tierGateRejected, ...capRejected];

  const rejectedSummaries = rejected.map((r) => ({
    symbol:      r.item.symbol,
    instruction: r.item.instruction,
    reason:      r.reason,
  }));

  if (allowed.length === 0) {
    return {
      mode: config.mode,
      considered: stagedItems.length,
      executed: 0,
      rejected: rejectedSummaries,
      breakerTripped: false, breakerReason: '',
      dryRun: config.mode === 'dry-run',
    };
  }

  // Dry-run: write paper trades, leave inbox alone.
  if (!shouldHitSchwab(config)) {
    const now = Date.now();
    const paperEntries: PaperTrade[] = allowed.map((it, i) => ({
      id:          `${now}-paper-${i}`,
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
      dryRun:      true,
    }));
    await savePaperTradeEntries(paperEntries);
    console.log(`[auto-execute] DRY-RUN: would have placed ${allowed.length} order(s).`);
    return {
      mode: 'dry-run',
      considered: stagedItems.length,
      executed: 0,
      rejected: rejectedSummaries,
      breakerTripped: false, breakerReason: '',
      dryRun: true,
    };
  }

  // Live mode: real Schwab orders.
  const tokens = await getTokens();
  if (!tokens) {
    console.warn('[auto-execute] no Schwab tokens — cannot execute in auto mode');
    return {
      mode: 'auto',
      considered: stagedItems.length,
      executed: 0,
      rejected: [...rejectedSummaries, ...allowed.map((it) => ({
        symbol: it.symbol, instruction: it.instruction, reason: 'No Schwab tokens',
      }))],
      breakerTripped: false, breakerReason: '',
      dryRun: false,
    };
  }

  // Multi-account routing: group allowed items by their target accountHash.
  // Items without one fall through to the primary (first) account. Each
  // bucket gets its own placeOrders call and cost-basis fetch so SELLs land
  // against the account that actually holds the position.
  const accountNums = await getAccountNumbers(tokens);
  const primaryAccountHash = accountNums[0]?.hashValue;
  if (!primaryAccountHash) {
    return {
      mode: 'auto',
      considered: stagedItems.length,
      executed: 0,
      rejected: [...rejectedSummaries, ...allowed.map((it) => ({
        symbol: it.symbol, instruction: it.instruction, reason: 'No Schwab accounts available',
      }))],
      breakerTripped: false, breakerReason: '',
      dryRun: false,
    };
  }

  const allowedByAccount = new Map<string, InboxItem[]>();
  for (const it of allowed) {
    const hash = it.accountHash ?? primaryAccountHash;
    if (!allowedByAccount.has(hash)) allowedByAccount.set(hash, []);
    allowedByAccount.get(hash)!.push(it);
  }

  const { fetchCostBasisMap, costBasisFor } = await import('../schwab/cost-basis');

  // Per-account placement, but parallelized across accounts so total wall
  // time stays close to single-account latency.
  type PerAccountResult = {
    accountHash: string;
    items:       InboxItem[];
    results:     Awaited<ReturnType<typeof placeOrders>>;
    costBasisMap: Record<string, number>;
  };
  const perAccountResults: PerAccountResult[] = await Promise.all(
    Array.from(allowedByAccount.entries()).map(async ([hash, items]) => {
      const reqs: OrderRequest[] = items.map((it) => ({
        symbol:      it.symbol,
        instruction: it.instruction as 'BUY' | 'SELL',
        quantity:    it.quantity,
        orderType:   it.orderType,
        price:       it.price,
      }));
      const hasSell = items.some((it) => it.instruction === 'SELL');
      const [results, costBasisMap] = await Promise.all([
        placeOrders(tokens, hash, reqs),
        hasSell ? fetchCostBasisMap(tokens, hash) : Promise.resolve({} as Record<string, number>),
      ]);
      return { accountHash: hash, items, results, costBasisMap };
    }),
  );

  // Reassemble a flat results list aligned with the original `allowed` order
  // so downstream code (history entries, markExecuted/markFailed loops) keeps
  // working without re-keying.
  const itemIdToResult = new Map<string, { r: PerAccountResult['results'][number]; basis: number | undefined }>();
  for (const par of perAccountResults) {
    par.results.forEach((r, i) => {
      const item = par.items[i];
      itemIdToResult.set(item.id, {
        r,
        basis: costBasisFor(item.instruction, r.symbol, par.costBasisMap),
      });
    });
  }
  const results = allowed.map((it) => itemIdToResult.get(it.id)!.r);
  const basisForItem = (i: number) => itemIdToResult.get(allowed[i].id)?.basis;

  const now = Date.now();
  const historyEntries: TradeHistoryEntry[] = results.map((r, i) => ({
    id:          `${now}-sig-${i}`,
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
    costBasisPerShare: basisForItem(i),
  }));
  await saveTradeHistoryEntries(historyEntries);

  // Mark each inbox item with the broker outcome:
  //   - 'placed' → status 'executed', orderId attached
  //   - anything else → status 'failed', reason recorded. Failed items will
  //     not be re-attempted on the next cron — they need user intervention.
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
        console.warn(
          `[auto-execute] Schwab failed ${allowed[i].instruction} ${allowed[i].symbol}: ${reason}. ` +
          `Inbox item marked failed; no retry on next cron.`,
        );
      } catch (err) {
        console.warn(`[auto-execute] markFailed write failed for ${allowed[i].id}:`, err);
      }
    }
  }

  // Surface broker errors in the autoExecute summary so the digest can show them.
  const erroredSummaries = results
    .map((r, i) => ({ r, item: allowed[i] }))
    .filter(({ r }) => r.status !== 'placed')
    .map(({ r, item }) => ({
      symbol:      item.symbol,
      instruction: item.instruction,
      reason:      `Schwab error: ${r.message ?? 'unknown'} — item marked failed`,
    }));

  console.log(`[auto-execute] AUTO: placed ${executed}/${allowed.length} order(s).`);
  return {
    mode: 'auto',
    considered: stagedItems.length,
    executed,
    rejected: [...rejectedSummaries, ...erroredSummaries],
    breakerTripped: false, breakerReason: '',
    dryRun: false,
  };
}
