/**
 * POST /api/quotes  body: { symbols: string[] }
 *
 * Lightweight live-price probe. Wraps Schwab `getQuotes` and returns a
 * `{ symbol: lastPrice }` map for the symbols requested. Used by the
 * AI Analysis Panel to compute share counts for recommendations on
 * symbols the user does not already hold (and therefore has no live
 * portfolio-stream price for).
 *
 * Symbols not resolvable by Schwab are simply omitted from the response
 * (the caller can fall back to "size unavailable" for those).
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getQuotes } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { symbols?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const raw = Array.isArray(body.symbols) ? body.symbols : [];
  const symbols = Array.from(
    new Set(
      raw
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 20),
    ),
  );

  if (symbols.length === 0) return NextResponse.json({ prices: {} });

  const tokens = await getTokens();
  if (!tokens) return NextResponse.json({ error: 'Schwab not authenticated' }, { status: 401 });

  // Batch in chunks of 50 — Schwab's quote endpoint is unreliable with 100+ symbols.
  const BATCH = 50;
  const prices: Record<string, number> = {};
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    try {
      const result = await getQuotes(tokens, chunk);
      for (const sym of chunk) {
        const p = result[sym]?.quote?.lastPrice;
        if (typeof p === 'number' && p > 0) prices[sym] = p;
      }
    } catch (err) {
      console.warn('[/api/quotes] batch failed:', err);
    }
  }

  return NextResponse.json({ prices });
}
