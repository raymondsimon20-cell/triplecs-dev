/**
 * Triple C's Signal Engine — TypeScript port.
 *
 * Pure function. Takes a snapshot of portfolio truth (positions/cash/margin
 * fetched from Schwab) plus the persisted engine state (gate flags, pivot
 * history, etc) plus market data (prices, SPY history, VIX), and returns:
 *
 *   - the set of trade signals + alerts + info items the engine wants to surface
 *   - the updated engine state to persist back to the blob
 *
 * No I/O happens here. The route handler does the fetching, calls this
 * function, then persists `nextState` and stages `actionableTrades` into the
 * inbox.
 *
 * ─── Cuts from the original Python engine ──────────────────────────────────
 *  - `LEVERAGE_REDUCTION` is ALERT-only (no SELL signal). Engine emits
 *    "update your Triples target to X%" — rebalance-plan executes the actual
 *    trim on its next drift run. See memory: triple_c_signal_engine.md.
 *  - `CLM_CRF_WEIGHT` buy side is removed — rebalance-plan's Cornerstone
 *    pillar drift owns cornerstone buys. Trim side (>20% combined) is kept
 *    as confirmed by the user (overrides the prior "never sell cornerstone"
 *    rule).
 *  - `AIRBAG_SCALE` is the sole owner of SPXU/SQQQ sizing — rebalance-plan
 *    no longer emits hedge orders.
 *  - `DEFENSE_MODE` and `MARGIN_KILL_SWITCH` write to the gate flags in
 *    `nextState`. Other endpoints consult those flags.
 */

import type { SignalEngineState } from './state';
import type { PillarType } from '../schwab/types';
import { listAiCurated, type FundFamily } from '../data/fund-metadata';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SignalDirection = 'BUY' | 'SELL' | 'REBALANCE' | 'ALERT' | 'INFO';
export type SignalPriority  = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface TradeSignal {
  id:           string;
  rule:         string;
  action:       string;
  ticker:       string;
  direction:    SignalDirection;
  sizeDollars:  number;
  priority:     SignalPriority;
  reason:       string;
  data:         Record<string, unknown>;
  timestamp:    string;
}

export interface MarketSnapshot {
  spy:        number;
  vix:        number;
  spyHistory: number[];
  timestamp:  string;
}

export interface PortfolioValuation {
  holdingsValue:  number;
  cash:           number;
  marginDebt:     number;
  totalValue:     number;
  equityValue:    number;
  equityRatio:    number;
  /** Pct weights keyed by ticker, e.g. { CLM: 12.5, CRF: 6.2, ... } */
  weightPcts:     Record<string, number>;
}

export interface EnginePosition {
  symbol: string;
  shares: number;
  /**
   * Market value of the position from Schwab (authoritative — already includes
   * dividend accrual and intraday revaluation). The engine prefers this over
   * `shares × prices[symbol]` so a missing quote doesn't zero out a holding.
   */
  marketValue: number;
  /**
   * Phase 2 additions — sourced from `lib/data/fund-metadata.ts` via the
   * enrichment step in `lib/classify.ts`. Optional so existing call sites
   * (and historical snapshot replay) keep working.
   */
  pillar?:               PillarType;
  family?:               FundFamily;
  maintenancePct?:       number;
  maintenancePctSource?: 'explicit' | 'default';
  /**
   * Schwab account hash this position lives in. Populated by the aggregator
   * when iterating multi-account state. Auto-execute uses this for SELLs so
   * the inverse order targets the right account. Optional for backward
   * compatibility with replay-from-snapshot.
   */
  accountHash?: string;
}

/**
 * User-configured pillar allocation targets (percent of total portfolio value).
 * Mirrors `StrategyTargets` in `lib/utils.ts`. Passed in by the run module
 * after reading from the server-side strategy store; falls back to defaults
 * if the user hasn't overridden anything.
 */
export interface PillarTargets {
  triplesPct:     number;
  cornerstonePct: number;
  incomePct:      number;
  hedgePct:       number;
}

/**
 * A recent sell, used so PILLAR_FILL can avoid proposing a BUY on a ticker
 * the user sold at a loss inside the wash-sale window. Defensive only — the
 * guardrail layer also catches this; this just keeps the engine from emitting
 * obviously-bad signals.
 */
export interface RecentSell {
  symbol:    string;
  soldDate:  string;   // ISO date
  isLoss:    boolean;
}

export interface EngineInputs {
  /** Positions from Schwab. Caller filters out options upstream. */
  positions:   EnginePosition[];
  /** Cash balance (USD). */
  cash:        number;
  /** Margin debt as a positive number (USD borrowed). */
  marginDebt:  number;
  /** Current quote per ticker. Used as a fallback when marketValue is 0/missing. */
  prices:      Record<string, number>;
  /** Last ~25 SPY daily closes (chronological). */
  spyHistory:  number[];
  /** Current VIX level. */
  vix:         number;
  /** Persisted engine memory. */
  state:       SignalEngineState;

  /**
   * Phase 2 additions. All optional so callers that pre-date them still type-check.
   */

  /** User-configured pillar targets. PILLAR_FILL is skipped when missing. */
  pillarTargets?: PillarTargets;
  /** Recent sells inside wash-sale window. PILLAR_FILL avoids re-buying these. */
  recentSells30d?: RecentSell[];
  /**
   * Cash actually available to deploy on new BUYs. If omitted, the engine uses
   * `max(0, cash)` — fine for most cases. Caller can override to apply a
   * stricter cushion (e.g. cash minus pending-order reserve).
   */
  buyingPowerAvailable?: number;
}

