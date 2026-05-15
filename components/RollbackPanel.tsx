'use client';

/**
 * Rollback Panel — undo recent autopilot trades.
 *
 * Shows every signal-engine_auto trade-history entry from the last 24h that
 * hasn't already been rolled back. One click places the inverse Schwab order
 * and tags both entries so a double-rollback isn't possible.
 *
 * Surfaces the recent rollbacks too so the user can see what's been reversed
 * without leaving the dashboard.
 *
 * Only operates on autopilot trades. Manual trades are reversed through the
 * regular TradeHub / orders interface.
 */

import { useState, useCallback, useEffect } from 'react';
import { Undo2, RefreshCw, AlertTriangle, History, TrendingUp, TrendingDown } from 'lucide-react';

interface HistoryEntry {
  id:           string;
  timestamp:    string;
  symbol:       string;
  instruction:  'BUY' | 'SELL' | string;
  quantity:     number;
  price?:       number;
  orderId:      string | null;
  status:       string;
  message?:     string;
  rationale?:   string;
  aiMode?:      string;
  rolledBackBy?: string;
  rollbackOf?:   string;
  costBasisPerShare?: number;
}

interface RollbackPayload {
  windowHours: number;
  reversible:  HistoryEntry[];
  rolledBack:  HistoryEntry[];
}

function fmt$(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style:                 'currency',
    currency:              'USD',
    maximumFractionDigits: 2,
  });
}

function fmtAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function directionIcon(d: string) {
  if (d === 'BUY')  return <TrendingUp   className="w-3.5 h-3.5 text-emerald-400" />;
  if (d === 'SELL') return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
  return <span className="w-3.5 h-3.5" />;
}

export function RollbackPanel() {
  const [data,    setData]    = useState<RollbackPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [busy,    setBusy]    = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/signals/rollback');
      const d = await r.json();
      if (d.error) setError(d.error);
      else        setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function rollback(entry: HistoryEntry) {
    const inverse = entry.instruction === 'BUY' ? 'SELL' : 'BUY';
    const msg =
      `Roll back ${entry.instruction} ${entry.quantity} ${entry.symbol}?\n\n` +
      `This will place a market ${inverse} of ${entry.quantity} ${entry.symbol} to reverse the position. ` +
      `This action cannot be undone (a second rollback would just place another inverse).`;
    if (!confirm(msg)) return;
    setBusy(entry.id);
    try {
      const r = await fetch('/api/signals/rollback', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: entry.id }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) {
        alert(`Rollback failed: ${d.error ?? d.reason ?? r.statusText}`);
      } else {
        alert(
          `Rolled back: ${d.inverse} ${d.quantity} ${d.symbol}\n` +
          `Order ID: ${d.orderId ?? '(none)'}\n` +
          `${d.message ?? ''}`,
        );
        await load();
      }
    } catch (err) {
      alert(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="h-20 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-red-400 flex items-start gap-2 p-2 border border-red-500/30 bg-red-500/5 rounded">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-[#7c82a0]">
          Rollback window: <strong className="text-white">{data.windowHours}h</strong> · Autopilot trades only
        </div>
        <button
          onClick={load}
          className="text-xs px-2 py-1 rounded hover:bg-white/[0.04] transition-colors flex items-center gap-1.5 text-[#7c82a0]"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {/* Reversible items */}
      <div>
        <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] mb-2">
          Reversible ({data.reversible.length})
        </div>
        {data.reversible.length === 0 ? (
          <div className="text-xs text-[#4a5070] p-3 border border-dashed border-[#2d3248] rounded">
            No reversible autopilot trades in the last {data.windowHours}h.
          </div>
        ) : (
          <div className="space-y-2">
            {data.reversible.map((e) => {
              const isBusy = busy === e.id;
              return (
                <div key={e.id} className="border border-[#2d3248] rounded p-2 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {directionIcon(e.instruction)}
                        <span className="font-mono font-semibold text-white">{e.instruction} {e.quantity} {e.symbol}</span>
                        {typeof e.price === 'number' && (
                          <span className="text-[#a0a4c0]">@ {fmt$(e.price)}</span>
                        )}
                        <span className="text-[10px] text-[#4a5070]">{fmtAge(e.timestamp)}</span>
                      </div>
                      {e.rationale && (
                        <div className="text-[11px] text-[#a0a4c0] mt-1">{e.rationale}</div>
                      )}
                    </div>
                    <button
                      onClick={() => rollback(e)}
                      disabled={isBusy}
                      className="text-[11px] px-2.5 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/15 flex items-center gap-1 transition-colors disabled:opacity-50 shrink-0 font-semibold"
                      title={`Place inverse ${e.instruction === 'BUY' ? 'SELL' : 'BUY'} order`}
                    >
                      {isBusy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                      Roll back
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recently rolled back */}
      {data.rolledBack.length > 0 && (
        <details>
          <summary className="text-[11px] uppercase tracking-wider text-[#7c82a0] cursor-pointer hover:text-white">
            Recently rolled back ({data.rolledBack.length})
          </summary>
          <div className="space-y-1.5 mt-2">
            {data.rolledBack.map((e) => (
              <div key={e.id} className="border border-[#2d3248] rounded p-2 text-[11px] opacity-70">
                <div className="flex items-center gap-2 flex-wrap">
                  <History className="w-3 h-3 text-[#7c82a0]" />
                  {directionIcon(e.instruction)}
                  <span className="font-mono text-white">{e.instruction} {e.quantity} {e.symbol}</span>
                  <span className="text-[10px] text-[#4a5070]">{fmtAge(e.timestamp)}</span>
                  <span className="text-[10px] text-red-300">→ rolled back</span>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
