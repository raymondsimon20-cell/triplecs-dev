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
import { appendInbox, listInbox, type AppendInput, type InboxItem } from '../inbox';

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
import { buildDigest, shouldSend } from './daily-digest';
import { archiveDailyPlan } from './plan-archive';
import { sendNotification } from '../notifications';
import { getFundMetadata } from '../data/fund-metadata';
import { getServerStrategyTargets } from '../strategy-store';
import type { TradeHistoryEntry } from '@/app/api/orders/route';

const CACHE_STORE = 'signal-engine-cache';
const CACHE_KEY   = 'latest';

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

async function fetchAggregatedPortfolio(): Promise<{
  positions:  EnginePosition[];
  cash:       number;
  marginDebt: number;
  prices:     Record<string, number>;
}> {
  const tokens = await getTokens();
  if (!tokens) throw new Error('Schwab not connected');

  const client      = await createClient();
  const accountNums = await getAccountNumbers(tokens);
  if (accountNums.length === 0) throw new Error('No Schwab accounts');

  const wrappers = await Promise.all(
    accountNums.map(({ hashValue }) => client.getAccount(hashValue)),
  );

  const positions: EnginePosition[] = [];
  let cash       = 0;
  let marginDebt = 0;

  for (const w of wrappers) {
    const acct = w.securitiesAccount;
    cash       += acct.currentBalances.cashBalance ?? 0;
    marginDebt += Math.abs(acct.currentBalances.marginBalance ?? 0);

    for (const p of acct.positions ?? []) {
      // Skip options (handled by option-plan, not the signal engine). Schwab
      // classifies CEFs/ETFs (CLM, CRF, JEPI, QDTE, etc.) as COLLECTIVE_INVESTMENT
      // or MUTUAL_FUND — not EQUITY — so filter by NOT-an-option rather than IS-equity.
      if (p.instrument.assetType === 'OPTION') continue;
      if (p.instrument.symbol.includes(' ')) continue;
      if (p.longQuantity <= 0) continue;
      const meta = getFundMetadata(p.instrument.symbol);
      positions.push({
        symbol:      p.instrument.symbol,
        shares:      p.longQuantity,
        marketValue: p.marketValue ?? 0,
        ...(meta
          ? {
              pillar:               meta.pillar,
              family:               meta.family,
              maintenancePct:       meta.maintenancePct,
              maintenancePctSource: meta.maintenancePctSource,
            }
          : {}),
      });
    }
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
  }

  return { positions, cash, marginDebt, prices };
}

// ─── Phase 2 inputs ──────────────────────────────────────────────────────────

/**
 * Load recent SELLs from trade-history for wash-sale defensive filtering.
 *
 * We can't reliably determine "sold at a loss" from TradeHistoryEntry alone
 * (cost basis isn't there). Conservative choice: flag every recent sell as
 * `isLoss: true` so PILLAR_FILL avoids re-proposing it. The authoritative
 * wash-sale check still happens in `lib/guardrails.ts` at stage time with
 * better data.
 */
async function loadRecentSells(windowDays = 30): Promise<RecentSell[]> {
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
      out.push({
        symbol:   e.symbol.toUpperCase(),
        soldDate: e.timestamp,
        isLoss:   true,  // conservative: treat all as potential wash-sale exposure
      });
    }
    return out;
  } catch (err) {
    console.warn('[signals/run] loadRecentSells failed:', err);
    return [];
  }
}

// ─── Signal → inbox mapper ───────────────────────────────────────────────────

/** Convert engine signals into inbox AppendInputs. Skips composite-ticker and
 *  zero-sized signals; computes shares from sizeDollars × current price. */
