'use client';

/**
 * PendingOrdersPanel — shows all open/pending orders with cancel functionality.
 *
 * Fetches orders from GET /api/orders?accountHash=X&status=pending
 * Cancels via DELETE /api/orders with { accountHash, orderId }
 */

import { useState, useEffect, useCallback } from 'react';
import { XCircle, RefreshCw, Clock, AlertTriangle, Loader2, Ban } from 'lucide-react';
import { fmt$ } from '@/lib/utils';
import type { SchwabOrder, SchwabOrderStatus } from '@/lib/schwab/types';

interface Props {
  accountHash: string;
}

// ─── Status badge colors ─────────────────────────────────────────────────────

const STATUS_STYLES: Partial<Record<SchwabOrderStatus, { bg: string; text: string; label: string }>> = {
  WORKING:                  { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Working' },
  QUEUED:                   { bg: 'bg-yellow-500/15', text: 'text-yellow-400', label: 'Queued' },
  ACCEPTED:                 { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'Accepted' },
  PENDING_ACTIVATION:       { bg: 'bg-orange-500/15', text: 'text-orange-400', label: 'Pending' },
  AWAITING_CONDITION:       { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Awaiting Condition' },
  AWAITING_STOP_CONDITION:  { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Awaiting Stop' },
  AWAITING_MANUAL_REVIEW:   { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Manual Review' },
  PENDING_CANCEL:           { bg: 'bg-red-500/15', text: 'text-red-300', label: 'Cancelling…' },
};

function StatusBadge({ status }: { status: SchwabOrderStatus }) {
  const style = STATUS_STYLES[status] ?? { bg: 'bg-gray-500/15', text: 'text-gray-400', label: status };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${style.bg} ${style.text}`}>
      <Clock className="w-2.5 h-2.5" />
      {style.label}
    </span>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function PendingOrdersPanel({ accountHash }: Props) {
  const [orders, setOrders] = useState<SchwabOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingIds, setCancellingIds] = useState<Set<number>>(new Set());
  const [cancelAllLoading, setCancelAllLoading] = useState(false);

  const fetchOrders = useCallback(async () => {
    if (!accountHash) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders?accountHash=${accountHash}&status=pending`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [accountHash]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // ─── Cancel a single order ───────────────────────────────────────────

  async function handleCancel(orderId: number) {
    setCancellingIds((prev) => new Set(prev).add(orderId));
    try {
      const res = await fetch('/api/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountHash, orderId }),
      });
      const data = await res.json();
      if (data.success) {
        // Remove from local state immediately, then refresh
        setOrders((prev) => prev.filter((o) => o.orderId !== orderId));
        // Brief delay then refresh to get updated statuses
        setTimeout(fetchOrders, 1500);
      } else {
        setError(data.message || 'Cancel failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel request failed');
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
    }
  }

  // ─── Cancel all orders ────────────────────────────────────────────────

  async function handleCancelAll() {
    if (!confirm(`Cancel all ${orders.length} pending order(s)?`)) return;
    setCancelAllLoading(true);
    try {
      for (const order of orders) {
        await fetch('/api/orders', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountHash, orderId: order.orderId }),
        });
      }
      setOrders([]);
      setTimeout(fetchOrders, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel all failed');
    } finally {
      setCancelAllLoading(false);
    }
  }

  // ─── Loading state ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-[#7c82a0] text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading pending orders…
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex items-center gap-2 py-4 px-3 text-sm text-red-400 bg-red-500/10 rounded-lg">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span>{error}</span>
        <button onClick={fetchOrders} className="ml-auto text-xs text-[#7c82a0] hover:text-white">
          Retry
        </button>
      </div>
    );
  }

  // ─── Empty state ──────────────────────────────────────────────────────

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-[#7c82a0] gap-2">
        <Ban className="w-5 h-5" />
        <span className="text-sm">No pending orders</span>
        <button
          onClick={fetchOrders}
          className="text-xs text-blue-400 hover:text-blue-300 mt-1"
        >
          Refresh
        </button>
      </div>
    );
  }

  // ─── Render orders ────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Header row with cancel-all and refresh */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#7c82a0]">
          {orders.length} pending order{orders.length !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-2">
          {orders.length > 1 && (
            <button
              onClick={handleCancelAll}
              disabled={cancelAllLoading}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium
                bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cancelAllLoading
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <XCircle className="w-3 h-3" />}
              Cancel All
            </button>
          )}
          <button
            onClick={fetchOrders}
            className="p-1.5 rounded-lg text-[#7c82a0] hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Refresh orders"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Order cards */}
      <div className="space-y-2">
        {orders.map((order) => {
          const leg = order.orderLegCollection?.[0];
          const symbol = leg?.instrument?.symbol ?? '???';
          const instruction = leg?.instruction ?? 'N/A';
          const qty = order.quantity;
          const filled = order.filledQuantity;
          const remaining = order.remainingQuantity;
          const isBuy = instruction === 'BUY' || instruction === 'BUY_TO_COVER';
          const isCancelling = cancellingIds.has(order.orderId);
          const enteredAt = new Date(order.enteredTime);

          return (
            <div
              key={order.orderId}
              className="flex items-center gap-3 p-3 rounded-xl bg-[#161923] border border-[#2d3248] hover:border-[#3d4268] transition-colors"
            >
              {/* Instruction badge */}
              <div className={`flex-shrink-0 px-2 py-1 rounded-lg text-xs font-bold uppercase
                ${isBuy
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-red-500/15 text-red-400'
                }`}
              >
                {instruction}
              </div>

              {/* Symbol and details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">{symbol}</span>
                  <StatusBadge status={order.status} />
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-[#7c82a0]">
                  <span>{qty} shares</span>
                  {filled > 0 && (
                    <span className="text-emerald-400">{filled} filled</span>
                  )}
                  {remaining > 0 && remaining !== qty && (
                    <span>{remaining} remaining</span>
                  )}
                  <span className="uppercase">{order.orderType}</span>
                  {order.price != null && (
                    <span>@ {fmt$(order.price)}</span>
                  )}
                  {order.stopPrice != null && (
                    <span>stop {fmt$(order.stopPrice)}</span>
                  )}
                  <span className="text-[#4a5070]">{order.duration}</span>
                </div>
                <div className="text-[10px] text-[#4a5070] mt-0.5">
                  Entered {enteredAt.toLocaleDateString()} {enteredAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>

              {/* Estimated value */}
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-semibold text-white tabular-nums">
                  {order.price
                    ? fmt$(order.price * remaining)
                    : '—'}
                </div>
                <div className="text-[10px] text-[#4a5070] uppercase">
                  est. value
                </div>
              </div>

              {/* Cancel button */}
              <button
                onClick={() => handleCancel(order.orderId)}
                disabled={isCancelling || order.status === 'PENDING_CANCEL'}
                className="flex-shrink-0 p-2 rounded-lg text-red-400 hover:bg-red-500/15
                  transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label={`Cancel ${symbol} order`}
                title="Cancel order"
              >
                {isCancelling
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <XCircle className="w-4 h-4" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Export helper: map of symbol → pending order count ──────────────────────

/** Hook for other components to check if a symbol has pending orders */
export function usePendingOrderSymbols(accountHash: string) {
  const [symbolMap, setSymbolMap] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!accountHash) return;
    fetch(`/api/orders?accountHash=${accountHash}&status=pending`)
      .then((res) => res.json())
      .then((data) => {
        const map = new Map<string, number>();
        for (const order of (data.orders ?? []) as SchwabOrder[]) {
          const sym = order.orderLegCollection?.[0]?.instrument?.symbol;
          if (sym) map.set(sym, (map.get(sym) ?? 0) + 1);
        }
        setSymbolMap(map);
      })
      .catch(() => {});
  }, [accountHash]);

  return symbolMap;
}
