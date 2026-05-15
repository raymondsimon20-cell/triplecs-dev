/**
 * POST /api/watchlist/seed
 *
 * Bulk-adds the Triple C fund universe to the watchlist.
 * Skips symbols already present. Returns added/skipped counts.
 *
 * The universe is sourced from the canonical metadata table
 * (`lib/data/fund-metadata.ts`) — a single source of truth for ticker
 * classification across the app.
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import type { WatchlistItem } from '../route';
import { listAllSymbols } from '@/lib/data/fund-metadata';

export const dynamic = 'force-dynamic';

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

    for (const symbol of listAllSymbols()) {
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
