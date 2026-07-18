/**
 * Fund metadata — SOURCE OF TRUTH for symbol → pillar classification.
 * Derived from docs/RULES.md §11 (Complete Symbol Lists from Volume 7).
 */

export type Pillar = 'triples' | 'cornerstone' | 'income' | 'hedge' | 'cash' | 'unknown';

export type FundFamily =
  | 'yieldmax'
  | 'defiance'
  | 'roundhill'
  | 'rexshares'
  | 'neos'
  | 'direxion'
  | 'proshares'
  | 'cornerstone'
  | 'bond'
  | 'growth'
  | 'other';

export interface FundMeta {
  pillar: Pillar;
  family: FundFamily;
  /** Income mechanic / behavior notes from the rules doc */
  behavior?: 'sells-puts' | 'sells-calls' | 'bounce-then-decay' | 'drip-at-nav' | 'inverse-income';
  /** Sector triples decay badly — flagged so the engine can warn (RULES §2) */
  sectorTriple?: boolean;
  index?: 'SPX' | 'NDX' | 'DJI' | 'RUT' | 'OTHER';
}

const T = (family: FundFamily, extra: Partial<FundMeta> = {}): FundMeta => ({
  pillar: 'triples',
  family,
  ...extra,
});
const H = (family: FundFamily, extra: Partial<FundMeta> = {}): FundMeta => ({
  pillar: 'hedge',
  family,
  ...extra,
});
const I = (family: FundFamily, extra: Partial<FundMeta> = {}): FundMeta => ({
  pillar: 'income',
  family,
  ...extra,
});

