/**
 * test-ro-deadline.ts — rights-offering urgency assessment.
 *
 * The failure this guards against is silence: an offering that needs a
 * decision but produces no banner. Every case below is really asking "would
 * this have screamed?"
 *
 * Run: npx tsx scripts/test-ro-deadline.ts
 */

import { assessRO, mostUrgent, daysUntil, type ROStatus } from '../lib/ro-deadline';

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const TODAY = new Date('2026-08-15T12:00:00Z');
const ro = (p: Partial<ROStatus>): ROStatus => ({
  ticker: 'CLM', status: 'subscription_open', notes: '', updatedAt: '',
  decision: 'pending', ...p,
});

console.log('\ndaysUntil');
check('same day is 0',        daysUntil('2026-08-15', TODAY), 0);
check('tomorrow is 1',        daysUntil('2026-08-16', TODAY), 1);
check('yesterday is -1',      daysUntil('2026-08-14', TODAY), -1);
check('crosses a month',      daysUntil('2026-09-01', TODAY), 17);
check('invalid date is NaN',  Number.isNaN(daysUntil('not-a-date', TODAY)), true);

console.log('\nassessRO — escalation by days remaining');
check('30 days out is info',      assessRO(ro({ expiresAt: '2026-09-14' }), TODAY).urgency, 'info');
check('11 days out is info',      assessRO(ro({ expiresAt: '2026-08-26' }), TODAY).urgency, 'info');
check('10 days out is warn',      assessRO(ro({ expiresAt: '2026-08-25' }), TODAY).urgency, 'warn');
check('4 days out is warn',       assessRO(ro({ expiresAt: '2026-08-19' }), TODAY).urgency, 'warn');
check('3 days out is critical',   assessRO(ro({ expiresAt: '2026-08-18' }), TODAY).urgency, 'critical');
check('expires today is critical',assessRO(ro({ expiresAt: '2026-08-15' }), TODAY).urgency, 'critical');
check('expired is missed',        assessRO(ro({ expiresAt: '2026-08-10' }), TODAY).urgency, 'missed');

console.log('\nassessRO — what silences it');
check('decided subscribed → silent',
  assessRO(ro({ expiresAt: '2026-08-18', decision: 'subscribed' }), TODAY).needsAction, false);
check('decided declined → silent',
  assessRO(ro({ expiresAt: '2026-08-18', decision: 'declined' }), TODAY).needsAction, false);
check('stage none → silent',
  assessRO(ro({ expiresAt: '2026-08-18', status: 'none' }), TODAY).needsAction, false);
check('stage complete → silent',
  assessRO(ro({ expiresAt: '2026-08-18', status: 'complete' }), TODAY).needsAction, false);
check('subscription_closed → silent',
  assessRO(ro({ expiresAt: '2026-08-10', status: 'subscription_closed' }), TODAY).needsAction, false);

console.log('\nassessRO — cases that MUST still fire');
// An expired-but-undecided offering keeps nagging. It's too late to subscribe,
// but leaving it silently unresolved is how the next one gets missed too.
check('expired but undecided still needs action',
  assessRO(ro({ expiresAt: '2026-08-01' }), TODAY).needsAction, true);
// The stage is hand-advanced and goes stale. An offering still marked
// 'announced' while the window closes must not be treated as not-yet-urgent.
check('stale "announced" stage still escalates on dates',
  assessRO(ro({ status: 'announced', expiresAt: '2026-08-16' }), TODAY).urgency, 'critical');
// Detection with no deadline yet — the common state right after the watcher
// fires. Must surface, and must say why it can't count down.
const noDate = assessRO(ro({ status: 'announced', expiresAt: undefined }), TODAY);
check('missing deadline needs action', noDate.needsAction, true);
check('missing deadline flagged',      noDate.missingDeadline, true);
check('missing deadline is warn',      noDate.urgency, 'warn');
check('missing deadline has no count', noDate.daysLeft, null);
// Default decision: a record written before `decision` existed has it
// undefined, and must be treated as pending rather than silently resolved.
check('undefined decision treated as pending',
  assessRO({ ticker: 'CRF', status: 'subscription_open', notes: '', updatedAt: '', expiresAt: '2026-08-20' }, TODAY).needsAction,
  true);

console.log('\nmostUrgent');
const clmSoon = ro({ ticker: 'CLM', expiresAt: '2026-08-17' });          // critical
const crfLater = ro({ ticker: 'CRF', expiresAt: '2026-09-10' });         // info
const crfDone  = ro({ ticker: 'CRF', expiresAt: '2026-08-16', decision: 'subscribed' });
check('picks the nearest deadline',
  mostUrgent([crfLater, clmSoon], TODAY)?.ro.ticker, 'CLM');
check('expired outranks critical',
  mostUrgent([clmSoon, ro({ ticker: 'CRF', expiresAt: '2026-08-01' })], TODAY)?.ro.ticker, 'CRF');
check('ignores decided offerings',
  mostUrgent([crfDone], TODAY), null);
check('none live returns null',
  mostUrgent([ro({ status: 'none' })], TODAY), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
