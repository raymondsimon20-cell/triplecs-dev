/**
 * /api/signals — Triple C's Signal Engine endpoint.
 *
 *   GET  → returns the most recent cached result (or `{ cached: false }` if
 *          none exists yet). Does NOT run the engine. Does NOT stage trades.
 *   POST → runs the engine fresh against live Schwab portfolio + Yahoo market
 *          data, saves the updated engine state, caches the result, and stages
 *          actionable BUY/SELL signals into the inbox with source 'signal-engine'.
 *
 * Engine logic lives in `lib/signals/engine.ts` (pure function, no I/O). State
 * persistence (defense-mode flag, kill-switch flag, pivot history, etc.) lives
 * in `lib/signals/state.ts`. This route is the only thing that does I/O.
 *
 * Cache: `signal-engine-cache` blob / key `latest`. Just the last result.
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';

import { requireAuth }       from '@/lib/session';
import { createClient, getAccountNumbers } from '@/lib/schwab/client';
import { getTokens }         from '@/lib/storage';
import { getDailyCloses }    from '@/lib/prices/historical';
import { appendInbox, type AppendInput } from '@/lib/inbox';

import { loadSignalState, saveSignalState } from '@/lib/signals/state';
import {
  runSignalEngine,
  type EngineInputs,
  type EnginePosition,
  type EngineResult,
  type TradeSignal,
} from '@/lib/signals/engine';

export const dynamic = 'force-dynamic';

const CACHE_STORE = 'signal-engine-cache';
const CACHE_KEY   = 'latest';

// Tickers we always price for the engine even if not currently held, so the
// hedge-airbag and triples checks have a baseline weight (0%) rather than
// undefined. Held-position symbols are added on top.
const ALWAYS_PRICE_TICKERS = ['CLM', 'CRF', 'QDTE', 'RDTE', 'IWMY', 'JEPI', 'JEPQ', 'UPRO', 'TQQQ', 'SPXU', 'SQQQ'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pull SPY history (last ~25 trading days) and current VIX from Yahoo via the
 * existing `getDailyCloses` helper. Returns parallel arrays sorted chronologically.
 */
async function fetchMarketContext(): Promise<{ spyHistory: number[]; vix: number; spyPrice: number }> {
  const today = new Date();
  const from  = isoDate(new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000)); // 60d window
  const to    = isoDate(today);

  const [spyMap, vixMap] = await Promise.all([
    getDailyCloses('SPY', from, to).catch(() => new Map<string, number>()),
    getDailyCloses('^VIX', from, to).catch(() => new Map<string, number>()),
  ]);

  // Sort by date ascending and take the last 25 closes.
  const spyCloses = Array.from(spyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
  const spyHistory = spyCloses.slice(-25);

  const vixCloses = Array.from(vixMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
  const vix = vixCloses[vixCloses.length - 1] ?? 20; // sensible default

  return {
    spyHistory,
    vix,
    spyPrice: spyHistory[spyHistory.length - 1] ?? 0,
  };
}

/**
 * Fetch all the user's Schwab accounts and aggregate into a single portfolio
 * snapshot. Single-account is the common case — `accounts` route does the same
 * aggregation pattern, this just inlines what we need.
 */
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
      // Skip options — they're handled by option-plan, not the signal engine.
      // Schwab classifies CEFs (CLM, CRF) and ETFs (JEPI, QDTE, etc.) as
      // COLLECTIVE_INVESTMENT or MUTUAL_FUND, not EQUITY, so we filter by
      // what's NOT-an-option rather than what IS-equity.
      if (p.instrument.assetType === 'OPTION') continue;
      if (p.instrument.symbol.includes(' ')) continue;   // option symbols
      if (p.longQuantity <= 0) continue;
      positions.push({
        symbol:      p.instrument.symbol,
        shares:      p.longQuantity,
        marketValue: p.marketValue ?? 0,
      });
    }
  }

  // Quotes for all held tickers (and the ALWAYS_PRICE set for engine baselines).
  const tickers = Array.from(new Set([
    ...positions.map((p) => p.symbol),
    ...ALWAYS_PRICE_TICKERS,
  ]));
  const prices: Record<string, number> = {};
  if (tickers.length > 0) {
    const quotes = await client.getQuotes(tickers);
    for (const [sym, q] of Object.entries(quotes)) {
      const price = q.quote?.lastPrice ?? q.quote?.mark;
      if (price && Number.isFinite(price)) {
        prices[sym] = price;
      }
    }
  }

  return { positions, cash, marginDebt, prices };
}

