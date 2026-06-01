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
exports.DEFAULT_TARGETS = {
    triplesPct: 10,
    cornerstonePct: 20,
    incomePct: 65,
    hedgePct: 5,
    marginLimitPct: 30,
    marginWarnPct: 20,
    marginTrimTargetPct: 25,
    marginNewBuyCeilingPct: 35,
    familyCapPct: 20,
    fireNumber: 10000,
    marginRatePct: 7.75,
};