export const FUND_METADATA: Record<string, FundMeta> = {
  // ---- Triples (long, major index preferred) ----
  UPRO: T('proshares', { index: 'SPX' }),
  TQQQ: T('proshares', { index: 'NDX' }),
  SPXL: T('direxion', { index: 'SPX' }),
  UDOW: T('proshares', { index: 'DJI' }),
  TECL: T('direxion', { sectorTriple: true }),
  SOXL: T('direxion', { sectorTriple: true }),
  FNGU: T('other', { sectorTriple: true }),
  LABU: T('direxion', { sectorTriple: true }),
  TNA: T('direxion', { index: 'RUT' }),
  FAS: T('direxion', { sectorTriple: true }),

  // ---- Hedges (inverse triples, vol) ----
  SPXU: H('proshares', { index: 'SPX' }),
  SQQQ: H('proshares', { index: 'NDX' }),
  SDOW: H('proshares', { index: 'DJI' }),
  SPXS: H('direxion', { index: 'SPX' }),
  SOXS: H('direxion', { sectorTriple: true }),
  FNGD: H('other', { sectorTriple: true }),
  FAZ: H('direxion'),
  SRTY: H('proshares', { index: 'RUT' }),
  SH: H('proshares', { index: 'SPX' }),
  PSQ: H('proshares', { index: 'NDX' }),
  DOG: H('proshares', { index: 'DJI' }),
  UVXY: H('proshares'),

  // ---- Cornerstone (CEFs, DRIP-at-NAV mechanic) ----
  CLM: { pillar: 'cornerstone', family: 'cornerstone', behavior: 'drip-at-nav' },
  CRF: { pillar: 'cornerstone', family: 'cornerstone', behavior: 'drip-at-nav' },

  // ---- Income: Yieldmax (bounce-then-decay) ----
  TSLY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  NVDY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  AMZY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  GOOGY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  MSFO: I('yieldmax', { behavior: 'bounce-then-decay' }),
  APLY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  OARK: I('yieldmax', { behavior: 'bounce-then-decay' }),
  JPMO: I('yieldmax', { behavior: 'bounce-then-decay' }),
  CONY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  NFLY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  DISO: I('yieldmax', { behavior: 'bounce-then-decay' }),
  SQY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  SMCY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  YMAX: I('yieldmax', { behavior: 'bounce-then-decay' }),
  YMAG: I('yieldmax', { behavior: 'bounce-then-decay' }),
  ULTY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  KLIP: I('yieldmax'),
  // Yieldmax inverse income (hedge tools for NVDY/TSLY)
  DIPS: I('yieldmax', { behavior: 'inverse-income' }),
  CRSH: I('yieldmax', { behavior: 'inverse-income' }),

  // ---- Income: Defiance (sells puts) ----
  QQQY: I('defiance', { behavior: 'sells-puts', index: 'NDX' }),
  JEPY: I('defiance', { behavior: 'sells-puts' }),
  IWMY: I('defiance', { behavior: 'sells-puts', index: 'RUT' }),
  DEFI: I('defiance', { behavior: 'sells-puts' }),
  WDTE: I('defiance', { behavior: 'sells-puts', index: 'SPX' }),
  BDTE: I('defiance', { behavior: 'sells-puts' }),
  IDTE: I('defiance', { behavior: 'sells-puts' }),
  QDTU: I('defiance', { behavior: 'sells-puts' }),

  // ---- Income: Roundhill (sells calls) ----
  XDTE: I('roundhill', { behavior: 'sells-calls', index: 'SPX' }),
  QDTE: I('roundhill', { behavior: 'sells-calls', index: 'NDX' }),
  RDTE: I('roundhill', { behavior: 'sells-calls', index: 'RUT' }),
  YBTC: I('roundhill', { behavior: 'sells-calls' }),
  WEEK: I('roundhill'),

  // ---- Income: RexShares (bounce-then-decay) ----
  FEPI: I('rexshares', { behavior: 'bounce-then-decay' }),
  AIPI: I('rexshares', { behavior: 'bounce-then-decay' }),

  // ---- Income: NEOS / other income ----
  SPYI: I('neos'),
  QQQI: I('neos'),
  IQQQ: I('other'),
  JEPI: I('other'),
  JEPQ: I('other'),
  DIVO: I('other'),
  SCHD: I('other'),
  BST: I('other'),
  STK: I('other'),
  BDJ: I('other'),
  EOS: I('other'),
  USA: I('other'),
  GOF: I('other'),
  PTY: I('other'),
  RIV: I('other'),
  OXLC: I('other'),
  CHW: I('other'),
  CSQ: I('other'),
  EXG: I('other'),
  ETV: I('other'),
  GDV: I('other'),
  SPYT: I('other'),
  XPAY: I('other'),
  MAGY: I('other'),
  FNGA: I('other'),
  FNGB: I('other'),

  // ---- Bond stabilizers (income pillar) ----
  AGG: I('bond'),
  BND: I('bond'),
  TLT: I('bond'),
  IEF: I('bond'),
  SGOV: I('bond'),
  USFR: I('bond'),

  // ---- Additional leveraged longs (triples pillar) ----
  URTY: T('proshares', { index: 'RUT' }),
  UMDD: T('proshares', { index: 'OTHER' }), // 3x MidCap 400 — not a major-index triple
  CURE: T('direxion', { sectorTriple: true }), // 3x healthcare — decay warning applies
  HIBL: T('direxion', { sectorTriple: true }), // 3x S&P high beta
  NVDL: T('other', { sectorTriple: true }), // leveraged single-stock (NVDA) — decay warning
  TSLL: T('direxion', { sectorTriple: true }), // leveraged single-stock (TSLA)

  // ---- Yieldmax additions ----
  MRNY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  XOMO: I('yieldmax', { behavior: 'bounce-then-decay' }),
  TSMY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  SNOY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  AIYY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  GDXY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  PLTY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  CVNY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  AMDY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  MSTY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  FBY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  BIOY: I('yieldmax', { behavior: 'bounce-then-decay' }),
  QDTY: I('yieldmax', { behavior: 'sells-calls', index: 'NDX' }), // Target 12 0DTE
  SDTY: I('yieldmax', { behavior: 'sells-calls', index: 'SPX' }),
  FIAT: I('yieldmax', { behavior: 'inverse-income' }), // short COIN

  // ---- Covered-call index ETFs (Global X et al.) ----
  QYLD: I('other', { behavior: 'sells-calls', index: 'NDX' }),
  XYLD: I('other', { behavior: 'sells-calls', index: 'SPX' }),
  RYLD: I('other', { behavior: 'sells-calls', index: 'RUT' }),
  DJIA: I('other', { behavior: 'sells-calls', index: 'DJI' }), // Global X Dow 30 covered call

  // ---- NEOS additions ----
  BTCI: I('neos'),
  IWMI: I('neos', { index: 'RUT' }),

  // ---- Income CEFs ----
  PCN: I('other'),
  PDI: I('other'),
  PDO: I('other'),
  PFN: I('other'),
  PFL: I('other'),
  PHK: I('other'),
  OPP: I('other'),
  GAB: I('other'),
  GGT: I('other'),
  EVT: I('other'),
  ETB: I('other'),
  EOI: I('other'),
  BUI: I('other'),
  BGY: I('other'),
  BCAT: I('other'),
  ECAT: I('other'),

  // ---- BDCs / other income ----
  OXSQ: I('other'),
  TPVG: I('other'),
  O: I('other'),
  QDVO: I('other'),
  COWS: I('other'),
  VYM: I('other'),
  BRKW: I('other'), // weekly payer (owner-confirmed)
  NIHI: I('other'), // income (owner-confirmed)
  TOPW: I('other'), // weekly payer (owner-confirmed)

  // ---- Commodity / stabilizers (income pillar) ----
  GLD: I('other'),
  IAU: I('other'),
  AAAU: I('other'),
  IAUI: I('other'), // gold-linked income (owner-confirmed)
  KSLV: I('other'), // VERIFY: silver-linked, pending confirmation
  KMLM: I('other'), // managed futures stabilizer

  // ---- Growth anchors (income/core pillar) ----
  SCHG: I('growth'),
  SCHB: I('growth'),
  RSP: I('growth'),
  IWM: I('growth'),
  QQQM: I('growth'),
  VXUS: I('growth'),
  MCD: I('growth'),
  COST: I('growth'),
  MSTR: I('growth'),
  KGC: I('growth'),
  ITA: I('growth'),
  BLOK: I('growth'),
  QQQ: I('growth'),
  SPYG: I('growth'),
  NVDA: I('growth'),
  MSFT: I('growth'),
  AAPL: I('growth'),
  AMZN: I('growth'),
  GOOGL: I('growth'),
  META: I('growth'),
  SPY: I('growth'),
  VOO: I('growth'),
  IVV: I('growth'),
  VTI: I('growth'),
  VGT: I('growth'),
};

/** Pillar allocation targets (RULES §1). */
export const PILLAR_TARGETS: Record<Exclude<Pillar, 'cash' | 'unknown'>, number> = {
  triples: 0.10,
  cornerstone: 0.20,
  income: 0.65,
  hedge: 0.05,
};
