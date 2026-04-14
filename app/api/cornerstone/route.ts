/**
 * Cornerstone NAV Premium Tracker
 *
 * Fetch chain (first success wins):
 *   1. Cornerstone official weekly survey CSV  (cornerstonetotalreturnfund.com)
 *   2. Yahoo Finance quoteSummary (navPerShare from defaultKeyStatistics / summaryDetail / fundProfile)
 *   3. Yahoo Finance chart API (price only — combined with cached NAV if available)
 *   4. Manual override stored in Netlify Blobs ("cornerstone-nav")
 *
 * 15-minute result cache in "cef-nav-cache" Blobs store.
 * Debug info always returned in response so browser dev-tools can diagnose failures.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

const TICKERS = ['CLM', 'CRF'] as const;
type Ticker = (typeof TICKERS)[number];
const CACHE_TTL_MS = 15 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** fetch() with a hard timeout */
async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 6000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface NavResult {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  sharesOutstanding?: number;
  lastUpdated: string;
  source: 'cornerstone' | 'yahoo' | 'manual' | 'unavailable';
}

interface CachedResult { funds: NavResult[]; cachedAt: number }

// ─── Source 1: Cornerstone official CSV ──────────────────────────────────────

/**
 * Cornerstone publishes a weekly NAV survey CSV.
 * We don't know the exact URL so we probe multiple patterns for the last 15 days
 * in parallel batches of 4.
 */
function csvUrlsForDate(date: Date): string[] {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const ymd  = `${y}${m}${d}`;
  const ymd2 = `${y}-${m}-${d}`;
  const base = 'https://www.cornerstonetotalreturnfund.com';
  return [
    `${base}/wp-content/uploads/${y}/${m}/nav-${ymd}.csv`,
    `${base}/wp-content/uploads/${y}/${m}/NAV${ymd}.csv`,
    `${base}/wp-content/uploads/${y}/${m}/nav_${ymd}.csv`,
    `${base}/wp-content/uploads/${y}/${m}/${ymd2}-nav.csv`,
    `${base}/wp-content/uploads/${y}/${m}/weekly-nav-${ymd}.csv`,
    `${base}/nav/${ymd2}.csv`,
    `${base}/nav-data/${ymd2}.csv`,
    `${base}/pdf/${ymd2}-nav.csv`,
  ];
}

type CSVData = Partial<Record<Ticker, { nav: number; marketPrice: number; premiumDiscount: number; sharesOutstanding?: number }>>;

function parseCSV(text: string): CSVData | null {
  try {
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return null;
    const headerLine = lines.find((l) => /nav|price|premium/i.test(l));
    if (!headerLine) return null;

    const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''));
    const ci = (re: RegExp) => headers.findIndex((h) => re.test(h));

    const tickerCol   = ci(/ticker|fund|symbol/);
    const navCol      = ci(/\bnav\b|net.asset/);
    const priceCol    = ci(/market.?price|closing.?price|\bprice\b/);
    const pdCol       = ci(/premium|discount|prem/);
    const sharesCol   = ci(/shares.out/);

    if (navCol < 0 || priceCol < 0) return null;

    const result: CSVData = {};
    for (const line of lines) {
      if (line === headerLine) continue;
      const cols = line.split(',').map((c) => c.trim().replace(/['"$%]/g, ''));
      const ticker = (tickerCol >= 0 ? cols[tickerCol] : '').toUpperCase() as Ticker;
      if (!TICKERS.includes(ticker)) continue;
      const nav = num(cols[navCol]);
      const mp  = num(cols[priceCol]);
      if (!nav || !mp) continue;
      const pd = pdCol >= 0 && cols[pdCol] ? num(cols[pdCol]) : ((mp - nav) / nav) * 100;
      result[ticker] = { nav, marketPrice: mp, premiumDiscount: pd, sharesOutstanding: sharesCol >= 0 ? num(cols[sharesCol]) || undefined : undefined };
    }
    return Object.keys(result).length ? result : null;
  } catch { return null; }
}

async function tryDateForCSV(date: Date, debug: string[]): Promise<CSVData | null> {
  const urls = csvUrlsForDate(date);
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
      if (!res.ok) return null;
      const text = await res.text();
      const parsed = parseCSV(text);
      if (parsed) debug.push(`CSV hit: ${url}`);
      return parsed;
    })
  );
  return results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))[0] ?? null;
}

async function fetchCornerStoneCSV(debug: string[]): Promise<CSVData | null> {
  const dates = Array.from({ length: 15 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i); return d;
  });
  for (let i = 0; i < dates.length; i += 4) {
    const batch = dates.slice(i, i + 4);
    const settled = await Promise.allSettled(batch.map((d) => tryDateForCSV(d, debug)));
    const found = settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))[0];
    if (found) return found;
  }
  debug.push('Cornerstone CSV: no file found in last 15 days');
  return null;
}

// ─── Source 2: Yahoo Finance ──────────────────────────────────────────────────

