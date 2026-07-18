import { NextRequest, NextResponse } from 'next/server';
import { getQuotes } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const symbols = (req.nextUrl.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
  if (symbols.length === 0) return NextResponse.json({ error: 'symbols required' }, { status: 400 });
  try {
    return NextResponse.json(await getQuotes(symbols));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
