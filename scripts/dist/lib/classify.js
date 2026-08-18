"use strict";
/**
 * Triple C's portfolio classification engine.
 * Assigns each position its pillar based on the strategy rules from the e-guides.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFundFamily = exports.PILLAR_LABELS = exports.GROWTH_ANCHORS = exports.INCOME_SYMBOLS = exports.INVERSE_SYMBOLS = exports.CORNERSTONE_SYMBOLS = exports.TRIPLES_SYMBOLS = void 0;
exports.classifySymbol = classifySymbol;
exports.enrichPositions = enrichPositions;
exports.summarizeByPillar = summarizeByPillar;
exports.getFundFamilyConcentrations = getFundFamilyConcentrations;
exports.getTaxHarvestCandidates = getTaxHarvestCandidates;
exports.checkMarginRules = checkMarginRules;
const fund_metadata_1 = require("./data/fund-metadata");
// ─── Symbol classification lists ──────────────────────────────────────────────
/** Triple leveraged ETFs — index-tied, long, ~15-20% of portfolio */
exports.TRIPLES_SYMBOLS = new Set([
    'UPRO', 'TQQQ', 'SPXL', 'UDOW', 'TECL', 'SOXL',
    'FNGU', 'LABU', 'TNA', 'FAS',
    'UMDD', 'URTY', 'CURE', 'HIBL',
]);
/** Cornerstone — CLM/CRF only. DRIP at NAV is the key mechanic. */
exports.CORNERSTONE_SYMBOLS = new Set([
    'CLM', 'CRF',
]);
/** Short / inverse ETFs and put hedges */
/**
 * Inverse and volatility instruments. Formerly the `hedge` pillar; folded into
 * Leveraged with the 2026-07 P2P taxonomy change. Kept as a named set because
 * several call sites still need to identify "this is a short/inverse position"
 * independently of which bucket it is filed under.
 */
