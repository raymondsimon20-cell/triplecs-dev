/**
 * Cornerstone NAV Premium Tracker
 *
 * Fetch chain (first success wins per ticker):
 *   1. CEF Connect HTML scrape  — regex NAV + price from fund page HTML
 *   2. NASDAQ fund info API     — public JSON endpoint, rarely rate-limited
 *   3. Manual override          — stored in Netlify Blobs "cornerstone-nav"
 *
 * 15-minute result cache in "cef-nav-cache" Blobs store.
 * ?refresh=true busts the cache for immediate re-fetch.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

const TICKERS = ['CLM', 'CRF'] as const;
type Ticker = (typeof TICKERS)[number];
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NavResult {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  lastUpdated: string;
  source: 'cefconnect' | 'nasdaq' | 'manual' | 'unavailable';
}

interface CachedResult { funds: NavResult[]; cachedAt: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function extractDollar(html: string, ...patterns: RegExp[]): number {
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (n > 0) return n;
    }
  }
  return 0;
}

// ─── Source 1: CEF Connect HTML scrape ───────────────────────────────────────

async function fetchCEFConnect(ticker: string, debug: string[]): Promise<{ nav: number; marketPrice: number } | null> {
  const url = `https://www.cefconnect.com/fund/${ticker}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        Referer: 'https://www.cefconnect.com/',
      },
    }, 10000);

    if (!res.ok) {
      debug.push(`CEFConnect ${ticker}: HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();

    // NAV patterns — CEF Connect renders values in various elements
    const nav = extractDollar(html,
      /nav[^<]{0,80}\$\s*([\d,]+\.[\d]{2})/i,
      /net\s+asset\s+value[^<]{0,80}\$\s*([\d,]+\.[\d]{2})/i,
      /"nav[^"]*"[^>]*>\s*\$?([\d,]+\.[\d]{2})/i,
      /NavPerShare[^:]*:\s*\$?([\d,]+\.[\d]{2})/i,
      /data-nav[^=]*=["']\$?([\d,]+\.[\d]{2})/i,
    );

    const marketPrice = extractDollar(html,
      /market\s+price[^<]{0,80}\$\s*([\d,]+\.[\d]{2})/i,
      /closing\s+price[^<]{0,80}\$\s*([\d,]+\.[\d]{2})/i,
      /last\s+price[^<]{0,80}\$\s*([\d,]+\.[\d]{2})/i,
      /"price[^"]*"[^>]*>\s*\$?([\d,]+\.[\d]{2})/i,
    );

    if (nav > 0 && marketPrice > 0) {
      debug.push(`CEFConnect ${ticker}: nav=${nav} price=${marketPrice}`);
      return { nav, marketPrice };
    }

    // Log a snippet to help tune regexes if they miss
    const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600);
    debug.push(`CEFConnect ${ticker}: parsed but found nav=${nav} price=${marketPrice}. Snippet: ${snippet}`);
    return null;
  } catch (e) {
    debug.push(`CEFConnect ${ticker}: ${e instanceof Error ? e.message : 'error'}`);
    return null;
  }
}

// ─── Source 2: NASDAQ fund info API ──────────────────────────────────────────

async function fetchNASDAQ(ticker: string, debug: string[]): Promise<{ nav: number; marketPrice: number } | null> {
  // NASDAQ exposes fund summary data via a public JSON endpoint
  const urls = [
    `https://api.nasdaq.com/api/fund/${ticker}/info`,
    `https://api.nasdaq.com/api/quote/${ticker}/info?assetClass=stocks`,
  ];

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://www.nasdaq.com',
          Referer: 'https://www.nasdaq.com/',
        },
      }, 8000);

      if (!res.ok) {
        debug.push(`NASDAQ ${ticker} (${url.split('/').slice(-2).join('/')}): HTTP ${res.status}`);
        continue;
      }

      const j = await res.json();

      // /fund/{ticker}/info response shape
      const fd = j?.data?.fundData ?? j?.data ?? {};
      const rawNav =
        fd?.navPerShare ??
        fd?.NAVPerShare ??
        fd?.nav ??
        fd?.netAssetValue ??
        j?.data?.primaryData?.navPerShare ??
        null;

      const rawPrice =
        fd?.lastSalePrice ??
        j?.data?.primaryData?.lastSalePrice ??
        j?.data?.primaryData?.regularMarketPrice ??
        null;

      const nav = rawNav ? parseFloat(String(rawNav).replace(/[$,]/g, '')) : 0;
      const marketPrice = rawPrice ? parseFloat(String(rawPrice).replace(/[$,]/g, '')) : 0;

      if (nav > 0 && marketPrice > 0) {
        debug.push(`NASDAQ ${ticker}: nav=${nav} price=${marketPrice}`);
        return { nav, marketPrice };
      }

      debug.push(`NASDAQ ${ticker}: incomplete — nav=${nav} price=${marketPrice} (keys: ${Object.keys(fd).slice(0, 10).join(',')})`);
    } catch (e) {
      debug.push(`NASDAQ ${ticker}: ${e instanceof Error ? e.message : 'error'}`);
    }
  }
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

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const forceRefresh = new URL(req.url).searchParams.get('refresh') === 'true';

  if (!forceRefresh) {
    const cached = await getCached();
    if (cached) return NextResponse.json({ funds: cached, fromCache: true, debug: ['served from 15-min cache'] });
  } else {
    try { await getStore('cef-nav-cache').delete('data'); } catch { /* ok */ }
  }

  const debug: string[] = [];

  const funds: NavResult[] = await Promise.all(
    TICKERS.map(async (ticker) => {
      // Source 1: CEF Connect HTML scrape
      const cef = await fetchCEFConnect(ticker, debug);
      if (cef) {
        const pd = ((cef.marketPrice - cef.nav) / cef.nav) * 100;
        return { ticker, nav: cef.nav, marketPrice: cef.marketPrice, premiumDiscount: pd, lastUpdated: new Date().toISOString(), source: 'cefconnect' as const };
      }

      // Source 2: NASDAQ API
      const nasdaq = await fetchNASDAQ(ticker, debug);
      if (nasdaq) {
        const pd = ((nasdaq.marketPrice - nasdaq.nav) / nasdaq.nav) * 100;
        return { ticker, nav: nasdaq.nav, marketPrice: nasdaq.marketPrice, premiumDiscount: pd, lastUpdated: new Date().toISOString(), source: 'nasdaq' as const };
      }

      // Source 3: Manual override
      const manual = await getManual(ticker);
      if (manual) return manual;

      // Unavailable
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
  const entry: NavResult = {
    ticker, nav: Number(nav), marketPrice: Number(marketPrice),
    premiumDiscount: pd, lastUpdated: new Date().toISOString(), source: 'manual',
  };

  try { await getStore('cef-nav-cache').delete('data'); } catch { /* ok */ }
  await getStore('cornerstone-nav').setJSON(ticker, entry);
  return NextResponse.json({ ok: true, entry });
}
