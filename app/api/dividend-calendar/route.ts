/**
 * POST /api/dividend-calendar  body: { symbols: string[] }
 *
 * Returns *declared* dividend dates from Schwab instrument fundamentals — the
 * next ex-date and pay date as published, rather than the estimates
 * `lib/portfolio/dividend-cadence` extrapolates from payment spacing.
 *
 * Also returns a `coverage` block. Schwab's fundamental data is inconsistent for
 * closed-end funds and recently launched ETFs, which is most of an income book,
 * so the caller needs to know how much of the portfolio actually resolved before
 * trusting the column. Where a symbol has no declared date, the UI should keep
 * showing the derived estimate and label it as such.
 *
 * Results are cached in-process for the trading day: declared dates change at
 * most once per distribution cycle, and 164 symbols is a lot of Schwab calls.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getFundamentals, type DeclaredDividendDates } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

interface CacheEntry { day: string; data: DeclaredDividendDates }
const cache = new Map<string, CacheEntry>();

const today = () => new Date().toISOString().slice(0, 10);

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { symbols?: unknown; refresh?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const raw = Array.isArray(body.symbols) ? body.symbols : [];
  const symbols = Array.from(
    new Set(
      raw
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 20 && !s.includes(' ')),
    ),
  );

  if (symbols.length === 0) {
    return NextResponse.json({ dates: {}, coverage: { requested: 0, resolved: 0, withNextExDate: 0, withNextPayDate: 0, missing: [] } });
  }

  const forceRefresh = body.refresh === true;
  const day = today();
  const dates: Record<string, DeclaredDividendDates> = {};
  const needed: string[] = [];

  for (const sym of symbols) {
    const hit = cache.get(sym);
    if (!forceRefresh && hit && hit.day === day) dates[sym] = hit.data;
    else needed.push(sym);
  }

  if (needed.length > 0) {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Schwab not authenticated' }, { status: 401 });

    try {
      const fetched = await getFundamentals(tokens, needed);
      for (const sym of needed) {
        const entry = fetched[sym];
        if (entry) {
          dates[sym] = entry;
          cache.set(sym, { day, data: entry });
        }
      }
    } catch (err) {
      console.error('[/api/dividend-calendar] fundamentals fetch failed:', err);
      // Partial results are still useful — return what resolved rather than 500.
    }
  }

  const resolved = Object.values(dates);
  const withNextExDate = resolved.filter((d) => d.nextExDate).length;
  const withNextPayDate = resolved.filter((d) => d.nextPayDate).length;

  return NextResponse.json({
    dates,
    coverage: {
      requested:       symbols.length,
      resolved:        resolved.length,
      withNextExDate,
      withNextPayDate,
      // Symbols Schwab returned nothing usable for — these keep the derived estimate.
      missing: symbols.filter((s) => !dates[s]?.nextExDate && !dates[s]?.nextPayDate),
    },
  });
}
