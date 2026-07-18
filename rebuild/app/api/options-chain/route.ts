import { NextRequest, NextResponse } from 'next/server';
import { getOptionChain } from '@/lib/schwab/client';
import { scanPuts } from '@/lib/signals/option-scan';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  try {
    const chain = await getOptionChain(symbol, { contractType: 'PUT' });
    return NextResponse.json({ chain, candidates: scanPuts(chain) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
