/**
 * duplicate-inflows — reconcile external money against internal register moves.
 *
 * A brokerage account posts both the arrival of external money and its later
 * movement between the cash and margin registers as positive amounts. Counting
 * both would double contributions.
 *
 * ── Why this is reconciliation and not pairing ──────────────────────────────
 * The first version of this matched inflows one-to-one on exact amount. That
 * model is wrong, because a single deposit is routinely split across several
 * register moves:
 *
 *   Jul 27  TRANSFER FUNDS FROM SCHWAB BANK  +$40,344.00   <- one arrival
 *   Jul 28  TRF FUNDS FRM TYPE 1             +$39,344.00   <- split across
 *   Jul 31  TRF FUNDS FRM TYPE 2                +$440.65   <- several moves
 *
 * Strict pairing misses that, and — worse — reporting "2 pairs found" implies
 * the check was exhaustive when it was not. Rather than chase subset sums for
 * false precision, this reports the two totals and lets the size of the
 * internal figure speak for itself.
 *
 * Correctness does not depend on this: internal register movements are excluded
 * from the Contribution category by description, whether or not they can be
 * traced to a specific deposit. This exists so the exclusion is visible and
 * auditable rather than silent.
 */

import { isInternalTransfer, isKnownContributionSource } from '@/lib/data/contribution-sources';

export interface InflowLike {
  id:          string;
  date:        string;
  description: string;
  amount:      number;
  category:    string;
}

export interface InflowReconciliation {
  /** Inflows recognised as new external money. */
  external:        InflowLike[];
  externalTotal:   number;
  /** Positive-amount movements between the account's own registers. */
  internal:        InflowLike[];
  internalTotal:   number;
  /** Positive inflows that are neither — worth a look, they may be unclassified. */
  unclassified:      InflowLike[];
  unclassifiedTotal: number;
  /**
   * Internal movement minus external money in.
   *
   * Register moves originate from money that arrived externally, so over a long
   * enough window the two should roughly converge — a deposit lands, then gets
   * swept, possibly in several pieces:
   *
   *   $40,344.00 arrives  ->  $39,344.00 + $600.00 + $400.00 swept
   *
   * A materially positive gap means more money is being moved around inside the
   * account than was recorded as arriving, which points at an external deposit
   * that is not being recognised as one. Short windows produce noise from
   * deposits and sweeps landing either side of the boundary, so this is a hint
   * to investigate, not a defect count.
   */
  unswept:         number;
}

export function reconcileInflows(txns: InflowLike[]): InflowReconciliation {
  const external: InflowLike[] = [];
  const internal: InflowLike[] = [];
  const unclassified: InflowLike[] = [];

  for (const t of txns) {
    if (t.amount <= 0) continue;

    if (isInternalTransfer(t.description)) {
      internal.push(t);
    } else if (t.category === 'Contribution' || isKnownContributionSource(t.description)) {
      external.push(t);
    } else if (t.category === 'Transfer') {
      // Positive, not a known payer, not a recognised register move. Could be a
      // contribution source nobody has added yet, or an unrelated credit.
      unclassified.push(t);
    }
  }

  const sum = (rows: InflowLike[]) => rows.reduce((s, r) => s + r.amount, 0);

  const externalTotal = sum(external);
  const internalTotal = sum(internal);

  return {
    external, externalTotal,
    internal, internalTotal,
    unclassified, unclassifiedTotal: sum(unclassified),
    unswept: internalTotal - externalTotal,
  };
}

/**
 * Threshold above which the internal/external gap is worth surfacing.
 *
 * Deliberately a proportion rather than a fixed dollar figure: a $700 gap on
 * $44k of movement is boundary noise, the same gap on $2k of movement is not.
 */
export const UNSWEPT_SIGNIFICANCE = 0.15;

export function unsweptIsSignificant(r: InflowReconciliation): boolean {
  if (r.internalTotal <= 0) return false;
  return r.unswept / r.internalTotal > UNSWEPT_SIGNIFICANCE;
}
