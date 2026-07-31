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
  // External money arriving from the linked bank. Distinct from the internal
  // register movements below, which are the same dollars being shuffled.
  'TRANSFER FUNDS FROM SCHWAB BANK',
];

/**
 * Descriptions that look like inflows but are internal movements, not new money.
 *
 * A brokerage account keeps separate registers — cash and margin — and moving
 * funds between them posts as a positive transaction with no external source.
 * Counting those as contributions inflates the figure and, worse, does so by
 * exactly the amount of a real deposit that has already been counted:
 *
 *   Jul 24   Pineland Propert SIGONFI   +$1,620.00     <- the actual deposit
 *   Jul 25   TRF FUNDS FRM TYPE 1       +$1,620.00     <- the same money moving
 *
 * These are listed for documentation and for the duplicate check; they are not
 * in CONTRIBUTION_SOURCES and must not be added to it.
 */
export const INTERNAL_TRANSFER_PATTERNS: readonly string[] = [
  'TRF FUNDS FRM TYPE',
  'TRF FUNDS TO TYPE',
];

export function isInternalTransfer(description: string | null | undefined): boolean {
  if (!description) return false;
  const upper = description.toUpperCase();
  return INTERNAL_TRANSFER_PATTERNS.some((s) => upper.includes(s));
}

/** True when a transaction description names a known contribution source. */
export function isKnownContributionSource(description: string | null | undefined): boolean {
  if (!description) return false;
  const upper = description.toUpperCase();
  return CONTRIBUTION_SOURCES.some((s) => upper.includes(s));
}
