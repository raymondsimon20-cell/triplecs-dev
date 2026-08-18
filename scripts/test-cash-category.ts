import { classifyCashMovement, isMarginInterestCharge, isMarginInterestDescription } from '../lib/transactions/cash-category';
import { cashFlowDateKeys, summarizeCashFlow } from '../lib/cash-flow';
import { findExpenseTag, normalizeExpenseDescription } from '../lib/transactions/expense-tags';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${String(actual)}, expected ${String(expected)}`);
}

console.log('\nCASH MOVEMENT CLASSIFICATION');

check(
  'negative trade-settlement journal is internal',
  classifyCashMovement({ txType: 'JOURNAL', description: 'SETTLEMENT OF TRADE PURCHASE', amount: -12_500 }),
  'Transfer',
);
check(
  'negative register movement is internal',
  classifyCashMovement({ txType: 'JOURNAL', description: 'TRF FUNDS TO TYPE 1', amount: -4_000 }),
  'Transfer',
);
check(
  'security-linked cash disbursement is internal',
  classifyCashMovement({ txType: 'CASH_DISBURSEMENT', description: 'PURCHASE', amount: -2_500, hasSecurity: true }),
  'Transfer',
);
check(
  'ambiguous negative journal is not treated as external withdrawal',
  classifyCashMovement({ txType: 'JOURNAL', description: 'INTERNAL ACCOUNT ADJUSTMENT', amount: -500 }),
  'Transfer',
);
check(
  'explicit journal withdrawal remains a withdrawal',
  classifyCashMovement({ txType: 'JOURNAL', description: 'CASH WITHDRAWAL REQUEST', amount: -500 }),
  'Withdrawal',
);
check(
  'ACH disbursement remains a withdrawal',
  classifyCashMovement({ txType: 'ACH_DISBURSEMENT', description: 'ACH TO BANK', amount: -500 }),
  'Withdrawal',
);
check(
  'wire out remains a withdrawal',
  classifyCashMovement({ txType: 'WIRE_OUT', description: 'OUTGOING WIRE', amount: -500 }),
  'Withdrawal',
);
check(
  'known payer remains a contribution',
  classifyCashMovement({ txType: 'JOURNAL', description: 'PINELAND PAYROLL', amount: 1_500 }),
  'Contribution',
);
check('recognizes margin interest', isMarginInterestDescription('MARGIN INTEREST CHARGE'), true);
check('recognizes margin fee variant', isMarginInterestDescription('MONTHLY MARGIN FEE'), true);
check('recognizes debit interest variant', isMarginInterestDescription('DEBIT INTEREST'), true);
check('recognizes margin balance interest variant', isMarginInterestDescription('MARGIN BALANCE INTEREST ADJUSTMENT'), true);
check('recognizes Schwab interest billing period', isMarginInterestDescription('INTEREST 06/29THRU 07/29'), true);
check('recognizes spaced Schwab interest billing period', isMarginInterestDescription('INTEREST 6/29 THRU 7/29'), true);
check('negative billing-period interest is a margin charge', isMarginInterestCharge('INTEREST 06/29THRU 07/29', -842.17), true);
check('positive billing-period interest remains income', isMarginInterestCharge('INTEREST 06/29THRU 07/29', 12.45), false);
check('does not call trade settlement interest', isMarginInterestDescription('INTERESTED PARTY TRADE SETTLEMENT'), false);

console.log('\nCASH FLOW WINDOW AND TOTALS');
const keys = cashFlowDateKeys(30, new Date(2026, 7, 18, 23, 30));
check('30-day view has exactly 30 dates', keys.length, 30);
check('window includes local today', keys.at(-1), '2026-08-18');
check('window starts 29 calendar days earlier', keys[0], '2026-07-20');

const summary = summarizeCashFlow([
  { date: '2026-08-18', category: 'Dividend', amount: 100 },
  { date: '2026-08-18', category: 'Interest', amount: 5 },
  { date: '2026-08-18', category: 'Option Trade', amount: 250 },
  { date: '2026-08-18', category: 'Option Trade', amount: -80 },
  { date: '2026-08-18', category: 'Stock Sale', amount: 10_000 },
  { date: '2026-08-18', category: 'Stock Purchase', amount: -9_000 },
  { date: '2026-08-18', category: 'Margin Interest', amount: -40 },
  { date: '2026-08-18', category: 'Withdrawal', amount: -60 },
]);
check('income excludes stock-sale principal', summary.income, 355);
check('positive option cash is visible as income', summary.optionIncome, 250);
check('stock-sale proceeds are disclosed separately', summary.stockSaleProceeds, 10_000);
check('purchases remain capital deployed', summary.deployed, 9_080);
check('expenses include withdrawals and margin interest only', summary.expenses, 100);
check('net operating uses the corrected income model', summary.netOperating, 255);

console.log('\nTRANSFER EXPENSE TAGS');
check(
  'normalization removes changing reference numbers',
  normalizeExpenseDescription('Acme Rent REF: 123456789'),
  'ACME RENT',
);
check(
  'same-name rule tags a future transfer',
  findExpenseTag('future-id', 'Acme Rent REF: 999999999', {
    overrides: {},
    rules: [{
      id: 'rule-1',
      normalizedDescription: 'ACME RENT',
      expenseCategory: 'Housing',
      createdAt: '2026-08-18T00:00:00.000Z',
    }],
  })?.expenseCategory,
  'Housing',
);
check(
  'one-off override tags its exact transaction',
  findExpenseTag('txn-1', 'Anything', {
    rules: [],
    overrides: {
      'txn-1': { transactionId: 'txn-1', expenseCategory: 'Other', createdAt: '2026-08-18T00:00:00.000Z' },
    },
  })?.expenseCategory,
  'Other',
);

if (failures > 0) {
  console.error(`\n${failures} cash-category check(s) failed.`);
  process.exit(1);
}

console.log('\nAll cash-category checks passed.');
