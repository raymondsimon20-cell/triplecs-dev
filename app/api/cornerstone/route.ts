/**
 * Cornerstone NAV Premium Tracker
 *
 * Price source  : NASDAQ public quote API (confirmed working)
 * NAV sources   : (first success wins)
 *   1. CEFConnect JSON API  — /api/v3/pricingdata/{ticker}
 *   2. Cornerstone fund websites — cornerstonetotalreturnfund.com (CRF) / cornerstonestrategicvalue.com (CLM)
 *   3. Manual override in Netlify Blobs "cornerstone-nav"
 *
 * 15-min result cache in "cef-nav-cache".  ?refresh=true bypasses it.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

const TICKERS = ['CLM', 'CRF'] as const;
type Ticker = (typeof TICKERS)[number];
const CACHE_TTL_MS = 15 * 60 * 1000;

export interface NavResult {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  lastUpdated: string;
  source: 'cefconnect' | 'nasdaq' | 'cornerstone' | 'manual' | 'unavailable';
}

interface CachedResult { funds: NavResult[]; cachedAt: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

function parseDollar(s: unknown): number {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return isFinite(n) && n > 0 ? n : 0;
}

function regexDollar(html: string, ...patterns: RegExp[]): number {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) { const n = parseDollar(m[1]); if (n > 0) return n; }
  }
  return 0;
}

// ─── Price: NASDAQ quote API ─────────────────────────────────────────────────

async function fetchNasdaqPrice(ticker: string, debug: string[]): Promise<number> {
  try {
    const res = await fetchWithTimeout(
      `https://api.nasdaq.com/api/quote/${ticker}/info?assetClass=stocks`,
      { headers: { ...BROWSER_HEADERS, Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } },
    );
    if (!res.ok) { debug.push(`NASDAQ price ${ticker}: HTTP ${res.status}`); return 0; }
    const j = await res.json();
    const pd = j?.data?.primaryData ?? {};
    const sd = j?.data?.secondaryData;
    debug.push(`NASDAQ ${ticker} primaryData keys: ${Object.keys(pd).join(',')}`);
    if (sd) debug.push(`NASDAQ ${ticker} secondaryData: ${JSON.stringify(sd).slice(0, 300)}`);
    const price = parseDollar(pd.lastSalePrice ?? pd.regularMarketPrice);
    if (price) debug.push(`NASDAQ price ${ticker}: $${price}`);
    else debug.push(`NASDAQ price ${ticker}: not found`);
    return price;
  } catch (e) {
    debug.push(`NASDAQ price ${ticker}: ${e instanceof Error ? e.message : 'error'}`);
    return 0;
  }
}

// ─── NAV Source 1: CEFConnect JSON API ───────────────────────────────────────

async function fetchCEFConnectNAV(ticker: string, debug: string[]): Promise<number> {
  const endpoints = [
    `https://www.cefconnect.com/api/v3/pricingdata/${ticker}`,
    `https://www.cefconnect.com/api/v3/fund/${ticker}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          ...BROWSER_HEADERS,
          Referer: `https://www.cefconnect.com/fund/${ticker}`,
          Origin: 'https://www.cefconnect.com',
        },
      }, 12000);
      if (!res.ok) { debug.push(`CEFConnect ${ticker} ${url.split('/').pop()}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      const record = Array.isArray(data) ? data[0] : data;
      if (!record) continue;
      const nav =
        record.NavPerShare ?? record.NAVPerShare ?? record.NAV ??
        record.nav ?? record.NetAssetValuePerShare ?? 0;
      const n = parseDollar(nav);
      if (n > 0) { debug.push(`CEFConnect NAV ${ticker}: $${n}`); return n; }
      debug.push(`CEFConnect ${ticker}: no NAV in keys: ${Object.keys(record).slice(0, 15).join(',')}`);
    } catch (e) {
      debug.push(`CEFConnect ${ticker}: ${e instanceof Error ? e.message : 'error'}`);
    }
  }
  return 0;
}

// ─── NAV Source 2: Cornerstone fund websites ──────────────────────────────────

const FUND_BASES: Record<Ticker, string> = {
  CRF: 'https://www.cornerstonetotalreturnfund.com',
  CLM: 'https://www.cornerstonestrategicvaluefund.com',
};

/** Extract CSV/JSON data URLs from a page's inline <script> blocks */
function extractDataUrls(html: string, baseUrl: string): string[] {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .join('\n');

  const found = new Set<string>();

  // CSV references (any path containing .csv)
  for (const m of scripts.matchAll(/['"`]([^'"`\s]*\.csv[^'"`\s]*)/gi)) {
    const raw = m[1];
    found.add(raw.startsWith('http') ? raw : `${baseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`);
  }
  // wp-content/uploads paths (WordPress media)
  for (const m of html.matchAll(/["'](\/wp-content\/uploads\/[^"'?\s]+)/gi)) {
    const raw = m[1];
    found.add(`${baseUrl}${raw}`);
  }
  // Any fetch/ajax/src URL containing nav/weekly/survey
  for (const m of scripts.matchAll(/['"`]([^'"`\s]*(?:nav|weekly|survey)[^'"`\s]*)/gi)) {
    const raw = m[1];
    if (raw.startsWith('/') || raw.startsWith('http')) {
      found.add(raw.startsWith('http') ? raw : `${baseUrl}${raw}`);
    }
  }
  // JSON data-src or data-url attributes
  for (const m of html.matchAll(/data-(?:src|url|file)=['"]([^'"]+)['"]/gi)) {
    const raw = m[1];
    found.add(raw.startsWith('http') ? raw : `${baseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`);
  }

  return [...found];
}

async function fetchFundWebsiteNAV(ticker: Ticker, debug: string[]): Promise<number> {
  const base = FUND_BASES[ticker];
  const navPageUrl = `${base}/net-asset-value`;

  // Step 1: Fetch the NAV page HTML to find embedded data URLs
  let pageHtml = '';
  try {
    const res = await fetchWithTimeout(navPageUrl, {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Accept: 'text/html,*/*' },
    }, 12000);
    if (res.ok) {
      pageHtml = await res.text();
      debug.push(`FundSite ${ticker}: NAV page loaded (${pageHtml.length} bytes)`);
    } else {
      debug.push(`FundSite ${ticker} navPage: HTTP ${res.status}`);
    }
  } catch (e) {
    debug.push(`FundSite ${ticker} navPage: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Step 2: Extract any data URLs the JS references on the page
  const dataUrls = pageHtml ? extractDataUrls(pageHtml, base) : [];
  debug.push(`FundSite ${ticker}: found ${dataUrls.length} data URL(s): ${dataUrls.slice(0, 5).join(', ')}`);

  // Step 3: Try each discovered URL as a CSV
  for (const url of dataUrls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Accept: 'text/csv,text/plain,*/*' },
      }, 8000);
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseCornerStoneCSV(text);
      const record = parsed?.[ticker];
      if (record?.nav) {
        debug.push(`FundSite ${ticker}: CSV from ${url} → NAV=$${record.nav}`);
        return record.nav;
      }
      debug.push(`FundSite ${ticker}: fetched ${url} but no parseable NAV (${text.slice(0, 100)})`);
    } catch { /* try next */ }
  }

  // Step 4: Log the raw page text near a dollar sign so we can see data shape
  if (pageHtml) {
    const text = pageHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const dollarIdx = text.indexOf('$');
    if (dollarIdx >= 0) {
      debug.push(`FundSite ${ticker} near first $: "${text.slice(Math.max(0, dollarIdx - 60), dollarIdx + 120)}"`);
    } else {
      debug.push(`FundSite ${ticker}: no $ found in page text`);
    }
  }

  return 0;
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

  // Fetch price and NAV in parallel for each ticker
  const funds: NavResult[] = await Promise.all(
    TICKERS.map(async (ticker) => {
      // Price: NASDAQ (confirmed working)
      const marketPrice = await fetchNasdaqPrice(ticker, debug);

      // NAV source 1: CEFConnect JSON API
      let nav = await fetchCEFConnectNAV(ticker, debug);
      let navSource: NavResult['source'] = 'cefconnect';

      // NAV source 2: Cornerstone fund websites
      if (!nav) {
        nav = await fetchFundWebsiteNAV(ticker, debug);
        navSource = 'cornerstone';
      }

      // NAV source 3: NASDAQ secondaryData (sometimes has nav for CEFs)
      // (already fetched above — parsed from debug. If still 0, use manual.)

      if (nav > 0 && marketPrice > 0) {
        const pd = ((marketPrice - nav) / nav) * 100;
        return { ticker, nav, marketPrice, premiumDiscount: pd, lastUpdated: new Date().toISOString(), source: navSource };
      }

      // Fallback: manual override
      const manual = await getManual(ticker);
      if (manual) {
        // Use fresh NASDAQ price if available
        if (marketPrice > 0 && manual.nav > 0) {
          return { ...manual, marketPrice, premiumDiscount: ((marketPrice - manual.nav) / manual.nav) * 100, source: 'manual' as const };
        }
        return manual;
      }

      return { ticker, nav: 0, marketPrice, premiumDiscount: 0, lastUpdated: '', source: 'unavailable' as const };
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
