import { NextRequest, NextResponse } from 'next/server';
import { runDaily } from '@/lib/signals/run';
import { loadDailyPlan } from '@/lib/signals/daily-plan';

export const dynamic = 'force-dynamic';

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  const plan = await loadDailyPlan(today);
  return NextResponse.json(plan ?? { date: today, trades: [], alerts: [], info: [], autoExecuted: [] });
}

/** Manually trigger an engine run (dryRun by default from the UI). */
export async function POST(req: NextRequest) {
  const { accountHash, dryRun = true } = (await req.json().catch(() => ({}))) as {
    accountHash?: string;
    dryRun?: boolean;
  };
  try {
    const out = await runDaily({ accountHash, dryRun });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
