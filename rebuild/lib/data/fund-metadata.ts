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

  // ---- Growth anchors (income/core pillar) ----
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
