/**
 * Triple C's portfolio classification engine.
 * Assigns each position its pillar based on the strategy rules from the e-guides.
 */

import type { SchwabPosition, EnrichedPosition, PillarType, SchwabQuotesResponse } from './schwab/types';

// ─── Symbol classification lists ──────────────────────────────────────────────

/** Triple leveraged ETFs — index-tied, long, ~15-20% of portfolio */
export const TRIPLES_SYMBOLS = new Set([
  'UPRO', 'TQQQ', 'SPXL', 'UDOW', 'TECL', 'SOXL',
  'FNGU', 'LABU', 'TNA', 'FAS',
]);

/** Cornerstone — CLM/CRF only. DRIP at NAV is the key mechanic. */
export const CORNERSTONE_SYMBOLS = new Set([
  'CLM', 'CRF',
]);

/** Short / inverse ETFs and put hedges */
export const HEDGE_SYMBOLS = new Set([
  'SPXU', 'SQQQ', 'SDOW', 'FAZ', 'SRTY', 'SPXS',
  'SH', 'PSQ', 'DOG', 'UVXY', 'SOXS',
]);

/** Income ETF families — Yieldmax, Defiance, Roundhill, RexShares, and known high-yielders */
export const INCOME_SYMBOLS = new Set([
  // Yieldmax
  'TSLY', 'NVDY', 'AMZY', 'GOOGY', 'MSFO', 'APLY', 'OARK', 'JPMO',
  'CONY', 'MSFO', 'NFLY', 'AMZY', 'GOOGY', 'DISO', 'SQY', 'SMCY',
  'YMAX', 'YMAG', 'ULTY',
  // Defiance
  'QQQY', 'JEPY', 'IWMY', 'SPYY', 'DEFI',
  // Roundhill
  'XDTE', 'QDTE', 'RDTE', 'YBTC',
  // RexShares
  'FEPI', 'AIPI',
  // Other high-dividend income
  'JEPI', 'JEPQ', 'DIVO', 'SCHD', 'BST', 'STK', 'BDJ', 'EOS',
  'USA', 'GOF', 'PTY', 'RIV', 'OXLC', 'KLIP',
  // Bond funds
  'AGG', 'BND', 'TLT', 'IEF', 'SGOV', 'USFR',
]);

/** Growth anchors — treated as income/core layer */
export const GROWTH_ANCHORS = new Set([
  'QQQ', 'SPYG', 'NVDA', 'MSFT', 'AAPL', 'AMZN', 'GOOGL', 'META',
  'SPY', 'VOO', 'IVV', 'VTI', 'VGT',
]);

// ─── Classifier ───────────────────────────────────────────────────────────────

export function classifySymbol(symbol: string): PillarType {
  const s = symbol.toUpperCase();
  if (TRIPLES_SYMBOLS.has(s)) return 'triples';
  if (CORNERSTONE_SYMBOLS.has(s)) return 'cornerstone';
  if (HEDGE_SYMBOLS.has(s)) return 'hedge';
  if (INCOME_SYMBOLS.has(s) || GROWTH_ANCHORS.has(s)) return 'income';
  // Options: classify based on instrument asset type downstream
  return 'other';
}

export const PILLAR_LABELS: Record<PillarType, string> = {
  triples: 'Triple Leveraged ETFs',
  cornerstone: 'Cornerstone (CLM/CRF)',
  income: 'Core / Income',
  hedge: 'Hedges / Shorts',
  other: 'Other',
};

// ─── Position enrichment ──────────────────────────────────────────────────────

export function enrichPositions(
  positions: SchwabPosition[],
  quotes: SchwabQuotesResponse,
  totalPortfolioValue: number,
): EnrichedPosition[] {
  return positions.map((pos) => {
    const symbol = pos.instrument.symbol;
    const quote = quotes[symbol]?.quote;
    const currentValue = pos.marketValue;
    const costBasis = (pos.averagePrice || pos.averageLongPrice) * pos.longQuantity;
    const gainLoss = currentValue - costBasis;
    const gainLossPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;
    const portfolioPercent = totalPortfolioValue > 0
      ? (currentValue / totalPortfolioValue) * 100
      : 0;

    // For options, classify by underlying if possible
    let pillar = classifySymbol(symbol);
    if (pillar === 'other' && pos.instrument.assetType === 'OPTION') {
      // Options used as hedges — put them in hedge pillar
      pillar = 'hedge';
    }

    return {
      ...pos,
      pillar,
      quote,
      currentValue,
      gainLoss,
      gainLossPercent,
      portfolioPercent,
    };
  });
}

// ─── Pillar allocation summary ────────────────────────────────────────────────

export interface PillarSummary {
  pillar: PillarType;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
  dayGainLoss: number;
}

export function summarizeByPillar(
  positions: EnrichedPosition[],
  totalValue: number,
): PillarSummary[] {
  const map = new Map<PillarType, PillarSummary>();

  const pillars: PillarType[] = ['triples', 'cornerstone', 'income', 'hedge', 'other'];
  for (const p of pillars) {
    map.set(p, {
      pillar: p,
      label: PILLAR_LABELS[p],
      totalValue: 0,
      portfolioPercent: 0,
      positionCount: 0,
      dayGainLoss: 0,
    });
  }

  for (const pos of positions) {
    const entry = map.get(pos.pillar)!;
    entry.totalValue += pos.marketValue;
    entry.positionCount += 1;
    entry.dayGainLoss += pos.currentDayProfitLoss ?? 0;
  }

  for (const entry of map.values()) {
    entry.portfolioPercent = totalValue > 0
      ? (entry.totalValue / totalValue) * 100
      : 0;
  }

  return [...map.values()].filter((e) => e.positionCount > 0);
}

// ─── Margin / risk rule checks ────────────────────────────────────────────────

export interface RuleAlert {
  level: 'danger' | 'warn' | 'ok';
  rule: string;
  detail: string;
}

export function checkMarginRules(
  equity: number,
  marginBalance: number,
  positions: EnrichedPosition[],
): RuleAlert[] {
  const alerts: RuleAlert[] = [];
  const totalValue = equity + Math.abs(marginBalance);
  const marginPct = totalValue > 0 ? (Math.abs(marginBalance) / totalValue) * 100 : 0;

  // Rule: never more than 30% margin (50% hard max)
  if (marginPct > 50) {
    alerts.push({ level: 'danger', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — ABOVE 50% MAX. Reduce immediately.` });
  } else if (marginPct > 30) {
    alerts.push({ level: 'warn', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — approaching 30% target. Consider reducing.` });
  } else {
    alerts.push({ level: 'ok', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — within safe range.` });
  }

  // Rule: no single position > 20% of portfolio
  for (const pos of positions) {
    if (pos.portfolioPercent > 20) {
      alerts.push({
        level: 'warn',
        rule: 'Concentration Cap',
        detail: `${pos.instrument.symbol} is ${pos.portfolioPercent.toFixed(1)}% of portfolio — exceeds 20% single-fund cap.`,
      });
    }
  }

  return alerts;
}
