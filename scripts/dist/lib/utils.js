"use strict";
/**
 * Shared formatting utilities for the Triple C dashboard.
 * Import these instead of declaring local fmt$ functions in each component.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TARGETS = exports.fmt$ = void 0;
exports.fmtDollar = fmtDollar;
exports.fmtPct = fmtPct;
exports.fmtDollarInt = fmtDollarInt;
exports.gainLossColor = gainLossColor;
exports.clamp = clamp;
/**
 * Format a number as a dollar amount.
 * Negative values are shown as -$X.XX
 * @param n        The number to format
 * @param decimals Number of decimal places (default 2)
 */
function fmtDollar(n, decimals = 2) {
    const abs = Math.abs(n);
    const str = abs.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
    return n < 0 ? `-$${str}` : `$${str}`;
}
/** Shorthand alias used by most components */
exports.fmt$ = fmtDollar;
/**
 * Format a number as a percentage with sign.
 * e.g. 3.14 → "+3.1%", -2.5 → "-2.5%"
 */
function fmtPct(n, decimals = 1) {
    return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}
/**
 * Format a number as a compact dollar (no decimals by default).
 * Useful for large round numbers like portfolio value.
 */
function fmtDollarInt(n) {
    return fmtDollar(n, 0);
}
/**
 * Format a gain/loss value with color class.
 * Returns { text, colorClass } for Tailwind color application.
 */
function gainLossColor(n) {
    if (n > 0)
        return 'text-emerald-400';
    if (n < 0)
        return 'text-red-400';
    return 'text-[#7c82a0]';
}
/**
 * Clamp a value between min and max.
 */
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
/**
 * P2P defaults (2026-07).
 *
 * Margin: the P2P rule is "maintain at least 50% equity", i.e. utilisation up to
 * 50%. Schwab independently hard-rejects orders above 50% utilisation, so the
 * app's own ceiling is deliberately set BELOW 50 — at 50 exactly, every order
 * sits on the boundary where the broker bounces it and the guardrail would only
 * announce itself through failed orders. 48% new-buy ceiling leaves headroom;
 * trim fires at 45 and pulls back to 40.
 *
 * Bucket splits are a starting point, not a prescription — the P2P material
 * gives no target percentages anywhere. Use "Set Targets from Current" or edit
 * via /api/strategy.
 */
exports.DEFAULT_TARGETS = {
    growthPct: 20,
    cornerstonePct: 20,
    incomePct: 50,
    triplesPct: 10,
    hedgeSleevePct: 5,
    marginWarnPct: 35,
    marginTrimTargetPct: 40,
    marginLimitPct: 45,
    marginNewBuyCeilingPct: 48, // stays under Schwab's hard 50% rejection
    familyCapPct: 20,
    fireNumber: 10000,
    // Actual negotiated Schwab rate. P2P quotes 8.4% as the rate to aim for;
    // this account is already below it, so the real figure stands — the spread
    // math should reflect what is actually charged, not the target.
    marginRatePct: 7.75,
};
