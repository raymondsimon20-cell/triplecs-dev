/** Rebalance plan: current vs target pillar allocations + dollar moves. */
import { NextResponse } from 'next/server';
import { getAccounts } from '@/lib/schwab/client';
import { pillarBreakdown } from '@/lib/classify';
import { PILLAR_TARGETS } from '@/lib/data/fund-metadata';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const accounts = await getAccounts();
    const account = accounts[0];
    if (!account) return NextResponse.json({ error: 'No account' }, { status: 400 });
    const breakdown = pillarBreakdown(
      account.positions.map((p) => ({
        symbol: p.instrument.symbol,
        marketValue: p.marketValue,
        putCall: p.instrument.putCall,
      })),
      account.balances.cashBalance ?? 0
    );
    const moves = Object.entries(PILLAR_TARGETS).map(([pillar, target]) => {
      const currentPct = breakdown.percents[pillar as keyof typeof breakdown.percents] ?? 0;
      const drift = currentPct - target;
      return {
        pillar,
        targetPct: target,
        currentPct,
        driftPct: drift,
        dollarMove: -drift * breakdown.total, // + = buy, - = sell
      };
    });
    return NextResponse.json({ breakdown, moves });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
