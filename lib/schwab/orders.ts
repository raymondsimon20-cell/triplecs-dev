/**
 * Schwab order placement
 * Supports equity market + limit orders via the Trader API.
 */

import { refreshAccessToken, isAccessTokenExpired } from './auth';
import { getTokens, saveTokens } from '../storage';
import type { SchwabTokens } from './types';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderInstruction = 'BUY' | 'SELL';
export type OrderType        = 'MARKET' | 'LIMIT';
export type OrderDuration    = 'DAY' | 'GOOD_TILL_CANCEL';

export interface OrderRequest {
  symbol:      string;
  instruction: OrderInstruction;
  quantity:    number;           // shares (must be a whole number for equities)
  orderType:   OrderType;
  price?:      number;           // required for LIMIT orders
  duration?:   OrderDuration;    // defaults to DAY
}

export interface OrderResult {
  symbol:   string;
  orderId:  string | null;       // from Location header on 201
  status:   'placed' | 'error';
  message?: string;
}

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
