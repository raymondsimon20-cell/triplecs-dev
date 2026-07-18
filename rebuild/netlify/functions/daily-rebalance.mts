/** Scheduled: daily snapshot + rebalance check (idempotent per day). */
import type { Config } from '@netlify/functions';
import { getAccounts } from '../../lib/schwab/client';
import { pillarBreakdown } from '../../lib/classify';
import { storage, KEYS } from '../../lib/storage';
import { recordCronRun } from '../../lib/signals/cron-health';

export default async function handler() {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const existing = await storage.get(KEYS.snapshot(date));
    if (existing) {
      await recordCronRun('daily-rebalance', 'ok');
      return new Response('already ran today', { status: 200 });
    }
    const accounts = await getAccounts();
    const account = accounts[0];
    if (!account) throw new Error('No account');
    await storage.set(KEYS.snapshot(date), {
      date,
      equity: account.balances.liquidationValue,
      afw: account.balances.availableFunds, // AFW (Available For Withdrawal)
      marginDebit: Math.max(0, -account.balances.marginBalance),
      pillars: pillarBreakdown(
        account.positions.map((p) => ({
          symbol: p.instrument.symbol,
          marketValue: p.marketValue,
          putCall: p.instrument.putCall,
        })),
        account.balances.cashBalance ?? 0
      ).percents,
    });
    await recordCronRun('daily-rebalance', 'ok');
    return new Response('snapshot saved', { status: 200 });
  } catch (e) {
    await recordCronRun('daily-rebalance', 'error', String(e));
    return new Response(String(e), { status: 500 });
  }
}

export const config: Config = { schedule: '0 18 * * 1-5' };
