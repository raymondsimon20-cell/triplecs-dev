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
import { placeOrders, placeOptionOrders, getOrders, cancelOrder } from '@/lib/schwab/orders';
import type { OrderRequest, OptionOrderRequest } from '@/lib/schwab/orders';

export const dynamic = 'force-dynamic';

interface OrderWithMeta extends OrderRequest {
  rationale?: string;
  aiMode?: string;
}

interface OptionOrderWithMeta extends OptionOrderRequest {
  rationale?: string;
  aiMode?: string;
}

const OPTION_INSTRUCTIONS = new Set(['BUY_TO_OPEN', 'BUY_TO_CLOSE', 'SELL_TO_OPEN', 'SELL_TO_CLOSE']);

export interface TradeHistoryEntry {
  id:          string;
  timestamp:   string;
  symbol:      string;
  instruction: 'BUY' | 'SELL' | 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';
  quantity:    number;
  orderType:   'MARKET' | 'LIMIT';
  price?:      number;
  orderId:     string | null;
  status:      'placed' | 'error';
  message?:    string;
  rationale?:  string;
  aiMode?:     string;
  /**
   * Cost basis per share for SELLs (USD/share). Captured at order placement
   * time from Schwab's position record. Used to compute realized P&L and to
   * decide whether a recent sell falls under wash-sale (loss) or not (gain).
   * Undefined for BUYs and when the position couldn't be located.
   */
  costBasisPerShare?: number;
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

  let body: { accountHash: string; orders?: OrderWithMeta[]; optionOrders?: OptionOrderWithMeta[] };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { accountHash, orders = [], optionOrders = [] } = body;

  if (!accountHash || typeof accountHash !== 'string')
    return NextResponse.json({ error: 'Missing accountHash' }, { status: 400 });
  if (orders.length === 0 && optionOrders.length === 0)
    return NextResponse.json({ error: 'No orders provided' }, { status: 400 });

  // Validate equity orders
  for (const order of orders) {
    if (!order.symbol)
      return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });
    if (!['BUY', 'SELL'].includes(order.instruction))
      return NextResponse.json({ error: `Invalid instruction for ${order.symbol}` }, { status: 400 });
    if (!order.quantity || order.quantity < 1)
      return NextResponse.json({ error: `Invalid quantity for ${order.symbol}` }, { status: 400 });
    if (order.orderType === 'LIMIT' && !order.price)
      return NextResponse.json({ error: `LIMIT order ${order.symbol} missing price` }, { status: 400 });
  }

  // Validate option orders
  for (const opt of optionOrders) {
    if (!opt.occSymbol?.trim())
      return NextResponse.json({ error: 'Option order missing occSymbol' }, { status: 400 });
    if (!OPTION_INSTRUCTIONS.has(opt.instruction))
      return NextResponse.json({ error: `Invalid option instruction for ${opt.occSymbol}` }, { status: 400 });
    if (!opt.contracts || opt.contracts < 1)
      return NextResponse.json({ error: `Invalid contracts for ${opt.occSymbol}` }, { status: 400 });
    if (!opt.limitPrice || opt.limitPrice <= 0)
      return NextResponse.json({ error: `Missing or invalid limitPrice for ${opt.occSymbol}` }, { status: 400 });
  }

  const tokens = await getTokens();
  if (!tokens) return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });

  try {
    // Capture cost-basis snapshot BEFORE placing orders. Done in parallel
    // with the orders themselves to keep latency flat; SELLs use the basis
    // from the pre-order state which is exactly the basis being closed out.
    const { fetchCostBasisMap, costBasisFor } = await import('@/lib/schwab/cost-basis');
    const [equityResults, optionResults, costBasisMap] = await Promise.all([
      orders.length     > 0 ? placeOrders(tokens, accountHash, orders)             : Promise.resolve([]),
      optionOrders.length > 0 ? placeOptionOrders(tokens, accountHash, optionOrders) : Promise.resolve([]),
      orders.some((o) => o.instruction === 'SELL')
        ? fetchCostBasisMap(tokens, accountHash)
        : Promise.resolve({} as Record<string, number>),
    ]);

    const now = Date.now();

    const equityHistory: TradeHistoryEntry[] = equityResults.map((r, i) => ({
      id:          `${now}-eq-${i}`,
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
      costBasisPerShare: costBasisFor(orders[i].instruction, r.symbol, costBasisMap),
    }));

    const optionHistory: TradeHistoryEntry[] = optionResults.map((r, i) => ({
      id:          `${now}-opt-${i}`,
      timestamp:   new Date().toISOString(),
      symbol:      r.symbol,
      instruction: optionOrders[i].instruction as TradeHistoryEntry['instruction'],
      quantity:    optionOrders[i].contracts,
      orderType:   'LIMIT',
      price:       optionOrders[i].limitPrice,
      orderId:     r.orderId,
      status:      r.status,
      message:     r.message,
      rationale:   optionOrders[i].rationale,
      aiMode:      optionOrders[i].aiMode,
    }));

    await saveTradeHistory([...equityHistory, ...optionHistory]);

    const allResults = [...equityResults, ...optionResults];
    return NextResponse.json({
      results:       allResults,
      equityResults,
      optionResults,
      success: allResults.every((r) => r.status === 'placed'),
      placed:  allResults.filter((r) => r.status === 'placed').length,
      failed:  allResults.filter((r) => r.status === 'error').length,
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
