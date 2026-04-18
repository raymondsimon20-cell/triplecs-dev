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
  'SH', 'PSQ', 'DOG', 'UVXY', 'SOXS', 'FNGD',
]);

/** Income ETF families — Yieldmax, Defiance, Roundhill, RexShares, and known high-yielders */
export const INCOME_SYMBOLS = new Set([
  // Yieldmax
  'TSLY', 'NVDY', 'AMZY', 'GOOGY', 'MSFO', 'APLY', 'OARK', 'JPMO',
  'CONY', 'MSFO', 'NFLY', 'AMZY', 'GOOGY', 'DISO', 'SQY', 'SMCY',
  'YMAX', 'YMAG', 'ULTY', 'DIPS', 'CRSH',
  // Defiance
  'QQQY', 'JEPY', 'IWMY', 'DEFI', 'WDTE', 'BDTE', 'IDTE', 'QDTU',
  // Roundhill
  'XDTE', 'QDTE', 'RDTE', 'YBTC', 'WEEK', 'RDTE',
  // RexShares
  'FEPI', 'AIPI',
  // Other high-dividend income
  'JEPI', 'JEPQ', 'DIVO', 'SCHD', 'BST', 'STK', 'BDJ', 'EOS',
  'USA', 'GOF', 'PTY', 'RIV', 'OXLC', 'KLIP', 'SPYI',
  'CHW', 'CSQ', 'EXG', 'ETV', 'GDV',
  // Newer income ETFs from Vol 7
  'IQQQ', 'QQQI', 'SPYT', 'XPAY', 'MAGY', 'FNGA', 'FNGB',
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

    // For options, classify by underlying symbol and position direction.
    // Option symbols look like "SPXU  250117P00040000" or "TQQQ250620C00080000"
    let pillar = classifySymbol(symbol);
    if (pos.instrument.assetType === 'OPTION') {
      if (pillar !== 'other') {
        // Keep the underlying's pillar (e.g. a TQQQ call stays in 'triples')
      } else {
        // Unknown underlying — use direction to infer intent:
        //   short quantity = sold put/call (income strategy)  → income
        //   long put = protective hedge                       → hedge
        //   long call = speculative / income long             → income
        const isLongPut  = pos.longQuantity  > 0 && symbol.toUpperCase().includes('P');
        const isShortPos = pos.shortQuantity > 0;
        if (isLongPut) {
          pillar = 'hedge';      // long puts are hedges
        } else if (isShortPos) {
          pillar = 'income';     // short puts/calls = premium income
        } else {
          pillar = 'income';     // long calls = speculative income layer
        }
      }
    }

    // Compute today's gain/loss from quote (more reliable than Schwab's field)
    const qty = pos.longQuantity || pos.shortQuantity || 0;
    const todayGainLoss = quote
      ? (quote.lastPrice - quote.closePrice) * qty * (pos.shortQuantity > 0 ? -1 : 1)
      : pos.currentDayProfitLoss ?? 0;

    return {
      ...pos,
      pillar,
      quote,
      currentValue,
      gainLoss,
      gainLossPercent,
      portfolioPercent,
      todayGainLoss,
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

// ─── Fund family classification ───────────────────────────────────────────────

export type FundFamily =
  | 'Yieldmax'
  | 'Defiance'
  | 'Roundhill'
  | 'RexShares'
  | 'ProShares'
  | 'Direxion'
  | 'Cornerstone'
  | 'Other';

const FUND_FAMILY_MAP: Record<string, FundFamily> = {
  // Yieldmax
  TSLY: 'Yieldmax', NVDY: 'Yieldmax', AMZY: 'Yieldmax', GOOGY: 'Yieldmax',
  MSFO: 'Yieldmax', APLY: 'Yieldmax', OARK: 'Yieldmax', JPMO: 'Yieldmax',
  CONY: 'Yieldmax', NFLY: 'Yieldmax', DISO: 'Yieldmax', SQY: 'Yieldmax',
  SMCY: 'Yieldmax', YMAX: 'Yieldmax', YMAG: 'Yieldmax', ULTY: 'Yieldmax',
  KLIP: 'Yieldmax', DIPS: 'Yieldmax', CRSH: 'Yieldmax',
  // Defiance
  QQQY: 'Defiance', JEPY: 'Defiance', IWMY: 'Defiance',
  DEFI: 'Defiance', WDTE: 'Defiance', BDTE: 'Defiance', IDTE: 'Defiance', QDTU: 'Defiance',
  // Roundhill
  XDTE: 'Roundhill', QDTE: 'Roundhill', RDTE: 'Roundhill', YBTC: 'Roundhill', WEEK: 'Roundhill',
  // RexShares
  FEPI: 'RexShares', AIPI: 'RexShares',
  // ProShares (triple long)
  UPRO: 'ProShares', TQQQ: 'ProShares', UDOW: 'ProShares',
  // Direxion (triple long + short)
  SPXL: 'Direxion', TECL: 'Direxion', SOXL: 'Direxion', LABU: 'Direxion',
  TNA: 'Direxion', FAS: 'Direxion', FNGU: 'Direxion',
  SPXS: 'Direxion', SOXS: 'Direxion', SRTY: 'Direxion', FAZ: 'Direxion',
  FNGD: 'Direxion', FNGA: 'Direxion', FNGB: 'Direxion',
  // Cornerstone
  CLM: 'Cornerstone', CRF: 'Cornerstone',
};

export function getFundFamily(symbol: string): FundFamily {
  return FUND_FAMILY_MAP[symbol.toUpperCase()] ?? 'Other';
}

export interface FundFamilyConcentration {
  family: FundFamily;
  totalValue: number;
  portfolioPercent: number;
  symbols: string[];
}

/** Summarizes income-family concentration (excludes 'Other') */
export function getFundFamilyConcentrations(
  positions: EnrichedPosition[],
  totalValue: number,
): FundFamilyConcentration[] {
  const map = new Map<FundFamily, FundFamilyConcentration>();

  for (const pos of positions) {
    const family = getFundFamily(pos.instrument.symbol);
    if (family === 'Other') continue;
    if (!map.has(family)) {
      map.set(family, { family, totalValue: 0, portfolioPercent: 0, symbols: [] });
    }
    const entry = map.get(family)!;
    entry.totalValue += pos.marketValue;
    entry.symbols.push(pos.instrument.symbol);
  }

  for (const entry of map.values()) {
    entry.portfolioPercent = totalValue > 0 ? (entry.totalValue / totalValue) * 100 : 0;
  }

  return [...map.values()].sort((a, b) => b.portfolioPercent - a.portfolioPercent);
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

  // Three-tier margin rule (Vol 3): 20% warn → 30% critical → 50% MAX emergency
  if (marginPct > 50) {
    alerts.push({ level: 'danger', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — ABOVE 50% EMERGENCY MAX. Reduce immediately.` });
  } else if (marginPct > 30) {
    alerts.push({ level: 'danger', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — above 30% target. Critical — reduce exposure.` });
  } else if (marginPct > 20) {
    alerts.push({ level: 'warn', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — approaching 30% limit. Monitor closely.` });
  } else {
    alerts.push({ level: 'ok', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — healthy range (below 20%).` });
  }

  // Position concentration: warn at 15%, hard stop at 20%
  for (const pos of positions) {
    if (pos.portfolioPercent > 20) {
      alerts.push({
        level: 'danger',
        rule: 'Concentration Cap',
        detail: `${pos.instrument.symbol} is ${pos.portfolioPercent.toFixed(1)}% of portfolio — exceeds 20% hard cap. Trim required.`,
      });
    } else if (pos.portfolioPercent > 15) {
      alerts.push({
        level: 'warn',
        rule: 'Concentration Cap',
        detail: `${pos.instrument.symbol} is ${pos.portfolioPercent.toFixed(1)}% of portfolio — approaching 20% cap.`,
      });
    }
  }

  return alerts;
}
