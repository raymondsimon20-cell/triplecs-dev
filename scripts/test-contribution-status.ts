/**
 * test-contribution-status.ts — the pure logic behind contribution tracking.
 *
 * Focused on the two things that decide whether the count can be trusted:
 * internal-transfer detection (a false open item trains you to ignore the
 * badge) and the trackable filter (a missed deposit is the whole failure this
 * feature exists to prevent).
 *
 * Run: npx tsx scripts/test-contribution-status.ts
 */

import {
  findInternalTransferPair,
  isTrackableContribution,
  MIN_TRACKED_AMOUNT,
  RESIDUAL_CLOSE_THRESHOLD,
} from '../lib/contributions/status';
import type { CashFlowEvent } from '../lib/storage';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const ev = (p: Partial<CashFlowEvent>): CashFlowEvent => ({
  id: Math.random().toString(36).slice(2),
  date: '2026-08-14',
  direction: 'in',
  amount: 2000,
  kind: 'deposit',
  source: 'schwab',
  ...p,
});

// ─── Trackable filter ────────────────────────────────────────────────────────
console.log('\nisTrackableContribution');
check('genuine ACH deposit',        isTrackableContribution(ev({})), true);
check('journal in (may be internal)', isTrackableContribution(ev({ kind: 'journal' })), true);
check('withdrawal excluded',        isTrackableContribution(ev({ direction: 'out', kind: 'withdrawal' })), false);
check('dividend excluded',          isTrackableContribution(ev({ kind: 'dividend' })), false);
check('margin interest excluded',   isTrackableContribution(ev({ kind: 'interest', direction: 'out' })), false);
check('fee excluded',               isTrackableContribution(ev({ kind: 'fee', direction: 'out' })), false);
check(`below $${MIN_TRACKED_AMOUNT} excluded`, isTrackableContribution(ev({ amount: 12 })), false);
check(`exactly $${MIN_TRACKED_AMOUNT} tracked`, isTrackableContribution(ev({ amount: MIN_TRACKED_AMOUNT })), true);

// ─── Internal transfer detection ─────────────────────────────────────────────
console.log('\nfindInternalTransferPair');

// Roth -> taxable: same day, same amount, opposite legs, different accounts.
const rothOut  = ev({ id: 'out-1', direction: 'out', kind: 'withdrawal', amount: 5000, accountHash: 'ROTH' });
const taxableIn = ev({ id: 'in-1', direction: 'in', kind: 'journal', amount: 5000, accountHash: 'TAXABLE' });
check('paired journal detected',
  findInternalTransferPair(taxableIn, [taxableIn, rothOut])?.id, 'out-1');

// Genuine outside deposit — no matching outgoing leg anywhere.
const outside = ev({ id: 'in-2', amount: 2000, accountHash: 'TAXABLE' });
check('unpaired deposit is genuine',
  findInternalTransferPair(outside, [outside, rothOut]), null);

// Same account can't transfer to itself — this is a deposit and a withdrawal
// that happen to coincide, not an internal move.
const sameAcctOut = ev({ id: 'out-3', direction: 'out', kind: 'withdrawal', amount: 2000, accountHash: 'TAXABLE' });
check('same-account coincidence not a transfer',
  findInternalTransferPair(outside, [outside, sameAcctOut]), null);

// Different day — a $5k deposit today and a $5k withdrawal last week are
// almost certainly unrelated.
const staleOut = ev({ id: 'out-4', direction: 'out', kind: 'withdrawal', amount: 5000, accountHash: 'ROTH', date: '2026-08-01' });
check('different date not a transfer',
  findInternalTransferPair(taxableIn, [taxableIn, staleOut]), null);

// Different amount.
const wrongAmt = ev({ id: 'out-5', direction: 'out', kind: 'withdrawal', amount: 4999, accountHash: 'ROTH' });
check('different amount not a transfer',
  findInternalTransferPair(taxableIn, [taxableIn, wrongAmt]), null);

// Untagged legacy events can't be proven internal — must not match, or old
// history would start being suppressed for the wrong reason.
const untaggedOut = ev({ id: 'out-6', direction: 'out', kind: 'withdrawal', amount: 5000 });
check('untagged leg does not match',
  findInternalTransferPair(taxableIn, [taxableIn, untaggedOut]), null);
const untaggedIn = ev({ id: 'in-7', amount: 5000 });
check('untagged deposit does not match',
  findInternalTransferPair(untaggedIn, [untaggedIn, rothOut]), null);

// Single linked account: the other leg is invisible, so the deposit is treated
// as genuine. A false open item is visible and dismissible; the opposite error
// leaves money unallocated.
check('single-account user sees deposit as genuine',
  findInternalTransferPair(taxableIn, [taxableIn]), null);

// Penny tolerance — amounts should match within a cent.
const centOff = ev({ id: 'out-8', direction: 'out', kind: 'withdrawal', amount: 5000.004, accountHash: 'ROTH' });
check('sub-cent difference still pairs',
  findInternalTransferPair(taxableIn, [taxableIn, centOff])?.id, 'out-8');

// ─── Residual close threshold ────────────────────────────────────────────────
// Mirrors markAllocated's decision: does a partly-deployed contribution close?
console.log('\nresidual handling');
const closes = (amount: number, deployed: number) =>
  (amount - deployed) < RESIDUAL_CLOSE_THRESHOLD;
check('$2000 with $1847 deployed stays open ($153 left)', closes(2000, 1847), false);
check('$2000 with $1960 deployed stays open ($40 left)',  closes(2000, 1960), false);
check('$2000 with $1993 deployed closes ($7 left)',       closes(2000, 1993), true);
check('fully deployed closes',                            closes(2000, 2000), true);
// Over-deployment (bought slightly past the contribution using settled cash)
// must not reopen the item on a negative residual.
check('over-deployed closes',                             closes(2000, 2100), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