export interface EngineResult {
  generatedAt:      string;
  marketSnapshot:   MarketSnapshot;
  valuation:        PortfolioValuation;
  signals:          TradeSignal[];
  actionableTrades: TradeSignal[];
  alerts:           TradeSignal[];
  info:             TradeSignal[];
  inDefenseMode:    boolean;
  killSwitchActive: boolean;
  /** Updated state to persist via saveSignalState(). */
  nextState:        SignalEngineState;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export const CONFIG = {
  // AFW
  AFW_LOOKBACK:    7,
  AFW_THRESHOLD:   0.90,
  AFW_DEPLOY:      1_000,

  // Defense
  DEFENSE_EQUITY_RATIO: 0.40,

  // Airbag
  AIRBAG_NORMAL:   0.01,
  AIRBAG_VIX_MED:  0.025,
  AIRBAG_VIX_HIGH: 0.075,

  // CLM/CRF — trim only (buy is owned by rebalance-plan Cornerstone pillar)
  CLM_CRF_TARGET:  0.19,
  CLM_CRF_MAX:     0.20,

  // Pivot
  PIVOT_THRESHOLD:      1.05,
  PIVOT_HARD_DEADLINE:  new Date('2026-06-26'),
  PIVOT_AMBER_DAYS:     30,
  PIVOT_RED_DAYS:       14,

  // Leverage reduction thresholds (ALERT-only — no trade signals)
  LEVERAGE_150K_TARGET: 0.07,
  LEVERAGE_200K_TARGET: 0.05,
  LEVERAGE_EXIT_PORTFOLIO_SIZE: 300_000,

  // Kill switch
  KILL_SWITCH_DEBT_GROWTH: 500,

  // Freedom ratio
  FREEDOM_RATIO_MONTHLY_GAIN: 0.02,

  // ── Phase 2 — Maintenance-ranked trim ─────────────────────────────────────
  /** Margin utilization above which a margin-relief SELL fires. */
  MARGIN_TRIM_THRESHOLD: 0.30,
  /** Trim sizes the SELL to bring utilization back down to this level. */
  MARGIN_TRIM_TARGET: 0.25,
  /** Don't sell more than this fraction of any single position in one signal. */
  MARGIN_TRIM_MAX_FRACTION_OF_POSITION: 0.5,
  /** Vol-7 rotation rule: trim proceeds rotate 1/3 into Triple ETFs. */
  ROTATION_INTO_TRIPLES_PCT: 0.33,

  // ── Phase 2 — Pillar fill (new-position suggestions) ──────────────────────
  /** PILLAR_FILL fires when actual is this many pp below target. */
  PILLAR_FILL_GAP_THRESHOLD_PP: 5,
  /** Each run proposes this fraction of the gap (averages in over runs). */
  PILLAR_FILL_GAP_FRACTION: 0.33,
  /** Hard ceiling per single PILLAR_FILL signal. Matches auto-execute per-trade cap. */
  PILLAR_FILL_MAX_DOLLARS: 5_000,
  /** At most this many new tickers per pillar per run. */
  PILLAR_FILL_MAX_CANDIDATES: 2,
  /** When margin > 30%, skip candidates whose maintenancePct exceeds this. */
  PILLAR_FILL_HIGH_MARGIN_MAINT_CEILING: 60,
  /** Penalize candidates whose family is already above this % of portfolio. */
  PILLAR_FILL_FAMILY_PENALTY_PCT: 10,
  /**
   * Absolute margin-utilization ceiling for ANY new-buy rule. Above this,
   * PILLAR_FILL is skipped entirely — MAINTENANCE_RANKED_TRIM is what should
   * be firing first to relieve margin pressure, not new buys that add to it.
   */
  PILLAR_FILL_MAX_MARGIN_PCT: 0.35,
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSignalFactory(runTimestamp: string) {
  let counter = 0;
  return function makeSignal(
    rule: string,
    action: string,
    ticker: string,
    direction: SignalDirection,
    sizeDollars: number,
    priority: SignalPriority,
    reason: string,
    data: Record<string, unknown> = {},
  ): TradeSignal {
    counter += 1;
    return {
      id:          `${rule}_${counter}_${Date.parse(runTimestamp)}`,
      rule,
      action,
      ticker,
      direction,
      sizeDollars: Math.round(sizeDollars * 100) / 100,
      priority,
      reason,
      data,
      timestamp:   runTimestamp,
    };
  };
}

function daysUntil(target: Date): number {
  return Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Valuation ───────────────────────────────────────────────────────────────

export function valuePortfolio(
  positions: EnginePosition[],
  cash: number,
  marginDebt: number,
  prices: Record<string, number>,
): PortfolioValuation {
  let holdingsValue = 0;
  const weightDollars: Record<string, number> = {};

  for (const pos of positions) {
    // Prefer Schwab's marketValue. Fall back to shares × price only if
    // Schwab returned 0 or negative (rare — e.g. a position that priced
    // mid-fetch).
    const fallback = pos.shares * (prices[pos.symbol] ?? 0);
    const val      = pos.marketValue > 0 ? pos.marketValue : fallback;
    holdingsValue += val;
    weightDollars[pos.symbol] = (weightDollars[pos.symbol] ?? 0) + val;
  }

  const totalValue  = holdingsValue + cash;
  const equityValue = totalValue - marginDebt;
  const equityRatio = totalValue > 0 ? equityValue / totalValue : 1;

  const weightPcts: Record<string, number> = {};
  for (const [t, v] of Object.entries(weightDollars)) {
    weightPcts[t] = totalValue > 0 ? Math.round((v / totalValue) * 10_000) / 100 : 0;
  }

  return {
    holdingsValue: Math.round(holdingsValue * 100) / 100,
    cash:          Math.round(cash * 100) / 100,
    marginDebt:    Math.round(marginDebt * 100) / 100,
    totalValue:    Math.round(totalValue * 100) / 100,
    equityValue:   Math.round(equityValue * 100) / 100,
    equityRatio:   Math.round(equityRatio * 10_000) / 10_000,
    weightPcts,
  };
}

// ─── Rule evaluators ─────────────────────────────────────────────────────────

type MakeSignal = ReturnType<typeof makeSignalFactory>;

function evalDefenseMode(
  valuation: PortfolioValuation,
  makeSignal: MakeSignal,
): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const { equityRatio, weightPcts, totalValue } = valuation;

  if (equityRatio <= CONFIG.DEFENSE_EQUITY_RATIO) {
    signals.push(makeSignal(
      'DEFENSE_MODE', 'STOP_ALL_DEPLOYMENTS', 'PORTFOLIO', 'ALERT', 0, 'CRITICAL',
      `Equity ratio ${(equityRatio * 100).toFixed(1)}% ≤ ${CONFIG.DEFENSE_EQUITY_RATIO * 100}% — defense mode active`,
      { equityRatio, equityValue: valuation.equityValue },
    ));

    // The TRIM_QDTE action survives — it's defense-mode specific and doesn't
    // collide with rebalance-plan (which doesn't react to equity ratio).
    const qdteW = (weightPcts['QDTE'] ?? 0) / 100;
    if (qdteW > 0.20) {
      signals.push(makeSignal(
        'DEFENSE_MODE', 'TRIM_QDTE', 'QDTE', 'SELL',
        (qdteW - 0.15) * totalValue, 'CRITICAL',
        `Defense mode: QDTE at ${(qdteW * 100).toFixed(1)}% > 20% — trim to 15%`,
        { currentWeight: qdteW },
      ));
    }
  }

  return signals;
}

function evalAfwTrigger(
  spyHistory: number[],
  valuation: PortfolioValuation,
  inDefense: boolean,
  makeSignal: MakeSignal,
): { signals: TradeSignal[]; fired: boolean } {
  if (inDefense || spyHistory.length < CONFIG.AFW_LOOKBACK) {
    return { signals: [], fired: false };
  }
  const signals: TradeSignal[] = [];

  const recent = spyHistory.slice(-CONFIG.AFW_LOOKBACK);
  const afw    = Math.max(...recent);
  const spyNow = spyHistory[spyHistory.length - 1];

  if (spyNow > CONFIG.AFW_THRESHOLD * afw) {
    return { signals: [], fired: false };
  }

  const triplesW =
    ((valuation.weightPcts['UPRO'] ?? 0) + (valuation.weightPcts['TQQQ'] ?? 0)) / 100;

  if (triplesW < 0.10) {
    signals.push(makeSignal(
      'AFW_TRIGGER', 'BUY_UPRO', 'UPRO', 'BUY',
      CONFIG.AFW_DEPLOY * 0.5, 'HIGH',
      `AFW: SPY $${spyNow.toFixed(2)} ≤ 90% of $${afw.toFixed(2)} 7-day max — deploy $500 UPRO`,
      { spy: spyNow, afw, triplesWeight: triplesW },
    ));
    signals.push(makeSignal(
      'AFW_TRIGGER', 'BUY_TQQQ', 'TQQQ', 'BUY',
      CONFIG.AFW_DEPLOY * 0.5, 'HIGH',
      `AFW: SPY $${spyNow.toFixed(2)} ≤ 90% of $${afw.toFixed(2)} 7-day max — deploy $500 TQQQ`,
      { spy: spyNow, afw, triplesWeight: triplesW },
    ));
  } else {
    signals.push(makeSignal(
      'AFW_TRIGGER', 'BUY_QDTE', 'QDTE', 'BUY',
      CONFIG.AFW_DEPLOY, 'HIGH',
      `AFW: SPY $${spyNow.toFixed(2)} ≤ 90% of $${afw.toFixed(2)} — triples at capacity (${(triplesW * 100).toFixed(1)}%), buy QDTE`,
      { spy: spyNow, afw, triplesWeight: triplesW },
    ));
  }

  return { signals, fired: true };
}

function evalAirbag(
  vix: number,
  spyHistory: number[],
  valuation: PortfolioValuation,
  makeSignal: MakeSignal,
): TradeSignal[] {
  if (spyHistory.length < 20) return [];
  const signals: TradeSignal[] = [];
  const spyNow   = spyHistory[spyHistory.length - 1];
  const spy20max = Math.max(...spyHistory.slice(-20));
  const spyDD    = (spyNow - spy20max) / spy20max;

  let target: number;
  let label:  string;

  if (vix > 30 && spyDD < -0.10) {
    target = CONFIG.AIRBAG_VIX_HIGH;
    label  = `VIX ${vix.toFixed(0)} >30 AND SPY drawdown ${(spyDD * 100).toFixed(1)}%`;
  } else if (vix > 20 && spyDD < -0.05) {
    target = CONFIG.AIRBAG_VIX_MED;
    label  = `VIX ${vix.toFixed(0)} >20 AND SPY drawdown ${(spyDD * 100).toFixed(1)}%`;
  } else {
    target = CONFIG.AIRBAG_NORMAL;
    label  = `VIX ${vix.toFixed(0)} normal`;
  }

  for (const ticker of ['SPXU', 'SQQQ'] as const) {
    const currentW = (valuation.weightPcts[ticker] ?? 0) / 100;
    const diff     = target - currentW;

    if (Math.abs(diff) > 0.005) {
      const direction: SignalDirection = diff > 0 ? 'BUY' : 'SELL';
      const size      = Math.abs(diff) * valuation.totalValue;
      const priority: SignalPriority  = target > CONFIG.AIRBAG_NORMAL ? 'HIGH' : 'MEDIUM';

      signals.push(makeSignal(
        'AIRBAG_SCALE',
        diff > 0 ? `SCALE_UP_${ticker}` : `SCALE_DOWN_${ticker}`,
        ticker, direction, size, priority,
        `Airbag ${ticker}: ${(currentW * 100).toFixed(1)}% → ${(target * 100).toFixed(1)}% (${label})`,
        { vix, spyDrawdown: spyDD, currentWeight: currentW, targetWeight: target },
      ));
    }
  }

  return signals;
}

function evalClmCrf(
  valuation: PortfolioValuation,
  makeSignal: MakeSignal,
): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const combined =
    ((valuation.weightPcts['CLM'] ?? 0) + (valuation.weightPcts['CRF'] ?? 0)) / 100;

  // TRIM side only — buys are owned by rebalance-plan's Cornerstone pillar.
  // Confirmed 2026-05-12: trim IS allowed (overrides prior never-sell rule).
  if (combined > CONFIG.CLM_CRF_MAX) {
    const trimVal = (combined - CONFIG.CLM_CRF_TARGET) * valuation.totalValue;
    signals.push(makeSignal(
      'CLM_CRF_TRIM', 'TRIM_CLM', 'CLM', 'SELL',
      trimVal / 2, 'MEDIUM',
      `CLM+CRF at ${(combined * 100).toFixed(1)}% > ${CONFIG.CLM_CRF_MAX * 100}% hard cap — trim CLM half`,
      { combinedWeight: combined },
    ));
    signals.push(makeSignal(
      'CLM_CRF_TRIM', 'TRIM_CRF', 'CRF', 'SELL',
      trimVal / 2, 'MEDIUM',
      `CLM+CRF at ${(combined * 100).toFixed(1)}% > ${CONFIG.CLM_CRF_MAX * 100}% hard cap — trim CRF half`,
      { combinedWeight: combined },
    ));
  }

  // Daily premium check reminder — INFO only.
  signals.push(makeSignal(
    'CLM_CRF_PREMIUM_CHECK', 'CHECK_PREMIUM', 'CLM+CRF', 'INFO', 0, 'INFO',
    'Daily: verify CLM/CRF premium/discount at CEFConnect',
    { url: 'https://www.cefconnect.com/fund/CLM', combinedWeight: combined },
  ));

  return signals;
}

function evalPivot(
  spyHistory: number[],
  pivotState: SignalEngineState['pivot'],
  makeSignal: MakeSignal,
): { signals: TradeSignal[]; nextSpyLow: number | null } {
  const signals: TradeSignal[] = [];
  if (spyHistory.length === 0) {
    return { signals: [], nextSpyLow: pivotState.spyLowSincePivot };
  }
  const spyNow   = spyHistory[spyHistory.length - 1];
  const daysLeft = daysUntil(CONFIG.PIVOT_HARD_DEADLINE);

  let nextSpyLow = pivotState.spyLowSincePivot ?? spyNow;
  if (spyNow < nextSpyLow) nextSpyLow = spyNow;

  if (pivotState.pivotExecuted) {
    return { signals, nextSpyLow };
  }

  if (spyNow >= CONFIG.PIVOT_THRESHOLD * nextSpyLow) {
    signals.push(makeSignal(
      'PIVOT_TRIGGER', 'EXECUTE_PIVOT', 'PORTFOLIO', 'REBALANCE', 0, 'CRITICAL',
      `Pivot trigger: SPY $${spyNow.toFixed(2)} ≥ +5% from low $${nextSpyLow.toFixed(2)}`,
      {
        spyNow,
        spyLow: nextSpyLow,
        gainFromLow: (spyNow / nextSpyLow) - 1,
        pivotSteps: [
          '1. Sell ULTY → JEPI (60%) + JEPQ (40%)',
          '2. Sell YMAX → JEPI (60%) + JEPQ (40%)',
          '3. Sell UDOW → add to UPRO',
          '4. Confirm no defense mode active first',
        ],
      },
    ));
  }

  if (daysLeft <= CONFIG.PIVOT_RED_DAYS) {
    signals.push(makeSignal(
      'PIVOT_DEADLINE', 'PIVOT_DEADLINE_RED', 'PORTFOLIO', 'ALERT', 0, 'CRITICAL',
      `HARD DEADLINE: ${daysLeft} days to June 26 pivot deadline — execute NOW to stop NAV bleed`,
      { daysRemaining: daysLeft, deadline: '2026-06-26' },
    ));
  } else if (daysLeft <= CONFIG.PIVOT_AMBER_DAYS) {
    signals.push(makeSignal(
      'PIVOT_DEADLINE', 'PIVOT_DEADLINE_AMBER', 'PORTFOLIO', 'ALERT', 0, 'HIGH',
      `AMBER: ${daysLeft} days to June 26 pivot deadline`,
      { daysRemaining: daysLeft, deadline: '2026-06-26' },
    ));
  }

  return { signals, nextSpyLow };
}

function evalMarginKillSwitch(
  marginDebt: number,
  state: SignalEngineState,
  makeSignal: MakeSignal,
): { signals: TradeSignal[]; tripped: boolean; reason: string } {
  const thisMonth = currentYearMonth();
  const prev = state.prevMonth;
  if (!prev || prev.month === thisMonth) {
    return { signals: [], tripped: false, reason: '' };
  }

  const growth = marginDebt - prev.margin;
  if (growth > CONFIG.KILL_SWITCH_DEBT_GROWTH && !state.afwThisMonth.fired) {
    const reason = `Margin debt grew $${growth.toFixed(0)} MoM without an AFW trigger this month`;
    return {
      signals: [makeSignal(
        'MARGIN_KILL_SWITCH', 'PAUSE_ALL_PURCHASES', 'MARGIN', 'ALERT', 0, 'CRITICAL',
        `${reason} — PAUSE all new purchases until gap closes`,
        { prevMargin: prev.margin, currentMargin: marginDebt, growth },
      )],
      tripped: true,
      reason,
    };
  }

  return { signals: [], tripped: false, reason: '' };
}

/**
 * LEVERAGE_REDUCTION — ALERT-only. Engine emits a recommendation to update the
 * Triples pillar target; rebalance-plan's drift logic executes the actual SELL
 * on its next run. See memory: triple_c_signal_engine.md.
 */
function evalLeverageReduction(
  valuation: PortfolioValuation,
  makeSignal: MakeSignal,
): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const total = valuation.totalValue;
  const triplesW =
    ((valuation.weightPcts['UPRO'] ?? 0) + (valuation.weightPcts['TQQQ'] ?? 0)) / 100;

