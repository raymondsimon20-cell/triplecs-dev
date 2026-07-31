/**
 * dividend-cadence — derive distribution cadence from observed payment history.
 *
 * Why this exists: `FREQ_MAP` in IncomeHub is a hand-maintained symbol→frequency
 * table. It goes stale silently. As of mid-2026 it still classifies the YieldMax
 * weeklies (YMAX/YMAG/ULTY/TSLY/NVDY/CONY…) as `monthly`, which understates their
 * projected annual income by roughly 4x and mis-shapes the 12-month projection.
 *
 * Deriving cadence from the actual spacing of payments is self-correcting: when a
 * fund changes its distribution schedule, the classification follows on its own.
 * FREQ_MAP is retained only as a fallback for symbols with too little history.
 */

export type Cadence =
  | 'weekly'
  | 'bi-weekly'
  | 'monthly'
  | 'quarterly'
  | 'semi-annual'
  | 'annual'
  | 'irregular'
  | 'unknown';

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly:        'Weekly',
  'bi-weekly':   'Bi-Weekly',
  monthly:       'Monthly',
  quarterly:     'Quarterly',
  'semi-annual': 'Semi-Annual',
  annual:        'Annual',
  irregular:     'Irregular',
  unknown:       '—',
};

/** Payments per year, used for annualising a single distribution. */
export const PAYMENTS_PER_YEAR: Record<Cadence, number> = {
  weekly:        52,
  'bi-weekly':   26,
  monthly:       12,
  quarterly:     4,
  'semi-annual': 2,
  annual:        1,
  irregular:     0,
  unknown:       0,
};

/** Nominal day-gap for each cadence, used to project the next payment date. */
const NOMINAL_GAP_DAYS: Record<Cadence, number> = {
  weekly:        7,
  'bi-weekly':   14,
  monthly:       30,
  quarterly:     91,
  'semi-annual': 182,
  annual:        365,
  irregular:     0,
  unknown:       0,
};

const DAY_MS = 86_400_000;

/**
 * Classify a median inter-payment gap (in days) into a cadence bucket.
 * Bounds are deliberately wide — real distributions drift around holidays,
 * month-end conventions, and settlement.
 */
