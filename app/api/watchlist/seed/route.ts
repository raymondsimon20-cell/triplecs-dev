/**
 * POST /api/watchlist/seed
 *
 * Bulk-adds the Triple C fund universe to the watchlist.
 * Skips symbols already present. Returns added/skipped counts.
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import type { WatchlistItem } from '../route';

export const dynamic = 'force-dynamic';

// Core Triple C fund universe — Triples, Cornerstone, Income, Hedge, Broad
const FUND_UNIVERSE: { symbol: string; pillar: string }[] = [
  // Triples (sell-put candidates)
  { symbol: 'TQQQ',  pillar: 'triples' },
  { symbol: 'UPRO',  pillar: 'triples' },
  { symbol: 'SPXL',  pillar: 'triples' },
  { symbol: 'TECL',  pillar: 'triples' },
  { symbol: 'SOXL',  pillar: 'triples' },
  { symbol: 'FNGU',  pillar: 'triples' },
  // Cornerstone
  { symbol: 'CLM',   pillar: 'cornerstone' },
  { symbol: 'CRF',   pillar: 'cornerstone' },
  // Income — Defiance / Roundhill daily
  { symbol: 'QQQY',  pillar: 'income' },
  { symbol: 'XDTE',  pillar: 'income' },
  { symbol: 'QDTE',  pillar: 'income' },
  { symbol: 'JEPY',  pillar: 'income' },
  { symbol: 'IWMY',  pillar: 'income' },
  // Income — RexShares
  { symbol: 'FEPI',  pillar: 'income' },
  { symbol: 'AIPI',  pillar: 'income' },
  // Income — JPMorgan
  { symbol: 'JEPI',  pillar: 'income' },
  { symbol: 'JEPQ',  pillar: 'income' },
  // Income — Amplify / Global X
  { symbol: 'SPYI',  pillar: 'income' },
  // Income — Yieldmax
  { symbol: 'YMAX',  pillar: 'income' },
  { symbol: 'YMAG',  pillar: 'income' },
  { symbol: 'KLIP',  pillar: 'income' },
  { symbol: 'DIPS',  pillar: 'income' },
  { symbol: 'CRSH',  pillar: 'income' },
  // Newer income ETFs (Vol 7)
  { symbol: 'IQQQ',  pillar: 'income' },
  { symbol: 'QQQI',  pillar: 'income' },
  { symbol: 'SPYT',  pillar: 'income' },
  { symbol: 'FNGA',  pillar: 'income' },
  { symbol: 'FNGB',  pillar: 'income' },
  // Hedge / inverse
  { symbol: 'SQQQ',  pillar: 'hedge' },
  { symbol: 'SPXU',  pillar: 'hedge' },
  { symbol: 'FNGD',  pillar: 'hedge' },
  { symbol: 'UVXY',  pillar: 'hedge' },
  // Broad market anchors
  { symbol: 'QQQ',   pillar: 'broad' },
  { symbol: 'SPY',   pillar: 'broad' },
];

export async function POST() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const store = getStore('watchlist');
    const existing = await store.get('items', { type: 'json' }) as WatchlistItem[] | null;
    const items: WatchlistItem[] = Array.isArray(existing) ? existing : [];

    const existingSet = new Set(items.map((i) => i.symbol));
    const now = new Date().toISOString();

    let added = 0;
    let skipped = 0;

    for (const { symbol } of FUND_UNIVERSE) {
      if (existingSet.has(symbol)) {
        skipped++;
      } else {
        items.push({ symbol, addedAt: now });
        existingSet.add(symbol);
        added++;
      }
    }

    await store.setJSON('items', items);

    return NextResponse.json({ added, skipped, total: items.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