  if (total >= CONFIG.LEVERAGE_EXIT_PORTFOLIO_SIZE && triplesW > 0) {
    signals.push(makeSignal(
      'LEVERAGE_REDUCTION_ALERT', 'UPDATE_TRIPLES_TARGET_TO_0',
      'UPRO+TQQQ', 'ALERT', 0, 'HIGH',
      `Portfolio at $${total.toLocaleString()} ≥ $300k — update Triples pillar target to 0% in Settings. Rebalance-plan will trim on its next run.`,
      { totalValue: total, triplesWeight: triplesW, recommendedTarget: 0 },
    ));
  } else if (total >= 200_000 && triplesW > CONFIG.LEVERAGE_200K_TARGET) {
    signals.push(makeSignal(
      'LEVERAGE_REDUCTION_ALERT', 'UPDATE_TRIPLES_TARGET_TO_5PCT',
      'UPRO+TQQQ', 'ALERT', 0, 'MEDIUM',
      `Portfolio at $${total.toLocaleString()} ≥ $200k — update Triples pillar target to ≤5% in Settings (currently ${(triplesW * 100).toFixed(1)}%). Rebalance-plan will trim on its next run.`,
      { totalValue: total, currentWeight: triplesW, recommendedTarget: CONFIG.LEVERAGE_200K_TARGET },
    ));
  } else if (total >= 150_000 && triplesW > CONFIG.LEVERAGE_150K_TARGET) {
    signals.push(makeSignal(
      'LEVERAGE_REDUCTION_ALERT', 'UPDATE_TRIPLES_TARGET_TO_7PCT',
      'UPRO+TQQQ', 'ALERT', 0, 'MEDIUM',
      `Portfolio at $${total.toLocaleString()} ≥ $150k — update Triples pillar target to ≤7% in Settings (currently ${(triplesW * 100).toFixed(1)}%). Rebalance-plan will trim on its next run.`,
      { totalValue: total, currentWeight: triplesW, recommendedTarget: CONFIG.LEVERAGE_150K_TARGET },
    ));
  }

