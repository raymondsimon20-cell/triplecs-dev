/**
 * drawdown — how far the market can fall before leverage forces a sale.
 *
 * This is the number the put-insurance rule exists to move. Protection is not
 * bought to profit from a crash; it is bought so that a drawdown does not push
 * equity below the point where positions get liquidated at the worst possible
 * moment. So the useful question is not "how much are my puts worth" but "how
 * far can this fall before I am forced to act", and what protection does to
 * that figure.
 *
 * Two distinct limits are modelled because they bite at different points:
 *
 *   1. The app's own utilisation guardrail (marginLimitPct). Self-imposed, and
 *      breaching it triggers trim logic, not a broker action.
 *   2. The broker's maintenance requirement. This is the real forced-sale line,
 *      and it depends on the maintenance percentage of the specific positions
 *      held — a book of 100%-maintenance funds has far less room than one of
 *      30%-maintenance index ETFs at the same leverage.
 */

export interface DrawdownInputs {
  totalValue:    number;
  /** Absolute margin borrowed. */
  marginUsed:    number;
  /** Sum of positionValue × maintenanceFraction across holdings. */
  maintenanceRequirement: number;
  /** App guardrail: margin utilisation percentage that triggers trim. */
  marginLimitPct: number;
}

export interface DrawdownResult {
  /** Fractional market decline before margin utilisation exceeds the app limit. */
  toAppLimit:       number | null;
  /** Fractional market decline before equity falls under the maintenance requirement. */
  toMaintenanceCall: number | null;
  /** Current margin utilisation, percent. */
  utilisationPct:   number;
  /** Current equity as a percentage of total value. */
  equityPct:        number;
}

/**
 * Both limits scale the same way under a uniform decline of fraction d:
 * position values fall to (1-d)·V while the borrowed amount M stays fixed.
 *
 * Utilisation limit L:  M / ((1-d)·T) > L      →  d > 1 − M/(L·T)
 * Maintenance call:     (1-d)T − M < (1-d)R    →  d > 1 − M/(T−R)
 *
 * A null means the limit is already breached, or the arithmetic is degenerate
 * (no margin used, or a maintenance requirement at or above total value).
 */
export function computeDrawdownHeadroom(i: DrawdownInputs): DrawdownResult {
  const { totalValue: T, marginUsed: M, maintenanceRequirement: R, marginLimitPct } = i;

  const utilisationPct = T > 0 ? (M / T) * 100 : 0;
  const equityPct      = T > 0 ? ((T - M) / T) * 100 : 0;

  if (T <= 0 || M <= 0) {
    // No borrowing means no forced-sale risk from leverage at any decline.
    return { toAppLimit: null, toMaintenanceCall: null, utilisationPct, equityPct };
  }

  const L = marginLimitPct / 100;
  const toAppLimit = L > 0 ? 1 - M / (L * T) : null;

  const denom = T - R;
  const toMaintenanceCall = denom > 0 ? 1 - M / denom : null;

  // Negative headroom means the limit is already breached; that is meaningful
  // information, so it is passed through rather than clamped to zero.
  return { toAppLimit, toMaintenanceCall, utilisationPct, equityPct };
}

export interface ProtectivePut {
  symbol:     string;
  underlying: string;
  strike:     number;
  expiration: string;
  dte:        number;
  contracts:  number;
  /** Strike × 100 × contracts — the notional value protected below the strike. */
  notional:   number;
  /** How far below the current underlying price the strike sits, in percent. */
  otmPct:     number | null;
}

/**
 * Payoff from a set of protective puts at a given uniform market decline.
 *
 * Deliberately simple: intrinsic value only, no time value, and it assumes the
 * portfolio moves with the underlying. Both assumptions understate the real
 * hedge — a put retains time value before expiry, and index puts typically gain
 * more than intrinsic in a fast selloff as volatility rises. Understating is
 * the right direction for a risk tool.
 */
export function putPayoffAtDecline(
  puts: ProtectivePut[],
  underlyingPrices: Record<string, number>,
  decline: number,
): number {
  let payoff = 0;
  for (const p of puts) {
    const spot = underlyingPrices[p.underlying];
    if (!spot || spot <= 0) continue;
    const priceAtDecline = spot * (1 - decline);
    const intrinsic = Math.max(0, p.strike - priceAtDecline);
    payoff += intrinsic * 100 * p.contracts;
  }
  return payoff;
}

/**
 * Decline at which equity, including put payoff, breaches the maintenance
 * requirement. Solved by scanning rather than algebraically: the payoff is a
 * piecewise-linear function of the decline (kinked at each strike), so a closed
 * form would need case analysis per strike ordering for no practical gain.
 */
export function declineToCallWithPuts(
  totalValue: number,
  marginUsed: number,
  maintenanceRequirement: number,
  puts: ProtectivePut[],
  underlyingPrices: Record<string, number>,
): number | null {
  if (totalValue <= 0 || marginUsed <= 0) return null;

  for (let pct = 1; pct <= 95; pct += 1) {
    const d = pct / 100;
    const equity = totalValue * (1 - d) - marginUsed + putPayoffAtDecline(puts, underlyingPrices, d);
    const requirement = maintenanceRequirement * (1 - d);
    if (equity < requirement) return d;
  }
  return null;   // survives a 95% decline on this model
}

/** P2P guidance: monthly index puts, 10–20% out of the money, ~30 days out. */
export const PUT_RULE = {
  minOtmPct: 10,
  maxOtmPct: 20,
  targetDte: 30,
  /** Below this many days, the position is near expiry and needs rolling. */
  rollDte: 14,
  underlyings: ['SPY', 'QQQ'],
} as const;
