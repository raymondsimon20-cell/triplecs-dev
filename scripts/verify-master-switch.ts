/**
 * Guards the signal-engine master switch.
 *
 * The switch used to be a local const inside the cron function, so it gated
 * the schedule only — POST /api/signals reached the same autoExecute() and
 * could place real orders while the engine was nominally off. These checks
 * assert the gate now lives at the chokepoint and covers every caller.
 *
 * Run: npx tsx scripts/verify-master-switch.ts
 */

import { autoExecute } from '../lib/signals/auto-execute';
import { SIGNAL_ENGINE_ENABLED, autoExecutionAllowed } from '../lib/signals/master-switch';
import type { InboxItem } from '../lib/inbox';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id:          'test-1',
    createdAt:   Date.now(),
    status:      'pending',
    symbol:      'UPRO',
    instruction: 'BUY',
    quantity:    10,
    tier:        'auto',
    accountHash: 'deadbeef',
    ...over,
  } as InboxItem;
}

(async () => {
  console.log(`SIGNAL_ENGINE_ENABLED = ${SIGNAL_ENGINE_ENABLED}\n`);
  check('autoExecutionAllowed() tracks the switch', autoExecutionAllowed() === SIGNAL_ENGINE_ENABLED);

  if (SIGNAL_ENGINE_ENABLED) {
    console.log('\nEngine is ENABLED — suppression path not exercised.');
    console.log('Re-run with SIGNAL_ENGINE_ENABLED = false to verify the gate.');
    process.exit(failures === 0 ? 0 : 1);
  }

  // Two tier:'auto' BUYs — the exact shape that would fire real orders if the
  // gate were missing and auto-config.mode had been set to 'auto'.
  const staged = [item(), item({ id: 'test-2', symbol: 'TQQQ' })];
  const res = await autoExecute(staged, 100_000);

  check('nothing executed',            res.executed === 0, `executed=${res.executed}`);
  check('reports manual mode',         res.mode === 'manual', `mode=${res.mode}`);
  check('not mislabelled as dry-run',  res.dryRun === false);
  check('all items accounted for',     res.considered === staged.length,
        `considered=${res.considered} of ${staged.length}`);
  check('every item rejected with reason', res.rejected.length === staged.length);
  check('reason names the switch',
        res.rejected.every((r) => /master switch/i.test(r.reason)),
        JSON.stringify(res.rejected.map((r) => r.reason)));
  check('breaker not falsely tripped', res.breakerTripped === false);

  console.log(failures === 0
    ? '\nMaster switch holds: no orders placed from any entry point.'
    : `\n${failures} check(s) FAILED — the engine may be able to trade unattended.`);
  process.exit(failures === 0 ? 0 : 1);
})();
