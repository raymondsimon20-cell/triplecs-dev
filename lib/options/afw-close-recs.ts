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
 * AFW. Greedy walk down the sorted list, accumulating AFW freed, stops
 * once projected post-close AFW clears the floor.
 *
 * ─── Margin / AFW-impact subtlety ────────────────────────────────────────────
 * Schwab's `maintenanceRequirement` field on an option position is the
 * MARGIN requirement — not the AFW reduction. For a CASH-SECURED short put,
 * the margin requirement is $0 (it's cash-secured!), but AFW is still
 * reduced by the full strike collateral (strike × 100 × contracts).
 *
 * So when Schwab reports `maintenanceRequirement = 0` on a short option we
 * fall back to the cash-secured estimate: parse the strike from the OCC
 * symbol and compute strike × 100 × contracts. The report flags this in
 * `marginSource` so the UI can be honest that it's an estimate rather than
 * Schwab's own number.
 *
 * Pure function. No I/O — caller fetches positions + balances and invokes.
 */
import type { SchwabPosition } from '../schwab/types';

/** Where the marginLocked value came from. */
export type MarginSource =
  /** Schwab's own maintenanceRequirement field, used as-is. */
  | 'schwab'
  /** Schwab reported $0; we estimated using cash-secured (strike × 100 × N). */
  | 'cash-secured-estimate'
  /** Long position — no margin lock. */
  | 'long-no-lock';

export interface OptionPositionReport {
  symbol:        string;               // OCC symbol (verbatim)
  underlying:    string;               // parsed from OCC; falls back to first token
  description?:  string;               // Schwab's human-readable description
  side:          'long' | 'short';
  contracts:     number;               // absolute count
  /** Put or call (parsed from OCC). Null when unparseable. */
  kind:          'put' | 'call' | null;
  /** Strike price (parsed from OCC). Null when unparseable. */
  strike:        number | null;
  marketValue:   number;               // signed (negative for shorts)
  /** Dollars freed back to AFW when this position closes. See file header. */
  marginLocked:  number;
  /** Provenance of marginLocked — Schwab's field vs our estimate. */
  marginSource:  MarginSource;
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

  // Greedy minimum-set: walk profit-sorted list, accumulating AFW freed
  // until projected AFW ≥ floor.
  //
  // We count only marginLocked (AFW impact) and ignore the cash impact of
  // the close itself — bid/ask + Schwab's accounting introduces uncertainty
  // there. Counting only the lock errs on the side of recommending MORE
  // closes than strictly needed, which is the right way to err for AFW
  // recovery.
  let projectedAfw = afwDollars;
  for (const opt of openOptions) {
    if (projectedAfw >= floor) break;
    projectedAfw += Math.max(0, opt.marginLocked);
    result.recommendedCloses.push(opt);
  }
  result.afwAfter = projectedAfw;
  return result;
}

// ─── OCC symbol parser ──────────────────────────────────────────────────────

/**
 * Parse a Schwab OCC option symbol.
 *
 * Format: `[underlying padded to 6][YYMMDD][P|C][strike × 1000, 8 digits]`
 * Examples:
 *   "TQQQ  260717P00078000" → underlying=TQQQ, exp=2026-07-17, put, strike=78
 *   "XDTE  260618P00037000" → underlying=XDTE, exp=2026-06-18, put, strike=37
 *   "SPY   240621C00500500" → underlying=SPY,  exp=2024-06-21, call, strike=500.5
 *
 * Returns null when the symbol doesn't match the OCC pattern (defensive —
 * Schwab is consistent but legacy data or future format changes shouldn't
 * crash the report).
 */
export interface ParsedOcc {
  underlying: string;
  expiration: string;        // YYYY-MM-DD
  kind:       'put' | 'call';
  strike:     number;        // dollars (not cents)
}

export function parseOccSymbol(sym: string): ParsedOcc | null {
  if (!sym) return null;
  // Trim, then match: 1–6 char underlying, exactly 6 date digits,
  // P|C, exactly 8 strike digits. Underlying may have trailing spaces in
  // the source; we strip them first.
  const compact = sym.replace(/\s+/g, '');
  const m = compact.match(/^([A-Z]{1,6})(\d{6})([PC])(\d{8})$/);
  if (!m) return null;
  const [, underlying, yymmdd, pc, strikeStr] = m;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = parseInt(yymmdd.slice(2, 4), 10);
  const dd = parseInt(yymmdd.slice(4, 6), 10);
  // OCC uses YY in 20YY range; that's fine through 2099.
  const expiration = `20${String(yy).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  // Strike is reported in 1000ths of a dollar (8 digits, e.g. "00078000" = $78.000).
  const strike = parseInt(strikeStr, 10) / 1000;
  return {
    underlying,
    expiration,
    kind: pc === 'P' ? 'put' : 'call',
    strike,
  };
}

// ─── Position → report ──────────────────────────────────────────────────────

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

  const sym = p.instrument.symbol ?? '';
  const parsed = parseOccSymbol(sym);
  const underlying = parsed?.underlying ?? sym.split(/\s+/)[0] ?? sym;
  const kind = parsed?.kind ?? null;
  const strike = parsed?.strike ?? null;

  // Margin / AFW-impact: prefer Schwab's reported value; fall back to
  // cash-secured estimate when Schwab reports $0 on a short (which it does
  // for genuinely cash-secured positions). See file header.
  const schwabMaint = p.maintenanceRequirement ?? 0;
  let marginLocked: number;
  let marginSource: MarginSource;
  if (!isShort) {
    // Long option: closing just unwinds the debit. AFW lock is 0.
    marginLocked = 0;
    marginSource = 'long-no-lock';
  } else if (schwabMaint > 0) {
    // Schwab reported a real margin number — naked or partially margined.
    // Use as-is, that's the authoritative AFW impact.
    marginLocked = schwabMaint;
    marginSource = 'schwab';
  } else if (strike != null) {
    // Schwab reported $0 → assume cash-secured. AFW reduction = strike collateral.
    // (Calls cash-secured would be backed by shares, not cash; we still
    // compute as strike × 100 × N as a conservative estimate.)
    marginLocked = strike * 100 * contracts;
    marginSource = 'cash-secured-estimate';
  } else {
    // Can't parse the symbol AND Schwab gave us nothing — surface as 0 but
    // mark the source so callers know we couldn't estimate.
    marginLocked = 0;
    marginSource = 'cash-secured-estimate';   // best label we have
  }

  return {
    symbol:           sym,
    underlying,
    description:      p.instrument.description,
    side:             isShort ? 'short' : 'long',
    contracts,
    kind,
    strike,
    marketValue,
    marginLocked,
    marginSource,
    unrealizedPL,
    closeInstruction: isShort ? 'BUY_TO_CLOSE' : 'SELL_TO_CLOSE',
  };
}
