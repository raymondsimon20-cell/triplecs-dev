/**
 * POST /api/signals/backtest
 *
 * Backtest with simulated execution. Replay tells you what would have fired;
 * backtest extends it by ACTUALLY EXECUTING every signal at the day's price
 * and tracking the resulting hypothetical portfolio across days.
 *
 * Output:
 *   - Two value paths over time: actual (what your real portfolio did) vs
 *     simulated (what would have happened if every engine signal had been
 *     executed at the day's close).
 *   - Per-rule attribution: realized P&L contributed by each rule (round-trip
 *     gains/losses when the simulated portfolio later sold the position).
 *
 * Honest limits — what this CANNOT tell you:
 *   - Real slippage. We use the day's close as the fill price. Real fills
 *     would be ~mid-spread off mark, with intraday volatility.
 *   - Tax drag. No realized capital gains accounting beyond per-rule attribution.
 *   - Margin interest. We model margin debt but not the daily interest expense.
 *   - Dividends / distributions. Most income-pillar tickers pay material
 *     monthly/weekly distributions; the simulation ignores them. This biases
 *     the simulation UNFAVORABLY for income-heavy strategies.
 *   - Wash-sale tracking. Engine's recentSells30d is empty in backtest.
 *
 * Use it to compare RULE BEHAVIOR vs the no-action baseline (would executing
 * every signal have helped or hurt by raw price action?). Don't treat the
 * absolute P&L number as forecast.
 *
 * Body:
 *   { limit?: number }   default 90, max 365
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getSnapshotHistory } from '@/lib/storage';
import { getServerStrategyTargets } from '@/lib/strategy-store';
import { getFundMetadata } from '@/lib/data/fund-metadata';
import {
  runSignalEngine,
  type EngineInputs,
  type EnginePosition,
  type TradeSignal,
} from '@/lib/signals/engine';
import { defaultSignalState, type SignalEngineState } from '@/lib/signals/state';

export const dynamic = 'force-dynamic';

interface BacktestBody { limit?: number }

interface SimulatedPosition {
  shares:    number;
  // Avg cost basis per share — moving-average across BUYs.
  costBasis: number;
}

interface RuleAttribution {
  rule:         string;
  realized:     number;   // realized P&L in dollars across simulated round-trips
  fires:        number;
  buys:         number;
  sells:        number;
}

interface ValuePoint {
  date:           string;
  actualValue:    number;
  simulatedValue: number;
  simulatedCash:  number;
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: BacktestBody = {};
  try { body = await req.json(); } catch { /* empty body fine */ }
  const limit = Math.max(1, Math.min(365, Math.floor(Number(body.limit) || 90)));

  try {
    const [snapshots, strategy] = await Promise.all([
      getSnapshotHistory(limit),
      getServerStrategyTargets(),
    ]);

    const realChronological = snapshots
      .filter((s) => !s.synthetic)
      .sort((a, b) => a.savedAt - b.savedAt);

    if (realChronological.length < 2) {
      return NextResponse.json({
        notice: 'Need at least 2 real snapshots to backtest.',
        valuePath: [],
        attribution: [],
      });
    }

    // Seed the simulated portfolio from the first snapshot — same positions
    // and cash as the actual portfolio at t=0.
    const first = realChronological[0];
    const simPositions = new Map<string, SimulatedPosition>();
    for (const p of first.positions ?? []) {
      if (p.shares <= 0 || p.marketValue <= 0) continue;
      const pricePerShare = p.marketValue / p.shares;
      simPositions.set(p.symbol, { shares: p.shares, costBasis: pricePerShare });
    }
    let simCash = Math.max(
      0,
      first.equity -
        (first.positions ?? []).reduce((s, p) => s + (p.marketValue || 0), 0) +
        Math.abs(first.marginBalance ?? 0),
    );

    // Build SPY history once so the engine sees realistic context.
    const spyByDate: Array<{ date: string; spy: number }> = realChronological
      .filter((s) => typeof s.spyClose === 'number' && (s.spyClose as number) > 0)
      .map((s) => ({
        date: new Date(s.savedAt).toISOString().slice(0, 10),
        spy:  s.spyClose as number,
      }));

    let state: SignalEngineState = defaultSignalState();
    const valuePath: ValuePoint[] = [];
    const attrByRule = new Map<string, RuleAttribution>();
    const symbolOriginRule = new Map<string, string>();  // last BUY rule per symbol

    const recordAttr = (rule: string, kind: 'buys' | 'sells' | 'fires', realizedDelta = 0): void => {
      let a = attrByRule.get(rule);
      if (!a) {
        a = { rule, realized: 0, fires: 0, buys: 0, sells: 0 };
        attrByRule.set(rule, a);
      }
      a[kind] += 1;
      a.realized += realizedDelta;
    };

    const priceMapFor = (snap: typeof realChronological[number]): Record<string, number> => {
      const prices: Record<string, number> = {};
      for (const p of snap.positions ?? []) {
        if (p.shares > 0 && p.marketValue > 0) prices[p.symbol] = p.marketValue / p.shares;
      }
      if (typeof snap.spyClose === 'number') prices['SPY'] = snap.spyClose;
      return prices;
    };

    const valueSimulated = (prices: Record<string, number>): number => {
      let v = simCash;
      for (const [sym, pos] of simPositions) {
        const px = prices[sym];
        if (px && pos.shares > 0) v += px * pos.shares;
      }
      return v;
    };

    for (const snap of realChronological) {
      const dateIso = new Date(snap.savedAt).toISOString().slice(0, 10);
      const prices = priceMapFor(snap);

      // Build engine inputs from the SIMULATED portfolio's positions.
      const enginePositions: EnginePosition[] = Array.from(simPositions.entries()).map(([symbol, sp]) => {
        const meta = getFundMetadata(symbol);
        const px   = prices[symbol] ?? sp.costBasis;
        return {
          symbol,
          shares:      sp.shares,
          marketValue: px * sp.shares,
          ...(meta
            ? {
                pillar:               meta.pillar,
                family:               meta.family,
                maintenancePct:       meta.maintenancePct,
                maintenancePctSource: meta.maintenancePctSource,
              }
            : {}),
        };
      });

      const spyHistory = spyByDate
        .filter((x) => x.date <= dateIso)
        .map((x) => x.spy)
        .slice(-25);

      const totalSim = valueSimulated(prices);
      const inputs: EngineInputs = {
        positions:  enginePositions,
        cash:       simCash,
        marginDebt: 0,  // simulation doesn't model margin debt path
        prices,
        spyHistory,
        vix:        20,
        state,
        pillarTargets: {
          triplesPct:     strategy.triplesPct,
          cornerstonePct: strategy.cornerstonePct,
          incomePct:      strategy.incomePct,
          hedgePct:       strategy.hedgePct,
        },
        recentSells30d:       [],
        buyingPowerAvailable: simCash,
      };

      const r = runSignalEngine(inputs);
      state = r.nextState;

      // Execute each actionable signal at the day's close.
      for (const sig of r.actionableTrades) {
        recordAttr(sig.rule, 'fires');
        if (sig.direction !== 'BUY' && sig.direction !== 'SELL') continue;
        const px = prices[sig.ticker];
        if (!px || px <= 0)            continue;
        const shares = Math.floor(sig.sizeDollars / px);
        if (shares <= 0)               continue;

        const existing = simPositions.get(sig.ticker);
        if (sig.direction === 'BUY') {
          const cost = shares * px;
          if (cost > simCash) continue;   // skip if we can't fund it
          simCash -= cost;
          if (existing) {
            const newShares = existing.shares + shares;
            const newBasis  = ((existing.shares * existing.costBasis) + cost) / newShares;
            simPositions.set(sig.ticker, { shares: newShares, costBasis: newBasis });
          } else {
            simPositions.set(sig.ticker, { shares, costBasis: px });
          }
          symbolOriginRule.set(sig.ticker, sig.rule);
          recordAttr(sig.rule, 'buys');
        } else {
          // SELL: trim shares; realize per-share (px - costBasis) × sold shares
          if (!existing || existing.shares <= 0) continue;
          const sellShares = Math.min(shares, existing.shares);
          const proceeds   = sellShares * px;
          const realized   = (px - existing.costBasis) * sellShares;
          simCash += proceeds;
          // Attribute realized P&L to the rule that originally bought it
          // (falls back to the SELL rule if we lost track).
          const attrRule = symbolOriginRule.get(sig.ticker) ?? sig.rule;
          recordAttr(attrRule, 'sells', realized);
          const remaining = existing.shares - sellShares;
          if (remaining > 0) {
            simPositions.set(sig.ticker, { shares: remaining, costBasis: existing.costBasis });
          } else {
            simPositions.delete(sig.ticker);
            symbolOriginRule.delete(sig.ticker);
          }
        }
      }

      valuePath.push({
        date:           dateIso,
        actualValue:    snap.totalValue,
        simulatedValue: valueSimulated(prices),
        simulatedCash:  simCash,
      });
    }

    const attribution = Array.from(attrByRule.values()).sort((a, b) => b.realized - a.realized);
    const last        = valuePath[valuePath.length - 1];
    const baseline    = valuePath[0];
    const summary = {
      snapshots:       realChronological.length,
      startDate:       valuePath[0]?.date,
      endDate:         last?.date,
      startValue:      baseline?.actualValue ?? 0,
      endActualValue:  last?.actualValue ?? 0,
      endSimValue:     last?.simulatedValue ?? 0,
      actualReturnPct: baseline && baseline.actualValue > 0
        ? ((last.actualValue / baseline.actualValue) - 1) * 100
        : 0,
      simReturnPct: baseline && baseline.simulatedValue > 0
        ? ((last.simulatedValue / baseline.simulatedValue) - 1) * 100
        : 0,
    };

    return NextResponse.json({
      summary,
      valuePath,
      attribution,
      caveats: [
        'Fills happen at snapshot close — no intraday slippage or spread cost.',
        'Margin interest and tax drag are NOT modeled.',
        'Dividends and distributions are ignored — biases income-heavy strategies down.',
        'Wash-sale tracking is off (recentSells30d=[]) — PILLAR_FILL may re-buy more aggressively than in production.',
        'Fund metadata is sourced from the current canonical table — historical reclassifications are not preserved.',
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[signals/backtest] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
