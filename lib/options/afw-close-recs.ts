/**
 * AFW close-recommendations for open option positions.
 *
 * Context: the post-trade AFW guardrail (lib/guardrails.ts:checkAfwHeadroom)
 * was added after an incident where a short put left AFW well below the
 * $10K safety floor. That guardrail prevents NEW trades from making things
 * worse, but doesn't unwind existing positions that are already over the
 * line. This module produces a report identifying which open option
 * positions to close to restore AFW headroom.
 *
 * Prioritization: profits-first. Sort open options by realized-if-closed
 * P&L descending — close the green tickets first to lock gains and recover
 * AFW. Greedy walk down the sorted list, accumulating margin freed, stops
 * once projected post-close AFW clears the floor.
 *
 * Pure function. No I/O — caller fetches positions + balances and invokes.
 */
import type { SchwabPosition } from '../schwab/types';

export interface OptionPositionReport {
  symbol:        string;               // OCC symbol (verbatim)
  underlying:    string;               // best-effort extraction (first token of OCC)
  description?:  string;               // Schwab's human-readable description
  side:          'long' | 'short';
  contracts:     number;               // absolute count
  marketValue:   number;               // signed (negative for shorts)
  marginLocked:  number;               // dollars freed if closed (maintenanceRequirement)
  /**
   * P&L if closed at current marketValue.
   *   - long:  marketValue − costBasis      (positive = profit)
   *   - short: costBasis − marketValue      (positive = profit)
   *
   * Cost basis is averagePrice × contracts × 100 (contracts × 100 = shares
   * of underlying). For shorts, averagePrice is the credit received per
   * share; for longs, the debit paid.
   */
  unrealizedPL:  number;
  /** Suggested close instruction for the staging layer. */
  closeInstruction: 'BUY_TO_CLOSE' | 'SELL_TO_CLOSE';
}

export interface CloseRecsResult {
  /** Current AFW dollars at report time. */
  afwBefore:        number;
  /** AFW dollars projected after executing all `recommendedCloses`. */
  afwAfter:         number;
  /** The AFW floor used for the recommendation. */
  floor:            number;
  /** True if afwBefore is already at/above floor — no closes needed. */
  alreadyHealthy:   boolean;
  /**
   * Minimum-set of closes (sorted by P&L descending) that brings projected
   * AFW back over the floor. Empty if already healthy.
   */
  recommendedCloses: OptionPositionReport[];
  /**
   * Every open option position, sorted by P&L descending. Lets the user see
   * the full picture rather than only the minimum set.
   */
  allOpenOptions:    OptionPositionReport[];
}

/**
 * Build the report from a list of Schwab positions and the account's
 * current AFW.
 *
 * `positions` should be the raw `positions[]` from the SchwabAccount; this
 * function filters to options and ignores equity rows. `afwDollars` and
 * `floor` are in USD.
 */
export function buildAfwCloseRecs(
  positions:  SchwabPosition[],
  afwDollars: number,
  floor:      number = 10_000,
): CloseRecsResult {
  const openOptions = positions
    .filter((p) => p.instrument.assetType === 'OPTION')
    .filter((p) => (p.longQuantity ?? 0) > 0 || (p.shortQuantity ?? 0) > 0)
    .map((p) => toReport(p))
    // Profits-first ordering. Stable sort: positive P&L before negative.
    .sort((a, b) => b.unrealizedPL - a.unrealizedPL);

  const result: CloseRecsResult = {
    afwBefore:         afwDollars,
    afwAfter:          afwDollars,
    floor,
    alreadyHealthy:    afwDollars >= floor,
    recommendedCloses: [],
    allOpenOptions:    openOptions,
  };

  if (result.alreadyHealthy) return result;

  // Greedy minimum-set: walk the profit-sorted list, accumulating margin
  // freed (and cash impact of closing) until projected AFW ≥ floor.
  //
  // Closing a SHORT releases marginLocked AND requires buying back at
  // marketValue (negative, so closing pays |marketValue|).
  // Closing a LONG releases marginLocked AND credits marketValue (positive).
  //
  // For AFW projection purposes both increase available funds:
  //   delta = marginLocked + (long ? marketValue : -marketValue)
  //
  // We're conservative and only count `marginLocked` for the minimum-set
  // check — the cash effect of the close is real but bid/ask + Schwab's
  // accounting introduces uncertainty. Counting only marginLocked errs on
  // the side of recommending MORE closes than strictly needed, which is the
  // right way to err when the goal is restoring AFW headroom.
  let projectedAfw = afwDollars;
  for (const opt of openOptions) {
    if (projectedAfw >= floor) break;
    projectedAfw += Math.max(0, opt.marginLocked);
    result.recommendedCloses.push(opt);
  }
  result.afwAfter = projectedAfw;
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toReport(p: SchwabPosition): OptionPositionReport {
  const longQty  = p.longQuantity  ?? 0;
  const shortQty = p.shortQuantity ?? 0;
  const isShort  = shortQty > 0;
  const contracts = isShort ? shortQty : longQty;

  // averagePrice is per-share for options too; one contract = 100 shares.
  const costBasis = (p.averagePrice ?? 0) * contracts * 100;
  const marketValue = p.marketValue ?? 0;

  // P&L direction depends on side. For shorts the credit received was
  // costBasis (positive), and marketValue is negative (liability). Closing
  // costs |marketValue|, so P&L = costBasis - |marketValue| = costBasis + mv.
  // For longs, marketValue is positive, P&L = marketValue - costBasis.
  const unrealizedPL = isShort
    ? costBasis + marketValue           // mv is negative for short obligations
    : marketValue - costBasis;

  // Underlying extraction: Schwab OCC symbols pad the underlying with spaces
  // to a fixed width, e.g. "UPRO  240621P00050000". Split on whitespace.
  const sym = p.instrument.symbol ?? '';
  const underlying = sym.split(/\s+/)[0] || sym;

  return {
    symbol:       sym,
    underlying,
    description:  p.instrument.description,
    side:         isShort ? 'short' : 'long',
    contracts,
    marketValue,
    marginLocked: p.maintenanceRequirement ?? 0,
    unrealizedPL,
    closeInstruction: isShort ? 'BUY_TO_CLOSE' : 'SELL_TO_CLOSE',
  };
}
