/**
 * Cornerstone NAV Premium Tracker
 *
 * NAV + price fetched via two-source fallback chain:
 *   1. Primary  — Cornerstone official weekly survey CSVs (cornerstonetotalreturnfund.com)
 *                 Searches up to 15 days back in parallel batches of 4.
 *   2. Fallback — Yahoo Finance API (v8 chart for price, v10 quoteSummary for NAV)
 *
 * Results cached 15 minutes in Netlify Blobs (store: "cef-nav-cache").
 * Manual override stored separately in "cornerstone-nav" (persists until overwritten).
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

const TICKERS = ['CLM', 'CRF'] as const;
type Ticker = (typeof TICKERS)[number];

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface NavResult {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  sharesOutstanding?: number;
  lastUpdated: string;
  source: 'cornerstone' | 'yahoo' | 'manual' | 'unavailable';
}

// ─── Cornerstone CSV (Primary) ──────────────────────────────────────────────

/**
 * Build candidate CSV URLs for a given date.
 * Cornerstone publishes weekly survey files; we don't know the exact date in
 * advance so we probe backwards day by day.
 */
function buildCSVUrls(date: Date): string[] {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const yyyymmdd = `${y}${m}${d}`;
  const yyyy_mm_dd = `${y}-${m}-${d}`;

  const base = 'https://www.cornerstonetotalreturnfund.com';
  return [
    `${base}/wp-content/uploads/${y}/${m}/nav-${yyyymmdd}.csv`,
    `${base}/wp-content/uploads/${y}/${m}/NAV${yyyymmdd}.csv`,
    `${base}/wp-content/uploads/${y}/${m}/nav_${yyyymmdd}.csv`,
    `${base}/wp-content/uploads/${y}/${m}/${yyyy_mm_dd}-nav.csv`,
    `${base}/nav/${yyyy_mm_dd}.csv`,
    `${base}/pdf/${yyyy_mm_dd}-nav.csv`,
  ];
}

interface CSVNavData {
  CLM?: { nav: number; marketPrice: number; premiumDiscount: number; sharesOutstanding?: number };
  CRF?: { nav: number; marketPrice: number; premiumDiscount: number; sharesOutstanding?: number };
}

/**
 * Parse a Cornerstone weekly survey CSV.
 * Expected columns (case-insensitive): Ticker/Fund, NAV, Price/Market Price,
 * Premium/Discount, Shares Outstanding.
 */
