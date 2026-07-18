import { NextResponse } from 'next/server';
import { getAccounts } from '@/lib/schwab/client';
import { pillarBreakdown } from '@/lib/classify';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const accounts = await getAccounts();
    const enriched = accounts.map((a) => ({
      ...a,
      pillars: pillarBreakdown(
        a.positions.map((p) => ({
          symbol: p.instrument.symbol,
          marketValue: p.marketValue,
          putCall: p.instrument.putCall,
        })),
        a.balances.cashBalance ?? 0
      ),
    }));
    return NextResponse.json(enriched);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