  return signals;
}

function evalFreedomRatio(
  history: SignalEngineState['freedomRatioHistory'],
  makeSignal: MakeSignal,
): TradeSignal[] {
  if (history.length < 3) return [];

  const recent = history.slice(-3).map((h) => h.ratio);
  let flatMonths = 0;
  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i] - recent[i - 1] < CONFIG.FREEDOM_RATIO_MONTHLY_GAIN) {
      flatMonths += 1;
    }
  }

  if (flatMonths >= 2) {
    return [makeSignal(
      'FREEDOM_RATIO', 'PORTFOLIO_REVIEW', 'PORTFOLIO', 'ALERT', 0, 'HIGH',
      'Freedom ratio flat for 2+ consecutive months — portfolio review needed',
      { history: history.slice(-3), targetGain: CONFIG.FREEDOM_RATIO_MONTHLY_GAIN },
    )];
  }

  return [];
}

// ─── Phase 2 — Maintenance-ranked trim ───────────────────────────────────────

/**
 * MAINTENANCE_RANKED_TRIM
 *
 * When margin utilization exceeds the threshold, sell the position that frees
 * the most equity per dollar sold — i.e. the highest maintenance % the user
 * actually holds. Pair the SELL with a 1/3 rotation into Triple ETFs per the
 * Vol-7 rotation rule.
 *
 * Skipped in defense mode or when the kill-switch is active (those gates take
 * priority). Skipped when the engine has no maintenance data for any position
 * (would degrade to a coin-flip ranking).
 *
 * Skipped for Triples (LEVERAGE_REDUCTION_ALERT owns that), Hedges (AIRBAG owns
 * those), and CLM/CRF (DRIP-protected by separate rule). The candidate set is
 * effectively "income pillar positions ranked by maintenance × marketValue".
 */
