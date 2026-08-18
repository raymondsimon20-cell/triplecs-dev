"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFallbackYieldPct = getFallbackYieldPct;
exports.getFundMetadata = getFundMetadata;
exports.getMaintenancePct = getMaintenancePct;
exports.getFundFamily = getFundFamily;
exports.listAll = listAll;
exports.listByPillar = listByPillar;
exports.listByFamily = listByFamily;
exports.listAiCurated = listAiCurated;
exports.listAllSymbols = listAllSymbols;
// ─── Explicit maintenance % (Triple C Vol-7 maintenance hierarchy) ───────────
/**
 * Tickers that appear in the Vol-7 maintenance hierarchy in the system prompt.
 * These are the values the strategy author personally validated. Anything not
 * in this map gets a pillar-derived default.
 *
 * Source: `lib/ai/system-prompt.ts` — MAINTENANCE HIERARCHY section.
 */
const EXPLICIT_MAINT_PCT = {
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
const DEFAULT_MAINT_PCT_BY_PILLAR = {
    triples: 75,
    income: 60,
    cornerstone: 50,
    // Growth anchors are the margin-efficient bucket — broad index and large-cap
    // names sit near the 30% end of the maintenance range, which is a large part
    // of why the bucket exists.
    growth: 35,
    other: 50,
};
const FUND_ROWS = [
    // ── Triples (3× leveraged ETFs) ─────────────────────────────────────────────
    ['UPRO', 'triples', 'ProShares', false, true],
    ['TQQQ', 'triples', 'ProShares', false, true],
    ['SPXL', 'triples', 'Direxion', false, true],
    ['UDOW', 'triples', 'ProShares', false, true],
    ['TECL', 'triples', 'Direxion', false, true],
    ['SOXL', 'triples', 'Direxion', false, true],
    ['FNGU', 'triples', 'Direxion', false, false],
    ['LABU', 'triples', 'Direxion', false, false],
    ['TNA', 'triples', 'Direxion', false, true],
    ['FAS', 'triples', 'Direxion', false, false],
    ['UMDD', 'triples', 'ProShares', false, false],
    ['URTY', 'triples', 'ProShares', false, false],
    ['CURE', 'triples', 'Direxion', false, false],
    ['HIBL', 'triples', 'Direxion', false, false],
    // ── CEFs (`cornerstone` key) ────────────────────────────────────────────────
    //
    // The bucket is closed-end funds generally, not just the Cornerstone pair.
    // CLM/CRF are the only holdings that offer DRIP at NAV — the compounding edge
    // the strategy is built around — but every CEF here trades at a NAV premium or
    // discount, and that is what earns them the bucket: the NAV scoring factor and
    // the 30%-premium trim rule only fire on this pillar. Left in High Yield they
    // were being scored as though NAV were irrelevant to them.
    //
    // Judgement calls worth revisiting: OXLC and OXSQ are credit vehicles (CLO
    // equity / BDC) and TPVG is venture debt. All three publish a NAV and trade at
    // premiums, so the NAV factor is meaningful — but their NAV behaves nothing
    // like an equity CEF's, so treat their scores with more suspicion.
    ['CLM', 'cornerstone', 'Cornerstone', true, true],
    ['CRF', 'cornerstone', 'Cornerstone', true, true],
    // ── Inverse / volatility (folded into Leveraged, 2026-07 P2P taxonomy) ──────
    ['SPXU', 'triples', 'ProShares', false, false],
    ['SQQQ', 'triples', 'ProShares', false, false],
    ['SDOW', 'triples', 'ProShares', false, false],
    ['SOXS', 'triples', 'Direxion', false, false],
    ['FNGD', 'triples', 'Direxion', false, false],
    ['SPXS', 'triples', 'Direxion', false, false],
    ['FAZ', 'triples', 'Direxion', false, false],
    ['SRTY', 'triples', 'Direxion', false, false],
    ['SH', 'triples', 'ProShares', false, false],
    ['PSQ', 'triples', 'ProShares', false, false],
    ['DOG', 'triples', 'ProShares', false, false],
    ['UVXY', 'triples', 'ProShares', false, false],
    // ── Income — YieldMax single-stock covered-call series ──────────────────────
    ['TSLY', 'income', 'YieldMax', false, true],
    ['NVDY', 'income', 'YieldMax', false, true],
    ['AMZY', 'income', 'YieldMax', false, true],
    ['GOOGY', 'income', 'YieldMax', false, true],
    ['MSFO', 'income', 'YieldMax', false, true],
    ['APLY', 'income', 'YieldMax', false, false],
    ['OARK', 'income', 'YieldMax', false, false],
    ['JPMO', 'income', 'YieldMax', false, false],
    ['CONY', 'income', 'YieldMax', false, true],
    ['NFLXY', 'income', 'YieldMax', false, false],
    ['AMDY', 'income', 'YieldMax', false, false],
    ['PYPLY', 'income', 'YieldMax', false, false],
    ['AIYY', 'income', 'YieldMax', false, true],
    ['OILY', 'income', 'YieldMax', false, false],
    ['CVNY', 'income', 'YieldMax', false, false],
    ['MRNY', 'income', 'YieldMax', false, false],
    ['SNOY', 'income', 'YieldMax', false, false],
    ['BIOY', 'income', 'YieldMax', false, false],
    ['DISO', 'income', 'YieldMax', false, false],
    ['ULTY', 'income', 'YieldMax', false, false],
    ['YMAX', 'income', 'YieldMax', false, true],
    ['YMAG', 'income', 'YieldMax', false, true],
    ['GDXY', 'income', 'YieldMax', false, false],
    ['XOMO', 'income', 'YieldMax', false, false],
    ['FBY', 'income', 'YieldMax', false, false],
    ['FIAT', 'income', 'YieldMax', false, false],
    ['FIVY', 'income', 'YieldMax', false, false],
    ['TSMY', 'income', 'YieldMax', false, false],
    ['DIPS', 'income', 'YieldMax', false, false],
    ['CRSH', 'income', 'YieldMax', false, false],
    ['KLIP', 'income', 'YieldMax', false, false],
    ['MSTY', 'income', 'YieldMax', false, false],
    ['PLTY', 'income', 'YieldMax', false, false],
    ['NFLY', 'income', 'YieldMax', false, false],
    ['SQY', 'income', 'YieldMax', false, false],
    ['SMCY', 'income', 'YieldMax', false, false],
    // ── Income — Defiance ───────────────────────────────────────────────────────
    ['QQQY', 'income', 'Defiance', false, true],
    ['IWMY', 'income', 'Defiance', false, true],
    ['JEPY', 'income', 'Defiance', false, true],
    ['QDTY', 'income', 'Defiance', false, false],
    ['SDTY', 'income', 'Defiance', false, false],
    ['DFNV', 'income', 'Defiance', false, false],
    ['DEFI', 'income', 'Defiance', false, false],
    ['BDTE', 'income', 'Defiance', false, false],
    ['IDTE', 'income', 'Defiance', false, false],
    ['QDTU', 'income', 'Defiance', false, false],
    ['YBTC', 'income', 'Defiance', false, false],
    // ── Income — Roundhill ──────────────────────────────────────────────────────
    ['XDTE', 'income', 'Roundhill', false, true],
    ['QDTE', 'income', 'Roundhill', false, true],
    ['RDTE', 'income', 'Roundhill', false, true],
    ['WDTE', 'income', 'Roundhill', false, false],
    ['MDTE', 'income', 'Roundhill', false, false],
    ['TOPW', 'income', 'Roundhill', false, false],
    ['BRKW', 'income', 'Roundhill', false, false],
    ['WEEK', 'income', 'Roundhill', false, false],
    // ── Income — RexShares ──────────────────────────────────────────────────────
    ['FEPI', 'income', 'RexShares', false, true],
    ['AIPI', 'income', 'RexShares', false, true],
    ['REXQ', 'income', 'RexShares', false, false],
    ['REXS', 'income', 'RexShares', false, false],
    // ── Income — GraniteShares / Kurv ───────────────────────────────────────────
    ['TSYY', 'income', 'GraniteShares', false, false],
    ['KSLV', 'income', 'Kurv', false, false],
    // ── Income — JPMorgan ───────────────────────────────────────────────────────
    ['JEPI', 'income', 'JPMorgan', false, true],
    ['JEPQ', 'income', 'JPMorgan', false, true],
    // ── Income — Neos ───────────────────────────────────────────────────────────
    ['SPYI', 'income', 'Neos', false, true],
    ['QDVO', 'income', 'Neos', false, true],
    ['JPEI', 'income', 'Neos', false, false],
    ['IWMI', 'income', 'Neos', false, false],
    ['QQQI', 'income', 'Neos', false, false],
    ['BTCI', 'income', 'Neos', false, false],
    ['NIHI', 'income', 'Neos', false, false],
    ['IAUI', 'income', 'Neos', false, false],
    // ── Income — Global X covered-call ──────────────────────────────────────────
    ['QYLD', 'income', 'Global X', false, false],
    ['RYLD', 'income', 'Global X', false, false],
    ['XYLD', 'income', 'Global X', false, false],
    ['DJIA', 'income', 'Global X', false, false],
    ['NVDL', 'income', 'Global X', false, false],
    ['TSLL', 'income', 'Global X', false, false],
    // ── Income — PIMCO CEFs ─────────────────────────────────────────────────────
    ['PDI', 'cornerstone', 'PIMCO', true, true],
    ['PDO', 'cornerstone', 'PIMCO', true, false],
    ['PTY', 'cornerstone', 'PIMCO', true, true],
    ['PCN', 'cornerstone', 'PIMCO', true, true],
    ['PFL', 'cornerstone', 'PIMCO', true, false],
    ['PFN', 'cornerstone', 'PIMCO', true, false],
    ['PHK', 'cornerstone', 'PIMCO', true, false],
    // ── Income — Eaton Vance CEFs ───────────────────────────────────────────────
    ['ETV', 'cornerstone', 'Eaton Vance', true, false],
    ['ETB', 'cornerstone', 'Eaton Vance', true, false],
    ['EOS', 'cornerstone', 'Eaton Vance', true, true],
    ['EOI', 'cornerstone', 'Eaton Vance', true, false],
    ['EVT', 'cornerstone', 'Eaton Vance', true, false],
    // ── Income — BlackRock CEFs ─────────────────────────────────────────────────
    ['BST', 'cornerstone', 'BlackRock', true, true],
    ['BDJ', 'cornerstone', 'BlackRock', true, true],
    ['ECAT', 'cornerstone', 'BlackRock', true, false],
    ['BGY', 'cornerstone', 'BlackRock', true, false],
    ['BCAT', 'cornerstone', 'BlackRock', true, false],
    ['BUI', 'cornerstone', 'BlackRock', true, false],
    // ── Income — Amplify ────────────────────────────────────────────────────────
    ['DIVO', 'income', 'Amplify', false, true],
    ['BLOK', 'income', 'Amplify', false, false],
    ['COWS', 'income', 'Amplify', false, false],
    // ── Income — Oxford Lane / RiverNorth / Liberty / Gabelli / Columbia ────────
    ['OXLC', 'cornerstone', 'Oxford Lane', false, false],
    ['OXSQ', 'cornerstone', 'Oxford Lane', false, false],
    ['RIV', 'cornerstone', 'RiverNorth', true, true],
    ['OPP', 'cornerstone', 'RiverNorth', false, false],
    ['USA', 'cornerstone', 'Liberty', true, true],
    ['LICT', 'income', 'Liberty', false, false],
    ['GAB', 'cornerstone', 'Gabelli', false, false],
    ['GDV', 'cornerstone', 'Gabelli', false, false],
    ['GGT', 'cornerstone', 'Gabelli', false, false],
    ['STK', 'cornerstone', 'Columbia', true, true],
    // ── Income — KraneShares / BDC / REIT ──────────────────────────────────────
    ['KMLM', 'income', 'KraneShares', false, false],
    ['TPVG', 'cornerstone', 'BDC', false, false],
    ['O', 'income', 'REIT', false, false],
    // ── Income — Vol 7 additions ────────────────────────────────────────────────
    ['IQQQ', 'income', 'Other', false, false],
    ['SPYT', 'income', 'Other', false, false],
    ['XPAY', 'income', 'Other', false, false],
    ['MAGY', 'income', 'Other', false, false],
    ['FNGA', 'income', 'Direxion', false, false],
    ['FNGB', 'income', 'Direxion', false, false],
    // ── Income — Additional CEFs ────────────────────────────────────────────────
    ['CHW', 'cornerstone', 'Other', true, false],
    ['CSQ', 'cornerstone', 'Other', true, false],
    ['EXG', 'cornerstone', 'Eaton Vance', true, false],
    ['GOF', 'cornerstone', 'Other', true, true],
    // ── Income — Bond funds ─────────────────────────────────────────────────────
    ['AGG', 'income', 'iShares', false, false],
    ['BND', 'income', 'Vanguard', false, false],
    ['TLT', 'income', 'iShares', false, false],
    ['IEF', 'income', 'iShares', false, false],
    ['SGOV', 'income', 'iShares', false, false],
    ['USFR', 'income', 'WisdomTree', false, false],
    // ── Growth: broad index anchors ─────────────────────────────────────────────
    ['QQQ', 'growth', 'Invesco', false, true],
    ['QQQM', 'growth', 'Invesco', false, true],
    ['RSP', 'growth', 'Invesco', false, false],
    ['SPY', 'growth', 'iShares', false, false],
    ['IVV', 'growth', 'iShares', false, false],
    ['IWM', 'growth', 'iShares', false, false],
    ['VTI', 'growth', 'Vanguard', false, false],
    ['VOO', 'growth', 'Vanguard', false, false],
    ['VYM', 'growth', 'Vanguard', false, true],
    ['VXUS', 'growth', 'Vanguard', false, false],
    ['SPYG', 'growth', 'Individual', false, true],
    ['SCHD', 'growth', 'Schwab', false, true],
    ['SCHG', 'growth', 'Schwab', false, false],
    ['SCHB', 'growth', 'Schwab', false, false],
    ['ITA', 'growth', 'iShares', false, false],
    ['VGT', 'growth', 'Vanguard', false, false],
    // ── Growth: individual large-cap anchors ────────────────────────────────────
    ['NVDA', 'growth', 'Individual', false, true],
    ['AAPL', 'growth', 'Individual', false, false],
    ['MSFT', 'growth', 'Individual', false, false],
    ['AMZN', 'growth', 'Individual', false, false],
    ['GOOGL', 'growth', 'Individual', false, false],
    ['META', 'growth', 'Individual', false, false],
    ['MCD', 'growth', 'Individual', false, false],
    ['COST', 'growth', 'Individual', false, false],
    ['BRK.B', 'growth', 'Individual', false, false],
    ['MSTR', 'growth', 'Individual', false, false],
    // ── Growth: gold / precious-metal anchors ───────────────────────────────────
    ['AAAU', 'growth', 'Gold', false, false],
    ['GLD', 'growth', 'Gold', false, false],
    ['IAU', 'growth', 'Gold', false, false],
    ['KGC', 'growth', 'Individual', false, false],
];
// ─── Fallback distribution yields ────────────────────────────────────────────
/**
 * Static fallback distribution yields (% annual) for the income/cornerstone
 * universe. Used by the engine's yield-aware PILLAR_FILL scoring ONLY when a
 * live Schwab `divYield` is unavailable for the symbol. These go stale —
 * covered-call fund payouts track volatility — so live data always wins.
 * Mirrors the fallback table in components/IncomeHub.tsx.
 */
const FALLBACK_YIELD_PCT = {
    // Roundhill weeklies
    XDTE: 30, QDTE: 35, RDTE: 28, WDTE: 30,
    // YieldMax
    TSLY: 55, NVDY: 50, CONY: 70, MSFO: 30, AMZY: 45, GOOGY: 25, AIYY: 35,
    YMAX: 40, YMAG: 35, ULTY: 55, JPMO: 15, APLY: 35, OARK: 45,
    // Defiance
    QQQY: 50, IWMY: 55, JEPY: 35,
    // RexShares / Neos
    FEPI: 20, AIPI: 25, SPYI: 12, QDVO: 10,
    // JPMorgan
    JEPI: 7.5, JEPQ: 9.5,
    // Cornerstone
    CLM: 18, CRF: 18,
    // CEFs
    PDI: 13, PTY: 10, PCN: 9, EOS: 8, BST: 6, BDJ: 7, RIV: 12, USA: 10,
    STK: 7, GOF: 14, OXLC: 18, KLIP: 35,
    // Dividend / broad ETFs
    DIVO: 4.5, SCHD: 3.5, VYM: 3, QQQ: 0.6, QQQM: 0.6, SPYG: 0.8, NVDA: 0.03,
};
/** Fallback distribution yield (% annual) or null when unknown. */
function getFallbackYieldPct(symbol) {
    return FALLBACK_YIELD_PCT[symbol.toUpperCase()] ?? null;
}
// ─── Build the lookup table ───────────────────────────────────────────────────
const TABLE = (() => {
    const m = new Map();
    for (const [symbol, pillar, family, drip, ai] of FUND_ROWS) {
        const explicit = EXPLICIT_MAINT_PCT[symbol];
        const maintenancePct = explicit ?? DEFAULT_MAINT_PCT_BY_PILLAR[pillar];
        const maintenancePctSource = explicit !== undefined ? 'explicit' : 'default';
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
function getFundMetadata(symbol) {
    return TABLE.get(symbol.toUpperCase()) ?? null;
}
/**
 * Maintenance percent for a symbol — explicit if known, pillar default otherwise.
 * Unknown symbols fall back to the 'other' pillar default (50%) so callers always
 * get a usable number. To distinguish "we know" from "we guessed", inspect
 * `getFundMetadata(symbol)?.maintenancePctSource`.
 */
function getMaintenancePct(symbol) {
    const meta = TABLE.get(symbol.toUpperCase());
    if (meta)
        return meta.maintenancePct;
    return DEFAULT_MAINT_PCT_BY_PILLAR.other;
}
/** Family for a symbol — 'Other' for unknowns (matches the prior behavior of getFundFamily). */
function getFundFamily(symbol) {
    return TABLE.get(symbol.toUpperCase())?.family ?? 'Other';
}
function listAll() {
    return [...TABLE.values()];
}
function listByPillar(pillar) {
    return [...TABLE.values()].filter((f) => f.pillar === pillar);
}
function listByFamily(family) {
    return [...TABLE.values()].filter((f) => f.family === family);
}
/**
 * The AI-curated subset used by the system prompt's APPROVED FUND UNIVERSE for
 * new-position suggestions. Phase 2 engine rules should prefer these when
 * proposing new buys — they're the strategy author's hand-picked candidates.
 */
function listAiCurated(pillar) {
    return [...TABLE.values()].filter((f) => f.aiCurated && (pillar === undefined || f.pillar === pillar));
}
/** All symbols in the universe (185 tickers). */
function listAllSymbols() {
    return [...TABLE.keys()];
}
