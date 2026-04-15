/**
 * /api/watchlist — CRUD for the user's symbol watchlist with price alerts.
 *
 * GET  → returns all watchlist items with live quotes
 * POST → add a symbol (with optional price target)
 * PUT  → update price target for a symbol
 * DELETE → remove a symbol
 *
 * Storage: Netlify Blobs store "watchlist"
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getQuotes } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export interface WatchlistItem {
  symbol: string;
  addedAt: string;
  targetBuy?: number;    // alert when price drops to this
  targetSell?: number;   // alert when price rises to this
  notes?: string;
}

export interface WatchlistItemWithQuote extends WatchlistItem {
  lastPrice?: number;
  dayChange?: number;
  dayChangePct?: number;
  hitBuyTarget?: boolean;
  hitSellTarget?: boolean;
}

async function getWatchlist(): Promise<WatchlistItem[]> {
  try {
    const store = getStore('watchlist');
    const data = await store.get('items', { type: 'json' }) as WatchlistItem[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveWatchlist(items: WatchlistItem[]) {
  const store = getStore('watchlist');
  await store.setJSON('items', items);
}

// ─── GET — fetch watchlist with live quotes ──────────────────────────────────

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const items = await getWatchlist();
    if (items.length === 0) {
      return NextResponse.json({ items: [], total: 0 });
    }

    // Fetch live quotes for all watchlist symbols
    const tokens = await getTokens();
    let enriched: WatchlistItemWithQuote[] = items;

    if (tokens) {
      try {
        const symbols = items.map((i) => i.symbol);
        const quotes = await getQuotes(tokens, symbols);

        enriched = items.map((item) => {
          const q = quotes[item.symbol]?.quote;
          const result: WatchlistItemWithQuote = { ...item };
          if (q) {
            result.lastPrice = q.lastPrice;
            result.dayChange = q.netChange;
            result.dayChangePct = q.netPercentChange;
            result.hitBuyTarget = item.targetBuy != null && q.lastPrice <= item.targetBuy;
            result.hitSellTarget = item.targetSell != null && q.lastPrice >= item.targetSell;
          }
          return result;
        });
      } catch (err) {
        console.warn('[Watchlist] Quote fetch failed, returning without prices:', err);
      }
    }

    return NextResponse.json({ items: enriched, total: enriched.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── POST — add a symbol ─────────────────────────────────────────────────────

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { symbol: string; targetBuy?: number; targetSell?: number; notes?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const symbol = body.symbol?.toUpperCase()?.trim();
  if (!symbol) return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });

  try {
    const items = await getWatchlist();
    if (items.some((i) => i.symbol === symbol)) {
      return NextResponse.json({ error: `${symbol} already on watchlist` }, { status: 409 });
    }

    const newItem: WatchlistItem = {
      symbol,
      addedAt: new Date().toISOString(),
      targetBuy: body.targetBuy,
      targetSell: body.targetSell,
      notes: body.notes,
    };
    items.push(newItem);
    await saveWatchlist(items);

    return NextResponse.json({ item: newItem, total: items.length }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── PUT — update price targets ──────────────────────────────────────────────

export async function PUT(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { symbol: string; targetBuy?: number | null; targetSell?: number | null; notes?: string | null };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const symbol = body.symbol?.toUpperCase()?.trim();
  if (!symbol) return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });

  try {
    const items = await getWatchlist();
    const idx = items.findIndex((i) => i.symbol === symbol);
    if (idx === -1) return NextResponse.json({ error: `${symbol} not on watchlist` }, { status: 404 });

    if (body.targetBuy !== undefined) items[idx].targetBuy = body.targetBuy ?? undefined;
    if (body.targetSell !== undefined) items[idx].targetSell = body.targetSell ?? undefined;
    if (body.notes !== undefined) items[idx].notes = body.notes ?? undefined;

    await saveWatchlist(items);
    return NextResponse.json({ item: items[idx] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── DELETE — remove a symbol ────────────────────────────────────────────────

export async function DELETE(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { symbol: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const symbol = body.symbol?.toUpperCase()?.trim();
  if (!symbol) return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });

  try {
    const items = await getWatchlist();
    const filtered = items.filter((i) => i.symbol !== symbol);
    if (filtered.length === items.length) {
      return NextResponse.json({ error: `${symbol} not on watchlist` }, { status: 404 });
    }

    await saveWatchlist(filtered);
    return NextResponse.json({ removed: symbol, total: filtered.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