function evalMaintenanceRankedTrim(
  positions:        EnginePosition[],
  valuation:        PortfolioValuation,
  inDefense:        boolean,
  killSwitchActive: boolean,
  makeSignal:       MakeSignal,
): TradeSignal[] {
  if (inDefense || killSwitchActive) return [];
  if (valuation.totalValue <= 0)     return [];

  const marginUtilPct = valuation.marginDebt / valuation.totalValue;
  if (marginUtilPct <= CONFIG.MARGIN_TRIM_THRESHOLD) return [];

  // Equity we need to free to bring utilization to TARGET. Each dollar sold
  // frees `maintenancePct%` of equity, so we need to sell more than the gap.
  const requiredEquityFreed =
    (marginUtilPct - CONFIG.MARGIN_TRIM_TARGET) * valuation.totalValue;

  // Eligible candidates: income (and "other") positions only. Triples/hedges/
  // cornerstone owned by other rules. Skip positions without maintenance data
  // (we'd be guessing).
  const candidates = positions
    .filter((p) => p.marketValue > 0)
    .filter((p) => p.pillar !== 'triples' && p.pillar !== 'hedge' && p.pillar !== 'cornerstone')
    .filter((p) => typeof p.maintenancePct === 'number')
    .map((p) => ({
      pos:   p,
      maint: p.maintenancePct as number,
      score: (p.maintenancePct as number) * p.marketValue,
    }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return [];

  const top = candidates[0];

  // dollars to sell ≈ requiredFreed / (maint / 100), capped at half the position
  const rawTrim    = requiredEquityFreed / (top.maint / 100);
  const maxTrim    = top.pos.marketValue * CONFIG.MARGIN_TRIM_MAX_FRACTION_OF_POSITION;
  const trimDollars = Math.min(rawTrim, maxTrim);

  if (trimDollars < 100) return [];   // not worth a signal

  const signals: TradeSignal[] = [];
  const priority: SignalPriority = marginUtilPct > 0.40 ? 'HIGH' : 'MEDIUM';

  signals.push(makeSignal(
    'MAINTENANCE_RANKED_TRIM',
    `TRIM_${top.pos.symbol}`,
    top.pos.symbol,
    'SELL',
    trimDollars,
    priority,
    `Margin at ${(marginUtilPct * 100).toFixed(1)}% > ${(CONFIG.MARGIN_TRIM_THRESHOLD * 100).toFixed(0)}%. ` +
      `${top.pos.symbol} has highest maintenance (${top.maint}%) among holdings — selling $${Math.round(trimDollars)} ` +
      `frees ~$${Math.round(trimDollars * top.maint / 100)} of equity (target margin ≤${(CONFIG.MARGIN_TRIM_TARGET * 100).toFixed(0)}%).`,
    {
      marginUtilPct,
      targetMarginPct:        CONFIG.MARGIN_TRIM_TARGET,
      candidateSymbol:        top.pos.symbol,
      candidateMaintPct:      top.maint,
      candidateMaintSource:   top.pos.maintenancePctSource ?? 'default',
      requiredEquityFreed,
      cappedAtHalfPosition:   rawTrim > maxTrim,
    },
  ));

  // Vol-7 1/3 rotation pair — only when 1/3 is large enough to be worth an order.
  const rotationDollars = trimDollars * CONFIG.ROTATION_INTO_TRIPLES_PCT;
  if (rotationDollars >= 100) {
    const uproW = valuation.weightPcts['UPRO'] ?? 0;
    const tqqqW = valuation.weightPcts['TQQQ'] ?? 0;
    const target = uproW <= tqqqW ? 'UPRO' : 'TQQQ';
    signals.push(makeSignal(
      'MAINTENANCE_RANKED_TRIM',
      `ROTATE_INTO_${target}`,
      target,
      'BUY',
      rotationDollars,
      priority,
      `Vol-7 1/3 rotation: ~$${Math.round(rotationDollars)} of ${top.pos.symbol} proceeds rotates into ${target} ` +
        `(currently ${(uproW + tqqqW > 0 ? (target === 'UPRO' ? uproW : tqqqW) : 0).toFixed(1)}%).`,
      {
        rotationFromSymbol: top.pos.symbol,
        rotationFraction:   CONFIG.ROTATION_INTO_TRIPLES_PCT,
        targetTicker:       target,
      },
    ));
  }

  return signals;
}

// ─── Phase 2 — Pillar fill (new-position suggestions) ────────────────────────

/**
 * PILLAR_FILL
 *
 * When the Income pillar is meaningfully below target and the engine isn't
 * gated, propose up to N new income tickers from the AI-curated subset.
 *
 * Scoring prefers candidates whose fund family the user is not already
 * concentrated in. When margin utilization is elevated (>30%), high-maintenance
 * candidates are filtered out so PILLAR_FILL doesn't fight MAINTENANCE_RANKED_TRIM.
 *
 * Triples are owned by AFW_TRIGGER + the rotation pair. Cornerstone buys are
 * owned by the rebalance-plan endpoint. Hedge sizing is owned by AIRBAG_SCALE.
 * So PILLAR_FILL only addresses the Income pillar gap.
 *
 * Skipped when:
 *  - pillarTargets is not provided (caller didn't load strategy config)
 *  - defense mode active, kill switch active
 *  - cash insufficient
 *  - gap is below threshold
 *
 * Size:
 *  - Each run proposes 1/3 of the gap (averages in over time)
 *  - Capped at PILLAR_FILL_MAX_DOLLARS per candidate, MAX_CANDIDATES per pillar
 *  - Bounded by 95% of available cash to leave a buffer
 */
function evalPillarFill(
  positions:           EnginePosition[],
  valuation:           PortfolioValuation,
  pillarTargets:       PillarTargets | undefined,
  buyingPowerAvail:    number,
  inDefense:           boolean,
  killSwitchActive:    boolean,
  recentSells30d:      RecentSell[],
  makeSignal:          MakeSignal,
): TradeSignal[] {
  if (!pillarTargets)                return [];
  if (inDefense || killSwitchActive) return [];
  if (buyingPowerAvail < 100)        return [];

  // Hard margin ceiling for the rule itself. Above this, the user should be
  // trimming not buying — MAINTENANCE_RANKED_TRIM handles that side.
  const utilFirstCheck =
    valuation.totalValue > 0 ? valuation.marginDebt / valuation.totalValue : 0;
  if (utilFirstCheck > CONFIG.PILLAR_FILL_MAX_MARGIN_PCT) return [];

  // Aggregate dollars by pillar and by family.
  const dollarsByPillar: Record<string, number> = {
    triples: 0, cornerstone: 0, income: 0, hedge: 0, other: 0,
  };
  const dollarsByFamily: Record<string, number> = {};
  const heldSymbols = new Set<string>();

  for (const p of positions) {
    if (p.marketValue <= 0) continue;
    heldSymbols.add(p.symbol);
    if (p.pillar) {
      dollarsByPillar[p.pillar] = (dollarsByPillar[p.pillar] ?? 0) + p.marketValue;
    }
    if (p.family) {
      dollarsByFamily[p.family] = (dollarsByFamily[p.family] ?? 0) + p.marketValue;
    }
  }

  const totalForPct = valuation.totalValue > 0 ? valuation.totalValue : 1;
  const incomePct   = (dollarsByPillar['income'] / totalForPct) * 100;
  const targetPct   = pillarTargets.incomePct;
  const gapPp       = targetPct - incomePct;

  if (gapPp < CONFIG.PILLAR_FILL_GAP_THRESHOLD_PP) return [];

  const fullGapDollars = (gapPp / 100) * valuation.totalValue;
  const deployBudget = Math.min(
    fullGapDollars * CONFIG.PILLAR_FILL_GAP_FRACTION,
    CONFIG.PILLAR_FILL_MAX_DOLLARS * CONFIG.PILLAR_FILL_MAX_CANDIDATES,
    buyingPowerAvail * 0.95,
  );
  if (deployBudget < 100) return [];

  // Wash-sale defensive skip — only blocks symbols sold at a loss in window.
  const washSaleSkip = new Set(
    recentSells30d.filter((s) => s.isLoss).map((s) => s.symbol),
  );

  const marginUtilPct = valuation.marginDebt / totalForPct;

  // Score candidates from the AI-curated income subset.
  const scored = listAiCurated('income')
    .filter((c) => !heldSymbols.has(c.symbol))
    .filter((c) => !washSaleSkip.has(c.symbol))
    .filter((c) => {
      if (marginUtilPct > 0.30 && c.maintenancePct > CONFIG.PILLAR_FILL_HIGH_MARGIN_MAINT_CEILING) {
        return false;
      }
      return true;
    })
    .map((c) => {
      const familyDollars   = dollarsByFamily[c.family] ?? 0;
      const familyPct       = (familyDollars / totalForPct) * 100;
      const familyPenalty   = Math.max(0, familyPct - CONFIG.PILLAR_FILL_FAMILY_PENALTY_PCT);
      // Maintenance gets a mild penalty: prefer lower-maint candidates when ranking
      // is otherwise tied, but don't override the family-diversification preference.
      const maintPenalty = c.maintenancePct / 100;
      const score = -familyPenalty - maintPenalty;
      return { c, familyPct, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  const pickN          = Math.min(CONFIG.PILLAR_FILL_MAX_CANDIDATES, scored.length);
  const perCandidate   = deployBudget / pickN;
  const sizePerSignal  = Math.min(perCandidate, CONFIG.PILLAR_FILL_MAX_DOLLARS);
  const signals: TradeSignal[] = [];
  const priority: SignalPriority = gapPp > 10 ? 'HIGH' : 'MEDIUM';

  for (let i = 0; i < pickN; i += 1) {
    const { c, familyPct } = scored[i];
    signals.push(makeSignal(
      'PILLAR_FILL',
      `FILL_INCOME_${c.symbol}`,
      c.symbol,
      'BUY',
      sizePerSignal,
      priority,
      `Income pillar at ${incomePct.toFixed(1)}% vs target ${targetPct}% (gap ${gapPp.toFixed(1)}pp). ` +
        `${c.symbol} (${c.family}) fills the gap; you don't already hold it` +
        (familyPct > 0 ? `, and current ${c.family} exposure is ${familyPct.toFixed(1)}%.` : '.'),
      {
        pillar:                 'income',
        actualPct:              Math.round(incomePct * 100) / 100,
        targetPct,
        gapPp:                  Math.round(gapPp * 100) / 100,
        candidateFamily:        c.family,
        familyExposurePct:      Math.round(familyPct * 100) / 100,
        candidateMaintPct:      c.maintenancePct,
        candidateMaintSource:   c.maintenancePctSource,
      },
    ));
  }

  return signals;
}

// ─── Main engine ─────────────────────────────────────────────────────────────

export function runSignalEngine(inputs: EngineInputs): EngineResult {
  const generatedAt = new Date().toISOString();
  const now         = Date.parse(generatedAt);
  const makeSignal  = makeSignalFactory(generatedAt);

  const valuation = valuePortfolio(inputs.positions, inputs.cash, inputs.marginDebt, inputs.prices);
  const inDefense = valuation.equityRatio <= CONFIG.DEFENSE_EQUITY_RATIO;
  const spyNow    = inputs.spyHistory[inputs.spyHistory.length - 1] ?? 0;

  // Start from the previous state — each rule mutates a copy of the slice it owns.
  const nextState: SignalEngineState = {
    ...inputs.state,
    defenseMode: { ...inputs.state.defenseMode },
    killSwitch:  { ...inputs.state.killSwitch },
    pivot:       { ...inputs.state.pivot },
    afwThisMonth: { ...inputs.state.afwThisMonth },
  };

  const all: TradeSignal[] = [];

  // 1. Defense mode — also updates gate flag in nextState.
  all.push(...evalDefenseMode(valuation, makeSignal));
  nextState.defenseMode = {
    active:      inDefense,
    since:       inDefense
                   ? (inputs.state.defenseMode.active ? inputs.state.defenseMode.since : now)
                   : null,
    equityRatio: valuation.equityRatio,
  };

  // 2. AFW trigger — fires only when not in defense.
  const afw = evalAfwTrigger(inputs.spyHistory, valuation, inDefense, makeSignal);
  all.push(...afw.signals);
  if (afw.fired) {
    nextState.afwThisMonth = {
      month: currentYearMonth(),
      fired: true,
    };
  }

  // 3. Airbag — sole owner of SPXU/SQQQ sizing.
  all.push(...evalAirbag(inputs.vix, inputs.spyHistory, valuation, makeSignal));

  // 4. CLM/CRF trim — buy side cut.
  all.push(...evalClmCrf(valuation, makeSignal));

  // 5. Pivot — both deadline alerts and the +5% recovery trigger.
  const pivot = evalPivot(inputs.spyHistory, inputs.state.pivot, makeSignal);
  all.push(...pivot.signals);
  nextState.pivot = {
    ...nextState.pivot,
    spyLowSincePivot: pivot.nextSpyLow,
  };

  // 6. Margin kill switch — only evaluates at month boundary. Sticky once
  //    tripped (cleared manually via a future admin endpoint).
  const kill = evalMarginKillSwitch(inputs.marginDebt, inputs.state, makeSignal);
  all.push(...kill.signals);
  if (kill.tripped) {
    nextState.killSwitch = {
      active: true,
      since:  inputs.state.killSwitch.active ? inputs.state.killSwitch.since : now,
      reason: kill.reason,
    };
  }
  // Note: we do NOT auto-clear killSwitch here — clearing is manual.

  // 7. Leverage reduction — ALERT-only (no SELL).
  all.push(...evalLeverageReduction(valuation, makeSignal));

  // 8. Freedom ratio.
  all.push(...evalFreedomRatio(inputs.state.freedomRatioHistory, makeSignal));

  // 9. (Phase 2) Maintenance-ranked margin-relief trim. Gated by inDefense and
  //    killSwitchActive — both are dominant when active.
  all.push(...evalMaintenanceRankedTrim(
    inputs.positions, valuation, inDefense, nextState.killSwitch.active, makeSignal,
  ));

  // 10. (Phase 2) Pillar-fill new-position suggestions. Requires pillarTargets;
  //     gated by inDefense and killSwitchActive. Income pillar only.
  const buyingPowerAvail = inputs.buyingPowerAvailable ?? Math.max(0, inputs.cash);
  all.push(...evalPillarFill(
    inputs.positions,
    valuation,
    inputs.pillarTargets,
    buyingPowerAvail,
    inDefense,
    nextState.killSwitch.active,
    inputs.recentSells30d ?? [],
    makeSignal,
  ));

  // Update prevMonth at month boundary (snapshot current margin for next month's
  // kill-switch comparison).
  const thisMonth = currentYearMonth();
  if (!inputs.state.prevMonth || inputs.state.prevMonth.month !== thisMonth) {
    nextState.prevMonth = { month: thisMonth, margin: inputs.marginDebt };
  }
  nextState.lastRunAt = now;

  // Sort by priority.
  const order: Record<SignalPriority, number> = {
    CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4,
  };
  all.sort((a, b) => order[a.priority] - order[b.priority]);

  const actionableTrades = all.filter((s) =>
    s.direction === 'BUY' || s.direction === 'SELL' || s.direction === 'REBALANCE',
  );
  const alerts = all.filter((s) => s.direction === 'ALERT' && s.priority !== 'INFO');
  const info   = all.filter((s) => s.direction === 'INFO' || s.priority === 'INFO');

  return {
    generatedAt,
    marketSnapshot: {
      spy:        spyNow,
      vix:        inputs.vix,
      spyHistory: inputs.spyHistory.slice(-25),
      timestamp:  generatedAt,
    },
    valuation,
    signals:          all,
    actionableTrades,
    alerts,
    info,
    inDefenseMode:    inDefense,
    killSwitchActive: nextState.killSwitch.active,
    nextState,
  };
}
