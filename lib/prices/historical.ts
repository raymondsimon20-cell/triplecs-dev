/**
 * Historical end-of-day price fetcher.
 *
 * Used by the backfill routine and the SPY benchmark when we need a price
 * for a date that wasn't captured live. Tries Polygon first if the API key
 * is present (more reliable + faster batching), falls back to Yahoo Finance
 * (public endpoint, no auth).
 *
 * Caching is best-effort, in-memory, request-scoped — Netlify functions are
 * stateless so this only de-dupes within a single invocation. That's enough
 * for the backfill walk which queries the same symbols repeatedly.
 */

const memoCloses = new Map<string, number | null>();

function memoKey(symbol: string, date: string): string {
  return `${symbol.toUpperCase()}|${date}`;
}

/** YYYY-MM-DD → epoch seconds at UTC midnight. */
function dateToEpoch(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000);
}

/** Polygon aggregates: range over a date band, returns daily OHLC bars. */
async function polygonRange(symbol: string, from: string, to: string): Promise<Map<string, number>> {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) throw new Error('No POLYGON_API_KEY');
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol.toUpperCase())}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon ${symbol}: HTTP ${res.status}`);
  const json = await res.json() as { results?: Array<{ t: number; c: number }> };
  const out = new Map<string, number>();
  for (const bar of json.results ?? []) {
    const day = new Date(bar.t).toISOString().slice(0, 10);
    out.set(day, bar.c);
  }
  return out;
}

/** Yahoo chart endpoint over a date band. */
async function yahooRange(symbol: string, from: string, to: string): Promise<Map<string, number>> {
  const period1 = dateToEpoch(from);
  // Add a day so the range is inclusive of `to`
  const period2 = dateToEpoch(to) + 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const json = await res.json() as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
  };
  const result = json.chart?.result?.[0];
  const ts     = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const out = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    const day = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.set(day, c);
  }
  return out;
}

/**
 * Get a single symbol's daily close series across a date band.
 * Returns a `Map<YYYY-MM-DD, close>` containing only days with valid bars
 * (weekends and market holidays naturally absent).
 */
export async function getDailyCloses(symbol: string, fromDate: string, toDate: string): Promise<Map<string, number>> {
  if (process.env.POLYGON_API_KEY) {
    try { return await polygonRange(symbol, fromDate, toDate); }
    catch (err) { console.warn(`[historical] Polygon ${symbol} failed → Yahoo:`, err); }
  }
  return yahooRange(symbol, fromDate, toDate);
}

/**
 * Look up close prices for many symbols on a single date.
 * Falls back to the most recent prior trading day's close when the requested
 * date is a weekend / holiday (within a 5-day window).
 */
export async function getCloses(symbols: string[], date: string): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  // Backfill within a 7-day window so we can recover from market holidays.
  const target = new Date(`${date}T00:00:00.000Z`);
  const fromDate = new Date(target.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate   = date;

  const out: Record<string, number> = {};

  // Resolve from cache first; collect misses.
  const misses: string[] = [];
  for (const s of symbols) {
    const cached = memoCloses.get(memoKey(s, date));
    if (cached != null) { out[s.toUpperCase()] = cached; continue; }
    if (cached === null) continue;     // negative cache hit
    misses.push(s);
  }

  // Fetch misses in parallel, capped to ~5 at a time so we don't pummel Yahoo.
  const BATCH = 5;
  for (let i = 0; i < misses.length; i += BATCH) {
    const slice = misses.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (sym) => {
        try {
          const series = await getDailyCloses(sym, fromDate, toDate);
          // Walk back from target date to find the most recent close
          for (let d = 0; d < 7; d++) {
            const probeDate = new Date(target.getTime() - d * 24 * 60 * 60 * 1000)
              .toISOString().slice(0, 10);
            const close = series.get(probeDate);
            if (close != null) return { sym, close };
          }
          return { sym, close: null as number | null };
        } catch (err) {
          console.warn(`[historical] ${sym} ${date} failed:`, err);
          return { sym, close: null as number | null };
        }
      }),
    );
    for (const { sym, close } of results) {
      memoCloses.set(memoKey(sym, date), close);
      if (close != null) out[sym.toUpperCase()] = close;
    }
  }

  return out;
}

/** Convenience: single-symbol single-date lookup. */
export async function getClose(symbol: string, date: string): Promise<number | null> {
  const closes = await getCloses([symbol], date);
  return closes[symbol.toUpperCase()] ?? null;
}
