/**
 * Schwab order placement
 * Supports equity market + limit orders, and option LIMIT orders via the Trader API.
 *
 * Option orders MUST be LIMIT (never market) and use instruction variants
 * BUY_TO_OPEN / BUY_TO_CLOSE / SELL_TO_OPEN / SELL_TO_CLOSE with assetType OPTION.
 * The occSymbol must come verbatim from the live options chain — never computed.
 */

import { refreshAccessToken, isAccessTokenExpired } from './auth';
import { getTokens, saveTokens } from '../storage';
import type { SchwabTokens, SchwabOrder } from './types';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderInstruction   = 'BUY' | 'SELL';
export type OptionInstruction  = 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';
export type OrderType          = 'MARKET' | 'LIMIT';
export type OrderDuration      = 'DAY' | 'GOOD_TILL_CANCEL';

export interface OrderRequest {
  symbol:      string;
  instruction: OrderInstruction;
  quantity:    number;           // shares (must be a whole number for equities)
  orderType:   OrderType;
  price?:      number;           // required for LIMIT orders
  duration?:   OrderDuration;    // defaults to DAY
}

/**
 * Option order request.
 * occSymbol must be the exact OCC symbol returned by the live chain API —
 * e.g. "TQQQ  251219P00040000". Never compute it from price estimates.
 * Always LIMIT. limitPrice should be at or near the mid of bid/ask.
 */
export interface OptionOrderRequest {
  occSymbol:    string;           // verbatim from chain API
  instruction:  OptionInstruction;
  contracts:    number;           // whole number, ≥ 1
  limitPrice:   number;           // per-contract price (not multiplied by 100)
  duration?:    OrderDuration;    // defaults to DAY
}

export interface OrderResult {
  symbol:   string;
  orderId:  string | null;       // from Location header on 201
  status:   'placed' | 'error';
  message?: string;
}

// OptionOrderResult reuses OrderResult — symbol will be the occSymbol
export type OptionOrderResult = OrderResult;

// ─── Core order placer ────────────────────────────────────────────────────────

async function schwabOrderFetch(
  url: string,
  tokens: SchwabTokens,
  body: Record<string, unknown>
): Promise<{ status: number; orderId: string | null; text: string }> {
  let activeTokens = tokens;
  if (isAccessTokenExpired(tokens)) {
    activeTokens = await refreshAccessToken(tokens.refresh_token);
    await saveTokens(activeTokens);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      Accept:          'application/json',
      Authorization:   `Bearer ${activeTokens.access_token}`,
    },
    body: JSON.stringify(body),
  });

  // 201 Created → order accepted; Location header has the order ID URL
  const orderId = response.status === 201
    ? (response.headers.get('Location') ?? '').split('/').pop() ?? null
    : null;

  const text = response.status === 201 ? '' : await response.text();

  return { status: response.status, orderId, text };
}

// ─── Build Schwab order payload ───────────────────────────────────────────────

function buildOrderPayload(order: OrderRequest): Record<string, unknown> {
  return {
    orderType:           order.orderType,
    session:             'NORMAL',
    duration:            order.duration ?? 'DAY',
    orderStrategyType:   'SINGLE',
    price:               order.orderType === 'LIMIT' ? order.price?.toFixed(2) : undefined,
    orderLegCollection: [
      {
        instruction: order.instruction,
        quantity:    Math.floor(order.quantity),   // Schwab requires whole shares
        instrument:  {
          symbol:    order.symbol.toUpperCase(),
          assetType: 'EQUITY',
        },
      },
    ],
  };
}

// ─── Place a single order ─────────────────────────────────────────────────────