function classifyGap(days: number): Cadence {
  if (days <= 0)   return 'unknown';
  if (days <= 10)  return 'weekly';
  if (days <= 20)  return 'bi-weekly';
  if (days <= 45)  return 'monthly';
  if (days <= 115) return 'quarterly';
  if (days <= 250) return 'semi-annual';
  if (days <= 450) return 'annual';
  return 'irregular';
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface CadenceResult {
  cadence:        Cadence;
  /** Median days between payments; 0 when undetermined. */
  medianGapDays:  number;
  /** How many distinct payment dates the classification is based on. */
  observations:   number;
  /** True when derived from history rather than the fallback table. */
  derived:        boolean;
  /** Most recent payment date (YYYY-MM-DD), or null. */
  lastPaymentDate: string | null;
  /** Projected next payment date (YYYY-MM-DD), or null when unprojectable. */
  nextPaymentDate: string | null;
}

/**
 * Derive cadence for one symbol from its payment dates.
 *
 * @param dates    Payment dates as YYYY-MM-DD. Order does not matter; duplicates
 *                 (same-day DRIP legs, split payments) are collapsed to one event.
 * @param fallback Cadence to use when history is too thin to classify. Pass the
 *                 FREQ_MAP lookup here so existing behaviour degrades gracefully.
 */
export function deriveCadence(dates: string[], fallback: Cadence = 'unknown'): CadenceResult {
  const unique = Array.from(new Set(dates.filter(Boolean))).sort();
  const last = unique.length > 0 ? unique[unique.length - 1] : null;

  // One payment tells us nothing about spacing; two is the minimum for a gap.
  if (unique.length < 2) {
    return {
      cadence:         fallback,
      medianGapDays:   NOMINAL_GAP_DAYS[fallback] ?? 0,
      observations:    unique.length,
      derived:         false,
      lastPaymentDate: last,
      nextPaymentDate: projectNext(last, NOMINAL_GAP_DAYS[fallback] ?? 0),
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < unique.length; i += 1) {
    const a = Date.parse(`${unique[i - 1]}T12:00:00Z`);
    const b = Date.parse(`${unique[i]}T12:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    const gap = (b - a) / DAY_MS;
    if (gap > 0) gaps.push(gap);
  }

  if (gaps.length === 0) {
    return {
      cadence: fallback, medianGapDays: 0, observations: unique.length,
      derived: false, lastPaymentDate: last, nextPaymentDate: null,
    };
  }

  const sortedGaps = [...gaps].sort((x, y) => x - y);
  const med = median(sortedGaps);
  let cadence = classifyGap(med);

  // Consistency check. A fund that pays on a real schedule has tightly clustered
  // gaps. Wide dispersion means special/irregular distributions — classifying
  // those as "monthly" would produce a confidently wrong projection, so we say
  // irregular instead. Skipped below 4 observations, where dispersion is noise.
  if (cadence !== 'unknown' && gaps.length >= 3) {
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    if (cv > 0.75) cadence = 'irregular';
  }

  return {
    cadence,
    medianGapDays:   Math.round(med),
    observations:    unique.length,
    derived:         true,
    lastPaymentDate: last,
    nextPaymentDate: projectNext(last, med),
  };
}

function projectNext(lastDate: string | null, gapDays: number): string | null {
  if (!lastDate || gapDays <= 0) return null;
  const t = Date.parse(`${lastDate}T12:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + gapDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Projected ex-date and pay-date for the next distribution.
 *
 * Schwab's transaction feed gives us pay dates only — the ex-date is not in the
 * data we hold. We approximate it as one settlement-ish window ahead of the
 * projected pay date, which is the common convention for these funds. Treat both
 * as estimates and label them as such in the UI; they are not declared dates.
 */
export function projectDividendDates(result: CadenceResult): { exDate: string | null; payDate: string | null } {
  const payDate = result.nextPaymentDate;
  if (!payDate) return { exDate: null, payDate: null };

  // Weeklies typically go ex 1 day before pay; slower cadences run a longer lag.
  const lagDays = result.cadence === 'weekly' || result.cadence === 'bi-weekly' ? 1 : 2;
  const t = Date.parse(`${payDate}T12:00:00Z`);
  if (Number.isNaN(t)) return { exDate: null, payDate };
  return { exDate: new Date(t - lagDays * DAY_MS).toISOString().slice(0, 10), payDate };
}

/**
 * Spread an annual figure across the next 12 months according to cadence.
 *
 * Index 0 is `startMonth` (0-11), so the caller gets a forward-looking series
 * beginning at the current month. Cadences that do not pay every month land on
 * the months where a payment is actually expected, anchored to `anchorMonth`
 * (the month of the last observed payment) so quarterly payers line up with
 * their real cycle rather than an arbitrary Jan/Apr/Jul/Oct assumption.
 */
export function distributeAnnualToMonths(
  annual: number,
  cadence: Cadence,
  startMonth: number,
  anchorMonth: number | null = null,
): number[] {
  const months = new Array(12).fill(0);
  if (annual <= 0) return months;

  const ppy = PAYMENTS_PER_YEAR[cadence];

  // Irregular/unknown: no reliable shape, so spread it evenly rather than
  // inventing spikes on months we have no evidence for.
  if (ppy === 0) {
    for (let i = 0; i < 12; i += 1) months[i] = annual / 12;
    return months;
  }

  if (ppy >= 12) {
    // Weekly and bi-weekly resolve to a per-month amount. Weight by how many
    // payment periods actually fall in each calendar month.
    const perPeriod = annual / ppy;
    const periodsPerMonth = ppy / 12;
    for (let i = 0; i < 12; i += 1) months[i] = perPeriod * periodsPerMonth;
    return months;
  }

  // Quarterly / semi-annual / annual: place payments on their real cycle.
  const strideMonths = Math.round(12 / ppy);
  const anchor = anchorMonth ?? startMonth;
  const perPayment = annual / ppy;
  for (let i = 0; i < 12; i += 1) {
    const calendarMonth = (startMonth + i) % 12;
    // Distance from the anchor month, in months, modulo the stride.
    const offset = ((calendarMonth - anchor) % strideMonths + strideMonths) % strideMonths;
    if (offset === 0) months[i] = perPayment;
  }
  return months;
}

/**
 * Annualise trailing payments using derived cadence.
 * Falls back to scaling the trailing window when cadence is unusable.
 */
export function annualiseFromHistory(
  payments: { date: string; amount: number }[],
  result: CadenceResult,
): number {
  if (payments.length === 0) return 0;
  const ppy = PAYMENTS_PER_YEAR[result.cadence];

  if (ppy > 0) {
    // Average the most recent payments at this cadence, then annualise. Recent
    // payments track the current distribution rate better than a 12-month mean,
    // which matters for funds that have cut or raised recently.
    const recent = [...payments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.min(4, payments.length));
    const avg = recent.reduce((s, p) => s + p.amount, 0) / recent.length;
    return avg * ppy;
  }

  // Irregular/unknown: scale whatever the observed window covers up to a year.
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const first = Date.parse(`${sorted[0].date}T12:00:00Z`);
  const last = Date.parse(`${sorted[sorted.length - 1].date}T12:00:00Z`);
  const spanDays = (last - first) / DAY_MS;
  const total = payments.reduce((s, p) => s + p.amount, 0);
  if (spanDays < 30) return total; // too short a window to extrapolate safely
  return total * (365 / spanDays);
}