exports.INVERSE_SYMBOLS = new Set([
    'SPXU', 'SQQQ', 'SDOW', 'FAZ', 'SRTY', 'SPXS',
    'SH', 'PSQ', 'DOG', 'UVXY', 'SOXS', 'FNGD',
]);
/** Income ETF families — Yieldmax, Defiance, Roundhill, RexShares, NEOS, and known high-yielders */
exports.INCOME_SYMBOLS = new Set([
    // Yieldmax
    'TSLY', 'NVDY', 'AMZY', 'GOOGY', 'MSFO', 'APLY', 'OARK', 'JPMO',
    'CONY', 'MSFO', 'NFLY', 'AMZY', 'GOOGY', 'DISO', 'SQY', 'SMCY',
    'YMAX', 'YMAG', 'ULTY', 'DIPS', 'CRSH',
    'MSTY', 'PLTY', 'GDXY',
    // GraniteShares YieldBOOST
    'TSYY',
    // Defiance
    'QQQY', 'JEPY', 'IWMY', 'DEFI', 'WDTE', 'BDTE', 'IDTE', 'QDTU',
    // Roundhill
    'XDTE', 'QDTE', 'RDTE', 'YBTC', 'WEEK', 'RDTE', 'TOPW', 'BRKW',
    // RexShares
    'FEPI', 'AIPI',
    // NEOS high-income
    'QQQI', 'SPYI', 'BTCI', 'NIHI', 'IAUI',
    // Kurv enhanced income
    'KSLV',
    // Other high-dividend income
    'JEPI', 'JEPQ', 'DIVO', 'SCHD', 'BST', 'STK', 'BDJ', 'EOS',
    'USA', 'GOF', 'PTY', 'RIV', 'OXLC', 'KLIP',
    'CHW', 'CSQ', 'EXG', 'ETV', 'GDV',
    // BlackRock closed-end income
    'ECAT',
    // REIT income
    'O',
    // Newer income ETFs from Vol 7
    'IQQQ', 'SPYT', 'XPAY', 'MAGY', 'FNGA', 'FNGB',
    // Bond funds
    'AGG', 'BND', 'TLT', 'IEF', 'SGOV', 'USFR',
    // YieldMax (additional variants)
    'AIYY', 'AMDY', 'AMZY2', 'BIOY', 'CVNY', 'FBY', 'FIAT', 'FIVY',
    'MRNY', 'MSFO2', 'NFLXY', 'OILY', 'PYPLY', 'SNOY', 'TSMY', 'XOMO',
    // Defiance (additional)
    'DFNV', 'QDTY', 'SDTY', 'IWMY2',
    // Roundhill (additional)
    'MDTE',
    // RexShares (additional)
    'REXQ', 'REXS', 'SPYI2',
    // Neos (additional)
    'QDVO', 'JPEI', 'IWMI',
    // Global X covered-call / leveraged income
    'DJIA', 'NVDL', 'TSLL', 'QYLD', 'RYLD', 'XYLD',
    // PIMCO CEFs
    'PCN', 'PDI', 'PDO', 'PFL', 'PFN', 'PHK',
    // Eaton Vance CEFs
    'EOI', 'ETB', 'EVT',
    // BlackRock CEFs (additional)
    'BCAT', 'BGY', 'BUI',
    // Amplify
    'BLOK', 'COWS',
    // Oxford Lane
    'OXSQ',
    // RiverNorth
    'OPP',
    // Liberty All-Star
    'LICT',
    // Gabelli
    'GAB', 'GGT',
    // Invesco (additional)
    'QQQM', 'RSP',
    // KraneShares
    'KMLM',
    // BDC income
    'TPVG',
]);
/** Growth anchors — treated as income/core layer */
exports.GROWTH_ANCHORS = new Set([
    'QQQ', 'SPYG', 'NVDA', 'MSFT', 'AAPL', 'AMZN', 'GOOGL', 'META',
    'SPY', 'VOO', 'IVV', 'VTI', 'VGT',
    // Quality / consumer / conglomerate anchors
    'MCD', 'COST', 'BRK.B', 'MSTR',
    // Gold / precious metals anchors
    'KGC', 'AAAU', 'GLD', 'IAU',
    // Defense anchor
    'ITA',
    // Broad index / ETF anchors (additional)
    'IWM', 'SCHB', 'SCHG', 'VXUS', 'VYM',
]);
// ─── Classifier ───────────────────────────────────────────────────────────────
function classifySymbol(symbol) {
    const s = symbol.toUpperCase();
    // Canonical metadata wins. The legacy sets below are kept only as a fallback
    // for symbols that haven't been added to the canonical table yet (and as a
    // mental cross-reference for the strategy). When the canonical table and the
    // legacy sets disagree, the canonical table is authoritative — Phase 1
    // consolidation made it the single source of truth.
    const meta = (0, fund_metadata_1.getFundMetadata)(s);
    if (meta)
        return meta.pillar;
    if (exports.TRIPLES_SYMBOLS.has(s))
        return 'triples';
    if (exports.CORNERSTONE_SYMBOLS.has(s))
        return 'cornerstone';
    // Inverse and volatility instruments live in Leveraged under the P2P
    // taxonomy — they are leveraged directional bets, not growth anchors.
    if (exports.INVERSE_SYMBOLS.has(s))
        return 'triples';
    if (exports.GROWTH_ANCHORS.has(s))
        return 'growth';
    if (exports.INCOME_SYMBOLS.has(s))
        return 'income';
    // Options: classify based on instrument asset type downstream
    return 'other';
}
/** User-facing bucket names, P2P vocabulary. */
exports.PILLAR_LABELS = {
    growth: 'Growth',
    cornerstone: 'CEFs',
    income: 'High Yield',
    triples: 'Leveraged',
    other: 'Other',
};
/**
 * True during regular US equity market hours (Mon–Fri 09:30–16:00 ET).
 *
 * Quote-derived day change is only meaningful inside this window. Schwab's
 * `lastPrice` carries extended-hours prints, and after 16:00 ET they roll
 * `closePrice` forward to the session that just ended — so outside RTH the
 * two operands stop describing the same interval and subtracting them is
 * meaningless. Market holidays are not modelled; on a closed weekday the
 * fallback is Schwab's own field, which is what the account page shows.
 */
