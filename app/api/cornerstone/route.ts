/**
 * Cornerstone NAV Premium Tracker
 * Fetches CLM & CRF NAV data from CEF Connect's public API.
 * Falls back to manually stored NAV values if the external fetch fails.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

const CORNERSTONE_TICKERS = ['CLM', 'CRF'];

interface CEFData {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number; // percentage, positive = premium
  lastUpdated: string;
  source: 'cefconnect' | 'manual' | 'unavailable';
}

async function fetchFromCEFConnect(ticker: string): Promise<CEFData | null> {
  try {
    const res = await fetch(
      `https://www.cefconnect.com/api/v3/fund/${ticker}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        next: { revalidate: 3600 }, // cache 1 hour
      }
    );
    if (!res.ok) return null;
    const data = await res.json();

    const nav: number = data?.NavPerShare ?? data?.NAV ?? 0;
    const marketPrice: number = data?.MarketPrice ?? data?.Price ?? 0;
    if (!nav || !marketPrice) return null;

    const premiumDiscount = ((marketPrice - nav) / nav) * 100;

    return {
      ticker,
      nav,
      marketPrice,
      premiumDiscount,
      lastUpdated: new Date().toISOString(),
      source: 'cefconnect',
    };
  } catch {
    return null;
  }
}

async function getStoredNAV(ticker: string): Promise<CEFData | null> {
  try {
    const stored = await getStore('cornerstone-nav').get(ticker, { type: 'json' }) as CEFData | null;
    return stored;
  } catch {
    return null;
  }
}

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await Promise.all(
    CORNERSTONE_TICKERS.map(async (ticker) => {
      // Try CEF Connect first
      const live = await fetchFromCEFConnect(ticker);
      if (live) return live;

      // Fall back to stored manual value
      const stored = await getStoredNAV(ticker);
      if (stored) return stored;

      // Return unavailable placeholder
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

  return NextResponse.json({ funds: results });
}

// Allow manual NAV entry (stored in Netlify Blobs)
export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { ticker, nav, marketPrice } = await req.json();
  if (!ticker || !nav || !marketPrice) {
    return NextResponse.json({ error: 'ticker, nav, and marketPrice are required' }, { status: 400 });
  }

  const premiumDiscount = ((marketPrice - nav) / nav) * 100;
  const entry: CEFData = {
    ticker,
    nav,
    marketPrice,
    premiumDiscount,
    lastUpdated: new Date().toISOString(),
    source: 'manual',
  };

  await getStore('cornerstone-nav').setJSON(ticker, entry);
  return NextResponse.json({ ok: true, entry });
}
