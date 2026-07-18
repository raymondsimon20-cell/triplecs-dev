import { NextRequest, NextResponse } from 'next/server';
import { storage, KEYS } from '@/lib/storage';
import { getQuotes } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const symbols = (await storage.get<string[]>(KEYS.watchlist)) ?? [];
  const quotes = symbols.length ? await getQuotes(symbols).catch(() => ({})) : {};
  return NextResponse.json({ symbols, quotes });
}

export async function PUT(req: NextRequest) {
  const { symbols } = (await req.json()) as { symbols: string[] };
  await storage.set(KEYS.watchlist, symbols.map((s) => s.toUpperCase()));
  return NextResponse.json({ ok: true });
}
