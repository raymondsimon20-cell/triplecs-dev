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

  return {
    external, externalTotal: sum(external),
    internal, internalTotal: sum(internal),
    unclassified, unclassifiedTotal: sum(unclassified),
  };
}
