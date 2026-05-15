/**
 * Canonical fund metadata — single source of truth for the Triple C universe.
 *
 * Before this module existed, ticker classification lived in three places that
 * had drifted apart:
 *   1. `lib/classify.ts`               — pillar (TRIPLES_SYMBOLS etc.) + family (FUND_FAMILY_MAP)
 *   2. `app/api/watchlist/seed/route.ts` — pillar tagging for the broad universe
 *   3. `components/FundFamilyMonitor.tsx` — family classification map (UI)
 *
 * The maintenance-% hierarchy lived in prose inside the AI system prompt and was
 * unreachable from code — which meant the engine could not actually rank sells
 * by maintenance efficiency, the very rule the prompt instructs Claude to follow.
 *
 * This file collapses all of that into one structured table. Everything else
 * should import from here.
 *
 *   getFundMetadata(symbol)     — full record for a symbol, or null if unknown
 *   listByPillar(pillar)        — every fund in a pillar
 *   listByFamily(family)        — every fund in a family
 *   listAiCurated(pillar?)      — the curated subset the system prompt approves
 *                                 for new-position suggestions
 *   getMaintenancePct(symbol)   — explicit value if known, pillar default otherwise
 */

import type { PillarType } from '@/lib/schwab/types';

// ─── Family taxonomy ──────────────────────────────────────────────────────────

/**
 * Family names match those used by `components/FundFamilyMonitor.tsx` for its
 * concentration-cap warnings. Spaces and capitalization are preserved so the
 * canonical table can be used directly by the UI without translation.
 *
 * Note: a few labels are bucket-style rather than strict issuer names —
 * 'Individual' for single-stock holdings, 'Gold' for physical-gold ETFs — to
 * match how the concentration monitor groups exempt categories.
 */
export type FundFamily =
  | 'YieldMax'
  | 'Defiance'
  | 'Roundhill'
  | 'RexShares'
  | 'GraniteShares'
  | 'Kurv'
  | 'JPMorgan'
  | 'Neos'
  | 'Global X'
  | 'PIMCO'
  | 'Eaton Vance'
  | 'BlackRock'
  | 'Amplify'
  | 'Oxford Lane'
  | 'RiverNorth'
  | 'Liberty'
  | 'Gabelli'
  | 'Columbia'
  | 'KraneShares'
  | 'BDC'
  | 'REIT'
  | 'ProShares'
  | 'Direxion'
  | 'Cornerstone'
  | 'Invesco'
  | 'Vanguard'
  | 'Schwab'
  | 'SPDR'
  | 'iShares'
  | 'WisdomTree'
  | 'Individual'
  | 'Gold'
  | 'Other';

export interface FundMetadata {
  symbol: string;
  pillar: PillarType;
  family: FundFamily;
  /** Schwab-style maintenance requirement. % of position value that must be backed by equity. */
  maintenancePct: number;
  /** 'explicit' = sourced from the Vol-7 maintenance hierarchy; 'default' = pillar-derived fallback. */
  maintenancePctSource: 'explicit' | 'default';
  /** Cornerstone DRIP eligibility + a small number of CEFs that DRIP at NAV. */
  dripEligible: boolean;
  /**
   * True when this ticker is in the AI system prompt's APPROVED FUND UNIVERSE — the
   * curated subset used for new-position suggestions. Phase 2 rule evaluators should
   * filter by this when proposing new buys, as a safer-by-default starting point than
   * the full 185-ticker universe.
   */
  aiCurated: boolean;
}

// ─── Explicit maintenance % (Triple C Vol-7 maintenance hierarchy) ───────────

/**
 * Tickers that appear in the Vol-7 maintenance hierarchy in the system prompt.
 * These are the values the strategy author personally validated. Anything not
 * in this map gets a pillar-derived default.
 *
 * Source: `lib/ai/system-prompt.ts` — MAINTENANCE HIERARCHY section.
 */
const EXPLICIT_MAINT_PCT: Record<string, number> = {
  OXLC: 100,
  KLIP: 90,
  ULTY: 85,
  TSLY: 80,
  APLY: 80,
  OARK: 75,
  QQQY: 65,
  XDTE: 60,
  NVDY: 55,
  FEPI: 50,
  GOF: 40,
  PTY: 40,
  RIV: 40,
  DIVO: 35,
  SCHD: 30,
  JEPI: 30,
};

