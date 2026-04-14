'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, Info, RefreshCw, Edit3, Check } from 'lucide-react';

interface CEFData {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  lastUpdated: string;
  source: 'cefconnect' | 'manual' | 'unavailable';
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

function ManualEntry({ ticker, onSave }: { ticker: string; onSave: () => void }) {
  const [nav, setNav] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!nav || !price) return;
    setSaving(true);
    await fetch('/api/cornerstone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, nav: parseFloat(nav), marketPrice: parseFloat(price) }),
    });
    setSaving(false);
    onSave();
  };

  return (
    <div className="flex items-center gap-2 mt-2">
      <input
        type="number"
        step="0.01"
        placeholder="NAV"
        value={nav}
        onChange={(e) => setNav(e.target.value)}
        className="w-20 bg-[#2d3248] border border-[#3d4260] rounded px-2 py-1 text-xs text-white"
      />
      <input
        type="number"
        step="0.01"
        placeholder="Price"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        className="w-20 bg-[#2d3248] border border-[#3d4260] rounded px-2 py-1 text-xs text-white"
      />
      <button
        onClick={save}
        disabled={saving}
        className="p-1 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
      >
        <Check className="w-3 h-3" />
      </button>
    </div>
  );
}

function FundCard({ fund, onRefresh }: { fund: CEFData; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false);

  const dripAdvantage = fund.nav > 0 && fund.marketPrice > 0
    ? ((fund.marketPrice - fund.nav) / fund.nav) * 100
    : 0;

  const isAvailable = fund.source !== 'unavailable' && fund.nav > 0;

  return (
    <div className="bg-[#22263a] rounded-xl p-4 space-y-3 border border-[#2d3248]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold text-white font-mono">{fund.ticker}</span>
          {isAvailable && <PremiumBadge pct={fund.premiumDiscount} />}
          {fund.source === 'manual' && (
            <span className="text-xs text-[#4a5070]">manual</span>
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

      {isAvailable ? (
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
      ) : (
        <div className="text-xs text-[#4a5070]">
          NAV data unavailable — enter manually below
        </div>
      )}

      {/* Rule guidance */}
      {isAvailable && (
        <div className="text-xs text-[#7c82a0] space-y-1 pt-1 border-t border-[#2d3248]">
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
        <ManualEntry ticker={fund.ticker} onSave={() => { setEditing(false); onRefresh(); }} />
      )}
    </div>
  );
}

export function CornerStoneCard() {
  const [funds, setFunds] = useState<CEFData[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/cornerstone');
      const data = await res.json();
      setFunds(data.funds ?? []);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const boxAlerts = funds.filter((f) => f.premiumDiscount >= 20).length;
  const sellAlerts = funds.filter((f) => f.premiumDiscount >= 30).length;

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
          <button onClick={fetchData} className="hover:text-white transition-colors">
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
