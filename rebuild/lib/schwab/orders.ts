/**
 * Order placement + retrieval.
 *
 * HARD CONSTRAINT: Schwab hard-caps margin utilization at 50% at the broker.
 * Orders above that fail silently or with a cryptic error — `precheckMarginCap`
 * MUST run client-side before any order is submitted.
 */
import { getAccessToken } from './auth';
import type { SchwabAccount, SchwabOrder, OrderInstruction } from './types';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

/** Broker-level hard cap on margin utilization. */
export const SCHWAB_MARGIN_HARD_CAP = 0.5;

export function marginUtilization(account: SchwabAccount): number {
  const equity = account.balances.liquidationValue;
  if (equity <= 0) return 1;
  const debit = Math.max(0, -account.balances.marginBalance);
  const grossAssets = equity + debit;
  return grossAssets > 0 ? debit / grossAssets : 0;
}

/**
 * Reject any buy order whose projected margin utilization exceeds the Schwab
 * 50% hard cap — the broker would fail it anyway, often cryptically.
 */
export function precheckMarginCap(account: SchwabAccount, orderNotional: number): {
  ok: boolean;
  projectedUtilization: number;
  reason?: string;
} {
  const equity = account.balances.liquidationValue;
  const debit = Math.max(0, -account.balances.marginBalance);
  const cash = Math.max(0, account.balances.cashBalance ?? 0);
  const marginDraw = Math.max(0, orderNotional - cash);
  const projectedDebit = debit + marginDraw;
  const projectedGross = equity + projectedDebit;
  const projectedUtilization = projectedGross > 0 ? projectedDebit / projectedGross : 1;
  if (projectedUtilization > SCHWAB_MARGIN_HARD_CAP) {
    return {
      ok: false,
      projectedUtilization,
      reason: `Projected margin utilization ${(projectedUtilization * 100).toFixed(1)}% exceeds Schwab's 50% broker hard cap — order would fail at the broker.`,
    };
  }
  return { ok: true, projectedUtilization };
}

export function buildEquityOrder(params: {
  symbol: string;
  instruction: OrderInstruction;
  quantity: number;
  limitPrice?: number;
}): SchwabOrder {
  return {
    orderType: params.limitPrice != null ? 'LIMIT' : 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    price: params.limitPrice,
    orderLegCollection: [
      {
        instruction: params.instruction,
        quantity: params.quantity,
        instrument: { symbol: params.symbol, assetType: 'EQUITY' },
      },
    ],
  };
}

export async function placeOrder(accountHash: string, order: SchwabOrder): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${TRADER_BASE}/accounts/${accountHash}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(order),
  });
  if (!res.ok) {
    throw new Error(`Order placement failed ${res.status}: ${await res.text()}`);
  }
}

export async function getOrders(
  accountHash: string,
  fromDate: string,
  toDate: string
): Promise<SchwabOrder[]> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    fromEnteredTime: `${fromDate}T00:00:00.000Z`,
    toEnteredTime: `${toDate}T23:59:59.000Z`,
  });
  const res = await fetch(`${TRADER_BASE}/accounts/${accountHash}/orders?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getOrders failed ${res.status}`);
  return (await res.json()) as SchwabOrder[];
}

export async function cancelOrder(accountHash: string, orderId: number): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${TRADER_BASE}/accounts/${accountHash}/orders/${orderId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`cancelOrder failed ${res.status}`);
}