/**
 * Filter and map engine signals → inbox `AppendInput[]`. We only stage signals
 * with direction BUY or SELL on a clean single-ticker symbol — composite tickers
 * like 'CLM+CRF' or 'PORTFOLIO' aren't real orders. We also need a current price
 * to convert sizeDollars → shares.
 */
function signalsToInbox(
  signals: TradeSignal[],
  prices: Record<string, number>,
): AppendInput[] {
  const out: AppendInput[] = [];
  for (const s of signals) {
    if (s.direction !== 'BUY' && s.direction !== 'SELL') continue;
    if (!/^[A-Z]{1,5}$/.test(s.ticker)) continue;   // single equity ticker
    if (s.sizeDollars <= 0) continue;

    const price = prices[s.ticker];
    if (!price || price <= 0) continue;

    const shares = Math.floor(s.sizeDollars / price);
    if (shares <= 0) continue;

    out.push({
      source:      'signal-engine',
      symbol:      s.ticker,
      instruction: s.direction,                     // 'BUY' | 'SELL'
      quantity:    shares,
      orderType:   'MARKET',
      price,
      pillar:      undefined,                       // engine signals are pillar-agnostic
      rationale:   `[${s.rule}] ${s.reason}`,
      aiMode:      'signal_engine',
      violations:  [],
    });
  }
  return out;
}

async function saveCache(result: EngineResult): Promise<void> {
  await getStore(CACHE_STORE).setJSON(CACHE_KEY, {
    cachedAt: Date.now(),
    result,
  });
}

async function loadCache(): Promise<{ cachedAt: number; result: EngineResult } | null> {
  return getStore(CACHE_STORE).get(CACHE_KEY, { type: 'json' }) as Promise<
    { cachedAt: number; result: EngineResult } | null
  >;
}

// ─── GET — return cached result, read-only ───────────────────────────────────

export async function GET() {
  try { await requireAuth(); } catch { return unauthorized(); }

  const cached = await loadCache();
  if (!cached) {
    return NextResponse.json({ cached: false, message: 'No signal run yet — POST to run.' });
  }
  return NextResponse.json({
    cached:   true,
    cachedAt: cached.cachedAt,
    result:   cached.result,
  });
}

// ─── POST — run engine fresh, persist state, stage to inbox ──────────────────

export async function POST() {
  try { await requireAuth(); } catch { return unauthorized(); }

  try {
    const [portfolio, market, state] = await Promise.all([
      fetchAggregatedPortfolio(),
      fetchMarketContext(),
      loadSignalState(),
    ]);

    // Splice SPY price into the prices map so any future rule referencing it
    // can find it without a separate fetch.
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

    // Persist updated engine state — this is what flips the gate flags that
    // rebalance-plan / option-plan / ai-analysis will consult.
    await saveSignalState(result.nextState);

    // Stage actionable trades. Best-effort: a staging failure logs but doesn't
    // fail the response — the result itself is still useful.
    const stageInputs = signalsToInbox(result.actionableTrades, portfolio.prices);
    let staged = 0;
    if (stageInputs.length > 0) {
      try {
        const persisted = await Promise.race([
          appendInbox(stageInputs),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('staging timeout')), 5000),
          ),
        ]);
        staged = Array.isArray(persisted) ? persisted.length : 0;
      } catch (err) {
        console.warn('[/api/signals] inbox staging failed:', err);
      }
    }

    await saveCache(result);

    return NextResponse.json({
      ok:     true,
      staged,                            // items actually added to inbox (post-dedup)
      proposed: stageInputs.length,      // items that passed signal→order conversion
      result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/signals POST]', err);
    return NextResponse.json({ error: 'Signal engine failed', detail: msg }, { status: 500 });
  }
}
