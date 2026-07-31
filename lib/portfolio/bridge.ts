/**
 * bridge — the margin-bridge cycle.
 *
 * The strategy's mechanic: the entire paycheck is deposited and invested, so
 * living expenses are floated on margin. Distributions then pay that balance
 * down. The bridge is meant to be temporary — dividends eventually exceed
 * expenses and it closes on its own.
 *
 * Whether that is actually happening is a monthly cash question, and it has a
 * direction: the balance either trends toward zero or it compounds against you.
 * That direction is what this models. It is deliberately separate from the FIRE
 * tab, which answers the endpoint question ("do distributions cover expenses
 * yet"); this answers the journey one.
 *
 * ── On the growth assumption ────────────────────────────────────────────────
 * A projection that compounds the portfolio at its distribution yield would be
 * badly wrong for a book like this. Distribution yield and total return are not
 * the same thing: a fund can pay 25% while its NAV erodes, because part of the
 * distribution is return of capital. Modelling growth at the yield would
 * silently assume that erosion away.
 *
 * So `navDragPct` is an explicit input. Set it to the gap between distribution
 * yield and actual total return and the projection reflects the account as it
 * has really behaved rather than as the headline yield implies.
 */

export interface BridgeInputs {
  /** Monthly W-2 / earned income deposited into the account. */
  monthlyIncome:   number;
  /** Monthly living expenses drawn against the account. */
  monthlyExpenses: number;
  /** Current portfolio value. */
  portfolioValue:  number;
  /** Current margin balance (positive number). */
  marginBalance:   number;
  /** Annual distribution yield on portfolio value, percent. */
  yieldPct:        number;
  /** Annual margin interest rate, percent. */
  marginRatePct:   number;
  /**
   * Annual change in portfolio value from price movement, percent. Negative
   * represents NAV erosion. Set from observed total return minus yield.
   */
  navDragPct:      number;
  /** Margin utilisation percentage that constitutes a breach. */
  marginLimitPct:  number;
}

export interface BridgeMonth {
  month:          number;
  portfolioValue: number;
  marginBalance:  number;
  distributions:  number;
  marginInterest: number;
  netCash:        number;
  utilisationPct: number;
}

export interface BridgeProjection {
  months:            BridgeMonth[];
  /** Direction of the margin balance over the projection. */
  direction:         'shrinking' | 'growing' | 'stable';
  /** Month index at which margin reaches zero, or null if it never does. */
  bridgeClearedAt:   number | null;
  /** Month index at which utilisation breaches the limit, or null. */
  limitBreachedAt:   number | null;
  /** Month index at which distributions alone cover expenses + interest. */
  selfSustainingAt:  number | null;
  /** First-month figures, for a headline read. */
  firstMonthNetCash: number;
}

/**
 * Project the bridge forward month by month.
 *
 * Order within a month mirrors the described cycle: income arrives and pays
 * down margin, distributions land and do the same, expenses and interest push
 * it back up, and whatever is left over is invested.
 */
export function projectBridge(i: BridgeInputs, horizonMonths = 120): BridgeProjection {
  const months: BridgeMonth[] = [];

  let portfolio = Math.max(0, i.portfolioValue);
  let margin    = Math.max(0, i.marginBalance);

  const monthlyYield   = i.yieldPct / 100 / 12;
  const monthlyRate    = i.marginRatePct / 100 / 12;
  const monthlyNavDrag = i.navDragPct / 100 / 12;

  let bridgeClearedAt: number | null = null;
  let limitBreachedAt: number | null = null;
  let selfSustainingAt: number | null = null;
  let firstMonthNetCash = 0;

  for (let m = 1; m <= horizonMonths; m += 1) {
    const distributions  = portfolio * monthlyYield;
    const marginInterest = margin * monthlyRate;

    // Cash available after living costs and the cost of carrying the bridge.
    const netCash = i.monthlyIncome + distributions - i.monthlyExpenses - marginInterest;
    if (m === 1) firstMonthNetCash = netCash;

    if (selfSustainingAt === null && distributions >= i.monthlyExpenses + marginInterest) {
      selfSustainingAt = m;
    }

    if (netCash >= 0) {
      // Pay the bridge down first; anything beyond that is deployed.
      const toMargin = Math.min(margin, netCash);
      margin -= toMargin;
      portfolio += netCash - toMargin;
    } else {
      // Shortfall is borrowed — the bridge widens.
      margin += -netCash;
    }

    // Price movement applies to the whole book.
    portfolio *= 1 + monthlyNavDrag;
    if (portfolio < 0) portfolio = 0;

    const utilisationPct = portfolio > 0 ? (margin / portfolio) * 100 : 0;

    if (bridgeClearedAt === null && margin <= 0.01) bridgeClearedAt = m;
    if (limitBreachedAt === null && utilisationPct > i.marginLimitPct) limitBreachedAt = m;

    months.push({
      month: m, portfolioValue: portfolio, marginBalance: margin,
      distributions, marginInterest, netCash, utilisationPct,
    });
  }

  const startMargin = Math.max(0, i.marginBalance);
  const endMargin   = months[months.length - 1]?.marginBalance ?? startMargin;
  const direction: BridgeProjection['direction'] =
    endMargin < startMargin - 1 ? 'shrinking'
    : endMargin > startMargin + 1 ? 'growing'
    : 'stable';

  return { months, direction, bridgeClearedAt, limitBreachedAt, selfSustainingAt, firstMonthNetCash };
}

/** Format a month offset as a readable horizon. */
export function describeMonths(m: number | null): string {
  if (m === null) return 'not within 10 years';
  if (m < 12) return `${m} month${m === 1 ? '' : 's'}`;
  const years = Math.floor(m / 12);
  const rem = m % 12;
  return rem === 0 ? `${years} year${years === 1 ? '' : 's'}` : `${years}y ${rem}m`;
}
