/**
 * drip — infer DRIP status from what actually happened, not from a setting.
 *
 * DRIP at NAV on CLM/CRF is the compounding mechanism the CEF bucket exists
 * for: reinvested distributions buy shares at net asset value while the market
 * price sits at a premium, so every reinvestment lands at an immediate discount
 * to what those shares are worth. If it is switched off at the broker, the
 * bucket is doing considerably less than the strategy assumes.
 *
 * The app cannot read a broker preference flag. What it can do is look at the
 * transaction stream: a DRIP payment arrives as a delivery of shares
 * (RECEIVE_AND_DELIVER) rather than a cash credit. Counting which of the two a
 * symbol has been receiving is a stronger signal than a self-reported checkbox,
 * because it reflects the account's actual behaviour.
 */

export type DripStatus = 'on' | 'off' | 'partial' | 'unknown';

export interface DripSummary {
  symbol:   string;
  status:   DripStatus;
  /** Share of distribution dollars that were reinvested rather than paid out. */
  reinvestedPct: number;
  reinvested:    number;
  cash:          number;
  payments:      number;
  reinvestedPayments: number;
}

export interface DripCounts {
  reinvested: number;
  cash: number;
  payments: number;
  reinvestedPayments: number;
}

/**
 * Classify from the reinvested share of distribution dollars.
 *
 * Bounds are loose on purpose. A DRIP that was switched on partway through the
 * window, or a fund that paid one special distribution in cash, should not read
 * as "off" — the interesting cases are wholly-on, wholly-off, and genuinely
 * mixed. Below two payments there is not enough to say anything.
 */
export function classifyDrip(c: DripCounts): DripStatus {
  if (c.payments < 2) return 'unknown';
  const total = c.reinvested + c.cash;
  if (total <= 0) return 'unknown';
  const pct = (c.reinvested / total) * 100;
  if (pct >= 90) return 'on';
  if (pct <= 10) return 'off';
  return 'partial';
}

export function summariseDrip(symbol: string, c: DripCounts): DripSummary {
  const total = c.reinvested + c.cash;
  return {
    symbol,
    status: classifyDrip(c),
    reinvestedPct: total > 0 ? (c.reinvested / total) * 100 : 0,
    reinvested: c.reinvested,
    cash: c.cash,
    payments: c.payments,
    reinvestedPayments: c.reinvestedPayments,
  };
}

/**
 * Funds where reinvestment happens at NAV rather than market price. This is a
 * property of the fund's own plan, not of the broker, which is why it is a
 * short hard-coded list rather than something inferred.
 */
export const NAV_DRIP_SYMBOLS = new Set(['CLM', 'CRF']);

export interface NavCapture {
  /** Dollars reinvested during the window. */
  reinvested:    number;
  /** Premium of market price over NAV, in percent. Positive = trading above NAV. */
  premiumPct:    number;
  /**
   * Estimated value of buying at NAV instead of market, in dollars.
   *
   * Reinvesting R dollars at NAV acquires R/NAV shares. With the market at a
   * premium p, those shares are worth (R/NAV) × price = R × (1 + p/100), so the
   * edge over reinvesting at market is R × p/100.
   */
  estimatedEdge: number;
}

/**
 * Value captured by reinvesting at NAV while the fund trades at a premium.
 *
 * Returns null at or below NAV. Note this is not merely "no advantage": at a
 * discount, buying at NAV acquires *fewer* shares than buying at market, so a
 * strict NAV reinvestment would be worse than a market one. Whether that
 * actually happens depends on the fund's plan terms — some CEF plans reinvest
 * at the lower of NAV or market precisely to avoid it, and Cornerstone's exact
 * terms have not been verified here.
 *
 * Rather than assert a negative edge we cannot substantiate, the null is
 * treated as "no premium advantage to report" and the UI says so plainly.
 */
export function estimateNavCapture(reinvested: number, premiumPct: number | null): NavCapture | null {
  if (reinvested <= 0 || premiumPct === null || premiumPct <= 0) return null;
  return {
    reinvested,
    premiumPct,
    estimatedEdge: reinvested * (premiumPct / 100),
  };
}

export const DRIP_STATUS_LABEL: Record<DripStatus, string> = {
  on:      'Reinvesting',
  off:     'Paying cash',
  partial: 'Mixed',
  unknown: 'Not enough history',
};
