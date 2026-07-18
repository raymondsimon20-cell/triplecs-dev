/** Scheduled: daily alert/digest email after close. */
import type { Config } from '@netlify/functions';
import { loadDailyPlan } from '../../lib/signals/daily-plan';
import { sendDigest } from '../../lib/signals/daily-digest';
import { recordCronRun } from '../../lib/signals/cron-health';

export default async function handler() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const plan = await loadDailyPlan(today);
    if (plan) await sendDigest(plan);
    await recordCronRun('daily-digest', 'ok');
    return new Response(plan ? 'digest sent' : 'no plan today', { status: 200 });
  } catch (e) {
    await recordCronRun('daily-digest', 'error', String(e));
    return new Response(String(e), { status: 500 });
  }
}

export const config: Config = { schedule: '30 21 * * 1-5' };
