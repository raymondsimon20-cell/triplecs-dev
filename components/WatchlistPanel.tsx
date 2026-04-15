'use client';

/**
 * WatchlistPanel — track symbols you're interested in with price target alerts.
 *
 * Features:
 *   - Add/remove symbols
 *   - Set buy/sell price targets
 *   - Live quotes with day change
 *   - Visual alerts when targets are hit
 *   - Toast notifications on target hits
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, X, Loader2, RefreshCw, Target, TrendingUp, TrendingDown,
  Bell, BellRing, Eye, Edit2, Check,
} from 'lucide-react';
import { fmt$, gainLossColor } from '@/lib/utils';
import { useToast } from './ToastProvider';
import type { WatchlistItemWithQuote } from '@/app/api/watchlist/route';

// ─── Add Symbol Form ─────────────────────────────────────────────────────────

function AddSymbolForm({ onAdd }: { onAdd: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [targetBuy, setTargetBuy] = useState('');
  const [targetSell, setTargetSell] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!symbol.trim()) return;
    setAdding(true);
    setError('');
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          targetBuy: targetBuy ? parseFloat(targetBuy) : undefined,
          targetSell: targetSell ? parseFloat(targetSell) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed'); return; }
      toast.show(`${symbol.toUpperCase()} added to watchlist`, 'success');
      setSymbol('');
      setTargetBuy('');
      setTargetSell('');
      onAdd();
    } catch {
      setError('Network error');
    } finally {
      setAdding(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="Symbol (e.g. AAPL)"
          className="flex-1 bg-[#22263a] border border-[#2d3248] rounded-lg px-3 py-2 text-sm text-white
            placeholder-[#4a5070] focus:outline-none focus:border-blue-500"
          maxLength={10}
        />
        <button
          type="submit"
          disabled={adding || !symbol.trim()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500
            text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add
        </button>
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          step="0.01"
          min="0"
          value={targetBuy}
          onChange={(e) => setTargetBuy(e.target.value)}
          placeholder="Buy target $"
          className="flex-1 bg-[#22263a] border border-[#2d3248] rounded-lg px-3 py-1.5 text-xs text-white
            placeholder-[#4a5070] focus:outline-none focus:border-emerald-500"
        />
        <input
          type="number"
          step="0.01"
          min="0"
          value={targetSell}
          onChange={(e) => setTargetSell(e.target.value)}
          placeholder="Sell target $"
          className="flex-1 bg-[#22263a] border border-[#2d3248] rounded-lg px-3 py-1.5 text-xs text-white
            placeholder-[#4a5070] focus:outline-none focus:border-red-500"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}

// ─── Watchlist row ───────────────────────────────────────────────────────────

function WatchlistRow({
  item,
  onRemove,
  onUpdate,
}: {
  item: WatchlistItemWithQuote;
  onRemove: (symbol: string) => void;
  onUpdate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [buyTarget, setBuyTarget] = useState(item.targetBuy?.toString() ?? '');
  const [sellTarget, setSellTarget] = useState(item.targetSell?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const dayChange = item.dayChange ?? 0;
  const dayPct = item.dayChangePct ?? 0;
  const isHit = item.hitBuyTarget || item.hitSellTarget;

  async function handleSave() {
    setSaving(true);
    try {
      await fetch('/api/watchlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: item.symbol,
          targetBuy: buyTarget ? parseFloat(buyTarget) : null,
          targetSell: sellTarget ? parseFloat(sellTarget) : null,
        }),
      });
      setEditing(false);
      onUpdate();
    } catch {
      toast.show('Failed to update targets', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`flex items-center gap-3 p-3 rounded-xl border transition-colors
      ${isHit
        ? 'bg-yellow-500/10 border-yellow-500/30 animate-pulse'
        : 'bg-[#161923] border-[#2d3248] hover:border-[#3d4268]'
      }`}
    >
      {/* Alert indicator */}
      <div className="flex-shrink-0">
        {isHit
          ? <BellRing className="w-4 h-4 text-yellow-400" />
          : <Eye className="w-4 h-4 text-[#4a5070]" />}
      </div>

      {/* Symbol + price */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm text-white">{item.symbol}</span>
          {item.lastPrice != null && (
            <span className="text-sm font-mono text-white">{fmt$(item.lastPrice)}</span>
          )}
          {dayChange !== 0 && (
            <span className={`text-xs font-mono ${gainLossColor(dayChange)}`}>
              {dayChange > 0 ? '+' : ''}{dayPct.toFixed(2)}%
            </span>
          )}
        </div>

        {/* Targets */}
        {editing ? (
          <div className="flex items-center gap-2 mt-1">
            <input
              type="number"
              step="0.01"
              value={buyTarget}
              onChange={(e) => setBuyTarget(e.target.value)}
              placeholder="Buy $"
              className="w-20 bg-[#22263a] border border-emerald-500/30 rounded px-2 py-0.5 text-xs text-emerald-400 focus:outline-none"
            />
            <input
              type="number"
              step="0.01"
              value={sellTarget}
              onChange={(e) => setSellTarget(e.target.value)}
              placeholder="Sell $"
              className="w-20 bg-[#22263a] border border-red-500/30 rounded px-2 py-0.5 text-xs text-red-400 focus:outline-none"
            />
            <button onClick={handleSave} disabled={saving} className="text-emerald-400 hover:text-emerald-300">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 mt-0.5 text-xs text-[#7c82a0]">
            {item.targetBuy != null && (
              <span className={item.hitBuyTarget ? 'text-emerald-400 font-semibold' : ''}>
                <TrendingDown className="w-2.5 h-2.5 inline mr-0.5" />
                Buy ≤ {fmt$(item.targetBuy)}
                {item.hitBuyTarget && ' ✓ HIT'}
              </span>
            )}
            {item.targetSell != null && (
              <span className={item.hitSellTarget ? 'text-red-400 font-semibold' : ''}>
                <TrendingUp className="w-2.5 h-2.5 inline mr-0.5" />
                Sell ≥ {fmt$(item.targetSell)}
                {item.hitSellTarget && ' ✓ HIT'}
              </span>
            )}
            {!item.targetBuy && !item.targetSell && (
              <span className="text-[#4a5070] italic">No price targets set</span>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => setEditing(!editing)}
          className="p-1.5 rounded-lg text-[#7c82a0] hover:text-white hover:bg-white/5 transition-colors"
          title="Edit targets"
        >
          <Edit2 className="w-3 h-3" />
        </button>
        <button
          onClick={() => onRemove(item.symbol)}
          className="p-1.5 rounded-lg text-[#7c82a0] hover:text-red-400 hover:bg-red-500/10 transition-colors"
          title="Remove from watchlist"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export function WatchlistPanel() {
  const [items, setItems] = useState<WatchlistItemWithQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const toast = useToast();
  const prevHits = useRef<Set<string>>(new Set());

  const fetchWatchlist = useCallback(async () => {
    try {
      const res = await fetch('/api/watchlist');
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items ?? []);

      // Fire toast for newly-hit targets
      for (const item of (data.items ?? []) as WatchlistItemWithQuote[]) {
        const key = `${item.symbol}-buy`;
        const keyS = `${item.symbol}-sell`;
        if (item.hitBuyTarget && !prevHits.current.has(key)) {
          toast.show(`${item.symbol} hit buy target at ${fmt$(item.lastPrice ?? 0)}!`, 'success', 10000);
          prevHits.current.add(key);
        }
        if (item.hitSellTarget && !prevHits.current.has(keyS)) {
          toast.show(`${item.symbol} hit sell target at ${fmt$(item.lastPrice ?? 0)}!`, 'warn', 10000);
          prevHits.current.add(keyS);
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchWatchlist();
    // Refresh every 60s to check price targets
    const interval = setInterval(fetchWatchlist, 60_000);
    return () => clearInterval(interval);
  }, [fetchWatchlist]);

  async function handleRemove(symbol: string) {
    try {
      await fetch('/api/watchlist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      setItems((prev) => prev.filter((i) => i.symbol !== symbol));
      toast.show(`${symbol} removed from watchlist`, 'info');
    } catch {
      toast.show('Failed to remove', 'danger');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-[#7c82a0] text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading watchlist…
      </div>
    );
  }

  const hitCount = items.filter((i) => i.hitBuyTarget || i.hitSellTarget).length;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#7c82a0]">
            {items.length} symbol{items.length !== 1 ? 's' : ''}
          </span>
          {hitCount > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/15 text-yellow-400">
              <Bell className="w-2.5 h-2.5" />
              {hitCount} alert{hitCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAdd(!showAdd)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors
              ${showAdd
                ? 'bg-blue-600/20 text-blue-400'
                : 'bg-[#22263a] text-[#7c82a0] hover:text-white'
              }`}
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
          <button
            onClick={fetchWatchlist}
            className="p-1.5 rounded-lg text-[#7c82a0] hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Refresh watchlist"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="bg-[#22263a] rounded-xl p-3 border border-[#2d3248]">
          <AddSymbolForm onAdd={() => { fetchWatchlist(); setShowAdd(false); }} />
        </div>
      )}

      {/* Watchlist items */}
      {items.length === 0 && !showAdd ? (
        <div className="text-center py-8 space-y-2">
          <Target className="w-5 h-5 mx-auto text-[#4a5070]" />
          <p className="text-sm text-[#7c82a0]">No symbols on your watchlist</p>
          <button
            onClick={() => setShowAdd(true)}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Add your first symbol
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <WatchlistRow
              key={item.symbol}
              item={item}
              onRemove={handleRemove}
              onUpdate={fetchWatchlist}
            />
          ))}
        </div>
      )}
    </div>
  );
}
