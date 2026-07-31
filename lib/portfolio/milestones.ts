/**
 * milestones — the phase ladder, measured against actual behaviour.
 *
 * The strategy frames progress as four thresholds: margin qualified, floating
 * core expenses, the $100k mark, then distributions covering living costs.
 *
 * A static progress bar would be decoration. What makes this worth building is
 * pace: the trailing contribution rate is observable from the transaction
 * ledger, so "how far to the next threshold" can be answered with the account's
 * own behaviour instead of an assumed savings rate.
 */

export interface Milestone {
  id:        string;
  label:     string;
  threshold: number;
  meaning:   string;
}

/**
 * Thresholds are portfolio value except the last, which is a monthly income
 * figure — the point of the ladder is that the final step changes units. Value
 * stops being the goal once distributions cover expenses.
 */
export const VALUE_MILESTONES: Milestone[] = [
  { id: 'spark',       label: 'Margin qualified', threshold: 2_000,
    meaning: 'Minimum for a margin account. Float one small bill to learn the cycle.' },
  { id: 'foundation',  label: 'Foundation',       threshold: 20_000,
    meaning: 'Distributions are meaningful enough to float core expenses like rent.' },
  { id: 'acceleration', label: 'Acceleration',    threshold: 100_000,
    meaning: 'The hardest stretch. Compounding becomes visible past this point.' },
];

export interface MilestoneProgress {
  /** The milestone currently being worked toward, or null when all are passed. */
  next:            Milestone | null;
  /** Most recent milestone already reached. */
  current:         Milestone | null;
  /** Progress toward `next`, 0–100. */
  progressPct:     number;
  /** Dollars still needed to reach `next`. */
  remaining:       number;
  /**
   * Months to reach `next` at the observed monthly rate of accumulation, or
   * null when the rate is zero or negative — in which case the threshold is not
   * being approached and a projection would be fiction.
   */
  monthsAtCurrentPace: number | null;
}

export function milestoneProgress(portfolioValue: number, monthlyAccumulation: number): MilestoneProgress {
  const passed = VALUE_MILESTONES.filter((m) => portfolioValue >= m.threshold);
  const current = passed.length > 0 ? passed[passed.length - 1] : null;
  const next = VALUE_MILESTONES.find((m) => portfolioValue < m.threshold) ?? null;

  if (!next) {
    return { next: null, current, progressPct: 100, remaining: 0, monthsAtCurrentPace: null };
  }

  const floor = current?.threshold ?? 0;
  const span  = next.threshold - floor;
  const progressPct = span > 0 ? Math.max(0, Math.min(100, ((portfolioValue - floor) / span) * 100)) : 0;
  const remaining = Math.max(0, next.threshold - portfolioValue);

  return {
    next, current, progressPct, remaining,
    monthsAtCurrentPace: monthlyAccumulation > 0 ? Math.ceil(remaining / monthlyAccumulation) : null,
  };
}

/**
 * Freedom is a different measurement: monthly distributions against the monthly
 * cost of living, not a portfolio balance. Reported separately for that reason
 * rather than being bolted onto the value ladder.
 */
export interface FreedomProgress {
  monthlyIncome:  number;
  monthlyTarget:  number;
  coveragePct:    number;
  gap:            number;
  /** Portfolio value implied by the target at the current blended yield. */
  impliedPortfolio: number | null;
}

export function freedomProgress(
  monthlyDistributions: number,
  monthlyTarget: number,
  blendedYieldPct: number,
): FreedomProgress {
  const coveragePct = monthlyTarget > 0 ? (monthlyDistributions / monthlyTarget) * 100 : 0;
  const impliedPortfolio = blendedYieldPct > 0
    ? (monthlyTarget * 12) / (blendedYieldPct / 100)
    : null;
  return {
    monthlyIncome: monthlyDistributions,
    monthlyTarget,
    coveragePct,
    gap: Math.max(0, monthlyTarget - monthlyDistributions),
    impliedPortfolio,
  };
}
