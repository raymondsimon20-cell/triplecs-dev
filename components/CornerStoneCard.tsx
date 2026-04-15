'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, Info, RefreshCw, Check, ExternalLink, Clock } from 'lucide-react';

interface CEFData {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  navUpdatedAt: string;
  priceUpdatedAt: string;
  source: 'live' | 'manual' | 'unavailable';
}

function fmt$(n: number) { return `$${n.toFixed(2)}`; }

function navAgeDays(navUpdatedAt: string): number | null {
  if (!navUpdatedAt) return null;
  return Math.floor((Date.now() - new Date(navUpdatedAt).getTime()) / 86_400_000);
}

function NavAgeBadge({ navUpdatedAt }: { navUpdatedAt: string }) {
  const days = navAgeDays(navUpdatedAt);
  if (days === null) return null;
  if (days === 0) return <span className="text-xs text-emerald-400">NAV updated today</span>;
  if (days <= 7)  return <span className="text-xs text-emerald-400">NAV {days}d ago</span>;
  if (days <= 14) return <span className="text-xs text-amber-400 flex items-center gap-1"><Clock className="w-3 h-3" />{days}d ago — update NAV</span>;
  return <span className="text-xs text-red-400 flex items-center gap-1"><Clock className="w-3 h-3" />{days}d ago — NAV stale</span>;
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

function NAVEntryForm({ ticker, onSave }: { ticker: string; onSave: () => void }) {
  const [nav, setNav] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const n = parseFloat(nav);
    if (!n || n <= 0) { setError('Enter a valid NAV'); return; }
    setError('');
    setSaving(true);
    try {
      const res = await fetch('/api/cornerstone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, nav: n }),
      });
      if (!res.ok) throw new Error('Save failed');
      onSave();
    } catch {
      setError('Save failed — try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 pt-2 border-t border-[#2d3248]">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#7c82a0]">Enter NAV per share</span>
        <a
          href={`https://www.cefconnect.com/fund/${ticker}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
        >
          Look up on CEF Connect <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-[#4a5070]">$</span>
        <input
          type="number"
          step="0.01"
          placeholder="e.g. 7.42"
          value={nav}
          onChange={(e) => setNav(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="flex-1 bg-[#2d3248] border border-[#3d4260] rounded px-2 py-1.5 text-sm text-white placeholder-[#4a5070] focus:outline-none focus:border-blue-500"
          autoFocus
        />
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50 transition-colors"
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
  const [showEntry, setShowEntry] = useState(fund.source === 'unavailable');
  const hasNAV = fund.nav > 0;
  const hasPrice = fund.marketPrice > 0;
  const dripEdge = hasNAV && hasPrice ? ((fund.marketPrice - fund.nav) / fund.nav) * 100 : 0;
  const navDays = navAgeDays(fund.navUpdatedAt);
  const navStale = navDays !== null && navDays > 7;

  return (
    <div className="bg-[#22263a] rounded-xl p-4 space-y-3 border border-[#2d3248]">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-white font-mono">{fund.ticker}</span>
          {hasNAV && hasPrice && <PremiumBadge pct={fund.premiumDiscount} />}
        </div>
        <button
          onClick={() => setShowEntry((s) => !s)}
          className={`text-xs px-2 py-1 rounded transition-colors ${showEntry ? 'bg-blue-600 text-white' : 'text-[#4a5070] hover:text-white border border-[#3d4260]'}`}
        >
          {showEntry ? 'Cancel' : 'Update NAV'}
        </button>
      </div>

      {/* Data grid */}
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <div className="text-xs text-[#7c82a0]">Market Price</div>
          <div className="text-base font-mono font-semibold text-white">
            {hasPrice ? fmt$(fund.marketPrice) : '—'}
          </div>
          <div className="text-xs text-[#4a5070]">NASDAQ live</div>
        </div>
        <div>
          <div className="text-xs text-[#7c82a0]">NAV</div>
          <div className={`text-base font-mono font-semibold ${hasNAV ? (navStale ? 'text-amber-400' : 'text-white') : 'text-[#4a5070]'}`}>
            {hasNAV ? fmt$(fund.nav) : '—'}
          </div>
          <div className="text-xs text-[#4a5070]">
            {hasNAV ? <NavAgeBadge navUpdatedAt={fund.navUpdatedAt} /> : 'not set'}
          </div>
        </div>
        <div>
          <div className="text-xs text-[#7c82a0]">DRIP Edge</div>
          <div className={`text-base font-mono font-semibold ${hasNAV && hasPrice ? 'text-emerald-400' : 'text-[#4a5070]'}`}>
            {hasNAV && hasPrice ? `+${dripEdge.toFixed(1)}%` : '—'}
          </div>
          <div className="text-xs text-[#4a5070]">vs price</div>
        </div>
      </div>

      {/* Rule guidance */}
      {hasNAV && hasPrice && (
        <div className="text-xs pt-1 border-t border-[#2d3248]">
          {fund.premiumDiscount >= 30 && (
            <div className="flex items-center gap-1.5 text-red-400">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
              Premium ≥30%: Sell signal — consider selling &amp; waiting for RO completion
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

      {/* NAV entry form */}
      {showEntry && (
        <NAVEntryForm
          ticker={fund.ticker}
          onSave={() => { setShowEntry(false); onRefresh(); }}
        />
      )}
    </div>
  );
}

export function CornerStoneCard() {
  const [funds, setFunds] = useState<CEFData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState('');

  const [dataSource, setDataSource] = useState('');
  const [dataDate, setDataDate] = useState('');

  const fetchData = async (forceRefresh = false) => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(forceRefresh ? '/api/cornerstone?refresh=true' : '/api/cornerstone');
      if (!res.ok) throw new Error();
      const data = await res.json();
      setFunds(data.funds ?? []);
      setLastUpdated(new Date().toLocaleTimeString());
      setDataSource(data.source ?? '');
      if (data.dataDate) {
        // Format YYYYMMDD → "Apr 10"
        const s = String(data.dataDate);
        const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
        setDataDate(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const boxAlerts  = funds.filter((f) => f.nav > 0 && f.premiumDiscount >= 20 && f.premiumDiscount < 30).length;
  const sellAlerts = funds.filter((f) => f.nav > 0 && f.premiumDiscount >= 30).length;
  const staleCount = funds.filter((f) => { const d = navAgeDays(f.navUpdatedAt); return d !== null && d > 7; }).length;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
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
          {staleCount > 0 && sellAlerts === 0 && boxAlerts === 0 && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-amber-500/10 text-amber-500 border border-amber-500/20">
              NAV needs update
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-[#4a5070]">
          {dataDate && dataSource === 'cornerstone-official' && (
            <span className="text-emerald-600">● cornerstone {dataDate}</span>
          )}
          {dataSource === 'yahoo-finance' && <span className="text-blue-500">● yahoo</span>}
          {dataSource === 'cornerstone+yahoo' && <span className="text-blue-400">● cornerstone+yahoo</span>}
          {lastUpdated && <span>{lastUpdated}</span>}
          <button onClick={() => fetchData(true)} className="hover:text-white transition-colors" title="Force refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Strategy reminder */}
      <div className="flex items-start gap-2 text-xs text-[#4a5070] bg-[#22263a] rounded-lg p-3">
        <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>
          Box Method: Box at ≥20% premium · Sell at ≥30% · Buy back after RO completion · DRIP always at NAV
          &nbsp;·&nbsp;
          <span className="text-[#5a6070]">NAV updates weekly — enter it once per week from{' '}
            <a href="https://www.cefconnect.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
              cefconnect.com
            </a>
          </span>
        </span>
      </div>

      {/* Cards */}
      {loading ? (
        <div className="text-xs text-[#4a5070] text-center py-4">Loading…</div>
      ) : error ? (
        <div className="text-xs text-red-400 text-center py-4">
          Failed to load — <button onClick={() => fetchData(true)} className="underline">retry</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {funds.map((f) => (
            <FundCard key={f.ticker} fund={f} onRefresh={() => fetchData(true)} />
          ))}
        </div>
      )}
    </div>
  );
}
