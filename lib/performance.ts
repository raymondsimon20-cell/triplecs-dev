/**
 * Performance math — pure functions, no I/O.
 *
 * The whole point of this module is to give us an honest read on how the
 * portfolio is actually doing — TWR (so deposits/withdrawals don't fake the
 * return), CAGR (so we can compare to the 40% target), pillar attribution
 * (so we know which sleeves are pulling weight), and alpha vs SPY (so we
 * know whether the active strategy is earning its complexity).
 */

import type { CashFlowEvent, PortfolioSnapshot } from './storage';

// ─── Public types ────────────────────────────────────────────────────────────

export interface PeriodReturn {
  startDate: string;
  endDate: string;
  startValue: number;
  endValue: number;
  netFlow: number;          // signed: + for inflow during period, - for outflow
  returnPct: number;        // (endValue - netFlow) / startValue - 1
}

export interface TwrResult {
  twrPct: number;           // cumulative TWR over the full window, e.g. 0.12 = +12%
  cagrPct: number;          // annualized
  periods: PeriodReturn[];
  daysCovered: number;
  /** True when at least one period had insufficient data to compute. */
  hasGaps: boolean;
}

export interface PillarAttribution {
  pillar: string;
  /** Contribution to total portfolio return, in percentage points. */
  contributionPp: number;
  /** Pillar's own return % (independent of weight). */
  returnPct: number;
  avgWeightPct: number;
}

export interface AlphaVsSPY {
  portfolioReturnPct: number;
  spyReturnPct: number;
  alphaPp: number;          // portfolio − SPY, in percentage points
}

