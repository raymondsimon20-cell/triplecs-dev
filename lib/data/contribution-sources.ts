/**
 * Counterparties whose inbound transfers are contributions.
 *
 * Schwab files employer and outside-institution deposits under JOURNAL or a
 * generic type, with only a free-text description identifying the payer — so
 * transaction type alone cannot classify them. Matching the payer name is the
 * only available signal.
 *
 * This lives in one place because two separate code paths need it and they must
 * agree:
 *
 *   app/api/transactions/route.ts   — the Contribution category shown in Cash
 *                                     Flow, Ledger, and the Month Close bridge
 *   lib/schwab/transactions.ts      — the deposit/withdrawal classification
 *                                     feeding TWR and CAGR
 *
 * If those two disagree, a deposit can appear as a contribution on screen while
 * the return calculation treats it as investment gain, or the reverse.
 *
 * Adding a source: matching is case-insensitive and substring-based, so an
 * entry only needs to be a distinctive fragment of the description. Keep
 * fragments specific — something short or common risks catching unrelated
 * descriptions and silently inflating the Contributions line.
 */

export const CONTRIBUTION_SOURCES: readonly string[] = [
  'PINELAND',
  'KEYWAY',
];

/** True when a transaction description names a known contribution source. */
export function isKnownContributionSource(description: string | null | undefined): boolean {
  if (!description) return false;
  const upper = description.toUpperCase();
  return CONTRIBUTION_SOURCES.some((s) => upper.includes(s));
}