/**
 * Conservative pillar defaults for tickers without an explicit value.
 * Biased high (toward the "less efficient to sell" side) so buying-power math
 * does not overestimate how much equity a sell would free. The engine should
 * treat `maintenancePctSource: 'default'` as lower-confidence data.
 */
const DEFAULT_MAINT_PCT_BY_PILLAR: Record<PillarType, number> = {
  triples:     75,
  hedge:       75,
  income:      60,
  cornerstone: 50,
  other:       50,
};

// ─── Canonical fund table ─────────────────────────────────────────────────────

// Compact row form: [symbol, pillar, family, dripEligible, aiCurated]
type Row = readonly [string, PillarType, FundFamily, boolean, boolean];

const FUND_ROWS: ReadonlyArray<Row> = [
  // ── Triples (3× leveraged ETFs) ─────────────────────────────────────────────
  ['UPRO',  'triples', 'ProShares', false, true ],
  ['TQQQ',  'triples', 'ProShares', false, true ],
  ['SPXL',  'triples', 'Direxion',  false, true ],
  ['UDOW',  'triples', 'ProShares', false, true ],
  ['TECL',  'triples', 'Direxion',  false, true ],
  ['SOXL',  'triples', 'Direxion',  false, true ],
  ['FNGU',  'triples', 'Direxion',  false, false],
  ['LABU',  'triples', 'Direxion',  false, false],
  ['TNA',   'triples', 'Direxion',  false, true ],
  ['FAS',   'triples', 'Direxion',  false, false],
  ['UMDD',  'triples', 'ProShares', false, false],
  ['URTY',  'triples', 'ProShares', false, false],
  ['CURE',  'triples', 'Direxion',  false, false],
  ['HIBL',  'triples', 'Direxion',  false, false],

  // ── Cornerstone ─────────────────────────────────────────────────────────────
  ['CLM',   'cornerstone', 'Cornerstone', true, true],
  ['CRF',   'cornerstone', 'Cornerstone', true, true],

  // ── Hedge / inverse ─────────────────────────────────────────────────────────
  ['SPXU',  'hedge', 'ProShares', false, false],
  ['SQQQ',  'hedge', 'ProShares', false, false],
  ['SDOW',  'hedge', 'ProShares', false, false],
  ['SOXS',  'hedge', 'Direxion',  false, false],
  ['FNGD',  'hedge', 'Direxion',  false, false],
  ['SPXS',  'hedge', 'Direxion',  false, false],
  ['FAZ',   'hedge', 'Direxion',  false, false],
  ['SRTY',  'hedge', 'Direxion',  false, false],
  ['SH',    'hedge', 'ProShares', false, false],
  ['PSQ',   'hedge', 'ProShares', false, false],
  ['DOG',   'hedge', 'ProShares', false, false],
  ['UVXY',  'hedge', 'ProShares', false, false],

  // ── Income — YieldMax single-stock covered-call series ──────────────────────
  ['TSLY',  'income', 'YieldMax', false, true ],
  ['NVDY',  'income', 'YieldMax', false, true ],
  ['AMZY',  'income', 'YieldMax', false, true ],
  ['GOOGY', 'income', 'YieldMax', false, true ],
  ['MSFO',  'income', 'YieldMax', false, true ],
  ['APLY',  'income', 'YieldMax', false, false],
  ['OARK',  'income', 'YieldMax', false, false],
  ['JPMO',  'income', 'YieldMax', false, false],
  ['CONY',  'income', 'YieldMax', false, true ],
  ['NFLXY', 'income', 'YieldMax', false, false],
  ['AMDY',  'income', 'YieldMax', false, false],
  ['PYPLY', 'income', 'YieldMax', false, false],
  ['AIYY',  'income', 'YieldMax', false, true ],
  ['OILY',  'income', 'YieldMax', false, false],
  ['CVNY',  'income', 'YieldMax', false, false],
  ['MRNY',  'income', 'YieldMax', false, false],
  ['SNOY',  'income', 'YieldMax', false, false],
  ['BIOY',  'income', 'YieldMax', false, false],
  ['DISO',  'income', 'YieldMax', false, false],
  ['ULTY',  'income', 'YieldMax', false, false],
  ['YMAX',  'income', 'YieldMax', false, true ],
  ['YMAG',  'income', 'YieldMax', false, true ],
  ['GDXY',  'income', 'YieldMax', false, false],
  ['XOMO',  'income', 'YieldMax', false, false],
  ['FBY',   'income', 'YieldMax', false, false],
  ['FIAT',  'income', 'YieldMax', false, false],
  ['FIVY',  'income', 'YieldMax', false, false],
  ['TSMY',  'income', 'YieldMax', false, false],
  ['DIPS',  'income', 'YieldMax', false, false],
  ['CRSH',  'income', 'YieldMax', false, false],
  ['KLIP',  'income', 'YieldMax', false, false],
  ['MSTY',  'income', 'YieldMax', false, false],
  ['PLTY',  'income', 'YieldMax', false, false],
  ['NFLY',  'income', 'YieldMax', false, false],
  ['SQY',   'income', 'YieldMax', false, false],
  ['SMCY',  'income', 'YieldMax', false, false],

  // ── Income — Defiance ───────────────────────────────────────────────────────
  ['QQQY',  'income', 'Defiance', false, true ],
  ['IWMY',  'income', 'Defiance', false, true ],
  ['JEPY',  'income', 'Defiance', false, true ],
  ['QDTY',  'income', 'Defiance', false, false],
  ['SDTY',  'income', 'Defiance', false, false],
  ['DFNV',  'income', 'Defiance', false, false],
  ['DEFI',  'income', 'Defiance', false, false],
  ['BDTE',  'income', 'Defiance', false, false],
  ['IDTE',  'income', 'Defiance', false, false],
  ['QDTU',  'income', 'Defiance', false, false],
  ['YBTC',  'income', 'Defiance', false, false],

  // ── Income — Roundhill ──────────────────────────────────────────────────────
  ['XDTE',  'income', 'Roundhill', false, true ],
  ['QDTE',  'income', 'Roundhill', false, true ],
  ['RDTE',  'income', 'Roundhill', false, true ],
  ['WDTE',  'income', 'Roundhill', false, false],
  ['MDTE',  'income', 'Roundhill', false, false],
  ['TOPW',  'income', 'Roundhill', false, false],
  ['BRKW',  'income', 'Roundhill', false, false],
  ['WEEK',  'income', 'Roundhill', false, false],

  // ── Income — RexShares ──────────────────────────────────────────────────────
  ['FEPI',  'income', 'RexShares', false, true ],
  ['AIPI',  'income', 'RexShares', false, true ],
  ['REXQ',  'income', 'RexShares', false, false],
  ['REXS',  'income', 'RexShares', false, false],

  // ── Income — GraniteShares / Kurv ───────────────────────────────────────────
  ['TSYY',  'income', 'GraniteShares', false, false],
  ['KSLV',  'income', 'Kurv',          false, false],

  // ── Income — JPMorgan ───────────────────────────────────────────────────────
  ['JEPI',  'income', 'JPMorgan', false, true],
  ['JEPQ',  'income', 'JPMorgan', false, true],

  // ── Income — Neos ───────────────────────────────────────────────────────────
  ['SPYI',  'income', 'Neos', false, true ],
  ['QDVO',  'income', 'Neos', false, true ],
  ['JPEI',  'income', 'Neos', false, false],
  ['IWMI',  'income', 'Neos', false, false],
  ['QQQI',  'income', 'Neos', false, false],
  ['BTCI',  'income', 'Neos', false, false],
  ['NIHI',  'income', 'Neos', false, false],
  ['IAUI',  'income', 'Neos', false, false],

  // ── Income — Global X covered-call ──────────────────────────────────────────
  ['QYLD',  'income', 'Global X', false, false],
  ['RYLD',  'income', 'Global X', false, false],
  ['XYLD',  'income', 'Global X', false, false],
  ['DJIA',  'income', 'Global X', false, false],
  ['NVDL',  'income', 'Global X', false, false],
  ['TSLL',  'income', 'Global X', false, false],

  // ── Income — PIMCO CEFs ─────────────────────────────────────────────────────
  ['PDI',   'income', 'PIMCO', true,  true ],
  ['PDO',   'income', 'PIMCO', true,  false],
  ['PTY',   'income', 'PIMCO', true,  true ],
  ['PCN',   'income', 'PIMCO', true,  true ],
  ['PFL',   'income', 'PIMCO', true,  false],
  ['PFN',   'income', 'PIMCO', true,  false],
  ['PHK',   'income', 'PIMCO', true,  false],

  // ── Income — Eaton Vance CEFs ───────────────────────────────────────────────
  ['ETV',   'income', 'Eaton Vance', true, false],
  ['ETB',   'income', 'Eaton Vance', true, false],
  ['EOS',   'income', 'Eaton Vance', true, true ],
  ['EOI',   'income', 'Eaton Vance', true, false],
  ['EVT',   'income', 'Eaton Vance', true, false],

  // ── Income — BlackRock CEFs ─────────────────────────────────────────────────
  ['BST',   'income', 'BlackRock', true, true ],
  ['BDJ',   'income', 'BlackRock', true, true ],
  ['ECAT',  'income', 'BlackRock', true, false],
  ['BGY',   'income', 'BlackRock', true, false],
  ['BCAT',  'income', 'BlackRock', true, false],
  ['BUI',   'income', 'BlackRock', true, false],

  // ── Income — Amplify ────────────────────────────────────────────────────────
  ['DIVO',  'income', 'Amplify', false, true ],
  ['BLOK',  'income', 'Amplify', false, false],
  ['COWS',  'income', 'Amplify', false, false],

  // ── Income — Oxford Lane / RiverNorth / Liberty / Gabelli / Columbia ────────
  ['OXLC',  'income', 'Oxford Lane', false, false],
  ['OXSQ',  'income', 'Oxford Lane', false, false],
  ['RIV',   'income', 'RiverNorth', true,  true ],
  ['OPP',   'income', 'RiverNorth', false, false],
  ['USA',   'income', 'Liberty',    true,  true ],
  ['LICT',  'income', 'Liberty',    false, false],
  ['GAB',   'income', 'Gabelli',    false, false],
  ['GDV',   'income', 'Gabelli',    false, false],
  ['GGT',   'income', 'Gabelli',    false, false],
  ['STK',   'income', 'Columbia',   true,  true ],

  // ── Income — KraneShares / BDC / REIT ──────────────────────────────────────
  ['KMLM',  'income', 'KraneShares', false, false],
  ['TPVG',  'income', 'BDC',         false, false],
  ['O',     'income', 'REIT',        false, false],

  // ── Income — Vol 7 additions ────────────────────────────────────────────────
  ['IQQQ',  'income', 'Other', false, false],
  ['SPYT',  'income', 'Other', false, false],
  ['XPAY',  'income', 'Other', false, false],
  ['MAGY',  'income', 'Other', false, false],
  ['FNGA',  'income', 'Direxion', false, false],
  ['FNGB',  'income', 'Direxion', false, false],

  // ── Income — Additional CEFs ────────────────────────────────────────────────
  ['CHW',   'income', 'Other', true, false],
  ['CSQ',   'income', 'Other', true, false],
  ['EXG',   'income', 'Eaton Vance', true, false],
  ['GOF',   'income', 'Other', true, true],

  // ── Income — Bond funds ─────────────────────────────────────────────────────
  ['AGG',   'income', 'iShares', false, false],
  ['BND',   'income', 'Vanguard', false, false],
  ['TLT',   'income', 'iShares', false, false],
  ['IEF',   'income', 'iShares', false, false],
  ['SGOV',  'income', 'iShares', false, false],
  ['USFR',  'income', 'WisdomTree', false, false],

  // ── Broad index / growth anchors (income pillar in this strategy) ──────────
  ['QQQ',   'income', 'Invesco',  false, true ],
  ['QQQM',  'income', 'Invesco',  false, true ],
  ['RSP',   'income', 'Invesco',  false, false],
  ['SPY',   'income', 'iShares',  false, false],
  ['IVV',   'income', 'iShares',  false, false],
  ['IWM',   'income', 'iShares',  false, false],
  ['VTI',   'income', 'Vanguard', false, false],
  ['VOO',   'income', 'Vanguard', false, false],
  ['VYM',   'income', 'Vanguard', false, true ],
  ['VXUS',  'income', 'Vanguard', false, false],
  ['SPYG',  'income', 'Individual', false, true ],
  ['SCHD',  'income', 'Schwab',   false, true ],
  ['SCHG',  'income', 'Schwab',   false, false],
  ['SCHB',  'income', 'Schwab',   false, false],
  ['ITA',   'income', 'iShares',  false, false],
  ['VGT',   'income', 'Vanguard', false, false],

  // ── Individual stocks (treated as income pillar growth anchors) ────────────
  ['NVDA',  'income', 'Individual', false, true ],
  ['AAPL',  'income', 'Individual', false, false],
  ['MSFT',  'income', 'Individual', false, false],
  ['AMZN',  'income', 'Individual', false, false],
  ['GOOGL', 'income', 'Individual', false, false],
  ['META',  'income', 'Individual', false, false],
  ['MCD',   'income', 'Individual', false, false],
  ['COST',  'income', 'Individual', false, false],
  ['BRK.B', 'income', 'Individual', false, false],
  ['MSTR',  'income', 'Individual', false, false],

  // ── Gold / precious metals ──────────────────────────────────────────────────
  ['AAAU',  'income', 'Gold',       false, false],
  ['GLD',   'income', 'Gold',       false, false],
  ['IAU',   'income', 'Gold',       false, false],
  ['KGC',   'income', 'Individual', false, false],
];

