'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, Info, RefreshCw, Edit3, Check } from 'lucide-react';

interface CEFData {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  sharesOutstanding?: number;
  lastUpdated: string;
  source: 'cornerstone' | 'yahoo' | 'manual' | 'unavailable';
}

function fmt$(n: number) {
  return `$${n.toFixed(2)}`;
}

function PremiumBadge({ pct }: { pct: number }) {
  if (pct >= 30) return (
    <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/30">
      SELL SIGNAL {pct.toFixed(1)}%
    </span>
  );
  if (pct >= 20) return (
    <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
      BOX TRIGGER {pct.toFixed(1)}%
    </span>
  );
  if (pct > 0) return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
      +{pct.toFixed(1)}% Premium
    </span>
  );
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
      {pct.toFixed(1)}% Discount
    </span>
  );
}

function ManualEntry({ ticker, currentPrice, onSave }: { ticker: string; currentPrice: number; onSave: () => void }) {
  const [nav, setNav] = useState('');
  // Pre-fill price from Schwab if we have it
  const [price, setPrice] = useState(currentPrice > 0 ? currentPrice.toFixed(2) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!nav || !price) { setError('Both NAV and Price are required'); return; }
    setError('');
    setSaving(true);
    try {
      await fetch('/api/cornerstone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, nav: parseFloat(nav), marketPrice: parseFloat(price) }),
      });
      onSave();
    } catch {
      setError('Save failed — try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 mt-2">
      <div className="text-xs text-[#7c82a0]">Enter NAV manually (check cefconnect.com)</div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.01"
          placeholder="NAV"
          value={nav}
          onChange={(e) => setNav(e.target.value)}
          className="w-24 bg-[#2d3248] border border-[#3d4260] rounded px-2 py-1 text-xs text-white placeholder-[#4a5070]"
        />
        <input
          type="number"
          step="0.01"
          placeholder="Price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="w-24 bg-[#2d3248] border border-[#3d4260] rounded px-2 py-1 text-xs text-white placeholder-[#4a5070]"
        />
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1 px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs disabled:opacity-50"
        >
          <Check className="w-3 h-3" />
          Save
        </button>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}

function FundCard({ fund, onRefresh }: { fund: CEFData; onRefresh: () => void }) {
  // Auto-open manual entry when NAV is unavailable so user knows what to do
  const [editing, setEditing] = useState(fund.source === 'unavailable');

  const dripAdvantage = fund.nav > 0 && fund.marketPrice > 0
    ? ((fund.marketPrice - fund.nav) / fund.nav) * 100
    : 0;

  const hasNAV = fund.nav > 0;
  const hasPrice = fund.marketPrice > 0;

  return (
    <div className="bg-[#22263a] rounded-xl p-4 space-y-3 border border-[#2d3248]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-white font-mono">{fund.ticker}</span>
          {hasNAV && hasPrice && <PremiumBadge pct={fund.premiumDiscount} />}
          {fund.source === 'cornerstone' && (
            <span className="text-xs text-emerald-600">● cornerstone.com</span>
          )}
          {fund.source === 'yahoo' && (
            <span className="text-xs text-blue-500">● yahoo finance</span>
          )}
          {fund.source === 'manual' && (
            <span className="text-xs text-[#4a5070]">manual NAV</span>
          )}
        </div>
        <button
          onClick={() => setEditing((e) => !e)}
          className="text-[#4a5070] hover:text-white transition-colors"
          title="Enter NAV manually"
        >
          <Edit3 className="w-3.5 h-3.5" />
        </button>
      </div>

      {hasNAV && hasPrice ? (
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-xs text-[#7c82a0]">NAV</div>
            <div className="text-base font-mono font-semibold text-white">{fmt$(fund.nav)}</div>
          </div>
          <div>
            <div className="text-xs text-[#7c82a0]">Price</div>
            <div className="text-base font-mono font-semibold text-white">{fmt$(fund.marketPrice)}</div>
          </div>
          <div>
            <div className="text-xs text-[#7c82a0]">DRIP Edge</div>
            <div className="text-base font-mono font-semibold text-emerald-400">
              +{dripAdvantage.toFixed(1)}%
            </div>
          </div>
        </div>
      ) : hasPrice && !hasNAV ? (
        <div className="space-y-1">
          <div className="text-xs text-[#7c82a0]">
            Price (Schwab): <span className="text-white font-mono">{fmt$(fund.marketPrice)}</span>
          </div>
          <div className="text-xs text-amber-400">
            NAV auto-fetch unavailable — enter it manually (check cefconnect.com)
          </div>
        </div>
      ) : (
        <div className="text-xs text-[#4a5070]">
          No data — enter NAV and price manually
        </div>
      )}

      {/* Rule guidance */}
      {hasNAV && hasPrice && (
        <div className="text-xs space-y-1 pt-1 border-t border-[#2d3248]">
          {fund.premiumDiscount >= 30 && (
            <div className="flex items-center gap-1.5 text-red-400">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
              Premium ≥30%: Sell signal — consider selling & waiting for RO completion
            </div>
          )}
          {fund.premiumDiscount >= 20 && fund.premiumDiscount < 30 && (
            <div className="flex items-center gap-1.5 text-amber-400">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
              Premium ≥20%: Box trigger — consider boxing position
            </div>
          )}
          {fund.premiumDiscount < 20 && (
            <div className="flex items-center gap-1.5 text-emerald-400">
              <TrendingUp className="w-3 h-3 flex-shrink-0" />
              Premium below box threshold — DRIP at NAV active
            </div>
          )}
        </div>
      )}

      {editing && (
        <ManualEntry
          ticker={fund.ticker}
          currentPrice={fund.marketPrice}
          onSave={() => { setEditing(false); onRefresh(); }}
        />
      )}
    </div>
  );
}

export function CornerStoneCard() {
  const [funds, setFunds] = useState<CEFData[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [fetchError, setFetchError] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const res = await fetch('/api/cornerstone');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFunds(data.funds ?? []);
      setLastUpdated(new Date().toLocaleTimeString());
      // Log debug info to console so you can see what sources were tried
      if (data.debug?.length) {
        console.group('[Cornerstone NAV] fetch debug');
        (data.debug as string[]).forEach((line: string) => console.log(line));
        console.groupEnd();
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const boxAlerts = funds.filter((f) => f.premiumDiscount >= 20 && f.nav > 0).length;
  const sellAlerts = funds.filter((f) => f.premiumDiscount >= 30 && f.nav > 0).length;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white">Cornerstone (CLM / CRF)</h2>
          {sellAlerts > 0 && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-red-500/20 text-red-400 border border-red-500/30">
              {sellAlerts} SELL
            </span>
          )}
          {boxAlerts > 0 && sellAlerts === 0 && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400 border border-amber-500/30">
              {boxAlerts} BOX
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-[#4a5070]">
          {lastUpdated && <span>{lastUpdated}</span>}
          <button onClick={fetchData} className="hover:text-white transition-colors" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Box Method reference */}
      <div className="flex items-start gap-2 text-xs text-[#4a5070] bg-[#22263a] rounded-lg p-3">
        <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>
          Box Method: Box at ≥20% premium · Sell at ≥30% · Buy back after RO completion · DRIP always at NAV
        </span>
      </div>

      {loading ? (
        <div className="text-xs text-[#4a5070] text-center py-4">Loading NAV data…</div>
      ) : fetchError ? (
        <div className="text-xs text-red-400 text-center py-4">
          Failed to load — <button onClick={fetchData} className="underline">retry</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {funds.map((f) => (
            <FundCard key={f.ticker} fund={f} onRefresh={fetchData} />
          ))}
        </div>
      )}
    </div>
  );
}
