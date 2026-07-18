/** Scheduled: daily signal engine run (idempotent via auto-execute ledger). */
import type { Config } from '@netlify/functions';
import { runDaily } from '../../lib/signals/run';
import { recordCronRun } from '../../lib/signals/cron-health';

export default async function handler() {
  try {
    const out = await runDaily({});
    await recordCronRun('daily-signals', 'ok');
    return new Response(
      JSON.stringify({ signals: out.signals.length, autoExecuted: out.auto.executed.length }),
      { status: 200 }
    );
  } catch (e) {
    await recordCronRun('daily-signals', 'error', String(e));
    return new Response(String(e), { status: 500 });
  }
}

export const config: Config = { schedule: '30 13 * * 1-5' };