function isRegularMarketHours(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = get('weekday');
    if (weekday === 'Sat' || weekday === 'Sun')
        return false;
    // hour12:false yields '24' for midnight on some ICU builds.
    const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
    return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
// ─── Position enrichment ──────────────────────────────────────────────────────
function enrichPositions(positions, quotes, totalPortfolioValue, 
/**
 * Clock used for the regular-hours gate on quote-derived day change.
 * Injectable so the behaviour is deterministic under test — the gate is
 * wall-clock dependent and cannot be expressed by fixture data alone.
 */
now = new Date()) {
    return positions.map((pos) => {
        const symbol = pos.instrument.symbol;
        const quote = quotes[symbol]?.quote;
        const currentValue = pos.marketValue;
        // ─── Cost basis & unrealized P/L ────────────────────────────────────────
        // Two failure modes this replaces:
        //   1. Options were basis'd as `averagePrice × quantity` with no ×100
        //      contract multiplier, while `marketValue` IS multiplied — so every
        //      option leg's P/L was off by ~100×.
        //   2. Short positions have `longQuantity === 0`, so basis came out 0 and
        //      gainLoss collapsed to `marketValue` (negative for a short) — every
        //      short leg booked a phantom 100% loss.
        // Sign convention matches lib/options/afw-close-recs.ts: long basis is
        // positive (capital out), short basis is negative (credit in), and
        // gainLoss = marketValue − costBasis works for both directions.
        const isOption = pos.instrument.assetType === 'OPTION';
        const multiplier = isOption ? 100 : 1;
        const longQty = pos.longQuantity ?? 0;
        const shortQty = pos.shortQuantity ?? 0;
        const netQty = longQty - shortQty;
        const longAvg = pos.averageLongPrice || pos.averagePrice || 0;
        const shortAvg = pos.averageShortPrice || pos.averagePrice || 0;
        const costBasis = (longQty * longAvg - shortQty * shortAvg) * multiplier;
        // Prefer Schwab's own open-P/L fields — they are dollar-denominated,
        // multiplier-applied, and computed off real tax lots rather than a blended
        // average. Gate each on having quantity on that side, because Schwab
        // returns a literal 0 for the side you don't hold.
        const schwabLongPL = longQty > 0 && typeof pos.longOpenProfitLoss === 'number' ? pos.longOpenProfitLoss : undefined;
        const schwabShortPL = shortQty > 0 && typeof pos.shortOpenProfitLoss === 'number' ? pos.shortOpenProfitLoss : undefined;
        const schwabPL = schwabLongPL !== undefined || schwabShortPL !== undefined
            ? (schwabLongPL ?? 0) + (schwabShortPL ?? 0)
            : undefined;
        const gainLossFromSchwab = schwabPL !== undefined;
        const gainLoss = schwabPL ?? (currentValue - costBasis);
        // Denominator is |basis| so a short's credit produces a positive,
        // meaningful percentage instead of a negative or divide-by-zero.
        const basisMagnitude = Math.abs(costBasis);
        const gainLossPercent = basisMagnitude > 0 ? (gainLoss / basisMagnitude) * 100 : 0;
        const portfolioPercent = totalPortfolioValue > 0
            ? (currentValue / totalPortfolioValue) * 100
            : 0;
        // For options, classify by underlying symbol and position direction.
        // Option symbols look like "SPXU  250117P00040000" or "TQQQ250620C00080000"
        let pillar = classifySymbol(symbol);
        if (pos.instrument.assetType === 'OPTION') {
            if (pillar !== 'other') {
                // Keep the underlying's pillar (e.g. a TQQQ call stays in 'triples')
            }
            else {
                // Unknown underlying — use direction to infer intent:
                //   short quantity = sold put/call (income strategy)  → income
                //   long put = protective hedge                       → hedge
                //   long call = speculative / income long             → income
                const isLongPut = pos.longQuantity > 0 && symbol.toUpperCase().includes('P');
                const isShortPos = pos.shortQuantity > 0;
                if (isLongPut) {
                    // Protective puts are the insurance layer. With `hedge` retired they
                    // sit in Leveraged, which is where the other directional-protection
                    // instruments now live.
                    pillar = 'triples';
                }
                else if (isShortPos) {
                    pillar = 'income'; // short puts/calls = premium income
                }
                else {
                    pillar = 'income'; // long calls = speculative income layer
                }
            }
        }
        // ─── Today's gain/loss ──────────────────────────────────────────────────
        // Quote math ((last − prevClose) × qty) is preferred for positions held
        // unchanged since the previous session: Schwab's `currentDayProfitLoss`
        // can lag intraday and goes stale out of hours.
        //
        // But it is WRONG for anything opened or resized today — shares bought
        // this morning did not earn the move from yesterday's close, and a
        // position opened today has no previous-session quantity at all. For
        // those, Schwab's field is the only correct source. Options additionally
        // need the ×100 multiplier the old code omitted.
        const prevLongQty = pos.previousSessionLongQuantity ?? 0;
        const prevShortQty = pos.previousSessionShortQuantity ?? 0;
        const quantityChangedToday = prevLongQty !== longQty || prevShortQty !== shortQty;
        // Schwab's `currentDayProfitLoss` is PRIMARY. The website's "Total day
        // change" is precisely the sum of this field across positions, so using it
        // makes the dashboard agree with the account page by construction.
        //
        // This deliberately reverses an older assumption that quote math was "more
        // reliable than Schwab's field". Measured against a real account on
        // 2026-08-03, quote math returned +$1,259 while Schwab reported -$2,732 —
        // wrong magnitude AND wrong sign. Three compounding reasons:
        //   • `regularMarketNetChange` is not in the `quote` object at all. It
        //     lives in a top-level `regular` block that `fields=quote,reference`
        //     never requests, so that branch was always undefined.
        //   • `netChange` / `lastPrice` include extended-hours prints; after 16:00
        //     ET Schwab also rolls `closePrice` forward to the session that just
        //     ended, so the two operands stop describing the same interval.
        //   • Options are filtered out of the quote fetch entirely, so any option
        //     leg contributed nothing to the quote-derived total.
        // Schwab's own field has none of these problems.
        //
        // Quote math survives only as a fallback for positions where Schwab omits
        // the field. `netQty` is signed (short → negative), so a price rise
        // correctly registers as a loss, and `multiplier` applies the option ×100.
        // Two independent sources, cross-checked rather than one trusted blindly:
        //
        //   quote math    (lastPrice − closePrice) × netQty × multiplier
        //   Schwab field  pos.currentDayProfitLoss
        //
        // Quote math is PRIMARY inside regular hours. Reconciled against a Schwab
        // positions export on 2026-08-18: quote math reproduced the account page
        // on 153 of 155 equity rows, residuals under $0.75 and explained by
        // Schwab rounding its own published day %. `currentDayProfitLoss` was
        // corrupt on nine — QDTE off by −$16,322, CRF +$10,584, CLM +$5,781, and
        // six CEFs each off by almost exactly −$700 regardless of position size.
        // Summed, the field put the book at −$5,484 against Schwab's −$1,565.
        //
        // This reverses the 2026-08-03 decision to trust the field outright, but
        // keeps every constraint that decision was built on:
        //   • Options are excluded from the quote fetch, so they have no quote and
        //     still fall through to the field — that is why 2026-08-03's quote
        //     total was wrong, and it stays fixed.
        //   • `lastPrice` includes extended-hours prints and `closePrice` rolls
        //     forward after 16:00 ET, so quote math is gated on regular hours.
        //   • A position resized today has no single quantity both operands
        //     describe, so it also falls through to the field.
        let quoteDerived;
        let quoteBase;
        if (quote && quote.closePrice > 0 && quote.lastPrice > 0
            && !quantityChangedToday && isRegularMarketHours(now)) {
            quoteDerived = (quote.lastPrice - quote.closePrice) * netQty * multiplier;
            quoteBase = Math.abs(quote.closePrice * netQty * multiplier);
        }
        const schwabDay = typeof pos.currentDayProfitLoss === 'number' && Number.isFinite(pos.currentDayProfitLoss)
            ? pos.currentDayProfitLoss
            : undefined;
        const todayGainLossSource = quoteDerived !== undefined ? 'quote'
            : schwabDay !== undefined ? 'schwab'
                : 'none';
        const todayGainLoss = quoteDerived !== undefined ? quoteDerived
            : schwabDay !== undefined ? schwabDay
                : 0;
        // Surface disagreement instead of silently preferring one source. A field
        // nobody was checking is what put $3,919 of phantom loss on the book.
        if (quoteDerived !== undefined && schwabDay !== undefined) {
            const tolerance = Math.max(25, Math.abs(currentValue) * 0.02);
            if (Math.abs(quoteDerived - schwabDay) > tolerance) {
                console.warn(`[day-change] ${symbol}: quote math ${quoteDerived.toFixed(2)} vs ` +
                    `Schwab currentDayProfitLoss ${schwabDay.toFixed(2)} ` +
                    `on a ${currentValue.toFixed(2)} position — using quote math`);
            }
        }
        // ─── Today's gain/loss as a PERCENTAGE ──────────────────────────────────
        // PositionsView and DashboardOverview each used to derive this themselves
        // as `todayGainLoss / (marketValue - todayGainLoss)`, and both were wrong
        // for the same reason: `marketValue` counts shares bought this session
        // while `todayGainLoss` measures those shares from their fill price, so
        // the two operands describe different position sizes.
        //
        //   • Added to a position today  → denominator inflates by the new
        //     capital, percentage shrinks toward nothing.
        //   • Opened a position today    → denominator collapses toward zero,
        //     percentage explodes into nonsense.
        //
        // The percentage must come from the SAME source as the dollars, or the
        // two columns contradict each other — the exact failure this field was
        // added to fix. Quote math already knows its own base (yesterday's close
        // × the unchanged quantity), so use it directly when that is the source.
        const prevNetQty = prevLongQty - prevShortQty;
        const schwabDayPct = pos.currentDayProfitLossPercentage;
        let todayGainLossPercent;
        if (todayGainLossSource === 'quote' && quoteBase !== undefined) {
            todayGainLossPercent = quoteBase > 0 ? (todayGainLoss / quoteBase) * 100 : null;
        }
        else if (typeof schwabDayPct === 'number' && Number.isFinite(schwabDayPct)) {
            todayGainLossPercent = schwabDayPct;
        }
        else if (prevNetQty !== 0 && quote && quote.closePrice > 0) {
            const priorBase = Math.abs(quote.closePrice * prevNetQty * multiplier);
            todayGainLossPercent = priorBase > 0 ? (todayGainLoss / priorBase) * 100 : null;
        }
        else {
            // No previous-session quantity and no usable close: the position did not
            // exist yesterday, so a day percentage is undefined. Say so.
            todayGainLossPercent = null;
        }
        // Pull family + maintenance from the canonical metadata table. Options
        // borrow the underlying's metadata where possible; unknowns fall through
        // as undefined and consumers should treat that as "no data".
        const underlyingSymbol = symbol.split(/\s|[0-9]/)[0]?.toUpperCase() ?? symbol;
        const meta = (0, fund_metadata_1.getFundMetadata)(underlyingSymbol);
        return {
            ...pos,
            pillar,
            quote,
            currentValue,
            costBasis,
            gainLoss,
            gainLossPercent,
            gainLossFromSchwab,
            portfolioPercent,
            todayGainLoss,
            todayGainLossPercent,
            todayGainLossSource,
            ...(meta
                ? {
                    family: meta.family,
                    maintenancePct: meta.maintenancePct,
                    maintenancePctSource: meta.maintenancePctSource,
                }
                : {}),
        };
    });
}
function summarizeByPillar(positions, totalValue) {
    const map = new Map();
    const pillars = ['growth', 'cornerstone', 'income', 'triples', 'other'];
    for (const p of pillars) {
        map.set(p, {
            pillar: p,
            label: exports.PILLAR_LABELS[p],
            totalValue: 0,
            portfolioPercent: 0,
            positionCount: 0,
            dayGainLoss: 0,
        });
    }
    for (const pos of positions) {
        const entry = map.get(pos.pillar);
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
var fund_metadata_2 = require("./data/fund-metadata");
Object.defineProperty(exports, "getFundFamily", { enumerable: true, get: function () { return fund_metadata_2.getFundFamily; } });
const fund_metadata_3 = require("./data/fund-metadata");
/** Summarizes income-family concentration (excludes 'Other') */
function getFundFamilyConcentrations(positions, totalValue) {
    const map = new Map();
    for (const pos of positions) {
        const family = (0, fund_metadata_3.getFundFamily)(pos.instrument.symbol);
        if (family === 'Other')
            continue;
        if (!map.has(family)) {
            map.set(family, { family, totalValue: 0, portfolioPercent: 0, symbols: [] });
        }
        const entry = map.get(family);
        entry.totalValue += pos.marketValue;
        entry.symbols.push(pos.instrument.symbol);
    }
    for (const entry of map.values()) {
        entry.portfolioPercent = totalValue > 0 ? (entry.totalValue / totalValue) * 100 : 0;
    }
    return [...map.values()].sort((a, b) => b.portfolioPercent - a.portfolioPercent);
}
/**
 * Returns income/cornerstone positions (not triples) with unrealized loss ≤ -threshold%.
 * Triples are excluded — those should be held through drawdowns per strategy rules.
 */
function getTaxHarvestCandidates(positions, thresholdPct = 10) {
    return positions
        .filter((p) => p.pillar !== 'triples' &&
        p.longQuantity > 0 &&
        p.gainLossPercent <= -thresholdPct)
        .map((p) => ({
        symbol: p.instrument.symbol,
        pillar: p.pillar,
        gainLossPct: parseFloat(p.gainLossPercent.toFixed(2)),
        gainLossDollars: parseFloat(p.gainLoss.toFixed(2)),
        marketValue: p.marketValue,
    }))
        .sort((a, b) => a.gainLossPct - b.gainLossPct); // worst losses first
}
function checkMarginRules(equity, marginBalance, positions) {
    const alerts = [];
    const totalValue = equity + Math.abs(marginBalance);
    const marginPct = totalValue > 0 ? (Math.abs(marginBalance) / totalValue) * 100 : 0;
    // Three-tier margin rule (Vol 3): 20% warn → 30% critical → 50% MAX emergency
    if (marginPct > 50) {
        alerts.push({ level: 'danger', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — ABOVE 50% EMERGENCY MAX. Reduce immediately.` });
    }
    else if (marginPct > 30) {
        alerts.push({ level: 'danger', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — above 30% target. Critical — reduce exposure.` });
    }
    else if (marginPct > 20) {
        alerts.push({ level: 'warn', rule: 'Margin Limit', detail: `Margin at ${marginPct.toFixed(1)}% — approaching 30% limit. Monitor closely.` });
    }
    else {
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
        }
        else if (pos.portfolioPercent > 15) {
            alerts.push({
                level: 'warn',
                rule: 'Concentration Cap',
                detail: `${pos.instrument.symbol} is ${pos.portfolioPercent.toFixed(1)}% of portfolio — approaching 20% cap.`,
            });
        }
    }
    return alerts;
}