function parseCornerStoneCSV(text: string): CSVNavData | null {
  try {
    const lines = text.trim().split('\n').filter((l) => l.trim());
    if (lines.length < 2) return null;

    // Find header row
    const headerLine = lines.find((l) =>
      /nav|price|premium|shares/i.test(l)
    );
    if (!headerLine) return null;

    const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''));
    const col = (name: RegExp) => headers.findIndex((h) => name.test(h));

    const tickerCol = col(/ticker|fund|symbol/);
    const navCol = col(/\bnav\b|net.asset.value/);
    const priceCol = col(/market.price|closing.price|price/);
    const pdCol = col(/premium|discount|prem/);
    const sharesCol = col(/shares.out|shares outstanding/);

    if (navCol === -1 || priceCol === -1) {
      console.warn('[cornerstone-csv] Could not locate NAV/Price columns in header:', headerLine);
      return null;
    }

    const result: CSVNavData = {};

    for (const line of lines) {
      if (line === headerLine) continue;
      const cols = line.split(',').map((c) => c.trim().replace(/['"$%]/g, ''));

      const ticker = tickerCol >= 0 ? cols[tickerCol]?.toUpperCase() : null;
      if (!ticker || !['CLM', 'CRF'].includes(ticker)) continue;

      const nav = parseFloat(cols[navCol]);
      const marketPrice = parseFloat(cols[priceCol]);
      if (!nav || !marketPrice || isNaN(nav) || isNaN(marketPrice)) continue;

      const premiumDiscount =
        pdCol >= 0 && cols[pdCol]
          ? parseFloat(cols[pdCol])
          : ((marketPrice - nav) / nav) * 100;

      const sharesOutstanding =
        sharesCol >= 0 ? parseFloat(cols[sharesCol]) || undefined : undefined;

      result[ticker as Ticker] = { nav, marketPrice, premiumDiscount, sharesOutstanding };
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    console.warn('[cornerstone-csv] parse error:', err);
    return null;
  }
}

async function tryFetchCSVForDate(date: Date): Promise<CSVNavData | null> {
  const urls = buildCSVUrls(date);
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv,text/plain,*/*' },
        next: { revalidate: 3600 },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.trim()) continue;
      const parsed = parseCornerStoneCSV(text);
      if (parsed) {
        console.log(`[cornerstone-csv] Found data at ${url}`);
        return parsed;
      }
    } catch {
      // keep trying
    }
  }
  return null;
}

async function fetchFromCornerStoneCSV(): Promise<CSVNavData | null> {
  const dates: Date[] = [];
  for (let i = 0; i < 15; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d);
  }

  const BATCH = 4;
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(tryFetchCSVForDate));
    const found = results.find((r) => r !== null);
    if (found) return found;
  }

  console.warn('[cornerstone-csv] No CSV found in last 15 days');
  return null;
}

// ─── Yahoo Finance (Fallback) ────────────────────────────────────────────────

async function fetchYahooData(ticker: string): Promise<{ nav: number; marketPrice: number } | null> {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'application/json',
    };

    const [chartRes, summaryRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`, { headers }),
      fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics`, { headers }),
    ]);

    let marketPrice = 0;
    if (chartRes.ok) {
      const chartData = await chartRes.json();
      const meta = chartData?.chart?.result?.[0]?.meta;
      marketPrice = meta?.regularMarketPrice ?? meta?.previousClose ?? 0;
    }

    let nav = 0;
    if (summaryRes.ok) {
      const summaryData = await summaryRes.json();
      const stats = summaryData?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
      nav = stats?.navPerShare?.raw ?? 0;
    }

    if (nav > 0 && marketPrice > 0) {
      console.log(`[cornerstone-yahoo] ${ticker}: nav=${nav} price=${marketPrice}`);
      return { nav, marketPrice };
    }

    console.warn(`[cornerstone-yahoo] ${ticker}: incomplete data nav=${nav} price=${marketPrice}`);
    return null;
  } catch (err) {
    console.warn(`[cornerstone-yahoo] ${ticker} error:`, err);
    return null;
  }
}

// ─── Cache (Netlify Blobs) ───────────────────────────────────────────────────

interface CachedResult {
  funds: NavResult[];
  cachedAt: number;
}

async function getCached(): Promise<NavResult[] | null> {
  try {
    const cached = (await getStore('cef-nav-cache').get('data', { type: 'json' })) as CachedResult | null;
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) return null; // expired
    console.log('[cornerstone] Serving from cache');
    return cached.funds;
  } catch {
    return null;
  }
}

async function setCache(funds: NavResult[]): Promise<void> {
  try {
    await getStore('cef-nav-cache').setJSON('data', { funds, cachedAt: Date.now() } satisfies CachedResult);
  } catch {
    // non-critical
  }
}

async function getManualOverride(ticker: string): Promise<NavResult | null> {
  try {
    return (await getStore('cornerstone-nav').get(ticker, { type: 'json' })) as NavResult | null;
  } catch {
    return null;
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Check 15-minute cache
  const cached = await getCached();
  if (cached) {
    return NextResponse.json({ funds: cached, fromCache: true });
  }

  // 2. Try Cornerstone official CSVs (primary)
  const csvData = await fetchFromCornerStoneCSV();

  // 3. Build per-ticker results
  const funds: NavResult[] = await Promise.all(
    TICKERS.map(async (ticker) => {
      // Use CSV data if we have it for this ticker
      const fromCSV = csvData?.[ticker];
      if (fromCSV) {
        return {
          ticker,
          nav: fromCSV.nav,
          marketPrice: fromCSV.marketPrice,
          premiumDiscount: fromCSV.premiumDiscount,
          sharesOutstanding: fromCSV.sharesOutstanding,
          lastUpdated: new Date().toISOString(),
          source: 'cornerstone' as const,
        };
      }

      // 4. Fallback: Yahoo Finance
      const fromYahoo = await fetchYahooData(ticker);
      if (fromYahoo) {
        const premiumDiscount = ((fromYahoo.marketPrice - fromYahoo.nav) / fromYahoo.nav) * 100;
        return {
          ticker,
          nav: fromYahoo.nav,
          marketPrice: fromYahoo.marketPrice,
          premiumDiscount,
          lastUpdated: new Date().toISOString(),
          source: 'yahoo' as const,
        };
      }

      // 5. Last resort: manual override stored in Blobs
      const manual = await getManualOverride(ticker);
      if (manual) return manual;

      // 6. Unavailable
      return {
        ticker,
        nav: 0,
        marketPrice: 0,
        premiumDiscount: 0,
        lastUpdated: '',
        source: 'unavailable' as const,
      };
    })
  );

  // Cache the fresh result
  await setCache(funds);

  return NextResponse.json({ funds, fromCache: false });
}

/** Manual NAV override — stored indefinitely, used when all automatic sources fail */
export async function POST(req: Request) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { ticker, nav, marketPrice } = await req.json();
  if (!ticker || !nav || !marketPrice) {
    return NextResponse.json({ error: 'ticker, nav, and marketPrice are required' }, { status: 400 });
  }

  const premiumDiscount = ((Number(marketPrice) - Number(nav)) / Number(nav)) * 100;
  const entry: NavResult = {
    ticker,
    nav: Number(nav),
    marketPrice: Number(marketPrice),
    premiumDiscount,
    lastUpdated: new Date().toISOString(),
    source: 'manual',
  };

  // Also bust the 15-minute cache so the new value shows immediately
  try { await getStore('cef-nav-cache').delete('data'); } catch { /* ok */ }
  await getStore('cornerstone-nav').setJSON(ticker, entry);

  return NextResponse.json({ ok: true, entry });
}
