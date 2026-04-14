/**
 * Cornerstone NAV Premium Tracker
 *
 * Market price  → Schwab quotes API (always authenticated, reliable)
 * NAV per share → CEF Connect public API (multiple endpoint fallbacks)
 *                 → falls back to Netlify Blobs manual entry if all else fails
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

const CORNERSTONE_TICKERS = ['CLM', 'CRF'];

interface CEFData {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  lastUpdated: string;
  source: 'live' | 'manual' | 'unavailable';
}

/** Try several known CEF Connect endpoint shapes to get NAV per share */
async function fetchNAVFromCEFConnect(ticker: string): Promise<number | null> {
  const endpoints = [
    `https://www.cefconnect.com/api/v3/pricingdata/${ticker}`,
    `https://www.cefconnect.com/api/v3/fund/${ticker}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://www.cefconnect.com/',
        },
        // cache up to 1 hour — NAV updates once per day after market close
        next: { revalidate: 3600 },
      });

      if (!res.ok) {
        console.warn(`[cornerstone] CEFConnect ${url} → HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();

      // CEF Connect v3 /pricingdata returns an array; /fund returns an object
      const record = Array.isArray(data) ? data[0] : data;
      if (!record) continue;

      // Try all known field name variants
      const nav =
        record.NavPerShare ??
        record.NAVPerShare ??
        record.NAV ??
        record.nav ??
        record.NetAssetValuePerShare ??
        null;

      if (nav && Number(nav) > 0) {
        console.log(`[cornerstone] ${ticker} NAV from ${url}: ${nav}`);
        return Number(nav);
      }

      console.warn(`[cornerstone] ${ticker} — no NAV field found in:`, JSON.stringify(record).slice(0, 300));
    } catch (err) {
      console.warn(`[cornerstone] fetch error for ${url}:`, err);
    }
  }

  return null;
}

async function getStoredNAV(ticker: string): Promise<CEFData | null> {
  try {
    return (await getStore('cornerstone-nav').get(ticker, { type: 'json' })) as CEFData | null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Get live market prices from Schwab (always reliable — we're authenticated)
  let schwabPrices: Record<string, number> = {};
  try {
    const client = await createClient();
    const quotes = await client.getQuotes(CORNERSTONE_TICKERS);
    for (const ticker of CORNERSTONE_TICKERS) {
      const q = quotes[ticker];
      if (q?.lastPrice) schwabPrices[ticker] = q.lastPrice;
    }
    console.log('[cornerstone] Schwab prices:', schwabPrices);
  } catch (err) {
    console.warn('[cornerstone] Schwab quote fetch failed:', err);
  }

  const results = await Promise.all(
    CORNERSTONE_TICKERS.map(async (ticker) => {
      const marketPrice = schwabPrices[ticker] ?? 0;

      // 2. Try CEF Connect for NAV
      const navFromCEF = await fetchNAVFromCEFConnect(ticker);

      if (navFromCEF && navFromCEF > 0 && marketPrice > 0) {
        const premiumDiscount = ((marketPrice - navFromCEF) / navFromCEF) * 100;
        return {
          ticker,
          nav: navFromCEF,
          marketPrice,
          premiumDiscount,
          lastUpdated: new Date().toISOString(),
          source: 'live' as const,
        };
      }

      // 3. Fall back to manually stored entry (if NAV was entered manually before)
      const stored = await getStoredNAV(ticker);
      if (stored) {
        // Use fresh Schwab price if available, update premium accordingly
        if (marketPrice > 0 && stored.nav > 0) {
          return {
            ...stored,
            marketPrice,
            premiumDiscount: ((marketPrice - stored.nav) / stored.nav) * 100,
            source: 'manual' as const,
          };
        }
        return stored;
      }

      // 4. Return unavailable — user needs to enter manually
      return {
        ticker,
        nav: 0,
        marketPrice,
        premiumDiscount: 0,
        lastUpdated: '',
        source: 'unavailable' as const,
      };
    })
  );

  return NextResponse.json({ funds: results });
}

/** Manual NAV entry — stored in Netlify Blobs, used as fallback when CEF Connect is down */
export async function POST(req: Request) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { ticker, nav, marketPrice } = await req.json();
  if (!ticker || !nav || !marketPrice) {
    return NextResponse.json(
      { error: 'ticker, nav, and marketPrice are required' },
      { status: 400 }
    );
  }

  const premiumDiscount = ((marketPrice - nav) / nav) * 100;
  const entry: CEFData = {
    ticker,
    nav: Number(nav),
    marketPrice: Number(marketPrice),
    premiumDiscount,
    lastUpdated: new Date().toISOString(),
    source: 'manual',
  };

  await getStore('cornerstone-nav').setJSON(ticker, entry);
  return NextResponse.json({ ok: true, entry });
}
