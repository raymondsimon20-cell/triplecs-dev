/**
 * Signal engine — shared run orchestration.
 *
 * The actual rule logic lives in `./engine.ts` (pure function, no I/O). This
 * module is the glue that fetches the inputs (Schwab portfolio + Yahoo SPY/VIX
 * + persisted state), invokes the engine, persists the updated state, stages
 * actionable trades into the inbox, and caches the result for the read-only
 * GET endpoint.
 *
 * Both the HTTP route (`app/api/signals/route.ts`) and the daily Netlify
 * scheduled function (`netlify/functions/daily-signal-engine.mts`) call
 * `runSignalsAndStage()` directly. No auth check inside — that's the caller's
 * responsibility (the HTTP route gates with `requireAuth()`, the scheduled
 * function runs in Netlify's privileged context).
 */

import { getStore } from '@netlify/blobs';

import { createClient, getAccountNumbers } from '../schwab/client';
import { getTokens }      from '../storage';
import { getDailyCloses } from '../prices/historical';
import { appendInbox, listInbox, pruneResolvedItems, type AppendInput, type InboxItem } from '../inbox';

import { loadSignalState, saveSignalState } from './state';
import {
  runSignalEngine,
  type EngineInputs,
  type EnginePosition,
  type EngineResult,
  type RecentSell,
  type TradeSignal,
} from './engine';
import { autoExecute, type AutoExecuteResult } from './auto-execute';
import { loadAutoConfig } from './auto-config';
import { buildDailyPlan, classifySignalTier } from './daily-plan';
import { archiveDailyPlan } from './plan-archive';
import { recordHeartbeat } from './cron-health';
import { runOptionScan } from './option-scan';
import { getFundMetadata } from '../data/fund-metadata';
import { getServerStrategyTargets } from '../strategy-store';
import { savePerAccountSnapshot, savePortfolioSnapshot } from '../storage';
import type { TradeHistoryEntry } from '@/app/api/orders/route';

const CACHE_STORE        = 'signal-engine-cache';
const CACHE_KEY          = 'latest';                  // household-combined result
const CACHE_ACCOUNT_PREFIX = 'latest:account:';        // per-account result

/** Tickers we always price even if not currently held so the engine can size
 *  buys / detect baseline weights for hedges and triples without an undefined. */
const ALWAYS_PRICE_TICKERS = [
  'CLM', 'CRF', 'QDTE', 'RDTE', 'IWMY', 'JEPI', 'JEPQ',
  'UPRO', 'TQQQ', 'SPXU', 'SQQQ',
];

// ─── Public types ────────────────────────────────────────────────────────────

export interface RunResult {
  result:   EngineResult;
  /** Inbox items that passed signal→order conversion. */
  proposed: number;
  /** Items that actually landed in the inbox after dedup. */
  staged:   number;
  /**
   * When `proposed > 0` and `staged === 0`, this is populated with the
   * reason — distinguishes silent dedup ('all-deduped') from a timeout
   * ('staging-timeout') from a thrown error ('staging-error'). Lets the
   * /api/signals response (and the cron log) make it obvious why staging
   * produced no rows. Pre-fix this was silent: 0 staged with no signal.
   */
  stagingFailureReason?: 'staging-timeout' | 'staging-error' | 'all-deduped';
  /** Free-form detail when stagingFailureReason is set. */
  stagingFailureDetail?: string;
  /** Auto-execute outcome — populated only when auto-config.mode !== 'manual'. */
  autoExecute?: AutoExecuteResult;
}

// ─── Cache helpers ───────────────────────────────────────────────────────────

export interface CachedRun {
  cachedAt: number;
  result:   EngineResult;
}

export async function saveCache(result: EngineResult): Promise<void> {
  await getStore(CACHE_STORE).setJSON(CACHE_KEY, {
    cachedAt: Date.now(),
    result,
  } satisfies CachedRun);
}

export async function loadCache(): Promise<CachedRun | null> {
  return getStore(CACHE_STORE).get(CACHE_KEY, { type: 'json' }) as Promise<CachedRun | null>;
}

/**
 * 2026-05 per-account cache. Stored alongside the legacy combined cache so
 * UI consumers that want a single account's view can fetch it directly
 * without splitting the combined result back apart.
 */
export async function savePerAccountCache(accountHash: string, result: EngineResult): Promise<void> {
  await getStore(CACHE_STORE).setJSON(`${CACHE_ACCOUNT_PREFIX}${accountHash}`, {
    cachedAt: Date.now(),
    result,
  } satisfies CachedRun);
}

export async function loadPerAccountCache(accountHash: string): Promise<CachedRun | null> {
  return getStore(CACHE_STORE).get(
    `${CACHE_ACCOUNT_PREFIX}${accountHash}`, { type: 'json' },
  ) as Promise<CachedRun | null>;
}