export async function placeOrder(
  tokens: SchwabTokens,
  accountHash: string,
  order: OrderRequest
): Promise<OrderResult> {
  const payload = buildOrderPayload(order);
  const url = `${TRADER_BASE}/accounts/${accountHash}/orders`;

  try {
    const { status, orderId, text } = await schwabOrderFetch(url, tokens, payload);

    if (status === 201) {
      return { symbol: order.symbol, orderId, status: 'placed' };
    }

    return {
      symbol:  order.symbol,
      orderId: null,
      status:  'error',
      message: `Schwab API ${status}: ${text.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      symbol:  order.symbol,
      orderId: null,
      status:  'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Place multiple orders in sequence ───────────────────────────────────────

export async function placeOrders(
  tokens: SchwabTokens,
  accountHash: string,
  orders: OrderRequest[]
): Promise<OrderResult[]> {
  // Sequential — Schwab rate limits concurrent order submission
  const results: OrderResult[] = [];
  for (const order of orders) {
    results.push(await placeOrder(tokens, accountHash, order));
  }
  return results;
}

// ─── Option order builder & placer ───────────────────────────────────────────

/**
 * Builds a Schwab option order payload.
 * Always LIMIT. assetType must be OPTION with the exact OCC symbol.
 */
function buildOptionOrderPayload(order: OptionOrderRequest): Record<string, unknown> {
  return {
    orderType:          'LIMIT',
    session:            'NORMAL',
    duration:           order.duration ?? 'DAY',
    orderStrategyType:  'SINGLE',
    price:              order.limitPrice.toFixed(2),
    orderLegCollection: [
      {
        instruction: order.instruction,
        quantity:    Math.max(1, Math.floor(order.contracts)),
        instrument:  {
          symbol:    order.occSymbol,   // verbatim OCC symbol from chain
          assetType: 'OPTION',
        },
      },
    ],
  };
}

export async function placeOptionOrder(
  tokens: SchwabTokens,
  accountHash: string,
  order: OptionOrderRequest,
): Promise<OptionOrderResult> {
  const payload = buildOptionOrderPayload(order);
  const url = `${TRADER_BASE}/accounts/${accountHash}/orders`;

  try {
    const { status, orderId, text } = await schwabOrderFetch(url, tokens, payload);

    if (status === 201) {
      return { symbol: order.occSymbol, orderId, status: 'placed' };
    }

    return {
      symbol:  order.occSymbol,
      orderId: null,
      status:  'error',
      message: `Schwab API ${status}: ${text.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      symbol:  order.occSymbol,
      orderId: null,
      status:  'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function placeOptionOrders(
  tokens: SchwabTokens,
  accountHash: string,
  orders: OptionOrderRequest[],
): Promise<OptionOrderResult[]> {
  const results: OptionOrderResult[] = [];
  for (const order of orders) {
    results.push(await placeOptionOrder(tokens, accountHash, order));
  }
  return results;
}

// ─── Fetch orders for an account ──────────────────────────────────────────────

/**
 * Fetch all orders for an account within a date range.
 * Defaults to last 7 days. Returns newest first.
 */
export async function getOrders(
  tokens: SchwabTokens,
  accountHash: string,
  fromDate?: string,   // ISO 8601 datetime
  toDate?: string,
): Promise<SchwabOrder[]> {
  let activeTokens = tokens;
  if (isAccessTokenExpired(tokens)) {
    activeTokens = await refreshAccessToken(tokens.refresh_token);
    await saveTokens(activeTokens);
  }

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    fromEnteredTime: fromDate ?? weekAgo.toISOString(),
    toEnteredTime: toDate ?? now.toISOString(),
  });

  const url = `${TRADER_BASE}/accounts/${accountHash}/orders?${params}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${activeTokens.access_token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Schwab API ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data as SchwabOrder[] : [];
}

// ─── Cancel a single order ───────────────────────────────────────────────────

export async function cancelOrder(
  tokens: SchwabTokens,
  accountHash: string,
  orderId: number | string,
): Promise<{ success: boolean; message?: string }> {
  let activeTokens = tokens;
  if (isAccessTokenExpired(tokens)) {
    activeTokens = await refreshAccessToken(tokens.refresh_token);
    await saveTokens(activeTokens);
  }

  const url = `${TRADER_BASE}/accounts/${accountHash}/orders/${orderId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${activeTokens.access_token}`,
    },
  });

  if (response.ok || response.status === 200 || response.status === 204) {
    return { success: true };
  }

  const text = await response.text();
  return { success: false, message: `Schwab API ${response.status}: ${text.slice(0, 200)}` };
}
