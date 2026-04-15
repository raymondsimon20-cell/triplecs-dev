/**
 * POST /api/orders
 *
 * Places one or more equity orders via the Schwab Trader API.
 * Each order must be explicitly confirmed by the user in the UI before
 * this endpoint is called.
 *
 * Body:
 *   {
 *     accountHash: string,
 *     orders: Array<{
 *       symbol:      string,
 *       instruction: 'BUY' | 'SELL',
 *       quantity:    number,    // whole shares
 *       orderType:  'MARKET' | 'LIMIT',
 *       price?:     number,     // required for LIMIT
 *     }>
 *   }
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { placeOrders } from '@/lib/schwab/orders';
import type { OrderRequest } from '@/lib/schwab/orders';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Auth
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse body
  let body: { accountHash: string; orders: OrderRequest[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { accountHash, orders } = body;

  if (!accountHash || typeof accountHash !== 'string') {
    return NextResponse.json({ error: 'Missing accountHash' }, { status: 400 });
  }

  if (!Array.isArray(orders) || orders.length === 0) {
    return NextResponse.json({ error: 'No orders provided' }, { status: 400 });
  }

  // Validate each order
  for (const order of orders) {
    if (!order.symbol || typeof order.symbol !== 'string') {
      return NextResponse.json({ error: `Invalid order: missing symbol` }, { status: 400 });
    }
    if (!['BUY', 'SELL'].includes(order.instruction)) {
      return NextResponse.json({ error: `Invalid instruction for ${order.symbol}` }, { status: 400 });
    }
    if (!order.quantity || order.quantity < 1) {
      return NextResponse.json({ error: `Invalid quantity for ${order.symbol}` }, { status: 400 });
    }
    if (order.orderType === 'LIMIT' && !order.price) {
      return NextResponse.json({ error: `LIMIT order for ${order.symbol} missing price` }, { status: 400 });
    }
  }

  // Get tokens
  const tokens = await getTokens();
  if (!tokens) {
    return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });
  }

  try {
    const results = await placeOrders(tokens, accountHash, orders);
    const allPlaced = results.every((r) => r.status === 'placed');

    return NextResponse.json({
      results,
      success: allPlaced,
      placed:  results.filter((r) => r.status === 'placed').length,
      failed:  results.filter((r) => r.status === 'error').length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Orders API error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
