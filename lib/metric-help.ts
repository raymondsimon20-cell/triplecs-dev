/**
 * metric-help.ts — what every number on the dashboard means, and how it's
 * derived.
 *
 * Keyed by the exact `label` string a card renders, so <StatCard> can look up
 * its own help without every call site being edited. Adding a stat card with
 * a label listed here gets a bubble for free; adding one that isn't listed
 * gets no bubble (and is reported by scripts/check-metric-help.ts).
 *
 * Two fields:
 *   what — plain English. What the number is, and why it's worth looking at.
 *   how  — the derivation, for figures that are computed rather than read
 *          straight off the Schwab response. Skip it when the value is just a
 *          count or a raw broker field; a fake formula is worse than none.
 *
 * Keep `how` honest about disagreements with Schwab's own website. Several of
 * these numbers deliberately differ (Day Change excludes the margin line,
 * Net Portfolio Value uses liquidationValue, and so on) and the bubble is the
 * only place a reader finds that out.
 */

export interface MetricHelp {
  what: string;
  how?: string;
}

export const METRIC_HELP: Record<string, MetricHelp> = {
  // ─── Dashboard overview ───────────────────────────────────────────────────
  'Gross Portfolio Value': {
    what: 'Everything you hold, at current market prices, before subtracting what you borrowed. This is exposure, not net worth.',
    how:  'Long market value + short market value. Short value is added, not absolute-valued — Schwab reports it negative because a short is a liability.',
  },
  'Net Portfolio Value': {
    what: 'What the account is actually worth: holdings minus margin debt. This is the number that matters for net worth.',
    how:  "Schwab's liquidationValue, which is what its Positions page calls \"Total accounts value\". Differs from equity in a margin account holding shorts, where equity counts short market value as a positive.",
  },
  'Margin Used': {
    what: 'Money currently borrowed from Schwab against your holdings. Interest accrues on this daily.',
    how:  'Absolute value of the margin balance. Schwab hard-stops new borrowing at 50% utilization.',
  },
  'Equity %': {
    what: 'The share of the portfolio you own outright. Falls as borrowing rises; below 40% the app switches to defense and stops new buying.',
    how:  'Equity ÷ gross portfolio value.',
  },
  'Unique Positions': {
    what: 'How many distinct holdings are in the account, options included. A rough concentration check.',
  },
  'Cash & Cash Investments': {
    what: 'Settled cash and money-market balances. Goes negative when you are borrowing on margin.',
  },
  'Last Sync': {
    what: 'When the app last pulled fresh data from Schwab. Portfolio data is cached for 60 seconds, so this can lag a refresh slightly.',
  },
  'Day Change': {
    what: "Today's market move on your positions only. Deliberately not the same as Schwab's headline day change.",
    how:  "Sum of each position's move since yesterday's close, over prior net account value. Schwab's headline figure folds in the cash/margin line, so drawing margin to buy shares shows there as a loss. Borrowing money is not a loss, so this card leaves it out.",
  },
  'Total Gain': {
    what: 'Unrealized profit or loss on what you currently hold — paper gains, not money taken off the table.',
    how:  'Sum of (market value − cost basis) across open positions, over total cost basis. Runs since purchase, so the window differs per position.',
  },

  // ─── Positions ────────────────────────────────────────────────────────────
  'Total Value': {
    what: 'Combined market value of every position in this view, at current prices.',
  },
  'Positions': {
    what: 'Number of position rows shown, after any filter you have applied.',
  },
  'Unique Symbols': {
    what: 'Distinct tickers held. Lower than the position count when you hold both shares and options on the same name.',
  },
  'Top Position': {
    what: 'Your largest holding by market value. Worth watching as a concentration risk.',
  },

  // ─── Dividends & income ───────────────────────────────────────────────────
  'Trailing 12M Income': {
    what: 'Dividends and distributions actually received over the last 12 months. Cash that landed, not a projection.',
    how:  'Sum of dividend transactions from the Schwab feed dated within the last 365 days.',
  },
  'Monthly Average': {
    what: 'Trailing 12-month income spread evenly across the year. Smooths out lumpy quarterly payers.',
    how:  'Trailing 12-month income ÷ 12. Always divides by 12 even if fewer months had payments, so it reads low on a partial year.',
  },
  'Dividend Symbols': {
    what: 'How many of your holdings actually paid you in the last 12 months.',
  },
  'All-Time Income': {
    what: 'Every dividend recorded for this account since the app started tracking it. Limited by how far back the transaction history reaches.',
  },
  'Est. Annual Income': {
    what: 'Forward-looking guess at the next 12 months of income, based on what each holding currently pays.',
    how:  "Per position: current shares × the most recent payment, annualized by its cadence. A projection — it assumes rates hold and you don't change position sizes.",
  },
  'Est. Monthly Income': {
    what: 'Projected annual income spread across 12 months.',
    how:  'Estimated annual income ÷ 12.',
  },
  'Yield on Cost': {
    what: 'What your income stream returns against the money you originally put in. Rises over time as a position appreciates, since the denominator is frozen at purchase.',
    how:  'Projected annual income ÷ cost basis of the paying positions.',
  },
  'Forward Yield': {
    what: "What your income returns against what the holdings are worth today. The number to compare against a bond or a savings rate.",
    how:  'Projected annual income ÷ current market value of the paying positions.',
  },

  // ─── Business spread (income vs borrowing cost) ───────────────────────────
  'Blended Yield': {
    what: 'The average yield across the whole portfolio, including holdings that pay nothing. What every dollar invested actually earns in distributions.',
    how:  'Projected annual income ÷ gross portfolio value. Non-payers drag this below any individual fund yield.',
  },
  'Margin Rate': {
    what: 'The annual interest rate Schwab charges on borrowed money.',
  },
  'Spread': {
    what: 'How much your portfolio out-earns the cost of the money you borrowed. Positive means borrowing is paying for itself; negative means the debt is eating the income.',
    how:  'Blended yield − margin rate, in percentage points.',
  },
  'Net / Paycheck': {
    what: 'Income after margin interest, sliced into a per-paycheck figure — what the portfolio contributes to living expenses each pay period.',
    how:  '(Projected annual income − annual margin interest) ÷ paychecks per year.',
  },

  // ─── Cash flow ledger ─────────────────────────────────────────────────────
  'Total Income': {
    what: 'Money the portfolio generated over the period — dividends, distributions, and interest credits.',
  },
  'Total Expenses': {
    what: 'Money that left: cash you withdrew plus margin interest charged.',
    how:  'Cash withdrawals + margin cost.',
  },
  'Margin Cost': {
    what: 'Interest Schwab charged on borrowed money over the period. Already included in Total Expenses.',
  },
  'Contributions': {
    what: 'Outside money you deposited. Not performance — the return calculations deliberately strip this out.',
  },
  'Cash Withdrawals': {
    what: 'Cash you pulled out of the account. Already included in Total Expenses.',
  },
  'Capital Deployed': {
    what: 'Cash spent buying securities over the period. Money moving from cash into positions, not money leaving the account.',
  },
  'Net Operating': {
    what: 'Whether the portfolio paid for itself over the period, before any market movement.',
    how:  'Total income − total expenses. Excludes price changes entirely; a positive figure with a falling market is normal.',
  },

  // ─── Month close ──────────────────────────────────────────────────────────
  'Closing Equity': {
    what: 'Net account value at the end of the month. Shows live and mid-month for the current month.',
  },
  'Net Change': {
    what: 'How much net account value moved over the month, from every cause combined — market, income, and your own deposits.',
    how:  'Closing equity − opening equity. Includes contributions, so a big deposit reads as a big gain here. Total Return is the figure that strips those out.',
  },
  'Market & Other': {
    what: 'The part of the month\'s change that came from the market rather than your deposits, income, or realized trades.',
    how:  'Closing equity − opening − contributions − net operating − realized. A residual, so anything the ledger failed to categorize lands here too.',
  },

  // ─── Target allocation ────────────────────────────────────────────────────
  'Scored Tickers': {
    what: 'How many symbols in your approved universe the scorer rated this run.',
  },
  'Strong Add / Add': {
    what: 'Symbols the scorer thinks are worth buying into right now.',
  },
  'Est. Blended Yield': {
    what: 'What the portfolio would yield at its current weights, next to what it would yield if you moved to the target weights. The gap is what rebalancing buys you in income.',
    how:  'Each holding\'s forward yield weighted by its share of the portfolio. The "at target weights" figure reruns the same calculation against the plan rather than today\'s actual weights.',
  },
  'Hold / Trim': {
    what: 'Symbols the scorer says to leave alone or reduce. Seed positions are never rated below Neutral — they are universe bookmarks, not investments.',
  },

  // ─── Performance panel ────────────────────────────────────────────────────
  'Cumulative TWR': {
    what: 'Total time-weighted return over your snapshot history. The honest measure of how the strategy performed, with your own deposits taken out.',
    how:  "Each period uses Modified Dietz, weighting external cash by how long it was invested, then chains the results geometrically. Uses equity rather than position value so dividends count as return and ex-dividend price drops don't read as losses. Synthetic backfilled days are excluded.",
  },
  'Annualized vs 40% target': {
    what: 'Your return scaled to a yearly rate, next to the 40% CAGR the plan targets.',
    how:  "Cumulative TWR compounded to a full year: (1 + TWR) ^ (365 ÷ days) − 1. On a short history this extrapolates hard — a good month can imply an absurd annual rate, so treat it as directional until you have a few months of snapshots.",
  },
  'Alpha vs SPY': {
    what: 'How much you beat or trailed simply holding the S&P 500 over the same window. This is what the strategy earns for its extra complexity and risk.',
    how:  'Portfolio TWR − SPY return over the same dates, in percentage points. Only days where a SPY close was recorded are compared, on both sides.',
  },
  'Return path': {
    what: 'Cumulative return over time, portfolio against SPY. Shows when the gap opened rather than just the final number.',
    how:  'Each point is equity ÷ starting equity − 1. Faded segments are synthetic days reconstructed from current positions at historical closes — approximate, and excluded from the headline return figures.',
  },
  'Pillar contribution to total return': {
    what: 'Which sleeves actually drove the return. A pillar can post a great return and still contribute little if you barely hold any of it.',
    how:  "Per period, each pillar's starting weight × its own return, summed across periods. Contributions are in percentage points of total return, so they approximately add up to the headline figure.",
  },

  // ─── Margin bridge ────────────────────────────────────────────────────────
  'Net cash, month 1': {
    what: 'What the portfolio nets you next month once living expenses and margin interest are paid.',
    how:  'Monthly distributions + income deposited − monthly expenses − margin interest. Negative means the shortfall gets borrowed, which grows the debt.',
  },
  'Bridge direction': {
    what: 'Whether the margin balance shrinks or grows over the ten-year projection. Shrinking means the portfolio is paying off its own debt; growing means you are borrowing to fund the gap.',
  },
  'Bridge cleared': {
    what: 'When the projection has the margin balance reaching zero — the point where you own the portfolio outright.',
    how:  'A projection on your current income, expense, and rate assumptions. The value is in the direction and rough timescale, not the exact month.',
  },
  'Self-sustaining': {
    what: 'When distributions alone cover both living expenses and margin interest, so the portfolio no longer needs outside money.',
    how:  'First projected month where distributions ≥ expenses + interest. Same assumption caveat as Bridge cleared.',
  },
};

/** Help for a metric label, or undefined when none is written yet. */
export function metricHelp(label: string): MetricHelp | undefined {
  return METRIC_HELP[label];
}