export async function loadAllPerAccountCaches(): Promise<Array<{ accountHash: string; cached: CachedRun }>> {
  const store = getStore(CACHE_STORE);
  try {
    const { blobs } = await store.list({ prefix: CACHE_ACCOUNT_PREFIX });
    const out: Array<{ accountHash: string; cached: CachedRun }> = [];
    await Promise.all(blobs.map(async (b) => {
      const cached = await store.get(b.key, { type: 'json' }) as CachedRun | null;
      if (!cached) return;
      out.push({
        accountHash: b.key.slice(CACHE_ACCOUNT_PREFIX.length),
        cached,
      });
    }));
    return out;
  } catch (err) {
    console.warn('[signals/run] loadAllPerAccountCaches failed:', err);
    return [];
  }
}

// ─── Market context ──────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Pull SPY history (last ~25 closes) and current VIX via the existing
 *  historical-prices helper. Defaults VIX to 20 if the fetch fails. */
async function fetchMarketContext(): Promise<{ spyHistory: number[]; vix: number; spyPrice: number }> {
  const today = new Date();
  const from  = isoDate(new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000));
  const to    = isoDate(today);

  const [spyMap, vixMap] = await Promise.all([
    getDailyCloses('SPY',  from, to).catch(() => new Map<string, number>()),
    getDailyCloses('^VIX', from, to).catch(() => new Map<string, number>()),
  ]);

  const spyHistory = Array.from(spyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
    .slice(-25);

  const vixCloses = Array.from(vixMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
  const vix = vixCloses[vixCloses.length - 1] ?? 20;

  return {
    spyHistory,
    vix,
    spyPrice: spyHistory[spyHistory.length - 1] ?? 0,
  };
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

/** Per-account slice the engine runs against. The engine sees one of these
 *  at a time so its rules (margin %, AFW gating, pillar drift, family caps)
 *  operate on the account's own balances rather than the household sum. */
export interface AccountPortfolio {
  accountHash: string;
  positions:   EnginePosition[];
  cash:        number;
  marginDebt:  number;
  /** AFW for THIS account — Schwab's `availableFunds`. */
  afwDollars:  number;
}

async function fetchAggregatedPortfolio(): Promise<{
  positions:  EnginePosition[];
  cash:       number;
  marginDebt: number;
  prices:     Record<string, number>;
  /**
   * AFW (Available For Withdrawal) — Schwab's margin-headroom metric, summed
   * across accounts. Sourced from `availableFunds` on the balances object.
   * Used by AFW_TRIGGER to gate deployments against the 50% Schwab ceiling.
   */
  afwDollars: number;
  /**
   * Live option positions across all accounts. Consumed by the daily put
   * autopilot scanner. We carry the raw shape (symbol/qty/price/marketValue)
   * here so the scanner doesn't need to re-fetch.
   */
  optionPositions: Array<{
    symbol:        string;
    shortQuantity: number;
    longQuantity:  number;
    averagePrice:  number;
    marketValue:   number;
    /** 2026-05: source account for per-account option-scan loop. */
    accountHash:   string;
  }>;
  /**
   * Per-account breakdown for the per-account engine loop (2026-05). Aggregate
   * fields above (`positions`, `cash`, etc.) remain for the household-level
   * computations (combined cache, digest). The accountBuckets slice the same
   * data so each account can be run independently with its own targets and
   * state.
   */
  accountBuckets: AccountPortfolio[];
}> {
  const tokens = await getTokens();
  if (!tokens) throw new Error('Schwab not connected');

  const client      = await createClient();
  const accountNums = await getAccountNumbers(tokens);
  if (accountNums.length === 0) throw new Error('No Schwab accounts');

  // Pair the wrapper with its hashValue so positions can be tagged with the
  // account they live in (needed for multi-account routing in auto-execute).
  const wrappers = await Promise.all(
    accountNums.map(async ({ hashValue }) => ({
      hashValue,
      wrapper: await client.getAccount(hashValue),
    })),
  );

  const positions: EnginePosition[] = [];
  const optionPositions: Array<{
    symbol:        string;
    shortQuantity: number;
    longQuantity:  number;
    averagePrice:  number;
    marketValue:   number;
    accountHash:   string;
  }> = [];
  const accountBuckets: AccountPortfolio[] = [];
  let cash       = 0;
  let marginDebt = 0;
  let afwDollars = 0;

  for (const { hashValue, wrapper } of wrappers) {
    const acct = wrapper.securitiesAccount;
    const acctCash       = acct.currentBalances.cashBalance     ?? 0;
    const acctMarginDebt = Math.abs(acct.currentBalances.marginBalance ?? 0);
    // AFW: sum availableFunds across accounts. This is what Schwab reports as
    // your true buying-power-after-maintenance headroom — exactly the Vol-7
    // AFW metric, sourced directly from the broker (not derived).
    const acctAfw        = acct.currentBalances.availableFunds  ?? 0;

    cash       += acctCash;
    marginDebt += acctMarginDebt;
    afwDollars += acctAfw;

    const acctPositions: EnginePosition[] = [];
    for (const p of acct.positions ?? []) {
      // Capture option positions for the daily put autopilot scanner (close
      // at gain / roll near expiry / propose new). Equity engine ignores
      // these via the assetType filter below.
      if (p.instrument.assetType === 'OPTION') {
        optionPositions.push({
          symbol:        p.instrument.symbol,
          shortQuantity: p.shortQuantity ?? 0,
          longQuantity:  p.longQuantity ?? 0,
          averagePrice:  p.averagePrice ?? p.averageLongPrice ?? 0,
          marketValue:   p.marketValue ?? 0,
          // 2026-05: capture the option's account so the per-account
          // option-scan loop knows where each contract lives.
          accountHash:   hashValue,
        });
        continue;
      }
      if (p.instrument.symbol.includes(' ')) continue;
      if (p.longQuantity <= 0) continue;
      const meta = getFundMetadata(p.instrument.symbol);
      const pos: EnginePosition = {
        symbol:      p.instrument.symbol,
        shares:      p.longQuantity,
        marketValue: p.marketValue ?? 0,
        accountHash: hashValue,
        ...(meta
          ? {
              pillar:               meta.pillar,
              family:               meta.family,
              maintenancePct:       meta.maintenancePct,
              maintenancePctSource: meta.maintenancePctSource,
            }
          : {}),
      };
      positions.push(pos);
      acctPositions.push(pos);
    }
    accountBuckets.push({
      accountHash: hashValue,
      positions:   acctPositions,
      cash:        acctCash,
      marginDebt:  acctMarginDebt,
      afwDollars:  acctAfw,
    });
  }

  const tickers = Array.from(new Set([
    ...positions.map((p) => p.symbol),
    ...ALWAYS_PRICE_TICKERS,
  ]));
  const prices: Record<string, number> = {};
  if (tickers.length > 0) {
    const quotes = await client.getQuotes(tickers);
    for (const [sym, q] of Object.entries(quotes)) {
      const price = q.quote?.lastPrice ?? q.quote?.mark;
      if (price && Number.isFinite(price)) prices[sym] = price;
    }
    // Surface any tickers Schwab failed to quote so the cron's "ok — n
    // signals" log makes it obvious which symbols were skipped. Previously
    // missing quotes were swallowed with console.warn and silently dropped
    // from the staging pipeline. Held positions missing a quote is the most
    // concerning case — log loudly so the user can investigate next morning.
    const { missingQuoteSymbols } = await import('../schwab/client');
    const missing = missingQuoteSymbols(quotes);
    const heldMissing = missing.filter((s) => positions.some((p) => p.symbol === s));
    if (heldMissing.length > 0) {
      console.error(`[signals/run] Held positions missing quotes — will be skipped from staging: ${heldMissing.join(', ')}`);
    }
    if (missing.length > heldMissing.length) {
      const probe = missing.filter((s) => !heldMissing.includes(s));
      console.warn(`[signals/run] Non-held tickers missing quotes (engine baselines): ${probe.join(', ')}`);
    }
  }

  return { positions, cash, marginDebt, prices, afwDollars, optionPositions, accountBuckets };
}

// ─── Phase 2 inputs ──────────────────────────────────────────────────────────

/**
 * Load recent SELLs from trade-history for wash-sale defensive filtering.
 *
 * `isLoss` is now computed honestly from cost-basis-per-share captured at
 * sale time (see lib/schwab/cost-basis.ts). When cost basis is unavailable
 * (older entries written before that capture, missing position record),
 * we fall back to the conservative `isLoss: true` so the engine errs on
 * the safe side of the wash-sale rule.
 *
 * The IRS wash-sale window is 30 calendar days, not trading days.
 */
export async function loadRecentSells(windowDays = 30): Promise<RecentSell[]> {
  try {
    const log = (await getStore('trade-history').get('log', { type: 'json' })) as
      | TradeHistoryEntry[]
      | null;
    if (!Array.isArray(log)) return [];
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const out: RecentSell[] = [];
    for (const e of log) {
      if (!e.timestamp || !e.symbol) continue;
      if (e.status !== 'placed') continue;
      if (e.instruction !== 'SELL' && e.instruction !== 'SELL_TO_CLOSE') continue;
      const t = Date.parse(e.timestamp);
      if (!Number.isFinite(t) || t < cutoff) continue;
      // Compute isLoss from captured cost basis when available. The wash-sale
      // rule blocks BUYs of substantially-identical securities sold AT A LOSS,
      // so a sell at a gain is fine to re-buy.
      let isLoss = true; // safe default when basis unknown
      if (
        typeof e.costBasisPerShare === 'number' && e.costBasisPerShare > 0 &&
        typeof e.price             === 'number' && e.price             > 0
      ) {
        isLoss = e.price < e.costBasisPerShare;
      }
      out.push({
        symbol:   e.symbol.toUpperCase(),
        soldDate: e.timestamp,
        isLoss,
      });
    }
    return out;
  } catch (err) {
    console.warn('[signals/run] loadRecentSells failed:', err);
    return [];
  }
}

// ─── Signal → inbox mapper ───────────────────────────────────────────────────

/** Convert engine signals into inbox AppendInputs for a SINGLE account.
 *
 *  Multi-account routing (2026-05 per-account engine):
 *   - Both BUYs and SELLs are tagged with the running account's hash. The
 *     engine itself is now scoped to one account at a time, so every signal
 *     it emits belongs to that account by construction.
 *   - Sells that target a symbol held in *another* account would normally
 *     never appear here (the engine's `positions` input is the account's own
 *     holdings) — defense-in-depth: we still cross-check against
 *     `positionAccount` and skip mismatches to avoid mis-routed orders.
 */
function signalsToInbox(
  signals: TradeSignal[],
  prices: Record<string, number>,
  positions: EnginePosition[],
  accountHash: string,
): AppendInput[] {
  const positionAccount = new Map<string, string>();
  const positionShares  = new Map<string, number>();
  for (const p of positions) {
    if (p.accountHash) positionAccount.set(p.symbol, p.accountHash);
    // Aggregate share count per symbol — used to enforce the "always keep
    // at least one share" rule on SELL signals (see below).
    positionShares.set(p.symbol, (positionShares.get(p.symbol) ?? 0) + p.shares);
  }

  const out: AppendInput[] = [];
  for (const s of signals) {
    if (s.direction !== 'BUY' && s.direction !== 'SELL') continue;
    if (!/^[A-Z]{1,5}$/.test(s.ticker)) continue;
    if (s.sizeDollars <= 0) continue;

    const price = prices[s.ticker];
    if (!price || price <= 0) continue;

    let shares = Math.floor(s.sizeDollars / price);
    if (shares <= 0) continue;

    // Cross-check: a SELL must be for a symbol THIS account actually holds.
    // The engine's per-account input already enforces this, but the check is
    // cheap and prevents mis-routing if a future engine change ever returns
    // a SELL for a symbol not in `positions`.
    if (s.direction === 'SELL') {
      const owner = positionAccount.get(s.ticker);
      if (owner && owner !== accountHash) continue;

      // Always-keep-one-share rule. Never stage a SELL that would close the
      // entire position — cap at currentShares - 1, and drop the signal
      // outright when the account only holds a single share (can't sell
      // anything without violating the rule).
      const currentShares = positionShares.get(s.ticker) ?? 0;
      if (currentShares < 2) continue;
      if (shares >= currentShares) shares = currentShares - 1;
    }

    out.push({
      source:      'signal-engine',
      symbol:      s.ticker,
      instruction: s.direction,
      quantity:    shares,
      orderType:   'MARKET',
      price,
      pillar:      undefined,
      rationale:   `[${s.rule}] ${s.reason}`,
      aiMode:      'signal_engine',
      violations:  [],
      // Tag the tier at stage time so auto-execute can filter to tier 1 only
      // when running unattended. Without this, mode=auto would fire tier-2
      // items too (the safety gap that motivated this).
      tier:        classifySignalTier(s),
      accountHash,
    });
  }
  return out;
}

// ─── Engine combine ──────────────────────────────────────────────────────────

/**
 * Roll up per-account EngineResults into one household-level EngineResult.
 * Used for:
 *   • The legacy single-cache write (`saveCache(result)`), so existing
 *     consumers (`/api/signals` GET, `/api/signals/daily-plan` GET) keep
 *     working unchanged.
 *   • The combined daily plan that backs the digest + plan archive.
 *
 * Combine rules:
 *   - generatedAt: latest of the inputs (they're typically within ms).
 *   - marketSnapshot: identical across accounts (one market) — pick first.
 *   - valuation: sum the dollar fields; recompute equityRatio and weightPcts
 *     against the combined totalValue so household weights sum to 100%.
 *   - signals / actionableTrades / alerts / info: concat in input order.
 *   - inDefenseMode / killSwitchActive: OR across accounts.
 *   - nextState: synthesise — the combined result's state isn't persisted
 *     (each account's state is already saved per-account). Use the first
 *     account's state as a representative value.
 */
function combineEngineResults(results: EngineResult[]): EngineResult {
  if (results.length === 0) {
    throw new Error('combineEngineResults: no per-account results');
  }
  if (results.length === 1) return results[0];

  const sum = (pick: (r: EngineResult) => number) => results.reduce((s, r) => s + pick(r), 0);

  const holdingsValue = sum((r) => r.valuation.holdingsValue);
  const cash          = sum((r) => r.valuation.cash);
  const marginDebt    = sum((r) => r.valuation.marginDebt);
  const totalValue    = sum((r) => r.valuation.totalValue);
  const equityValue   = sum((r) => r.valuation.equityValue);
  const equityRatio   = totalValue > 0 ? equityValue / totalValue : 1;

  // Rebuild weight pcts: per-account weight% × that account's totalValue → $,
  // sum per symbol, then divide by combined totalValue.
  const dollarsBySymbol: Record<string, number> = {};
  for (const r of results) {
    const acctTotal = r.valuation.totalValue;
    for (const [sym, pct] of Object.entries(r.valuation.weightPcts)) {
      dollarsBySymbol[sym] = (dollarsBySymbol[sym] ?? 0) + (pct / 100) * acctTotal;
    }
  }
  const weightPcts: Record<string, number> = {};
  if (totalValue > 0) {
    for (const [sym, $$] of Object.entries(dollarsBySymbol)) {
      weightPcts[sym] = ($$ / totalValue) * 100;
    }
  }

  const generatedAt = results.map((r) => r.generatedAt).sort().slice(-1)[0]!;

  return {
    generatedAt,
    marketSnapshot:   results[0].marketSnapshot,
    valuation: {
      holdingsValue, cash, marginDebt, totalValue, equityValue, equityRatio, weightPcts,
    },
    signals:          results.flatMap((r) => r.signals),
    actionableTrades: results.flatMap((r) => r.actionableTrades),
    alerts:           results.flatMap((r) => r.alerts),
    info:             results.flatMap((r) => r.info),
    inDefenseMode:    results.some((r) => r.inDefenseMode),
    killSwitchActive: results.some((r) => r.killSwitchActive),
    // Representative only — not persisted. Each account's state was already
    // saved to its own slot by the per-account loop.
    nextState:        results[0].nextState,
  };
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Fetch, run, persist, stage, cache — in that order. Throws on hard failures
 * (no Schwab connection, no accounts); inbox staging errors are swallowed and
 * logged because the result itself is still useful even if staging hiccupped.
 */
export async function runSignalsAndStage(): Promise<RunResult> {
  const runStartedAt = Date.now();
  try {
    return await runSignalsAndStageInner(runStartedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Record a failed heartbeat so /api/signals/health surfaces the failure
    // rather than reporting "no heartbeat" forever. Don't await alert sending
    // here — the throw needs to propagate to the caller (HTTP route / cron).
    void recordHeartbeat({
      ranAt:       runStartedAt,
      durationMs:  Date.now() - runStartedAt,
      status:      'error',
      signalCount: 0,
      actionable:  0,
      error:       msg,
    }).catch(() => undefined);
    throw err;
  }
}

async function runSignalsAndStageInner(runStartedAt: number): Promise<RunResult> {
  // 2026-05: per-account autopilot. The engine now runs once per Schwab
  // account, scoped to that account's own positions, cash, margin debt,
  // AFW, signal-engine state, and strategy targets (override → global).
  //
  // Shared inputs (one fetch, used across all accounts):
  //   • market context (SPY history + VIX) — household-level
  //   • wash-sale recent sells — IRS rule is household-wide
  //
  // Per-account inputs (fetched in parallel):
  //   • signal state (loadSignalState(accountHash))
  //   • strategy targets (getServerStrategyTargets(accountHash) → override
  //     → global → DEFAULT_TARGETS)
  const [portfolio, market, recentSells30d] = await Promise.all([
    fetchAggregatedPortfolio(),
    fetchMarketContext(),
    loadRecentSells(30),
  ]);

  if (market.spyPrice > 0) portfolio.prices['SPY'] = market.spyPrice;

  // Per-account engine loop. We run them in parallel so total wall time
  // stays close to a single-account run; the engine itself is pure-function
  // so concurrency is safe.
  type PerAccountRun = {
    accountHash: string;
    portfolio:   AccountPortfolio;
    result:      EngineResult;
    /** Staged inputs ready to append to the inbox. */
    stageInputs: AppendInput[];
  };

  const perAccount: PerAccountRun[] = await Promise.all(
    portfolio.accountBuckets.map(async (bucket) => {
      const [state, strategy] = await Promise.all([
        loadSignalState(bucket.accountHash),
        getServerStrategyTargets(bucket.accountHash),
      ]);

      const inputs: EngineInputs = {
        positions:  bucket.positions,
        cash:       bucket.cash,
        marginDebt: bucket.marginDebt,
        prices:     portfolio.prices,
        spyHistory: market.spyHistory,
        vix:        market.vix,
        state,
        // Per-account targets — Phase 2 rules (MAINTENANCE_RANKED_TRIM,
        // PILLAR_FILL) now drift / size against this account's allocation,
        // not the household sum.
        pillarTargets: {
          triplesPct:     strategy.triplesPct,
          cornerstonePct: strategy.cornerstonePct,
          incomePct:      strategy.incomePct,
          hedgePct:       strategy.hedgePct,
        },
        marginThresholds: {
          trimAbovePct:     strategy.marginLimitPct,
          trimTargetPct:    strategy.marginTrimTargetPct,
          newBuyCeilingPct: strategy.marginNewBuyCeilingPct,
        },
        recentSells30d,
        // Buying power scoped to this account. Cash floor protects against
        // negative AFW edge cases.
        buyingPowerAvailable: bucket.afwDollars > 0
          ? bucket.afwDollars
          : Math.max(0, bucket.cash),
        afwDollars: bucket.afwDollars > 0 ? bucket.afwDollars : undefined,
      };

      const result = runSignalEngine(inputs);

      // Persist THIS account's updated state to its own slot. Defense mode
      // / kill switch flip per-account from here on.
      await saveSignalState(result.nextState, bucket.accountHash);

      // 2026-05 — capture a per-account snapshot from the engine's run so
      // the circuit breaker has a recent prior value to compare against on
      // the next intraday run, even when the user never opens the dashboard
      // (which would otherwise be the only path that writes snapshots).
      // Fire-and-forget; storage failures don't poison the engine result.
      savePerAccountSnapshot(bucket.accountHash, {
        savedAt:    Date.now(),
        totalValue: result.valuation.totalValue,
        equity:     result.valuation.equityValue,
        marginBalance:        result.valuation.marginDebt,
        marginUtilizationPct: result.valuation.totalValue > 0
          ? (result.valuation.marginDebt / result.valuation.totalValue) * 100
          : 0,
        afwDollars: bucket.afwDollars,
        pillarSummary: [],   // engine result doesn't track pillarSummary
                             // in this shape; the /api/accounts path still
                             // writes the richer snapshot when the user
                             // loads the dashboard.
        positions:  bucket.positions.map((p) => ({
          symbol:       p.symbol,
          pillar:       p.pillar ?? 'other',
          marketValue:  p.marketValue,
          shares:       p.shares,
          unrealizedGL: 0,   // not tracked by EnginePosition
          ...(p.family            !== undefined ? { family:            p.family            } : {}),
          ...(p.maintenancePct    !== undefined ? { maintenancePct:    p.maintenancePct    } : {}),
          ...(p.maintenancePctSource           ? { maintenancePctSource: p.maintenancePctSource } : {}),
        })),
      }).catch((e) => console.warn(`[signals/run] per-account snapshot save failed for ${bucket.accountHash}:`, e));

      // Stage signals tagged with this account's hash (both BUY and SELL).
      const stageInputs = signalsToInbox(
        result.actionableTrades,
        portfolio.prices,
        bucket.positions,
        bucket.accountHash,
      );

      return { accountHash: bucket.accountHash, portfolio: bucket, result, stageInputs };
    }),
  );

  // Combined household-level result, used for the legacy single cache + the
  // digest. Each account's state was already saved by the loop above.
  const result = combineEngineResults(perAccount.map((r) => r.result));

  // One append to the inbox for the whole household so staging is atomic and
  // the cross-source dedup window sees all proposals in one shot.
  const stageInputs = perAccount.flatMap((r) => r.stageInputs);
  let staged = 0;
  let freshItems: InboxItem[] = [];
  let stagingFailureReason: RunResult['stagingFailureReason'];
  let stagingFailureDetail: string | undefined;
  if (stageInputs.length > 0) {
    // Bumped to 15s in 2026-05. The previous 5s was tight for the locked
    // appendInbox path (acquire + verify + readAll + writeAll over Netlify
    // Blobs ≈ 4-8 round trips; a cold start could blow past 5s and silently
    // drop every signal that day).
    const STAGING_TIMEOUT_MS = 15_000;
    try {
      const persisted = await Promise.race([
        appendInbox(stageInputs),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('staging timeout')), STAGING_TIMEOUT_MS),
        ),
      ]);
      if (Array.isArray(persisted)) {
        freshItems = persisted;
        staged     = persisted.length;
        if (staged === 0) {
          stagingFailureReason = 'all-deduped';
          stagingFailureDetail = `appendInbox returned 0 items — all ${stageInputs.length} inputs were dropped by same-source or cross-source dedup. Check console for "[inbox] cross-source dedup" entries.`;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stagingFailureReason = msg.includes('timeout') ? 'staging-timeout' : 'staging-error';
      stagingFailureDetail = msg;
      console.warn('[signals/run] inbox staging failed:', msg);
    }
  }

  // Auto-execute pass — no-op in 'manual' mode. In 'dry-run' it writes paper
  // trades; in 'auto' it places real Schwab orders. Always non-fatal — a
  // failure here doesn't poison the rest of the result.
  //
  // 2026-07 fix: the batch is freshItems PLUS any still-pending tier-'auto'
  // signal-engine items that match a signal the engine re-emitted today but
  // that same-source dedup dropped. Previously autoExecute only ever saw
  // freshly-staged items, so when yesterday's identical item was still
  // pending at staging time (24h TTL vs 24h cron cadence — a seconds-level
  // boundary race), the new signal deduped to nothing and NO execution
  // happened that day. The pending item then expired, the day after restaged
  // fresh, and only then executed — a consistent one-day slip unless the
  // user approved manually. Re-emission today is the retry signal: the
  // engine still wants this trade, so the pending copy is fair game.
  let autoBatch = freshItems;
  if (stageInputs.length > freshItems.length) {
    try {
      const wanted = new Set(stageInputs.map((s) =>
        `${s.symbol}|${s.instruction}|${s.accountHash ?? ''}`));
      const freshIds = new Set(freshItems.map((it) => it.id));
      const pending = await listInbox({ status: 'pending', source: 'signal-engine' });
      const dedupedPending = pending.filter((it) =>
        !freshIds.has(it.id) &&
        it.tier === 'auto' &&
        wanted.has(`${it.symbol}|${it.instruction}|${it.accountHash ?? ''}`),
      );
      if (dedupedPending.length > 0) {
        console.log(
          `[signals/run] picking up ${dedupedPending.length} deduped-but-still-wanted ` +
          `pending item(s) for auto-execute: ` +
          dedupedPending.map((it) => `${it.instruction} ${it.symbol}`).join(', '),
        );
        autoBatch = [...freshItems, ...dedupedPending];
      }
    } catch (err) {
      console.warn('[signals/run] deduped-pending pickup failed:', err);
    }
  }
  let autoExecuteResult: AutoExecuteResult | undefined;
  if (autoBatch.length > 0) {
    try {
      // Per-account totals let autoExecute's per-account caps + circuit
      // breaker work against THAT account's value, not the household pool.
      const perAccountValues = new Map<string, number>(
        perAccount.map((pa) => [pa.accountHash, pa.result.valuation.totalValue]),
      );
      autoExecuteResult = await autoExecute(
        autoBatch,
        result.valuation.totalValue,
        perAccountValues,
      );
    } catch (err) {
      console.warn('[signals/run] auto-execute failed:', err);
    }
  }

  // Cache writes: legacy combined cache for backward-compat consumers
  // (`/api/signals` GET, `/api/signals/daily-plan` GET), plus per-account
  // caches so UI consumers can fetch a single account's view directly.
  await Promise.all([
    saveCache(result),
    ...perAccount.map((pa) => savePerAccountCache(pa.accountHash, pa.result)),
  ]);

  // Household-level snapshot for the legacy `latest` blob and household
  // performance chart. Cron-side write so the snapshot history isn't held
  // hostage by whether the dashboard happens to be open.
  savePortfolioSnapshot({
    savedAt:    Date.now(),
    totalValue: result.valuation.totalValue,
    equity:     result.valuation.equityValue,
    marginBalance:        result.valuation.marginDebt,
    marginUtilizationPct: result.valuation.totalValue > 0
      ? (result.valuation.marginDebt / result.valuation.totalValue) * 100
      : 0,
    afwDollars: portfolio.afwDollars,
    pillarSummary: [],
    positions: portfolio.positions.map((p) => ({
      symbol:       p.symbol,
      pillar:       p.pillar ?? 'other',
      marketValue:  p.marketValue,
      shares:       p.shares,
      unrealizedGL: 0,
      ...(p.family            !== undefined ? { family:            p.family            } : {}),
      ...(p.maintenancePct    !== undefined ? { maintenancePct:    p.maintenancePct    } : {}),
      ...(p.maintenancePctSource           ? { maintenancePctSource: p.maintenancePctSource } : {}),
    })),
  }).catch((e) => console.warn('[signals/run] household snapshot save failed:', e));

  // ─── Daily put autopilot scan ────────────────────────────────────────────
  // 2026-05 per-account: run the scan ONCE per account so proposals can be
  // staged with that account's hash. Each account passes its own option
  // positions + equity positions + totalValue + AFW; the scan's gating
  // logic (Triples exposure, AFW headroom) is now per-account.
  // All proposals stage as tier 'approval' regardless — options never
  // auto-execute.
  try {
    const tokens = await getTokens();
    if (tokens && portfolio.optionPositions.length > 0) {
      let totalStaged = 0;
      await Promise.all(perAccount.map(async (pa) => {
        const acctOptions = portfolio.optionPositions.filter((p) => p.accountHash === pa.accountHash);
        if (acctOptions.length === 0) return;
        try {
          const scan = await runOptionScan(
            tokens,
            acctOptions,
            pa.portfolio.positions,
            portfolio.prices,
            pa.result.valuation.totalValue,
            pa.portfolio.afwDollars > 0 ? pa.portfolio.afwDollars : undefined,
          );
          const allOptionProposals = [
            ...scan.closeProposals,
            ...scan.rollProposals,
            ...scan.protectProposals,
            ...scan.incomeProposals,
          ].map((p) => ({ ...p, accountHash: pa.accountHash }));
          if (allOptionProposals.length > 0) {
            try {
              await Promise.race([
                appendInbox(allOptionProposals),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('option staging timeout')), 5000),
                ),
              ]);
              totalStaged += allOptionProposals.length;
              console.log(
                `[option-scan ${pa.accountHash.slice(0, 6)}…] staged ${scan.closeProposals.length} close, ` +
                `${scan.rollProposals.length} roll, ${scan.protectProposals.length} protect, ` +
                `${scan.incomeProposals.length} income proposals`,
              );
            } catch (err) {
              console.warn(`[option-scan ${pa.accountHash.slice(0, 6)}…] inbox staging failed:`, err);
            }
          }
          if (scan.skipped.length > 0) {
            console.log(`[option-scan ${pa.accountHash.slice(0, 6)}…] skipped ${scan.skipped.length}:`,
              scan.skipped.map((s) => `${s.underlying}: ${s.reason}`).join('; '));
          }
        } catch (err) {
          console.warn(`[option-scan ${pa.accountHash.slice(0, 6)}…] scan failed:`, err);
        }
      }));
      if (totalStaged > 0) console.log(`[option-scan] total staged across accounts: ${totalStaged}`);
    }
  } catch (err) {
    console.warn('[option-scan] scan failed:', err);
  }

  // Inbox housekeeping — drop resolved items older than 60 days so the audit
  // trail doesn't accumulate forever. Pending items are never touched here.
  void pruneResolvedItems(60).catch(() => undefined);

  // Heartbeat: record before the digest/archive so a slow notification
  // doesn't widen the perceived run duration. Best-effort — failures don't
  // break the run.
  void recordHeartbeat({
    ranAt:       runStartedAt,
    durationMs:  Date.now() - runStartedAt,
    status:      'success',
    signalCount: result.signals.length,
    actionable:  result.actionableTrades.length,
  }).catch(() => undefined);

  // Fire-and-forget daily digest. Never fails the run — notification failures
  // are logged and swallowed so a missing API key or network blip doesn't
  // poison auto-execute. Only sends when there's something actionable
  // (tier-2 pending, executed trades, or breaker tripped).
  try {
    const [inbox, autoConfig] = await Promise.all([
      listInbox({ status: 'pending' }),
      loadAutoConfig(),
    ]);
    const plan = buildDailyPlan(result, inbox, autoConfig);
    // Archive every run so the user can review history later. Writes BOTH
    // the household combined plan AND a per-account plan for each account
    // that ran this cycle, so per-account "what did the engine suggest
    // last Tuesday" recall works.
    try { await archiveDailyPlan(plan); }
    catch (err) { console.warn('[signals/run] plan archive failed:', err); }
    await Promise.all(perAccount.map(async (pa) => {
      try {
        const acctAutoConfig = await loadAutoConfig(pa.accountHash);
        const acctInbox      = inbox.filter((it) => !it.accountHash || it.accountHash === pa.accountHash);
        const acctPlan       = buildDailyPlan(pa.result, acctInbox, acctAutoConfig);
        await archiveDailyPlan(acctPlan, pa.accountHash);
      } catch (err) {
        console.warn(`[signals/run] per-account plan archive failed for ${pa.accountHash}:`, err);
      }
    }));

    // Email send is intentionally NOT here as of 2026-05. The after-close
    // signal engine just stages signals and archives the plan; the
    // daily-rebalance cron (15 min later) is the single consolidation point
    // that reads this archived plan + the morning alerts + its own drift
    // result and sends one combined email. See netlify/functions/daily-rebalance.mts.
  } catch (err) {
    console.warn('[signals/run] post-run bookkeeping failed:', err);
  }

  return {
    result,
    proposed: stageInputs.length,
    staged,
    stagingFailureReason,
    stagingFailureDetail,
    autoExecute: autoExecuteResult,
  };
}
