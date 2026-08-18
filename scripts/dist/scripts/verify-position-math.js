"use strict";
/**
 * Sanity check for enrichPositions() cost-basis / P&L / day-change math.
 *
 * Guards the three bugs fixed in Aug 2026:
 *   1. Option legs missing the ×100 contract multiplier on cost basis.
 *   2. Short positions basis'd at 0 (longQuantity === 0), booking the whole
 *      market value as a loss.
 *   3. Day change computed from previous close for positions opened today.
 *
 * Run: npx tsx scripts/verify-position-math.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const classify_1 = require("../lib/classify");
function pos(p) {
    return {
        shortQuantity: 0,
        averagePrice: 0,
        currentDayProfitLoss: 0,
        currentDayProfitLossPercentage: 0,
        longQuantity: 0,
        settledLongQuantity: 0,
        settledShortQuantity: 0,
        instrument: { assetType: 'EQUITY', symbol: 'TEST' },
        marketValue: 0,
        maintenanceRequirement: 0,
        averageLongPrice: 0,
        taxLotAverageLongPrice: 0,
        longOpenProfitLoss: 0,
        previousSessionLongQuantity: 0,
        currentDayCost: 0,
        ...p,
    };
}
let failures = 0;
function check(label, actual, expected, tol = 0.01) {
    const ok = Math.abs(actual - expected) <= tol;
    if (!ok)
        failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual.toFixed(2)}, expected ${expected.toFixed(2)}`);
}
// ── Case 1: plain long equity, held since yesterday, up $2/share today ───────
// Schwab says the position is DOWN $310 today. The quote fields, polluted by
// an after-hours print, would imply +$290. We must follow Schwab.
const longEquity = pos({
    instrument: { assetType: 'EQUITY', symbol: 'UPRO' },
    longQuantity: 100, previousSessionLongQuantity: 100,
    averageLongPrice: 50, averagePrice: 50,
    marketValue: 7000, // 100 × $70
    longOpenProfitLoss: 2000,
    currentDayProfitLoss: -310,
});
// ── Case 2: SHORT put, 5 contracts sold at $3.00, now worth $1.20 ───────────
// Credit received = 5 × 3.00 × 100 = $1,500. Current liability = -$600.
// True P/L = +$900.  Old code: basis 0 → gainLoss = -600 (phantom loss).
const shortPut = pos({
    instrument: { assetType: 'OPTION', symbol: 'SOXL  260918P00020000' },
    shortQuantity: 5, previousSessionShortQuantity: 5,
    averagePrice: 3.0, averageShortPrice: 3.0,
    marketValue: -600,
    longOpenProfitLoss: 0, // Schwab zeroes the side you don't hold
});
// ── Case 3: LONG call, 2 contracts at $4.00, now $6.50 ──────────────────────
// Basis = 2 × 4.00 × 100 = $800. Value = $1,300. P/L = +$500.
// Old code: basis = 4.00 × 2 = $8 → gainLoss = $1,292.
const longCall = pos({
    instrument: { assetType: 'OPTION', symbol: 'TQQQ  260320C00080000' },
    longQuantity: 2, previousSessionLongQuantity: 2,
    averagePrice: 4.0, averageLongPrice: 4.0,
    marketValue: 1300,
    longOpenProfitLoss: 500,
});
// ── Case 4: equity BOUGHT TODAY at $95, now $96, prev close was $90 ─────────
// Real day gain = $100 (1 × 100 shares). Quote math would claim 100 × ($96−$90)
// = $600 because the shares did not exist at yesterday's close.
const boughtToday = pos({
    instrument: { assetType: 'EQUITY', symbol: 'SCHD' },
    longQuantity: 100, previousSessionLongQuantity: 0,
    averageLongPrice: 95, averagePrice: 95,
    marketValue: 9600,
    longOpenProfitLoss: 100,
    currentDayProfitLoss: 100,
});
// `lastPrice` here is deliberately an EXTENDED-HOURS print that disagrees with
// the regular session, to prove we follow Schwab's regularMarketNetChange
// rather than subtracting lastPrice - closePrice ourselves.
//   UPRO: regular session closed +$2.00/sh; after hours it drifted to $70.90.
//         Schwab shows +$200 on 100 shares. Manual subtraction would say +$290.
const quotes = {
    UPRO: { quote: { lastPrice: 70.9, closePrice: 68, netChange: 2.9, regularMarketNetChange: 2 } },
    SCHD: { quote: { lastPrice: 96, closePrice: 90, netChange: 6, regularMarketNetChange: 6 } },
    // Real row from the 2026-08-18 Schwab reconciliation. Schwab's account page
    // showed -$1.08 on the day; its API field claimed -$701.87 on a $708
    // position. Quote math lands on the truth.
    BDJ: { quote: { lastPrice: 9.835, closePrice: 9.8498, netChange: -0.0148 } },
};
// The regular-hours gate is wall-clock dependent, so the clock is injected.
const RTH = new Date('2026-08-18T14:00:00Z'); // Tue 10:00 ET — open
const AFTER_HOURS = new Date('2026-08-19T00:00:00Z'); // Tue 20:00 ET — closed
function checkEq(label, actual, expected) {
    const ok = actual === expected;
    if (!ok)
        failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`);
}
// Cost basis and unrealized P/L are clock-independent; run them after hours so
// the same call also covers the Schwab-field day-change path.
const [a, b, c, d] = (0, classify_1.enrichPositions)([longEquity, shortPut, longCall, boughtToday], quotes, 100000, AFTER_HOURS);
console.log('\n--- cost basis (signed, dollar-denominated) ---');
check('long equity basis', a.costBasis, 5000);
check('short put basis', b.costBasis, -1500); // negative = credit received
check('long call basis', c.costBasis, 800); // ×100 applied
check('bought-today basis', d.costBasis, 9500);
console.log('\n--- unrealized P/L ---');
check('long equity P/L', a.gainLoss, 2000);
check('short put P/L', b.gainLoss, 900); // was -600 before the fix
check('long call P/L', c.gainLoss, 500); // was +1292 before the fix
check('bought-today P/L', d.gainLoss, 100);
console.log('\n--- day change: OUTSIDE regular hours ---');
// The 2026-08-03 lesson, preserved. `lastPrice` carries extended-hours prints
// and Schwab rolls `closePrice` forward after 16:00 ET, so the two operands
// stop describing the same interval. Quote math is switched off; the field wins.
check('held position falls back to Schwab field', a.todayGainLoss, -310); // NOT +290
checkEq('and says so', a.todayGainLossSource, 'schwab');
console.log('\n--- day change: INSIDE regular hours ---');
// The 2026-08-18 lesson. Reconciled against a Schwab positions export, quote
// math matched the account page on 153 of 155 equity rows while
// currentDayProfitLoss was corrupt on nine, totalling $3,919 of phantom loss.
const [rthEquity, , , rthBought] = (0, classify_1.enrichPositions)([longEquity, shortPut, longCall, boughtToday], quotes, 100000, RTH);
check('held position prefers quote math', rthEquity.todayGainLoss, 290); // NOT -310
checkEq('and says so', rthEquity.todayGainLossSource, 'quote');
// A position resized today has no single quantity both operands describe, so
// it still falls through to Schwab's field even during regular hours.
check('bought-today still uses Schwab field', rthBought.todayGainLoss, 100); // NOT +600
checkEq('and says so', rthBought.todayGainLossSource, 'schwab');
console.log('\n--- regression: the real BDJ row from 2026-08-18 ---');
const [bdj] = (0, classify_1.enrichPositions)([pos({
        instrument: { assetType: 'EQUITY', symbol: 'BDJ' },
        longQuantity: 72, previousSessionLongQuantity: 72,
        averageLongPrice: 9.84, averagePrice: 9.84,
        marketValue: 708.12,
        currentDayProfitLoss: -701.87, // Schwab's API field. Garbage.
        currentDayProfitLossPercentage: -49.82,
    })], quotes, 100000, RTH);
check('BDJ day change matches the account page', bdj.todayGainLoss, -1.07, 0.02);
check('BDJ day % derived from the same source', bdj.todayGainLossPercent ?? 0, -0.15, 0.01);
checkEq('BDJ source', bdj.todayGainLossSource, 'quote');
console.log('\n--- no Schwab field at all ---');
const noFieldPos = pos({
    instrument: { assetType: 'EQUITY', symbol: 'UPRO' },
    longQuantity: 100, previousSessionLongQuantity: 100,
    averageLongPrice: 50, averagePrice: 50, marketValue: 7000,
    currentDayProfitLoss: undefined,
});
const [noFieldRth] = (0, classify_1.enrichPositions)([noFieldPos], quotes, 100000, RTH);
const [noFieldAfter] = (0, classify_1.enrichPositions)([noFieldPos], quotes, 100000, AFTER_HOURS);
check('quote math carries it during RTH', noFieldRth.todayGainLoss, 290); // (70.9 − 68) × 100
// Nothing trustworthy is left after hours — report zero rather than subtract
// two prices that describe different sessions.
check('reports zero after hours', noFieldAfter.todayGainLoss, 0);
checkEq('and admits it has no source', noFieldAfter.todayGainLossSource, 'none');
console.log('\n--- portfolio total ---');
const totalGain = [a, b, c, d].reduce((s, p) => s + p.gainLoss, 0);
check('summed unrealized', totalGain, 3500);
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
