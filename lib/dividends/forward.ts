/**
 * Forward-dividend projection.
 *
 * Given current positions, estimate the FORWARD 12-month dividend income
 * based on each holding's current shares × per-share annual distribution.
 *
 * Preference order for each position's annual dividend:
 *   1. Schwab quote `divYield` (%) × marketValue     — most accurate when present
 *   2. Schwab quote `divAmount` × shares × frequency — for funds reporting per-payment
 *   3. Static fallback yield table                   — covered-call / CEF funds whose
 *                                                      divYield is often reported as 0
 *
 * This is the projection the AI and FIRE-gap UI should use when comparing
 * against the user's FIRE target. Do NOT use trailing 12-month realized
 * dividends for the target comparison — the portfolio may have been
 * significantly restructured in that window.
 */

import type { EnrichedPosition } from '@/lib/schwab/types';

export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export const FREQ_MAP: Record<string, Frequency> = {
  XDTE: 'weekly', QDTE: 'weekly', RDTE: 'weekly', WDTE: 'weekly', MDTE: 'weekly',

  TSLY: 'monthly', NVDY: 'monthly', AMZY: 'monthly', GOOGY: 'monthly',
  MSFO: 'monthly', CONY: 'monthly', JPMO: 'monthly', NFLXY: 'monthly',
  AMDY: 'monthly', PYPLY: 'monthly', AIYY: 'monthly', OILY: 'monthly',
  CVNY: 'monthly', MRNY: 'monthly', SNOY: 'monthly', BIOY: 'monthly',
  DISO: 'monthly', ULTY: 'monthly', YMAX: 'monthly', YMAG: 'monthly',
  FBY: 'monthly', GDXY: 'monthly', XOMO: 'monthly', TSMY: 'monthly',

  QQQY: 'monthly', IWMY: 'monthly', JEPY: 'monthly',
  QDTY: 'monthly', SDTY: 'monthly',

  FEPI: 'monthly', AIPI: 'monthly', SPYI: 'monthly', QDVO: 'monthly',
  JPEI: 'monthly', IWMI: 'monthly',

  JEPI: 'monthly', JEPQ: 'monthly',

  CLM: 'monthly', CRF: 'monthly',

  OXLC: 'monthly', PDI: 'monthly', PDO: 'monthly', PTY: 'monthly',
  PCN: 'monthly', PFL: 'monthly', PFN: 'monthly',
  ETV: 'monthly', ETB: 'monthly', EOS: 'monthly', EOI: 'monthly',
  BST: 'monthly', BDJ: 'monthly', ECAT: 'monthly',
  RIV: 'monthly', OPP: 'monthly', GOF: 'monthly',
  STK: 'monthly', USA: 'monthly', KLIP: 'monthly',

  DIVO: 'quarterly',

  QYLD: 'monthly', RYLD: 'monthly', XYLD: 'monthly',

  SCHD: 'quarterly', VYM: 'quarterly', QQQ: 'quarterly',
  SPY: 'quarterly', IVV: 'quarterly', VOO: 'quarterly', VTI: 'quarterly',
  NVDA: 'quarterly', AAPL: 'quarterly', MSFT: 'quarterly',
  SPYG: 'quarterly',

  UPRO: 'annual', TQQQ: 'annual', SPXL: 'annual', UDOW: 'annual', SQQQ: 'annual',
};

/**
 * Approximate annual distribution yields (%) for funds whose Schwab quote
 * reports divYield = 0 (common for covered-call ETFs and CEFs paying ROC).
 * Trailing 12-month estimates — use only when live quote fields are missing.
 */
export const FALLBACK_YIELDS: Record<string, number> = {
  XDTE: 30, QDTE: 35, RDTE: 28, WDTE: 30, MDTE: 28,

  TSLY: 55, NVDY: 50, CONY: 70, MSFO: 30, AMZY: 45,
  GOOGY: 25, JPMO: 15, NFLXY: 35, AMDY: 40, PYPLY: 30,
  AIYY: 35, OILY: 35, CVNY: 30, MRNY: 40, SNOY: 25,
  BIOY: 25, DISO: 30, ULTY: 55, YMAX: 40, YMAG: 35,
  FBY: 35, GDXY: 25, XOMO: 30, TSMY: 30,

  QQQY: 50, IWMY: 55, JEPY: 35, QDTY: 30, SDTY: 30,

  FEPI: 20, AIPI: 25, SPYI: 12, QDVO: 10, JPEI: 12, IWMI: 15,

  JEPI: 7.5, JEPQ: 9.5,

  CLM: 18, CRF: 18,

  OXLC: 18, PDI: 13, PDO: 12, PTY: 10, PCN: 9, PFL: 10, PFN: 10,
  ETV: 8.5, ETB: 8, EOS: 8, EOI: 8,
  BST: 6, BDJ: 7, ECAT: 9, RIV: 12, OPP: 12, GOF: 14,
  STK: 7, USA: 10, KLIP: 35,

  QYLD: 12, RYLD: 12, XYLD: 11,

  DIVO: 4.5,

  SCHD: 3.5, VYM: 3, QQQ: 0.6, SPY: 1.3, IVV: 1.3,
  VOO: 1.3, VTI: 1.3, NVDA: 0.03, AAPL: 0.5, MSFT: 0.7, SPYG: 0.8,

  UPRO: 0, TQQQ: 0, SPXL: 0, UDOW: 0, SQQQ: 0,
};

export function getFrequency(symbol: string): Frequency {
  return FREQ_MAP[symbol.toUpperCase()] ?? 'quarterly';
}

/** Forward-projected annual dividend for a single position. */
export function estimateAnnualDividend(pos: EnrichedPosition): number {
  const symbol = pos.instrument?.symbol?.toUpperCase() ?? '';

  if (pos.quote?.divYield && pos.quote.divYield > 0) {
    return pos.marketValue * (pos.quote.divYield / 100);
  }

  if (pos.quote?.divAmount && pos.quote.divAmount > 0) {
    const freq = getFrequency(symbol);
    const paymentsPerYear = freq === 'weekly' ? 52 : freq === 'monthly' ? 12 : freq === 'quarterly' ? 4 : 1;
    return pos.quote.divAmount * paymentsPerYear * pos.longQuantity;
  }

  const fallbackYield = FALLBACK_YIELDS[symbol];
  if (fallbackYield && fallbackYield > 0) {
    return pos.marketValue * (fallbackYield / 100);
  }

  return 0;
}

/** Sum forward-projected annual dividends across all positions. */
export function forwardAnnualDividends(positions: EnrichedPosition[]): number {
  let total = 0;
  for (const pos of positions) {
    if (pos.instrument?.assetType === 'OPTION') continue;
    total += estimateAnnualDividend(pos);
  }
  return total;
}
