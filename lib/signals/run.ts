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
import { appendInbox, type AppendInput } from '../inbox';

import { loadSignalState, saveSignalState } from './state';
import {
  runSignalEngine,
  type EngineInputs,
  type EnginePosition,
  type EngineResult,
  type TradeSignal,
} from './engine';
import { autoExecute, type AutoExecuteResult } from './auto-execute';
import type { InboxItem } from '../inbox';

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
      positions.push({
        symbol:      p.instrument.symbol,
        shares:      p.longQuantity,
        marketValue: p.marketValue ?? 0,
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
  const [portfolio, market, state] = await Promise.all([
    fetchAggregatedPortfolio(),
    fetchMarketContext(),
    loadSignalState(),
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

  return {
    result,
    proposed: stageInputs.length,
    staged,
    autoExecute: autoExecuteResult,
  };
}
