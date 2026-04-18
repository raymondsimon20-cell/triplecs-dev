'use client';

/**
 * TradeHub — merged Pending Orders + Trade History.
 *
 * Tabs:
 *   Pending  — live open/working orders from Schwab with cancel support
 *   History  — orders placed through this dashboard (Netlify Blobs log)
 */

import { useState, useEffect, useCallback } from 'react';
import {
  History, RefreshCw, CheckCircle, AlertTriangle,
  ChevronDown, ChevronUp, XCircle, Clock, Loader2, Ban, ClipboardList,
} from 'lucide-react';
import { fmt$ } from '@/lib/utils';
import type { SchwabOrder, SchwabOrderStatus } from '@/lib/schwab/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  accountHash: string;
}

interface TradeHistoryEntry {
  id: string;
  timestamp: string;
  symbol: string;
  instruction: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
  orderId: string | null;
  status: 'placed' | 'error';
  message?: string;
  rationale?: string;
  aiMode?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INSTRUCTION_COLORS = {
  BUY:  'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
  SELL: 'bg-red-500/20 text-red-300 border border-red-500/30',
};

const MODE_LABELS: Record<string, string> = {
  trade_plan:    'Trade Plan',
  what_to_sell:  'What to Sell',
  rule_audit:    'Rule Audit',
  daily_pulse:   'Daily Pulse',
  open_question: 'Ask Anything',
};

const STATUS_STYLES: Partial<Record<SchwabOrderStatus, { bg: string; text: string; label: string }>> = {
  WORKING:                 { bg: 'bg-blue-500/15',   text: 'text-blue-400',   label: 'Working' },
  QUEUED:                  { bg: 'bg-yellow-500/15', text: 'text-yellow-400', label: 'Queued' },
  ACCEPTED:                { bg: 'bg-emerald-500/15',text: 'text-emerald-400',label: 'Accepted' },
  PENDING_ACTIVATION:      { bg: 'bg-orange-500/15', text: 'text-orange-400', label: 'Pending' },
  AWAITING_CONDITION:      { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Awaiting Condition' },
  AWAITING_STOP_CONDITION: { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Awaiting Stop' },
  AWAITING_MANUAL_REVIEW:  { bg: 'bg-red-500/15',    text: 'text-red-400',    label: 'Manual Review' },
  PENDING_CANCEL:          { bg: 'bg-red-500/15',    text: 'text-red-300',    label: 'Cancelling…' },
};

function StatusBadge({ status }: { status: SchwabOrderStatus }) {
  const s = STATUS_STYLES[status] ?? { bg: 'bg-gray-500/15', text: 'text-gray-400', label: status };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${s.bg} ${s.text}`}>
      <Clock className="w-2.5 h-2.5" />{s.label}
    </span>
  );
}

function fmtTs(ts: string) {
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ─── Pending tab ──────────────────────────────────────────────────────────────

function PendingTab({ accountHash }: { accountHash: string }) {
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
      setOrders((await res.json()).orders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [accountHash]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  async function handleCancel(orderId: number) {
    setCancellingIds((p) => new Set(p).add(orderId));
    try {
      const res = await fetch('/api/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountHash, orderId }),
      });
      const data = await res.json();
      if (data.success) {
        setOrders((p) => p.filter((o) => o.orderId !== orderId));
        setTimeout(fetchOrders, 1500);
      } else {
        setError(data.message || 'Cancel failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel request failed');
    } finally {
      setCancellingIds((p) => { const n = new Set(p); n.delete(orderId); return n; });
    }
  }

  async function handleCancelAll() {
    if (!confirm(`Cancel all ${orders.length} pending order(s)?`)) return;
    setCancelAllLoading(true);
    try {
      for (const o of orders)
        await fetch('/api/orders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountHash, orderId: o.orderId }) });
      setOrders([]);
      setTimeout(fetchOrders, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel all failed');
    } finally {
      setCancelAllLoading(false);
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-8 text-[#7c82a0] text-sm gap-2">
      <Loader2 className="w-4 h-4 animate-spin" />Loading pending orders…
    </div>
  );

  if (error) return (
    <div className="flex items-center gap-2 py-4 px-3 text-sm text-red-400 bg-red-500/10 rounded-lg">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />{error}
      <button onClick={fetchOrders} className="ml-auto text-xs text-[#7c82a0] hover:text-white">Retry</button>
    </div>
  );

  if (orders.length === 0) return (
    <div className="flex flex-col items-center justify-center py-8 text-[#7c82a0] gap-2">
      <Ban className="w-5 h-5" />
      <span className="text-sm">No pending orders</span>
      <button onClick={fetchOrders} className="text-xs text-blue-400 hover:text-blue-300 mt-1">Refresh</button>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#7c82a0]">{orders.length} pending order{orders.length !== 1 ? 's' : ''}</span>
        <div className="flex items-center gap-2">
          {orders.length > 1 && (
            <button onClick={handleCancelAll} disabled={cancelAllLoading}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50">
              {cancelAllLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
              Cancel All
            </button>
          )}
          <button onClick={fetchOrders} className="p-1.5 rounded-lg text-[#7c82a0] hover:text-white hover:bg-white/5 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {orders.map((order) => {
          const leg = order.orderLegCollection?.[0];
          const symbol = leg?.instrument?.symbol ?? '???';
          const instruction = leg?.instruction ?? 'N/A';
          const isBuy = instruction === 'BUY' || instruction === 'BUY_TO_COVER';
          const isCancelling = cancellingIds.has(order.orderId);
          const enteredAt = new Date(order.enteredTime);

          return (
            <div key={order.orderId}
              className="flex items-center gap-3 p-3 rounded-xl bg-[#161923] border border-[#2d3248] hover:border-[#3d4268] transition-colors">
              <div className={`flex-shrink-0 px-2 py-1 rounded-lg text-xs font-bold uppercase ${isBuy ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                {instruction}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">{symbol}</span>
                  <StatusBadge status={order.status} />
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-[#7c82a0]">
                  <span>{order.quantity} shares</span>
                  {order.filledQuantity > 0 && <span className="text-emerald-400">{order.filledQuantity} filled</span>}
                  {order.remainingQuantity > 0 && order.remainingQuantity !== order.quantity && <span>{order.remainingQuantity} remaining</span>}
                  <span className="uppercase">{order.orderType}</span>
                  {order.price != null && <span>@ {fmt$(order.price)}</span>}
                  {order.stopPrice != null && <span>stop {fmt$(order.stopPrice)}</span>}
                  <span className="text-[#4a5070]">{order.duration}</span>
                </div>
                <div className="text-[10px] text-[#4a5070] mt-0.5">
                  Entered {enteredAt.toLocaleDateString()} {enteredAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-semibold text-white tabular-nums">
                  {order.price ? fmt$(order.price * order.remainingQuantity) : '—'}
                </div>
                <div className="text-[10px] text-[#4a5070] uppercase">est. value</div>
              </div>
              <button onClick={() => handleCancel(order.orderId)}
                disabled={isCancelling || order.status === 'PENDING_CANCEL'}
                className="flex-shrink-0 p-2 rounded-lg text-red-400 hover:bg-red-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {isCancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── History tab ──────────────────────────────────────────────────────────────

function HistoryTab() {
  const [entries, setEntries] = useState<TradeHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/trade-history');
      if (res.ok) setEntries((await res.json()).entries ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  function toggleEntry(id: string) {
    setExpanded((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const placed = entries.filter((e) => e.status === 'placed').length;
  const failed = entries.filter((e) => e.status === 'error').length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#7c82a0]">
          {entries.length === 0 ? 'Orders placed through this dashboard' : `${placed} placed${failed > 0 ? ` · ${failed} failed` : ''}`}
        </p>
        <button onClick={fetchHistory} disabled={loading}
          className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>

      {loading && entries.length === 0 ? (
        <div className="text-xs text-[#4a5070] text-center py-6">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-xs text-[#4a5070] text-center py-6">
          No trades placed yet. Use the AI Trade Plan to generate and execute orders.
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const isExpanded = expanded.has(entry.id);
            return (
              <div key={entry.id} className={`rounded-lg border text-sm transition-colors ${
                entry.status === 'placed' ? 'bg-[#0f1117] border-[#2d3248]' : 'bg-red-500/5 border-red-500/20'
              }`}>
                <button className="w-full flex items-center gap-3 px-3 py-2.5 text-left" onClick={() => toggleEntry(entry.id)}>
                  {entry.status === 'placed'
                    ? <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    : <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${INSTRUCTION_COLORS[entry.instruction]}`}>
                    {entry.instruction}
                  </span>
                  <span className="font-semibold text-white">{entry.symbol}</span>
                  <span className="text-[#7c82a0]">{entry.quantity} shares</span>
                  <span className="text-[#4a5070] text-xs ml-auto">{fmtTs(entry.timestamp)}</span>
                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-[#4a5070] flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-[#4a5070] flex-shrink-0" />}
                </button>
                {isExpanded && (
                  <div className="px-3 pb-3 space-y-1.5 border-t border-[#2d3248] pt-2.5">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#7c82a0]">
                      <span>Order type: <span className="text-white">{entry.orderType}</span></span>
                      {entry.orderId && <span>Order ID: <span className="text-white font-mono">{entry.orderId}</span></span>}
                      {entry.aiMode && <span>Source: <span className="text-violet-400">{MODE_LABELS[entry.aiMode] ?? entry.aiMode}</span></span>}
                      {entry.status === 'error' && entry.message && <span className="text-red-400">Error: {entry.message}</span>}
                    </div>
                    {entry.rationale && (
                      <p className="text-xs text-[#7c82a0] italic leading-relaxed">AI rationale: {entry.rationale}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TradeHub({ accountHash }: Props) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'pending' | 'history'>('pending');

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <ClipboardList className="w-5 h-5 text-yellow-400" />
          <span className="font-semibold text-white text-sm">Orders & Trade History</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248]">
          {/* Tab bar */}
          <div className="flex border-b border-[#2d3248] px-4 pt-2 gap-1">
            <button
              onClick={() => setTab('pending')}
              className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-t border-b-2 transition-colors ${
                tab === 'pending'
                  ? 'border-yellow-500 text-yellow-400 bg-yellow-500/5'
                  : 'border-transparent text-[#7c82a0] hover:text-white'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />Pending
            </button>
            <button
              onClick={() => setTab('history')}
              className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-t border-b-2 transition-colors ${
                tab === 'history'
                  ? 'border-blue-500 text-blue-400 bg-blue-500/5'
                  : 'border-transparent text-[#7c82a0] hover:text-white'
              }`}
            >
              <History className="w-3.5 h-3.5" />History
            </button>
          </div>

          <div className="px-5 py-4">
            {tab === 'pending'
              ? <PendingTab accountHash={accountHash} />
              : <HistoryTab />
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Re-export hook (used by PositionsTable etc.) ─────────────────────────────

export function usePendingOrderSymbols(accountHash: string) {
  const [symbolMap, setSymbolMap] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!accountHash) return;
    fetch(`/api/orders?accountHash=${accountHash}&status=pending`)
      .then((r) => r.json())
      .then((data) => {
        const map = new Map<string, number>();
        for (const o of (data.orders ?? []) as SchwabOrder[])  {
          const sym = o.orderLegCollection?.[0]?.instrument?.symbol;
          if (sym) map.set(sym, (map.get(sym) ?? 0) + 1);
        }
        setSymbolMap(map);
      })
      .catch(() => {});
  }, [accountHash]);

  return symbolMap;
}