function signalsToInbox(
  signals: TradeSignal[],
  prices: Record<string, number>,
): AppendInput[] {
  const out: AppendInput[] = [];
  for (const s of signals) {
    if (s.direction !== 'BUY' && s.direction !== 'SELL') continue;
    if (!/^[A-Z]{1,5}$/.test(s.ticker)) continue;
    if (s.sizeDollars <= 0) continue;

    const price = prices[s.ticker];
    if (!price || price <= 0) continue;

    const shares = Math.floor(s.sizeDollars / price);
    if (shares <= 0) continue;

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
    });
  }
  return out;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Fetch, run, persist, stage, cache — in that order. Throws on hard failures
 * (no Schwab connection, no accounts); inbox staging errors are swallowed and
 * logged because the result itself is still useful even if staging hiccupped.
 */
export async function runSignalsAndStage(): Promise<RunResult> {
  const [portfolio, market, state, strategy, recentSells30d] = await Promise.all([
    fetchAggregatedPortfolio(),
    fetchMarketContext(),
    loadSignalState(),
    getServerStrategyTargets(),
    loadRecentSells(30),
  ]);

  if (market.spyPrice > 0) portfolio.prices['SPY'] = market.spyPrice;

  const inputs: EngineInputs = {
    positions:  portfolio.positions,
    cash:       portfolio.cash,
    marginDebt: portfolio.marginDebt,
    prices:     portfolio.prices,
    spyHistory: market.spyHistory,
    vix:        market.vix,
    state,
    // Phase 2 — server-side strategy targets + recent sells unlock
    // MAINTENANCE_RANKED_TRIM and PILLAR_FILL.
    pillarTargets: {
      triplesPct:     strategy.triplesPct,
      cornerstonePct: strategy.cornerstonePct,
      incomePct:      strategy.incomePct,
      hedgePct:       strategy.hedgePct,
    },
    recentSells30d,
    buyingPowerAvailable: Math.max(0, portfolio.cash),
  };

  const result = runSignalEngine(inputs);

  // Persist updated state — this is what flips defenseMode / killSwitch flags
  // for the other endpoints to consult via getAutomationGate().
  await saveSignalState(result.nextState);

  // Stage actionable trades with a hard timeout so a slow inbox doesn't hang
  // the whole run. Staging failures are non-fatal.
  const stageInputs = signalsToInbox(result.actionableTrades, portfolio.prices);
  let staged = 0;
  let freshItems: InboxItem[] = [];
  if (stageInputs.length > 0) {
    try {
      const persisted = await Promise.race([
        appendInbox(stageInputs),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('staging timeout')), 5000),
        ),
      ]);
      if (Array.isArray(persisted)) {
        freshItems = persisted;
        staged     = persisted.length;
      }
    } catch (err) {
      console.warn('[signals/run] inbox staging failed:', err);
    }
  }

  // Auto-execute pass — no-op in 'manual' mode. In 'dry-run' it writes paper
  // trades; in 'auto' it places real Schwab orders. Always non-fatal — a
  // failure here doesn't poison the rest of the result.
  let autoExecuteResult: AutoExecuteResult | undefined;
  if (freshItems.length > 0) {
    try {
      autoExecuteResult = await autoExecute(freshItems, result.valuation.totalValue);
    } catch (err) {
      console.warn('[signals/run] auto-execute failed:', err);
    }
  }

  await saveCache(result);

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
    // Archive every run so the user can review history later.
    try { await archiveDailyPlan(plan); }
    catch (err) { console.warn('[signals/run] plan archive failed:', err); }

    if (shouldSend({ plan, autoExecute: autoExecuteResult })) {
      const dashboardUrl = process.env.URL || process.env.DEPLOY_URL || undefined;
      const digest = buildDigest({
        plan,
        autoExecute: autoExecuteResult,
        dashboardUrl: dashboardUrl ? `${dashboardUrl}/dashboard` : undefined,
      });
      const sent = await sendNotification(digest);
      if (!sent.delivered) {
        console.warn('[signals/run] digest not delivered:', sent.reason);
      }
    }
  } catch (err) {
    console.warn('[signals/run] daily digest failed:', err);
  }

  return {
    result,
    proposed: stageInputs.length,
    staged,
    autoExecute: autoExecuteResult,
  };
}