export interface Vs40Progress {
  actualCAGR: number;
  targetCAGR: number;       // always 0.40
  gapPp: number;            // actualCAGR − targetCAGR, in percentage points (negative = behind)
  paceLabel: 'ahead' | 'on-pace' | 'behind';
  /** What return-rate would close the gap by year-end? */
  requiredForwardCAGR: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function daysBetween(startISO: string, endISO: string): number {
  return (new Date(endISO).getTime() - new Date(startISO).getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Sum cash-flow events in (startDate, endDate]. The flow is signed: deposits
 * positive, withdrawals/fees/interest negative — to subtract from end value.
 */
function netFlowInPeriod(flows: CashFlowEvent[], startDate: string, endDate: string): number {
  let net = 0;
  for (const f of flows) {
    if (f.date <= startDate) continue;
    if (f.date > endDate) continue;
    net += f.direction === 'in' ? f.amount : -f.amount;
  }
  return net;
}

// ─── TWR ─────────────────────────────────────────────────────────────────────

/**
 * Time-Weighted Return over a series of snapshots.
 *
 * For each adjacent pair (A → B), period return is computed as
 *   r = (B.totalValue - netFlow) / A.totalValue - 1
 * which strips out deposits/withdrawals so they don't get counted as performance.
 *
 * Periods are chained geometrically and annualized to CAGR using actual
 * elapsed calendar days.
 */
export function computeTWR(snapshots: PortfolioSnapshot[], cashFlows: CashFlowEvent[]): TwrResult | null {
  if (snapshots.length < 2) return null;

  // Sort ascending by savedAt (defensive — store usually already sorted)
  const sorted = [...snapshots].sort((a, b) => a.savedAt - b.savedAt);
  const periods: PeriodReturn[] = [];
  let hasGaps = false;

  for (let i = 1; i < sorted.length; i++) {
    const A = sorted[i - 1];
    const B = sorted[i];
    if (!A.totalValue || A.totalValue <= 0) { hasGaps = true; continue; }

    const startDate = toDayKey(A.savedAt);
    const endDate   = toDayKey(B.savedAt);
    const netFlow   = netFlowInPeriod(cashFlows, startDate, endDate);
    const ret       = (B.totalValue - netFlow) / A.totalValue - 1;

    periods.push({
      startDate, endDate,
      startValue: A.totalValue,
      endValue:   B.totalValue,
      netFlow,
      returnPct:  ret,
    });
  }

  if (periods.length === 0) return null;

  const twr = periods.reduce((acc, p) => acc * (1 + p.returnPct), 1) - 1;
  const days = daysBetween(periods[0].startDate, periods[periods.length - 1].endDate);
  const cagr = days > 0 ? Math.pow(1 + twr, 365 / days) - 1 : 0;

  return { twrPct: twr, cagrPct: cagr, periods, daysCovered: days, hasGaps };
}

// ─── Pillar attribution ──────────────────────────────────────────────────────

/**
 * Per-pillar contribution to total return.
 *
 * For each adjacent pair, the pillar's return for the period is computed
 * directly from its dollar value — we DO NOT subtract intra-period trades
 * here because trades just shift dollars between pillars (zero-sum), they
 * don't add or subtract from total portfolio value. The TWR-style flow
 * adjustment lives at the *portfolio* level.
 *
 * Within a period, each pillar's contribution to total return =
 *   pillarStartWeight × pillarReturn
 * Summed across periods (weighted by period length), this gives a
 * cumulative attribution that approximately reconciles with the total TWR.
 */
export function computePillarAttribution(snapshots: PortfolioSnapshot[]): PillarAttribution[] {
  if (snapshots.length < 2) return [];
  const sorted = [...snapshots].sort((a, b) => a.savedAt - b.savedAt);

  const acc = new Map<string, { contribution: number; weightSum: number; weightCount: number; geomReturn: number }>();

  for (let i = 1; i < sorted.length; i++) {
    const A = sorted[i - 1];
    const B = sorted[i];
    if (!A.totalValue || !B.totalValue) continue;

    for (const startPillar of A.pillarSummary) {
      const endPillar = B.pillarSummary.find((p) => p.pillar === startPillar.pillar);
      if (!endPillar || startPillar.totalValue <= 0) continue;

      const pillarReturn = endPillar.totalValue / startPillar.totalValue - 1;
      const weight       = startPillar.totalValue / A.totalValue;
      const contribution = weight * pillarReturn;

      const cur = acc.get(startPillar.pillar) ?? { contribution: 0, weightSum: 0, weightCount: 0, geomReturn: 1 };
      cur.contribution += contribution;
      cur.weightSum    += startPillar.portfolioPercent;
      cur.weightCount  += 1;
      cur.geomReturn   *= (1 + pillarReturn);
      acc.set(startPillar.pillar, cur);
    }
  }

  return Array.from(acc.entries())
    .map(([pillar, v]) => ({
      pillar,
      contributionPp: v.contribution * 100,
      returnPct:      (v.geomReturn - 1) * 100,
      avgWeightPct:   v.weightCount > 0 ? v.weightSum / v.weightCount : 0,
    }))
    .sort((a, b) => b.contributionPp - a.contributionPp);
}

// ─── SPY benchmark ───────────────────────────────────────────────────────────

/**
 * Cumulative return of the portfolio vs SPY over the snapshot window.
 * Requires snapshots to carry `spyClose`. Snapshots missing the field are
 * skipped on both sides so the comparison is apples-to-apples.
 */
export function computeAlphaVsSPY(snapshots: PortfolioSnapshot[], cashFlows: CashFlowEvent[]): AlphaVsSPY | null {
  const withSpy = snapshots
    .filter((s) => typeof s.spyClose === 'number' && s.spyClose > 0)
    .sort((a, b) => a.savedAt - b.savedAt);
  if (withSpy.length < 2) return null;

  const portfolioTwr = computeTWR(withSpy, cashFlows);
  if (!portfolioTwr) return null;

  const first = withSpy[0].spyClose!;
  const last  = withSpy[withSpy.length - 1].spyClose!;
  const spyReturn = last / first - 1;

  return {
    portfolioReturnPct: portfolioTwr.twrPct * 100,
    spyReturnPct:       spyReturn * 100,
    alphaPp:            (portfolioTwr.twrPct - spyReturn) * 100,
  };
}

// ─── 40% target progress ─────────────────────────────────────────────────────

/**
 * How are we tracking against the 40% annual CAGR target?
 *
 * `actualCAGR` should be the annualized return computed by `computeTWR`.
 * `daysSinceStart` is the elapsed window we're measuring over (used to
 * back out what forward CAGR would be needed to hit 40% by the
 * one-year mark from the start date).
 */
export function computeProgressVs40(actualCAGR: number, daysSinceStart: number): Vs40Progress {
  const target = 0.40;
  const gapPp  = (actualCAGR - target) * 100;

  let paceLabel: 'ahead' | 'on-pace' | 'behind';
  if (gapPp >= 2)       paceLabel = 'ahead';
  else if (gapPp >= -2) paceLabel = 'on-pace';
  else                  paceLabel = 'behind';

  let requiredForwardCAGR: number | null = null;
  if (daysSinceStart > 0 && daysSinceStart < 365) {
    // Cumulative return so far at the actualCAGR rate
    const cumReturnSoFar = Math.pow(1 + actualCAGR, daysSinceStart / 365) - 1;
    const remainingDays  = 365 - daysSinceStart;
    // Required cumulative growth over remaining year to reach 1+target overall
    const requiredFactor = (1 + target) / (1 + cumReturnSoFar);
    if (requiredFactor > 0) {
      requiredForwardCAGR = Math.pow(requiredFactor, 365 / remainingDays) - 1;
    }
  }

  return { actualCAGR, targetCAGR: target, gapPp, paceLabel, requiredForwardCAGR };
}
