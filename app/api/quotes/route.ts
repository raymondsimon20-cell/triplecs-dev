/**
 * GET /api/quotes?symbols=AAPL,TSLA
 *
 * Fetches live last-trade prices for arbitrary tickers so client-side flows
 * (e.g. converting an AI-recommended dollar amount into shares for a ticker
 * the user doesn't yet own) never have to fall back to a hard-coded price.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getQuotes } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('symbols') ?? '';
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ quotes: {} });
  }

  try {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const raw = await getQuotes(tokens, symbols);
    const out: Record<string, { lastPrice: number; bidPrice?: number; askPrice?: number }> = {};
    for (const sym of symbols) {
      const q = raw[sym]?.quote;
      if (q && q.lastPrice > 0) {
        out[sym] = {
          lastPrice: q.lastPrice,
          bidPrice:  q.bidPrice,
          askPrice:  q.askPrice,
        };
      }
    }
    return NextResponse.json({ quotes: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
