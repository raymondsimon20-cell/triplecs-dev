/**
 * Shared formatting utilities for the Triple C dashboard.
 * Import these instead of declaring local fmt$ functions in each component.
 */

/**
 * Format a number as a dollar amount.
 * Negative values are shown as -$X.XX
 * @param n        The number to format
 * @param decimals Number of decimal places (default 2)
 */
export function fmtDollar(n: number, decimals = 2): string {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return n < 0 ? `-$${str}` : `$${str}`;
}

/** Shorthand alias used by most components */
export const fmt$ = fmtDollar;

/**
 * Format a number as a percentage with sign.
 * e.g. 3.14 → "+3.1%", -2.5 → "-2.5%"
 */
export function fmtPct(n: number, decimals = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

/**
 * Format a number as a compact dollar (no decimals by default).
 * Useful for large round numbers like portfolio value.
 */
export function fmtDollarInt(n: number): string {
  return fmtDollar(n, 0);
}

/**
 * Format a gain/loss value with color class.
 * Returns { text, colorClass } for Tailwind color application.
 */
export function gainLossColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-[#7c82a0]';
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Default Triple C allocation targets (can be overridden via SettingsPanel).
 */
export const DEFAULT_TARGETS = {
  triplesPct: 10,       // % of portfolio
  cornerstonePct: 15,   // % of portfolio
  incomePct: 60,        // % of portfolio
  hedgePct: 5,          // % of portfolio
  marginLimitPct: 30,   // max margin as % of total value
  marginWarnPct: 20,    // warn threshold
  familyCapPct: 20,     // max single fund family concentration
  fireNumber: 10000,    // monthly income FIRE target ($)
} as const;

export type StrategyTargets = typeof DEFAULT_TARGETS;
