/**
 * POST /api/orders
 *
 * Places one or more equity orders via the Schwab Trader API, then
 * persists each result to the "trade-history" Netlify Blobs store.
 *
 * Body:
 *   {
 *     accountHash: string,
 *     orders: Array<{
 *       symbol:      string,
 *       instruction: 'BUY' | 'SELL',
 *       quantity:    number,
 *       orderType:  'MARKET' | 'LIMIT',
 *       price?:     number,
 *       rationale?: string,   // AI rationale that triggered the trade
 *       aiMode?:    string,   // which analysis mode generated it
 *     }>
 *   }
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { placeOrders, getOrders, cancelOrder } from '@/lib/schwab/orders';
import type { OrderRequest } from '@/lib/schwab/orders';

export const dynamic = 'force-dynamic';

interface OrderWithMeta extends OrderRequest {
  rationale?: string;
  aiMode?: string;
}

export interface TradeHistoryEntry {
  id:          string;
  timestamp:   string;
  symbol:      string;
  instruction: 'BUY' | 'SELL';
  quantity:    number;
  orderType:   'MARKET' | 'LIMIT';
  price?:      number;
  orderId:     string | null;
  status:      'placed' | 'error';
  message?:    string;
  rationale?:  string;
  aiMode?:     string;
}

async function saveTradeHistory(entries: TradeHistoryEntry[]) {
  try {
    const store = getStore('trade-history');
    const existing = await store.get('log', { type: 'json' }) as TradeHistoryEntry[] | null;
    const log = Array.isArray(existing) ? existing : [];
    // Prepend newest first; cap at 500 entries
    const updated = [...entries, ...log].slice(0, 500);
    await store.setJSON('log', updated);
  } catch (err) {
    // Non-critical — don't fail the order if history write fails
    console.error('Trade history write error:', err);
  }
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { accountHash: string; orders: OrderWithMeta[] };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { accountHash, orders } = body;

  if (!accountHash || typeof accountHash !== 'string')
    return NextResponse.json({ error: 'Missing accountHash' }, { status: 400 });
  if (!Array.isArray(orders) || orders.length === 0)
    return NextResponse.json({ error: 'No orders provided' }, { status: 400 });

  for (const order of orders) {
    if (!order.symbol)                          return NextResponse.json({ error: `Missing symbol` }, { status: 400 });
    if (!['BUY', 'SELL'].includes(order.instruction))
                                                return NextResponse.json({ error: `Invalid instruction for ${order.symbol}` }, { status: 400 });
    if (!order.quantity || order.quantity < 1)  return NextResponse.json({ error: `Invalid quantity for ${order.symbol}` }, { status: 400 });
    if (order.orderType === 'LIMIT' && !order.price)
                                                return NextResponse.json({ error: `LIMIT order ${order.symbol} missing price` }, { status: 400 });
  }

  const tokens = await getTokens();
  if (!tokens) return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });

  try {
    const results = await placeOrders(tokens, accountHash, orders);

    // Persist to trade history
    const historyEntries: TradeHistoryEntry[] = results.map((r, i) => ({
      id:          `${Date.now()}-${i}`,
      timestamp:   new Date().toISOString(),
      symbol:      r.symbol,
      instruction: orders[i].instruction,
      quantity:    orders[i].quantity,
      orderType:   orders[i].orderType,
      price:       orders[i].price,
      orderId:     r.orderId,
      status:      r.status,
      message:     r.message,
      rationale:   orders[i].rationale,
      aiMode:      orders[i].aiMode,
    }));
    await saveTradeHistory(historyEntries);

    return NextResponse.json({
      results,
      success: results.every((r) => r.status === 'placed'),
      placed:  results.filter((r) => r.status === 'placed').length,
      failed:  results.filter((r) => r.status === 'error').length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Orders API error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── GET /api/orders — fetch orders for an account ──────────────────────────

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHash = searchParams.get('accountHash');
  const status = searchParams.get('status'); // optional: 'pending' to filter open orders only

  if (!accountHash) {
    return NextResponse.json({ error: 'Missing accountHash query parameter' }, { status: 400 });
  }

  const tokens = await getTokens();
  if (!tokens) return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });

  try {
    const orders = await getOrders(tokens, accountHash);

    // If status=pending, filter to only cancellable/open orders
    const { CANCELLABLE_STATUSES } = await import('@/lib/schwab/types');
    const filtered = status === 'pending'
      ? orders.filter((o) => CANCELLABLE_STATUSES.has(o.status))
      : orders;

    return NextResponse.json({ orders: filtered, total: filtered.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('GET /api/orders error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── DELETE /api/orders — cancel a specific order ───────────────────────────

export async function DELETE(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { accountHash: string; orderId: number | string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { accountHash, orderId } = body;

  if (!accountHash || !orderId) {
    return NextResponse.json({ error: 'Missing accountHash or orderId' }, { status: 400 });
  }

  const tokens = await getTokens();
  if (!tokens) return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });

  try {
    const result = await cancelOrder(tokens, accountHash, orderId);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/orders error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
