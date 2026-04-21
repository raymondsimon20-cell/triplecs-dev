/**
 * Cornerstone NAV Tracker
 *
 * Primary  — Cornerstone official CSV:
 *   https://www.cornerstonetotalreturnfund.com/assets/data/Cornerstone_WeeklySurveyInformation{YYYYMMDD}.csv
 *   Searches up to 15 days back in parallel batches of 4.
 *   Columns: Ticker | NAV per share ($) | Closing Market ($) | Premium/Discount (%) | Shares Outstanding
 *
 * Fallback — Yahoo Finance:
 *   chart API for price, quoteSummary defaultKeyStatistics.navPrice.raw for NAV
 *
 * Cache — 15 min in Netlify Blobs "cef-nav-cache"
 * Manual override — "cornerstone-nav" Blobs store (survives cache busts)
 * ?refresh=true — bypasses 15-min cache
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';
import { saveCornerstoneSnapshot } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const TICKERS = ['CLM', 'CRF'] as const;
type Ticker = (typeof TICKERS)[number];
const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_DAYS_BACK = 15;
const BATCH_SIZE = 4;

export interface NavResult {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  sharesOutstanding?: number;
  navUpdatedAt: string;
  priceUpdatedAt: string;
  source: 'cornerstone' | 'yahoo' | 'manual' | 'unavailable';
}

interface CachedResult {
  funds: NavResult[];
  cachedAt: number;
  dataDate?: string;
  source?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function formatDate(date: Date): string {
  const y = date.getFullYear().toString();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return y + m + d;
}

function parseDollar(s: string | undefined): number {
  const n = parseFloat((s ?? '').replace(/[$,%]/g, '').trim());
  return isFinite(n) ? n : 0;
}

// ─── Source 1: Cornerstone official CSV ──────────────────────────────────────

type CSVRow = Record<string, string>;

function parseCSV(text: string): CSVRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const rows: CSVRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row: CSVRow = {};
    headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] ?? '').trim(); });
    rows.push(row);
  }
  return rows;
}

function buildNavFromCSV(rows: CSVRow[], dateStr: string): NavResult[] {
  const now = new Date().toISOString();
  return rows
    .filter((r) => TICKERS.includes(r['Ticker'] as Ticker))
    .map((r) => {
      const nav    = parseDollar(r['NAV per share ($)']);
      const price  = parseDollar(r['Closing Market ($)']);
      const premium = parseDollar(r['Premium/Discount (%)']);
      const shares = parseDollar(r['Shares Outstanding']);
      return {
        ticker: r['Ticker'],
        nav,
        marketPrice: price,
        premiumDiscount: premium,
        sharesOutstanding: shares || undefined,
        navUpdatedAt: now,
        priceUpdatedAt: now,
        source: 'cornerstone' as const,
      };
    })
    .filter((r) => r.nav > 0 && r.marketPrice > 0);
}

async function fetchCornerstoneCSV(): Promise<{ funds: NavResult[]; dateStr: string } | null> {
  const baseUrl = 'https://www.cornerstonetotalreturnfund.com/assets/data/Cornerstone_WeeklySurveyInformation';

  for (let batchStart = 0; batchStart <= MAX_DAYS_BACK; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, MAX_DAYS_BACK + 1);

    const fetches = Array.from({ length: batchEnd - batchStart }, async (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (batchStart + i));
      const dateStr = formatDate(date);
      const url = `${baseUrl}${dateStr}.csv`;

      try {
        const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!resp.ok) return null;
        const text = await resp.text();
        const rows = parseCSV(text);
        if (!rows.length) return null;
        const funds = buildNavFromCSV(rows, dateStr);
        if (funds.length > 0) {
          console.log(`[cornerstone] CSV found: ${url}`);
          return { funds, dateStr };
        }
        return null;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(fetches);
    const found = results.find((r) => r !== null);
    if (found) return found;
  }

  return null;
}

// ─── Source 2: Yahoo Finance fallback ────────────────────────────────────────

async function fetchYahooFallback(): Promise<Partial<Record<Ticker, { nav: number; marketPrice: number }>>> {
  const out: Partial<Record<Ticker, { nav: number; marketPrice: number }>> = {};

  await Promise.all(TICKERS.map(async (symbol) => {
    try {
      // Price from chart API
      const chartResp = await fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d&includePrePost=false`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (chartResp.ok) {
        const data = await chartResp.json();
        const meta = data?.chart?.result?.[0]?.meta ?? {};
        const price = meta.regularMarketPrice ?? meta.previousClose ?? 0;
        if (price > 0) out[symbol] = { nav: 0, marketPrice: price };
      }

      // NAV from quoteSummary — field is navPrice.raw (NOT navPerShare)
      const summaryResp = await fetchWithTimeout(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics,price`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (summaryResp.ok) {
        const data = await summaryResp.json();
        const stats = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics ?? {};
        const priceData = data?.quoteSummary?.result?.[0]?.price ?? {};
        const nav = stats?.navPrice?.raw ?? 0;
        const price = priceData?.regularMarketPrice?.raw ?? 0;
        if (nav > 0 || price > 0) {
          out[symbol] = { nav, marketPrice: price || out[symbol]?.marketPrice || 0 };
        }
      }
    } catch {
      // skip
    }
  }));

  return out;
}

// ─── Cache & manual store ─────────────────────────────────────────────────────

async function getCached(): Promise<CachedResult | null> {
  try {
    const c = (await getStore('cef-nav-cache').get('data', { type: 'json' })) as CachedResult | null;
    if (!c || Date.now() - c.cachedAt > CACHE_TTL_MS) return null;
    return c;
  } catch { return null; }
}

async function setCache(funds: NavResult[], dataDate?: string, source?: string) {
  try {
    await getStore('cef-nav-cache').setJSON('data', { funds, cachedAt: Date.now(), dataDate, source } satisfies CachedResult);
  } catch { /* ok */ }
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
    if (cached) return NextResponse.json({ funds: cached.funds, fromCache: true, source: cached.source, dataDate: cached.dataDate });
  } else {
    try { await getStore('cef-nav-cache').delete('data'); } catch { /* ok */ }
  }

  // Source 1: Cornerstone official CSV
  const csvResult = await fetchCornerstoneCSV();
  if (csvResult) {
    const missing = TICKERS.filter((t) => !csvResult.funds.find((f) => f.ticker === t));

    // If CSV had both tickers, we're done
    if (missing.length === 0) {
      await setCache(csvResult.funds, csvResult.dateStr, 'cornerstone-official');
      return NextResponse.json({ funds: csvResult.funds, fromCache: false, source: 'cornerstone-official', dataDate: csvResult.dateStr });
    }
  }

  // Source 2: Yahoo Finance (covers any missing tickers)
  const yahooData = await fetchYahooFallback();
  const now = new Date().toISOString();
  let source = csvResult ? 'cornerstone+yahoo' : 'yahoo-finance';

  const funds: NavResult[] = await Promise.all(
    TICKERS.map(async (ticker) => {
      // Use CSV data if available for this ticker
      const fromCSV = csvResult?.funds.find((f) => f.ticker === ticker);
      if (fromCSV) return fromCSV;

      // Use Yahoo
      const yh = yahooData[ticker];
      if (yh?.nav && yh?.marketPrice) {
        const pd = ((yh.marketPrice - yh.nav) / yh.nav) * 100;
        return { ticker, nav: yh.nav, marketPrice: yh.marketPrice, premiumDiscount: pd, navUpdatedAt: now, priceUpdatedAt: now, source: 'yahoo' as const };
      }

      // Use manual override, refresh its market price from Yahoo if possible
      const manual = await getManual(ticker);
      if (manual) {
        if (yh?.marketPrice && yh.marketPrice > 0 && manual.nav > 0) {
          const pd = ((yh.marketPrice - manual.nav) / manual.nav) * 100;
          return { ...manual, marketPrice: yh.marketPrice, premiumDiscount: pd, source: 'manual' as const };
        }
        return manual;
      }

      // Unavailable
      source = 'partial';
      return { ticker, nav: 0, marketPrice: yh?.marketPrice ?? 0, premiumDiscount: 0, navUpdatedAt: '', priceUpdatedAt: now, source: 'unavailable' as const };
    })
  );

  await setCache(funds, csvResult?.dateStr, source);
  // Persist latest NAV data so daily-alert can check premiums without auth
  saveCornerstoneSnapshot({ savedAt: Date.now(), funds: funds.map((f) => ({
    ticker: f.ticker, nav: f.nav, marketPrice: f.marketPrice, premiumDiscount: f.premiumDiscount,
  })) }).catch(() => {});
  return NextResponse.json({ funds, fromCache: false, source, dataDate: csvResult?.dateStr ?? null });
}

// ─── POST — manual NAV override ──────────────────────────────────────────────

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { ticker, nav } = await req.json();
  if (!ticker || !nav) return NextResponse.json({ error: 'ticker and nav required' }, { status: 400 });

  const entry: NavResult = {
    ticker, nav: Number(nav), marketPrice: 0, premiumDiscount: 0,
    navUpdatedAt: new Date().toISOString(), priceUpdatedAt: '',
    source: 'manual',
  };

  try { await getStore('cef-nav-cache').delete('data'); } catch { /* ok */ }
  await getStore('cornerstone-nav').setJSON(ticker, entry);
  return NextResponse.json({ ok: true, entry });
}
