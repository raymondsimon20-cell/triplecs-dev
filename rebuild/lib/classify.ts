/**
 * Canonical symbol → pillar classification.
 * Backed by lib/data/fund-metadata.ts (source of truth); legacy symbol sets
 * kept as fallback for anything not yet in the table.
 */
import { FUND_METADATA, type FundMeta, type Pillar, type FundFamily } from './data/fund-metadata';

// Legacy fallback sets (pre-metadata-table classification)
const LEGACY_TRIPLES = new Set(['UPRO', 'TQQQ', 'SPXL', 'UDOW', 'TECL', 'SOXL', 'FNGU', 'LABU', 'TNA', 'FAS']);
const LEGACY_HEDGES = new Set(['SPXU', 'SQQQ', 'SDOW', 'FAZ', 'SRTY', 'SPXS', 'SH', 'PSQ', 'DOG', 'UVXY', 'SOXS', 'FNGD']);
const LEGACY_CORNERSTONE = new Set(['CLM', 'CRF']);

const CASH_LIKE = new Set(['MMDA1', 'SWVXX', 'SNVXX', 'CASH']);

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Is this an option symbol (OCC-style, e.g. "SPY   250815P00450000")? */
export function isOptionSymbol(symbol: string): boolean {
  return /\d{6}[CP]\d{8}/.test(symbol.replace(/\s+/g, ' '));
}

export function underlyingOfOption(symbol: string): string {
  return normalizeSymbol(symbol.split(/[\s\d]/)[0]);
}

export function getMeta(symbol: string): FundMeta | null {
  return FUND_METADATA[normalizeSymbol(symbol)] ?? null;
}

/**
 * Classify a symbol into a pillar. Options classify by intent: puts on
 * long names and any position in inverse names are hedges.
 */
export function classify(symbol: string, putCall?: 'PUT' | 'CALL'): Pillar {
  const sym = normalizeSymbol(symbol);
  if (CASH_LIKE.has(sym)) return 'cash';

  if (isOptionSymbol(sym) || putCall) {
    // Put options are hedges (RULES §3, §9)
    if (putCall === 'PUT' || /\d{6}P\d{8}/.test(sym)) return 'hedge';
    const under = getMeta(underlyingOfOption(sym));
    return under?.pillar ?? 'unknown';
  }

  const meta = FUND_METADATA[sym];
  if (meta) return meta.pillar;

  // Legacy fallback
  if (LEGACY_TRIPLES.has(sym)) return 'triples';
  if (LEGACY_HEDGES.has(sym)) return 'hedge';
  if (LEGACY_CORNERSTONE.has(sym)) return 'cornerstone';
  return 'unknown';
}

export function getFamily(symbol: string): FundFamily {
  return getMeta(symbol)?.family ?? 'other';
}

export function isSectorTriple(symbol: string): boolean {
  return getMeta(symbol)?.sectorTriple === true;
}

export interface PillarBreakdown {
  values: Record<Pillar, number>;
  percents: Record<Pillar, number>;
  total: number;
}

export interface SimplePosition {
  symbol: string;
  marketValue: number;
  putCall?: 'PUT' | 'CALL';
}

export function pillarBreakdown(positions: SimplePosition[], cashValue = 0): PillarBreakdown {
  const values: Record<Pillar, number> = {
    triples: 0,
    cornerstone: 0,
    income: 0,
    hedge: 0,
    cash: cashValue,
    unknown: 0,
  };
  for (const p of positions) {
    values[classify(p.symbol, p.putCall)] += p.marketValue;
  }
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  const percents = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, total > 0 ? v / total : 0])
  ) as Record<Pillar, number>;
  return { values, percents, total };
}

/** Fund-family concentration: family → % of portfolio. */
export function familyConcentration(positions: SimplePosition[]): Record<string, number> {
  const total = positions.reduce((s, p) => s + p.marketValue, 0);
  const byFamily: Record<string, number> = {};
  for (const p of positions) {
    const fam = getFamily(p.symbol);
    byFamily[fam] = (byFamily[fam] ?? 0) + p.marketValue;
  }
  if (total > 0) {
    for (const k of Object.keys(byFamily)) byFamily[k] /= total;
  }
  return byFamily;
}
