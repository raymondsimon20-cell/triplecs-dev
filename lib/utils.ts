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
 * Default Triple C allocation targets (can be overridden via SettingsPanel
 * or by POSTing to /api/strategy).
 *
 * Margin model — the engine consumes these to size when to trim and when to
 * stop proposing new buys:
 *
 *   marginLimitPct           — When margin utilization exceeds this,
 *                              MAINTENANCE_RANKED_TRIM fires. This is the
 *                              "upper edge of comfortable" — past it, the
 *                              engine starts asking you to come down.
 *
 *   marginTrimTargetPct      — Trim signals are sized to bring utilization
 *                              back to roughly this level. Should be a few
 *                              points below marginLimitPct to leave headroom.
 *
 *   marginNewBuyCeilingPct   — PILLAR_FILL refuses to propose NEW positions
 *                              above this margin utilization. Prevents the
 *                              engine fighting itself (proposing buys while
 *                              another rule wants to trim).
 *
 *   marginWarnPct            — Informational warn level for the UI. No engine
 *                              behavior changes; pure display.
 *
 * Vol-7 defaults below describe a low-leverage strategy. Higher-leverage
 * operators (e.g. targeting 40–45%) can adjust by POSTing to /api/strategy.
 */
export interface StrategyTargets {
  triplesPct: number;       // % of portfolio
  cornerstonePct: number;   // % of portfolio
  incomePct: number;        // % of portfolio
  hedgePct: number;         // % of portfolio
  marginLimitPct: number;          // trim fires above this
  marginWarnPct: number;           // informational warn threshold
  marginTrimTargetPct: number;     // trim aims to bring margin back here
  marginNewBuyCeilingPct: number;  // PILLAR_FILL bails above this
  familyCapPct: number;     // max single fund family concentration
  fireNumber: number;       // monthly income FIRE target ($)
  marginRatePct: number;    // margin interest rate % (e.g. 7.75 for 7.75%)
}

export const DEFAULT_TARGETS: StrategyTargets = {
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
