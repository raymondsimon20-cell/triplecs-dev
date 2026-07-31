/**
 * duplicate-inflows — catch the same dollars counted twice.
 *
 * A brokerage account records both the arrival of external money and its
 * subsequent movement between the cash and margin registers. Both post as
 * positive amounts, so a naive classifier can count one deposit as two:
 *
 *   Jul 24   Pineland Propert SIGONFI   +$1,620.00
 *   Jul 25   TRF FUNDS FRM TYPE 1       +$1,620.00
 *
 * An exact amount match within a few days is a strong signal — two unrelated
 * inflows landing on the same cent that close together is unlikely. This
 * surfaces candidates for review rather than silently reclassifying them,
 * because the wrong call either double-counts contributions or discards a real
 * deposit, and only the account holder can tell which.
 */

import { isInternalTransfer } from '@/lib/data/contribution-sources';

export interface InflowLike {
  id:          string;
  date:        string;
  description: string;
  amount:      number;
  category:    string;
}

export interface DuplicatePair {
  /** The transaction most likely to be the real external arrival. */
  original:  InflowLike;
  /** The transaction that appears to restate it. */
  duplicate: InflowLike;
  amount:    number;
  daysApart: number;
  /** True when one side looks like an internal register movement. */
  internalMatch: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Find inflows that appear to be the same money recorded twice.
 *
 * @param windowDays How far apart two matching amounts can be and still pair.
 *                   Three days covers a weekend without reaching so far that
 *                   genuinely separate deposits of equal size get caught.
 */
export function findDuplicateInflows(txns: InflowLike[], windowDays = 3): DuplicatePair[] {
  const inflows = txns
    .filter((t) => t.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const pairs: DuplicatePair[] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < inflows.length; i += 1) {
    const a = inflows[i];
    if (claimed.has(a.id)) continue;

    for (let j = i + 1; j < inflows.length; j += 1) {
      const b = inflows[j];
      if (claimed.has(b.id)) continue;

      // Compare to the cent — a near-match is far more likely to be two real
      // deposits than one restated, so exactness is the point.
      if (Math.abs(a.amount - b.amount) > 0.005) continue;

      const days = Math.round(
        (Date.parse(`${b.date}T12:00:00Z`) - Date.parse(`${a.date}T12:00:00Z`)) / DAY_MS,
      );
      if (days < 0 || days > windowDays) continue;

      const aInternal = isInternalTransfer(a.description);
      const bInternal = isInternalTransfer(b.description);

      // The internal-looking side is the restatement; if neither looks
      // internal, the earlier one is treated as the arrival.
      const original  = bInternal ? a : aInternal ? b : a;
      const duplicate = original.id === a.id ? b : a;

      pairs.push({
        original, duplicate,
        amount: a.amount,
        daysApart: Math.abs(days),
        internalMatch: aInternal || bInternal,
      });
      claimed.add(a.id);
      claimed.add(b.id);
      break;
    }
  }

  return pairs;
}

/** Total that would be double-counted if every flagged pair were counted twice. */
export function duplicateExposure(pairs: DuplicatePair[]): number {
  return pairs.reduce((s, p) => s + p.amount, 0);
}
