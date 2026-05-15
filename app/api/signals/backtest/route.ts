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

    // Seed the simulated portfolio from the first snapshot — same positions,
    // cash, AND margin debt as the actual portfolio at t=0. Modeling margin
    // honestly is essential for an AFW-aware strategy: ignoring marginDebt
    // would underestimate leverage and silently let the sim deploy capital
    // it doesn't have.
    const first = realChronological[0];
    const simPositions = new Map<string, SimulatedPosition>();
    for (const p of first.positions ?? []) {
      if (p.shares <= 0 || p.marketValue <= 0) continue;
      const pricePerShare = p.marketValue / p.shares;
      simPositions.set(p.symbol, { shares: p.shares, costBasis: pricePerShare });
    }
    const holdingsAtStart = (first.positions ?? []).reduce(
      (s, p) => s + (p.marketValue || 0), 0,
    );
    // cash = equity - positions + marginDebt (rearrange equity = pos + cash − margin)
    let simCash       = Math.max(0, first.equity - holdingsAtStart + Math.abs(first.marginBalance ?? 0));
    let simMarginDebt = Math.abs(first.marginBalance ?? 0);

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
      // Total value is gross of margin — equity is total minus margin debt.
      // valueSimulated returns total (matches how the engine valuation works).
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
      // AFW estimate during simulation: equity minus an assumed 50% Reg-T
      // maintenance requirement on positions. Coarse but matches Schwab's
      // headroom math closely enough for sim purposes. Falls back to 0
      // (no headroom) if totals look wrong.
      const positionsValue = totalSim - simCash;
      const equityForSim   = totalSim - simMarginDebt;
      const simAfwDollars  = Math.max(0, equityForSim - positionsValue * 0.5);

      const inputs: EngineInputs = {
        positions:  enginePositions,
        cash:       simCash,
        marginDebt: simMarginDebt,
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
        marginThresholds: {
          trimAbovePct:     strategy.marginLimitPct,
          trimTargetPct:    strategy.marginTrimTargetPct,
          newBuyCeilingPct: strategy.marginNewBuyCeilingPct,
        },
        recentSells30d:       [],
        buyingPowerAvailable: Math.max(simCash, simAfwDollars),
        afwDollars:           simAfwDollars > 0 ? simAfwDollars : undefined,
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
          // Fund the buy from cash first; if cash runs out, borrow on margin.
          // This mirrors how Schwab settles: cash account first, margin account
          // takes the overflow up to the maintenance ceiling. The simulation
          // would CONTINUE borrowing past the 50% Schwab cap (since we don't
          // model the broker rejection) — that's a known limit of the sim.
          if (cost <= simCash) {
            simCash -= cost;
          } else {
            const cashUsed   = simCash;
            const borrowed   = cost - cashUsed;
            simCash         = 0;
            simMarginDebt  += borrowed;
          }
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
          // SELL: trim shares; realize per-share (px - costBasis) × sold shares.
          // Proceeds pay down margin first (mirrors how Schwab applies SELL
          // proceeds when margin debt is outstanding), then build up cash.
          if (!existing || existing.shares <= 0) continue;
          const sellShares = Math.min(shares, existing.shares);
          const proceeds   = sellShares * px;
          const realized   = (px - existing.costBasis) * sellShares;
          if (simMarginDebt > 0) {
            const paydown = Math.min(simMarginDebt, proceeds);
            simMarginDebt -= paydown;
            simCash       += proceeds - paydown;
          } else {
            simCash += proceeds;
          }
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
        'Margin debt IS modeled (seeded from first snapshot, paid down by SELL proceeds, borrowed on BUYs that overrun cash). Margin INTEREST expense is not modeled.',
        'AFW is estimated as `equity − 0.5 × positionsValue` during the sim (Reg-T proxy). The live engine uses Schwab\'s authoritative availableFunds; the sim approximates.',
        'Schwab\'s 50% margin ceiling is NOT enforced in the simulation — the sim can borrow past the cap. Live trading would be rejected at that point.',
        'Dividends and distributions are ignored — biases income-heavy strategies down.',
        'Tax drag is not modeled.',
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
