import { computeTWR } from '../lib/performance';
import { buildSnapshot, type FetchedAccountState } from '../lib/portfolio/fetch';
import type { CashFlowEvent, PortfolioSnapshot } from '../lib/storage';

let failures = 0;

function close(label: string, actual: number, expected: number, tolerance = 1e-9) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}

function snap(iso: string, equity: number | null): PortfolioSnapshot {
  return {
    savedAt: Date.parse(iso), totalValue: equity ?? 0, equity,
    marginBalance: 0, marginUtilizationPct: 0, pillarSummary: [], positions: [],
  };
}

function flow(overrides: Partial<CashFlowEvent>): CashFlowEvent {
  return {
    id: 'flow', date: '2026-08-02', direction: 'in', amount: 100,
    kind: 'deposit', source: 'schwab', accountHash: 'acct-1', ...overrides,
  };
}

const start = snap('2026-08-01T12:00:00.000Z', 100);
const end = snap('2026-08-02T12:00:00.000Z', 210);

// $100 added halfway through the period was invested for half the interval:
// ($210 - $100 - $100) / ($100 + $100 * 0.5) = 6.6667%.
const timed = computeTWR([start, end], [flow({ occurredAt: '2026-08-02T00:00:00.000Z' })]);
close('mid-period flow uses Modified Dietz weighting', timed?.twrPct ?? NaN, 10 / 150);

// Legacy/manual date-only entries belong to the period ending on that date.
// The $100 deposit is removed from the $110 balance increase, leaving $10 gain.
const dateOnly = computeTWR([start, end], [flow({ occurredAt: undefined })]);
close('date-only flow is assigned to its calendar-date snapshot period', dateOnly?.twrPct ?? NaN, 0.1);

const withGap = computeTWR([
  snap('2026-08-01T12:00:00.000Z', 100),
  snap('2026-08-02T12:00:00.000Z', null),
  snap('2026-08-10T12:00:00.000Z', 100),
  snap('2026-08-11T12:00:00.000Z', 110),
], []);
close('CAGR day count excludes skipped periods', withGap?.daysCovered ?? NaN, 1);
close('surviving period return is preserved', withGap?.twrPct ?? NaN, 0.1);

const emptyState = (accountNumber: string, equity: number): FetchedAccountState => ({
  accountNumber, totalValue: equity, equity, marginBalance: 0,
  marginUtilizationPct: 0, afwDollars: 0, pillarSummary: [], positions: [],
});
const household = buildSnapshot([emptyState('one', 100), emptyState('two', 250)]);
close('household snapshot sums every account', household.equity ?? NaN, 350);

if (failures > 0) process.exit(1);