async function fetchYahoo(ticker: string, debug: string[]): Promise<{ nav: number; marketPrice: number } | null> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    Accept: 'application/json',
  };

  // --- Price from chart API ---
  let marketPrice = 0;
  try {
    const r = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
      { headers }, 6000
    );
    if (r.ok) {
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta ?? {};
      marketPrice = num(meta.regularMarketPrice) || num(meta.previousClose);
      debug.push(`Yahoo chart ${ticker}: price=${marketPrice}`);
    } else {
      debug.push(`Yahoo chart ${ticker}: HTTP ${r.status}`);
    }
  } catch (e) {
    debug.push(`Yahoo chart ${ticker}: ${e instanceof Error ? e.message : 'error'}`);
  }

  // --- NAV from quoteSummary — try all relevant modules ---
  let nav = 0;
  const modules = 'defaultKeyStatistics,summaryDetail,fundProfile';
  try {
    const r = await fetchWithTimeout(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${encodeURIComponent(modules)}`,
      { headers }, 6000
    );
    if (r.ok) {
      const j = await r.json();
      const result = j?.quoteSummary?.result?.[0] ?? {};

      // defaultKeyStatistics → navPerShare
      nav = num(result.defaultKeyStatistics?.navPerShare?.raw);
      if (nav) { debug.push(`Yahoo defaultKeyStatistics ${ticker}: nav=${nav}`); }

      // summaryDetail → navPerShare (some funds put it here)
      if (!nav) {
        nav = num(result.summaryDetail?.navPerShare?.raw);
        if (nav) debug.push(`Yahoo summaryDetail ${ticker}: nav=${nav}`);
      }

      // fundProfile may have totalNetAssets — compute nav if we have shares
      if (!nav) {
        debug.push(`Yahoo quoteSummary ${ticker}: no navPerShare found`);
      }
    } else {
      debug.push(`Yahoo quoteSummary ${ticker}: HTTP ${r.status}`);
    }
  } catch (e) {
    debug.push(`Yahoo quoteSummary ${ticker}: ${e instanceof Error ? e.message : 'error'}`);
  }

  if (nav > 0 && marketPrice > 0) return { nav, marketPrice };
  if (marketPrice > 0) { debug.push(`${ticker}: have price but no NAV from Yahoo`); }
  return null;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

async function getCached(): Promise<NavResult[] | null> {
  try {
    const c = (await getStore('cef-nav-cache').get('data', { type: 'json' })) as CachedResult | null;
    if (!c || Date.now() - c.cachedAt > CACHE_TTL_MS) return null;
    return c.funds;
  } catch { return null; }
}
async function setCache(funds: NavResult[]) {
  try { await getStore('cef-nav-cache').setJSON('data', { funds, cachedAt: Date.now() } satisfies CachedResult); } catch { /* ok */ }
}
async function getManual(ticker: string): Promise<NavResult | null> {
  try { return (await getStore('cornerstone-nav').get(ticker, { type: 'json' })) as NavResult | null; } catch { return null; }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cached = await getCached();
  if (cached) return NextResponse.json({ funds: cached, fromCache: true, debug: ['served from 15-min cache'] });

  const debug: string[] = [];

  // Source 1: Cornerstone CSV
  const csvData = await fetchCornerStoneCSV(debug);

  // Source 2: Yahoo (per ticker, only if CSV missed it)
  const yahooData: Partial<Record<Ticker, { nav: number; marketPrice: number }>> = {};
  await Promise.all(
    TICKERS.filter((t) => !csvData?.[t]).map(async (t) => {
      const y = await fetchYahoo(t, debug);
      if (y) yahooData[t] = y;
    })
  );

  // Build results
  const funds: NavResult[] = await Promise.all(
    TICKERS.map(async (ticker) => {
      const csv = csvData?.[ticker];
      if (csv) return { ticker, ...csv, lastUpdated: new Date().toISOString(), source: 'cornerstone' as const };

      const yh = yahooData[ticker];
      if (yh) {
        const pd = ((yh.marketPrice - yh.nav) / yh.nav) * 100;
        return { ticker, nav: yh.nav, marketPrice: yh.marketPrice, premiumDiscount: pd, lastUpdated: new Date().toISOString(), source: 'yahoo' as const };
      }

      const manual = await getManual(ticker);
      if (manual) return manual;

      return { ticker, nav: 0, marketPrice: 0, premiumDiscount: 0, lastUpdated: '', source: 'unavailable' as const };
    })
  );

  await setCache(funds);
  console.log('[cornerstone] debug:', debug);
  return NextResponse.json({ funds, fromCache: false, debug });
}

// ─── POST — manual override ───────────────────────────────────────────────────

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { ticker, nav, marketPrice } = await req.json();
  if (!ticker || !nav || !marketPrice)
    return NextResponse.json({ error: 'ticker, nav, marketPrice required' }, { status: 400 });

  const pd = ((Number(marketPrice) - Number(nav)) / Number(nav)) * 100;
  const entry: NavResult = { ticker, nav: Number(nav), marketPrice: Number(marketPrice), premiumDiscount: pd, lastUpdated: new Date().toISOString(), source: 'manual' };

  try { await getStore('cef-nav-cache').delete('data'); } catch { /* ok */ }
  await getStore('cornerstone-nav').setJSON(ticker, entry);
  return NextResponse.json({ ok: true, entry });
}
