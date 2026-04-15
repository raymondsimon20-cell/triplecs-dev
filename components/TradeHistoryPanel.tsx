'use client';

/**
 * Trade History Panel — shows all orders placed through the dashboard,
 * stored in Netlify Blobs. Newest first.
 */

import { useState, useEffect } from 'react';
import { History, RefreshCw, CheckCircle, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

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

const INSTRUCTION_COLORS = {
  BUY:  'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  SELL: 'bg-red-500/20 text-red-300 border-red-500/30',
};

const MODE_LABELS: Record<string, string> = {
  trade_plan:   'Trade Plan',
  what_to_sell: 'What to Sell',
  rule_audit:   'Rule Audit',
  daily_pulse:  'Daily Pulse',
  open_question:'Ask Anything',
};

function fmt(ts: string) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function TradeHistoryPanel() {
  const [open,     setOpen]     = useState(false);
  const [entries,  setEntries]  = useState<TradeHistoryEntry[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/trade-history');
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries ?? []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && entries.length === 0) fetchHistory();
  }, [open]);

  const toggleEntry = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const placed = entries.filter((e) => e.status === 'placed').length;
  const failed = entries.filter((e) => e.status === 'error').length;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <History className="w-5 h-5 text-blue-400" />
          <span className="font-semibold text-white text-sm">Trade History</span>
          {entries.length > 0 && (
            <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">
              {placed} placed{failed > 0 ? ` · ${failed} failed` : ''}
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-[#7c82a0]">Orders placed through this dashboard</p>
            <button
              onClick={fetchHistory}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
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
                  <div
                    key={entry.id}
                    className={`rounded-lg border text-sm transition-colors ${
                      entry.status === 'placed'
                        ? 'bg-[#0f1117] border-[#2d3248]'
                        : 'bg-red-500/5 border-red-500/20'
                    }`}
                  >
                    {/* Main row */}
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                      onClick={() => toggleEntry(entry.id)}
                    >
                      {entry.status === 'placed'
                        ? <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                        : <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />}

                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${INSTRUCTION_COLORS[entry.instruction]}`}>
                        {entry.instruction}
                      </span>

                      <span className="font-semibold text-white">{entry.symbol}</span>
                      <span className="text-[#7c82a0]">{entry.quantity} shares</span>
                      <span className="text-[#4a5070] text-xs ml-auto">{fmt(entry.timestamp)}</span>
                      {isExpanded
                        ? <ChevronUp className="w-3.5 h-3.5 text-[#4a5070] flex-shrink-0" />
                        : <ChevronDown className="w-3.5 h-3.5 text-[#4a5070] flex-shrink-0" />}
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-1.5 border-t border-[#2d3248] pt-2.5">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#7c82a0]">
                          <span>Order type: <span className="text-white">{entry.orderType}</span></span>
                          {entry.orderId && <span>Order ID: <span className="text-white font-mono">{entry.orderId}</span></span>}
                          {entry.aiMode && <span>Source: <span className="text-violet-400">{MODE_LABELS[entry.aiMode] ?? entry.aiMode}</span></span>}
                          {entry.status === 'error' && entry.message && (
                            <span className="text-red-400">Error: {entry.message}</span>
                          )}
                        </div>
                        {entry.rationale && (
                          <p className="text-xs text-[#7c82a0] italic leading-relaxed">
                            AI rationale: {entry.rationale}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