// ─── Build the lookup table ───────────────────────────────────────────────────

const TABLE: ReadonlyMap<string, FundMetadata> = (() => {
  const m = new Map<string, FundMetadata>();
  for (const [symbol, pillar, family, drip, ai] of FUND_ROWS) {
    const explicit = EXPLICIT_MAINT_PCT[symbol];
    const maintenancePct = explicit ?? DEFAULT_MAINT_PCT_BY_PILLAR[pillar];
    const maintenancePctSource: 'explicit' | 'default' =
      explicit !== undefined ? 'explicit' : 'default';
    m.set(symbol, {
      symbol,
      pillar,
      family,
      maintenancePct,
      maintenancePctSource,
      dripEligible: drip,
      aiCurated: ai,
    });
  }
  return m;
})();

// ─── Public API ───────────────────────────────────────────────────────────────

/** Full metadata record for a symbol, or null if the symbol is not in the universe. */
export function getFundMetadata(symbol: string): FundMetadata | null {
  return TABLE.get(symbol.toUpperCase()) ?? null;
}

/**
 * Maintenance percent for a symbol — explicit if known, pillar default otherwise.
 * Unknown symbols fall back to the 'other' pillar default (50%) so callers always
 * get a usable number. To distinguish "we know" from "we guessed", inspect
 * `getFundMetadata(symbol)?.maintenancePctSource`.
 */
