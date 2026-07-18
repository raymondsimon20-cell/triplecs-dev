/** Daily portfolio snapshots for performance tracking. */
import { NextResponse } from 'next/server';
import { storage, KEYS } from '@/lib/storage';
import { getAccounts } from '@/lib/schwab/client';
import { pillarBreakdown } from '@/lib/classify';

export const dynamic = 'force-dynamic';

export interface Snapshot {
  date: string;
  equity: number;
  afw: number; // AFW (Available For Withdrawal)
  marginDebit: number;
  pillars: Record<string, number>;
}

export async function GET() {
  const keys = await storage.list('snapshot-');
  const snaps: Snapshot[] = [];
  for (const k of keys.sort()) {
    const s = await storage.get<Snapshot>(k);
    if (s) snaps.push(s);
  }
  return NextResponse.json(snaps);
}

/** Capture today's snapshot (idempotent per day). */
export async function POST() {
  try {
    const accounts = await getAccounts();
    const account = accounts[0];
    if (!account) return NextResponse.json({ error: 'No account' }, { status: 400 });
    const date = new Date().toISOString().slice(0, 10);
    const snap: Snapshot = {
      date,
      equity: account.balances.liquidationValue,
      afw: account.balances.availableFunds,
      marginDebit: Math.max(0, -account.balances.marginBalance),
      pillars: pillarBreakdown(
        account.positions.map((p) => ({
          symbol: p.instrument.symbol,
          marketValue: p.marketValue,
          putCall: p.instrument.putCall,
        })),
        account.balances.cashBalance ?? 0
      ).percents as unknown as Record<string, number>,
    };
    await storage.set(KEYS.snapshot(date), snap);
    return NextResponse.json(snap);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
