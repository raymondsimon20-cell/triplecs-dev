import { NextRequest, NextResponse } from 'next/server';
import { getTransactions } from '@/lib/schwab/transactions';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const accountHash = req.nextUrl.searchParams.get('account');
  if (!accountHash) return NextResponse.json({ error: 'account required' }, { status: 400 });
  const days = Number(req.nextUrl.searchParams.get('days') ?? 30);
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  try {
    return NextResponse.json(await getTransactions(accountHash, from, to));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
