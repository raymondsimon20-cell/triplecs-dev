/**
 * Triple C signals engine — PURE, testable rules. No I/O in this file.
 *
 * Every tunable lives in the single CONFIG object below (no magic numbers
 * inline). Each rule is a named function producing typed TradeSignals in
 * three categories: actionable trades, alerts, info.
 *
 * NOTE: signals produced here are PROPOSALS. Execution always re-validates
 * through lib/guardrails.ts — never trust this engine alone.
 */
import { classify, pillarBreakdown, getFamily, familyConcentration } from '@/lib/classify';
import { PILLAR_TARGETS } from '@/lib/data/fund-metadata';
import type {
  EngineInput,
  EngineOutput,
  EngineState,
  TradeSignal,
  ProposedTrade,
  RuleId,
  SignalCategory,
  SignalSeverity,
} from './types';

// ---------------------------------------------------------------------------
// CONFIG — every threshold, dollar amount, and percentage the engine uses.
// ---------------------------------------------------------------------------
export const CONFIG = {
  /** AFW (Available For Withdrawal) drawdown buy trigger (RULES §8). SPY
   *  drawdown is used as the proxy when AFW history is sparse. */
  AFW_TRIGGER: {
    drawdownPct: 0.10, // AFW/SPY down 10% from high = BUY signal
    buyNotionalPer10Pct: 100_000, // buy $100K in triples per 10% down (RULES §2)
    maxTotalNotional: 300_000, // up to $300K at -30%
  },

  /** DEFENSE mode: equity ratio (equity / gross assets) below threshold →
   *  stop buying, start trimming. */
  DEFENSE: {
    equityRatioFloor: 0.70,
  },

  /** AIRBAG: VIX-scaled position sizing — shrink new-position sizes as VIX rises. */
  AIRBAG: {
    vixCalm: 15, // at/below: full size
    vixPanic: 40, // at/above: minimum size
    minSizeFactor: 0.25,
  },

  /** MAINTENANCE_RANKED_TRIM: margin relief above threshold; sell ranked by
   *  maintenance-requirement-heaviness; rotate 1/3 of proceeds into triples
   *  (RULES §6, 1/3 rule §2). */
  MAINTENANCE_RANKED_TRIM: {
    marginUtilizationTrigger: 0.30, // "critical" tier
    trimNotional: 25_000, // per run
    triplesRotationFraction: 1 / 3,
  },

  /** PILLAR_FILL: propose new positions to close pillar gaps. */
  PILLAR_FILL: {
    minGapPct: 0.03, // only act on gaps > 3% of portfolio
    maxPerTrade: 15_000,
    maxPerRun: 30_000,
    /** Penalize proposing more of a family already above this share. */
    familyConcentrationPenaltyAbove: 0.15,
    candidates: {
      triples: ['UPRO', 'TQQQ', 'SPXL'],
      cornerstone: ['CLM', 'CRF'],
      income: ['XDTE', 'QDTE', 'SPYI', 'JEPQ'],
      hedge: ['SQQQ', 'SPXU'],
    } as Record<string, string[]>,
  },

  /**
   * TRIPLES_DIP_LADDER: per-ticker dip-buying ladder.
   * Fixed % step down from the per-ticker anchor; weighted budget split;
   * anchors reset on new highs; hard ceilings on combined + per-ticker weight.
   *
   * TACTICAL DEVIATION (temporary, owner decision — see docs/RULES.md §13):
   * SOXL is weighted 2× UPRO/TQQQ "for now" despite the Vol-7 sector-triple
   * decay warning. Do not treat as permanent strategy.
   */
  DIP_LADDER: {
    stepPct: 0.05, // buy rung every 5% down from anchor
    budgetPerRung: 10_000,
    weights: { SOXL: 2, UPRO: 1, TQQQ: 1 } as Record<string, number>,
    maxCombinedWeightPct: 0.30, // triples pillar hard ceiling (RULES §2 range top)
    maxPerTickerWeightPct: 0.15,
  },

  /** Triples trim: every ~5% rise above target, trim back (RULES §2). */
  TRIPLES_TRIM: {
    trimTriggerPct: 0.05, // 5% above target value
  },

  /** Pivot deadline / kill-switch on runaway margin debt growth. */
  PIVOT_DEADLINE: {
    lookbackDays: 10,
    debtGrowthKillPct: 0.25, // margin debit up 25% in lookback → kill switch
  },

  /** Cornerstone premium-to-NAV sell/box signal (RULES §4). */
  CORNERSTONE_PREMIUM: {
    sellBoxThresholdPct: 0.30,
  },

  /** Concentration caps (RULES §7). */
  CONCENTRATION: {
    hardCapPct: 0.20,
    warnPct: 0.15,
    personalTargetPct: 0.10,
  },

  /** Margin tiers (RULES §6). Schwab hard-caps utilization at 50% at the broker. */
  MARGIN_TIERS: {
    healthyBelow: 0.20,
    warningBelow: 0.30,
    criticalBelow: 0.50,
    brokerHardCap: 0.50,
  },

  /** Hedge floor: minimum 1% of portfolio always held in hedges (RULES §3). */
  HEDGE_FLOOR: {
    minPct: 0.01,
    refillNotional: 5_000,
  },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let seq = 0;
function signal(
  rule: RuleId,
  category: SignalCategory,
  severity: SignalSeverity,
  title: string,
  rationale: string,
  opts: { trade?: ProposedTrade; autoExecutable?: boolean; today: string }
): TradeSignal {
  return {
    id: `${opts.today}-${rule}-${seq++}`,
    rule,
    category,
    severity,
    title,
    rationale,
    trade: opts.trade,
    autoExecutable: opts.autoExecutable ?? false,
    createdAt: new Date().toISOString(),
  };
}

export function marginUtilizationOf(balances: EngineInput['balances']): number {
  const gross = balances.equity + balances.marginDebit;
  return gross > 0 ? balances.marginDebit / gross : 0;
}

export function equityRatioOf(balances: EngineInput['balances']): number {
  const gross = balances.equity + balances.marginDebit;
  return gross > 0 ? balances.equity / gross : 1;
}

/** AIRBAG size factor: 1.0 at calm VIX, scaling down to minSizeFactor at panic VIX. */
export function airbagFactor(vix: number): number {
  const { vixCalm, vixPanic, minSizeFactor } = CONFIG.AIRBAG;
  if (vix <= vixCalm) return 1;
  if (vix >= vixPanic) return minSizeFactor;
  const t = (vix - vixCalm) / (vixPanic - vixCalm);
  return 1 - t * (1 - minSizeFactor);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export function runEngine(input: EngineInput): EngineOutput {
  seq = 0;
  const { positions, balances, market, today } = input;
  const state: EngineState = structuredClone(input.state);
  const signals: TradeSignal[] = [];
  const total = balances.equity;
  const breakdown = pillarBreakdown(
    positions.map((p) => ({ symbol: p.symbol, marketValue: p.marketValue, putCall: p.putCall })),
    balances.cash
  );
  const util = marginUtilizationOf(balances);
  const eqRatio = equityRatioOf(balances);
  const sizeFactor = airbagFactor(market.vix);
  const defense = eqRatio < CONFIG.DEFENSE.equityRatioFloor;

  // --- Update trailing highs / anchors ---
  state.afwHigh = Math.max(state.afwHigh, balances.afw);
  state.spyHigh = Math.max(state.spyHigh, market.spyPrice);

  // --- MARGIN_TIER (alerts) ---
  const tiers = CONFIG.MARGIN_TIERS;
  if (util >= tiers.brokerHardCap) {
    signals.push(
      signal('MARGIN_TIER', 'alert', 'critical', 'EMERGENCY: margin at/above Schwab 50% hard cap',
        `Margin utilization ${(util * 100).toFixed(1)}%. Schwab hard-caps at 50% — new buys will fail at the broker. Reduce immediately.`,
        { today })
    );
  } else if (util >= tiers.warningBelow) {
    signals.push(
      signal('MARGIN_TIER', 'alert', 'high', 'Margin critical (30–50%)',
        `Margin utilization ${(util * 100).toFixed(1)}% — reduce exposure (RULES §6).`, { today })
    );
  } else if (util >= tiers.healthyBelow) {
    signals.push(
      signal('MARGIN_TIER', 'alert', 'medium', 'Margin warning (20–30%)',
        `Margin utilization ${(util * 100).toFixed(1)}% — monitor closely.`, { today })
    );
  }

  // --- DEFENSE mode (info + gates buying) ---
  if (defense) {
    signals.push(
      signal('DEFENSE', 'alert', 'high', 'DEFENSE mode active',
        `Equity ratio ${(eqRatio * 100).toFixed(1)}% below ${(CONFIG.DEFENSE.equityRatioFloor * 100).toFixed(0)}% floor. New buys suppressed; trim signals prioritized.`,
        { today })
    );
  }

  // --- AIRBAG (info) ---
  if (sizeFactor < 1) {
    signals.push(
      signal('AIRBAG', 'info', 'low', `AIRBAG sizing at ${(sizeFactor * 100).toFixed(0)}%`,
        `VIX ${market.vix.toFixed(1)} — new-position sizes scaled to ${(sizeFactor * 100).toFixed(0)}% of normal.`,
        { today })
    );
  }

  // --- AFW_TRIGGER: SPY drawdown proxy for AFW drawdown (buy trigger) ---
  const EPS = 1e-9; // guard exact-threshold floating-point misses
  const spyDrawdown = state.spyHigh > 0 ? 1 - market.spyPrice / state.spyHigh : 0;
  const cfgA = CONFIG.AFW_TRIGGER;
  if (spyDrawdown + EPS >= cfgA.drawdownPct && !defense) {
    const rungs = Math.min(
      Math.floor((spyDrawdown + EPS) / cfgA.drawdownPct),
      Math.floor(cfgA.maxTotalNotional / cfgA.buyNotionalPer10Pct)
    );
    const targetNotional = rungs * cfgA.buyNotionalPer10Pct * sizeFactor;
    signals.push(
      signal('AFW_TRIGGER', 'trade', 'high',
        `AFW buy trigger: market ${(spyDrawdown * 100).toFixed(1)}% off highs`,
        `AFW (Available For Withdrawal) proxy drawdown ≥ ${(rungs * cfgA.drawdownPct * 100).toFixed(0)}%. Playbook: $${cfgA.buyNotionalPer10Pct.toLocaleString()} of triples per 10% down (cap $${cfgA.maxTotalNotional.toLocaleString()}). AIRBAG-adjusted target this cycle: $${Math.round(targetNotional).toLocaleString()}.`,
        {
          today,
          trade: { symbol: 'UPRO', side: 'BUY', notional: targetNotional, pillar: 'triples' },
        })
    );
  }

  // --- TRIPLES_TRIM: 5% above target → trim back to target ---
  const triplesTarget = total * PILLAR_TARGETS.triples;
  const triplesValue = breakdown.values.triples;
  if (triplesTarget > 0 && triplesValue > triplesTarget * (1 + CONFIG.TRIPLES_TRIM.trimTriggerPct)) {
    const excess = triplesValue - triplesTarget;
    const triples = positions
      .filter((p) => classify(p.symbol, p.putCall) === 'triples')
      .sort((a, b) => b.marketValue - a.marketValue);
    if (triples.length > 0) {
      signals.push(
        signal('TRIPLES_TRIM', 'trade', 'medium', 'Trim triples back to target',
          `Triples $${Math.round(triplesValue).toLocaleString()} are ${(((triplesValue / triplesTarget) - 1) * 100).toFixed(1)}% above the ${(PILLAR_TARGETS.triples * 100).toFixed(0)}% target. Trim $${Math.round(excess).toLocaleString()} and redeploy into income names (RULES §2).`,
          {
            today,
            autoExecutable: true,
            trade: { symbol: triples[0].symbol, side: 'SELL', notional: excess, pillar: 'triples' },
          })
      );
    }
  }

  // --- MAINTENANCE_RANKED_TRIM ---
  const cfgM = CONFIG.MAINTENANCE_RANKED_TRIM;
  if (util >= cfgM.marginUtilizationTrigger) {
    const ranked = positions
      .filter((p) => (p.maintenanceRequirement ?? 0) > 0 && classify(p.symbol, p.putCall) === 'income')
      .sort(
        (a, b) =>
          (b.maintenanceRequirement ?? 0) / Math.max(1, b.marketValue) -
          (a.maintenanceRequirement ?? 0) / Math.max(1, a.marketValue)
      );
    if (ranked.length > 0) {
      const victim = ranked[0];
      const trimAmt = Math.min(cfgM.trimNotional, victim.marketValue);
      const intoTriples = trimAmt * cfgM.triplesRotationFraction;
      signals.push(
        signal('MAINTENANCE_RANKED_TRIM', 'trade', 'high', `Margin relief: trim ${victim.symbol}`,
          `Margin utilization ${(util * 100).toFixed(1)}% ≥ ${(cfgM.marginUtilizationTrigger * 100).toFixed(0)}%. Sell $${Math.round(trimAmt).toLocaleString()} of the most maintenance-heavy income name and rotate 1/3 ($${Math.round(intoTriples).toLocaleString()}) into triples (RULES §6 + 1/3 rule).`,
          {
            today,
            trade: { symbol: victim.symbol, side: 'SELL', notional: trimAmt, pillar: 'income' },
          })
      );
      signals.push(
        signal('MAINTENANCE_RANKED_TRIM', 'trade', 'medium', 'Rotate 1/3 of trim into triples',
          `Companion to the ${victim.symbol} trim: buy $${Math.round(intoTriples).toLocaleString()} UPRO per the 1/3 rule.`,
          {
            today,
            trade: { symbol: 'UPRO', side: 'BUY', notional: intoTriples, pillar: 'triples' },
          })
      );
    }
  }

  // --- PILLAR_FILL ---
  if (!defense) {
    const cfgP = CONFIG.PILLAR_FILL;
    const famConc = familyConcentration(
      positions.map((p) => ({ symbol: p.symbol, marketValue: p.marketValue, putCall: p.putCall }))
    );
    let budget = cfgP.maxPerRun;
    for (const [pillar, target] of Object.entries(PILLAR_TARGETS)) {
      if (budget <= 0) break;
      const current = breakdown.percents[pillar as keyof typeof breakdown.percents] ?? 0;
      const gap = target - current;
      if (gap <= cfgP.minGapPct) continue;
      const candidates = (cfgP.candidates[pillar] ?? []).filter(
        (sym) => (famConc[getFamily(sym)] ?? 0) < cfgP.familyConcentrationPenaltyAbove
      );
      if (candidates.length === 0) continue;
      const notional = Math.min(cfgP.maxPerTrade, gap * total, budget) * sizeFactor;
      budget -= notional;
      signals.push(
        signal('PILLAR_FILL', 'trade', 'low', `Fill ${pillar} gap with ${candidates[0]}`,
          `${pillar} at ${(current * 100).toFixed(1)}% vs ${(target * 100).toFixed(0)}% target (gap ${(gap * 100).toFixed(1)}%). Proposing $${Math.round(notional).toLocaleString()} ${candidates[0]}; over-concentrated families penalized.`,
          {
            today,
            autoExecutable: true,
            trade: { symbol: candidates[0], side: 'BUY', notional, pillar: pillar as ProposedTrade['pillar'] },
          })
      );
    }
  }

  // --- TRIPLES_DIP_LADDER (per-ticker; TACTICAL: SOXL 2× — see CONFIG note) ---
  const cfgD = CONFIG.DIP_LADDER;
  const weightSum = Object.values(cfgD.weights).reduce((a, b) => a + b, 0);
  const triplesPct = breakdown.percents.triples ?? 0;
  for (const [ticker, weight] of Object.entries(cfgD.weights)) {
    const pos = positions.find((p) => p.symbol === ticker);
    const price = pos?.price ?? 0;
    if (price <= 0) continue;
    const anchor = state.dipLadder.anchors[ticker] ?? price;
    if (price > anchor) {
      // New high → reset anchor and cycle deployment
      state.dipLadder.anchors[ticker] = price;
      state.dipLadder.deployed[ticker] = 0;
      continue;
    }
    state.dipLadder.anchors[ticker] = anchor;
    const drop = 1 - price / anchor;
    const rungsHit = Math.floor((drop + EPS) / cfgD.stepPct);
    if (rungsHit <= 0) continue;
    const tickerBudget = (cfgD.budgetPerRung * weight) / weightSum;
    const targetDeployed = rungsHit * tickerBudget;
    const already = state.dipLadder.deployed[ticker] ?? 0;
    const toDeploy = (targetDeployed - already) * sizeFactor;
    if (toDeploy <= 0) continue;
    // Hard ceilings
    const tickerPct = (pos?.marketValue ?? 0) / Math.max(1, total);
    if (triplesPct >= cfgD.maxCombinedWeightPct) {
      signals.push(
        signal('TRIPLES_DIP_LADDER', 'info', 'low', `Dip ladder capped (combined)`,
          `${ticker} rung hit at -${(drop * 100).toFixed(1)}% but triples already at ${(triplesPct * 100).toFixed(1)}% ≥ ${(cfgD.maxCombinedWeightPct * 100).toFixed(0)}% ceiling.`,
          { today })
      );
      continue;
    }
    if (tickerPct >= cfgD.maxPerTickerWeightPct) continue;
    if (defense) continue;
    state.dipLadder.deployed[ticker] = already + toDeploy;
    signals.push(
      signal('TRIPLES_DIP_LADDER', 'trade', 'medium',
        `Dip ladder: buy ${ticker} at -${(drop * 100).toFixed(1)}%`,
        `${ticker} is ${rungsHit} rung(s) (${(cfgD.stepPct * 100).toFixed(0)}% steps) below its anchor $${anchor.toFixed(2)}. Deploy $${Math.round(toDeploy).toLocaleString()} (weight ${weight}/${weightSum}${ticker === 'SOXL' ? ' — TACTICAL 2× weighting, temporary' : ''}).`,
        {
          today,
          autoExecutable: true,
          trade: { symbol: ticker, side: 'BUY', notional: toDeploy, pillar: 'triples' },
        })
    );
  }

  // --- PIVOT_DEADLINE kill-switch ---
  const cfgK = CONFIG.PIVOT_DEADLINE;
  state.marginDebtHistory.push({ date: today, debit: balances.marginDebit });
  state.marginDebtHistory = state.marginDebtHistory.slice(-cfgK.lookbackDays);
  const oldest = state.marginDebtHistory[0];
  if (
    state.marginDebtHistory.length >= 2 &&
    oldest.debit > 0 &&
    balances.marginDebit / oldest.debit - 1 >= cfgK.debtGrowthKillPct
  ) {
    signals.push(
      signal('PIVOT_DEADLINE', 'alert', 'critical', 'KILL SWITCH: runaway margin debt',
        `Margin debit grew ${(((balances.marginDebit / oldest.debit) - 1) * 100).toFixed(1)}% over ${state.marginDebtHistory.length} sessions (≥ ${(cfgK.debtGrowthKillPct * 100).toFixed(0)}% threshold). Automation should pause; deleverage per RULES §6.`,
        { today })
    );
  }

  // --- CONCENTRATION ---
  const cfgC = CONFIG.CONCENTRATION;
  for (const p of positions) {
    const pct = p.marketValue / Math.max(1, total);
    if (pct >= cfgC.hardCapPct) {
      signals.push(
        signal('CONCENTRATION', 'alert', 'high', `${p.symbol} above 20% hard cap`,
          `${p.symbol} is ${(pct * 100).toFixed(1)}% of portfolio (hard cap ${(cfgC.hardCapPct * 100).toFixed(0)}%). Trim required (RULES §7).`,
          { today })
      );
    } else if (pct >= cfgC.warnPct) {
      signals.push(
        signal('CONCENTRATION', 'alert', 'medium', `${p.symbol} approaching concentration cap`,
          `${p.symbol} at ${(pct * 100).toFixed(1)}% (warning ${(cfgC.warnPct * 100).toFixed(0)}%, personal target ${(cfgC.personalTargetPct * 100).toFixed(0)}%).`,
          { today })
      );
    }
  }

  // --- HEDGE_FLOOR: minimum 1% always held ---
  const hedgePct = breakdown.percents.hedge ?? 0;
  if (hedgePct < CONFIG.HEDGE_FLOOR.minPct) {
    signals.push(
      signal('HEDGE_FLOOR', 'trade', 'medium', 'Hedge floor breached — refill inverse triples',
        `Hedges at ${(hedgePct * 100).toFixed(2)}% < ${(CONFIG.HEDGE_FLOOR.minPct * 100).toFixed(0)}% minimum (RULES §3). Buy $${CONFIG.HEDGE_FLOOR.refillNotional.toLocaleString()} SQQQ.`,
        {
          today,
          autoExecutable: true,
          trade: { symbol: 'SQQQ', side: 'BUY', notional: CONFIG.HEDGE_FLOOR.refillNotional, pillar: 'hedge' },
        })
    );
  }

  state.lastRunAt = new Date().toISOString();
  return { signals, nextState: state };
}