export function getMaintenancePct(symbol: string): number {
  const meta = TABLE.get(symbol.toUpperCase());
  if (meta) return meta.maintenancePct;
  return DEFAULT_MAINT_PCT_BY_PILLAR.other;
}

/** Family for a symbol — 'Other' for unknowns (matches the prior behavior of getFundFamily). */
export function getFundFamily(symbol: string): FundFamily {
  return TABLE.get(symbol.toUpperCase())?.family ?? 'Other';
}

export function listAll(): FundMetadata[] {
  return [...TABLE.values()];
}

export function listByPillar(pillar: PillarType): FundMetadata[] {
  return [...TABLE.values()].filter((f) => f.pillar === pillar);
}

export function listByFamily(family: FundFamily): FundMetadata[] {
  return [...TABLE.values()].filter((f) => f.family === family);
}

/**
 * The AI-curated subset used by the system prompt's APPROVED FUND UNIVERSE for
 * new-position suggestions. Phase 2 engine rules should prefer these when
 * proposing new buys — they're the strategy author's hand-picked candidates.
 */
export function listAiCurated(pillar?: PillarType): FundMetadata[] {
  return [...TABLE.values()].filter(
    (f) => f.aiCurated && (pillar === undefined || f.pillar === pillar),
  );
}

/** All symbols in the universe (185 tickers). */
export function listAllSymbols(): string[] {
  return [...TABLE.keys()];
}
