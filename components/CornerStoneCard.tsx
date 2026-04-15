'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, Info, RefreshCw, Check, ExternalLink, Clock, ChevronDown, ChevronUp } from 'lucide-react';

interface CEFData {
  ticker: string;
  nav: number;
  marketPrice: number;
  premiumDiscount: number;
  navUpdatedAt: string;
  priceUpdatedAt: string;
  source: 'cornerstone' | 'yahoo' | 'cornerstone+yahoo' | 'live' | 'manual' | 'unavailable';
}

type ROStage = 'none' | 'announced' | 'subscription_open' | 'subscription_closed' | 'complete';

interface ROStatus {
  ticker: string;
  status: ROStage;
  notes: string;
  updatedAt: string;
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

const RO_STAGE_META: Record<ROStage, { label: string; color: string; bgColor: string; borderColor: string }> = {
  none:                { label: 'No Active RO',        color: 'text-[#7c82a0]',  bgColor: 'bg-[#2d3248]/60',      borderColor: 'border-[#3d4260]' },
  announced:           { label: 'RO Announced',         color: 'text-amber-400',  bgColor: 'bg-amber-500/10',      borderColor: 'border-amber-500/30' },
  subscription_open:   { label: 'Subscription Open',    color: 'text-orange-400', bgColor: 'bg-orange-500/10',     borderColor: 'border-orange-500/30' },
  subscription_closed: { label: 'Subscription Closed',  color: 'text-blue-400',   bgColor: 'bg-blue-500/10',       borderColor: 'border-blue-500/30' },
  complete:            { label: 'RO Complete',           color: 'text-emerald-400',bgColor: 'bg-emerald-500/10',   borderColor: 'border-emerald-500/30' },
};

const RO_STAGE_ORDER: ROStage[] = ['none', 'announced', 'subscription_open', 'subscription_closed', 'complete'];

function roStrategyGuidance(stage: ROStage, premiumPct: number): { text: string; urgent: boolean } | null {
  if (stage === 'none') return null;

  if (stage === 'announced') {
    if (premiumPct >= 30) return { text: 'RO announced + premium ≥30%: Sell down to ~3 shares and wait for RO completion to buy back.', urgent: true };
    if (premiumPct >= 20) return { text: 'RO announced + premium ≥20%: Consider boxing the position until RO completes.', urgent: true };
    return { text: 'RO announced: Monitor premium — box or sell if premium rises above 20–30%.', urgent: false };
  }
  if (stage === 'subscription_open') {
    if (premiumPct >= 20) return { text: 'Subscription open + elevated premium: Box or reduce position. Avoid buying at premium during subscription.', urgent: true };
    return { text: 'Subscription period active. Participate via DRIP at NAV if subscribed. Avoid buying at market.', urgent: false };
  }
  if (stage === 'subscription_closed') {
    return { text: 'Subscription closed — shares being issued. Wait for RO completion before adding.', urgent: false };
  }
  if (stage === 'complete') {
    return { text: 'RO complete: Buy-back opportunity at or near NAV. Resume normal DRIP and accumulation.', urgent: false };
  }
  return null;
}

function ROStageBadge({ stage }: { stage: ROStage }) {
  const meta = RO_STAGE_META[stage];
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${meta.bgColor} ${meta.color} border ${meta.borderColor}`}>
      {meta.label}
    </span>
  );
}

function ROUpdateForm({ ticker, current, onSave }: { ticker: string; current: ROStatus; onSave: (updated: ROStatus) => void }) {
  const [stage, setStage] = useState<ROStage>(current.status);
  const [notes, setNotes] = useState(current.notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/ro-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, status: stage, notes }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      onSave(data.entry);
    } catch {
      setError('Save failed — try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 pt-2 border-t border-[#2d3248]">
      <div className="text-xs text-[#7c82a0] font-medium">Update RO Status</div>
      <div className="grid grid-cols-1 gap-2">
        {/* Stage selector */}
        <div className="flex flex-wrap gap-1">
          {RO_STAGE_ORDER.map((s) => {
            const meta = RO_STAGE_META[s];
            const selected = stage === s;
            return (
              <button
                key={s}
                onClick={() => setStage(s)}
                className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${
                  selected
                    ? `${meta.bgColor} ${meta.color} ${meta.borderColor}`
                    : 'bg-transparent text-[#4a5070] border-[#3d4260] hover:text-[#7c82a0]'
                }`}
              >
                {meta.label}
              </button>
            );
          })}
        </div>

        {/* Notes field */}
        <input
          type="text"
          placeholder="Notes (optional) — e.g. RO announced Feb 14"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="w-full bg-[#2d3248] border border-[#3d4260] rounded px-2 py-1.5 text-xs text-white placeholder-[#4a5070] focus:outline-none focus:border-blue-500"
        />

        {/* Save button */}
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50 transition-colors"
          >
            <Check className="w-3 h-3" />
            {saving ? 'Saving…' : 'Save'}
          </button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>
    </div>
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

function FundCard({
  fund,
  roStatus,
  onRefresh,
  onROUpdate,
}: {
  fund: CEFData;
  roStatus: ROStatus | null;
  onRefresh: () => void;
  onROUpdate: (updated: ROStatus) => void;
}) {
  const isLive = fund.source !== 'unavailable' && fund.source !== 'manual';
  const [showNavEntry, setShowNavEntry] = useState(fund.source === 'unavailable');
  const [showROForm, setShowROForm] = useState(false);

  const hasNAV = fund.nav > 0;
  const hasPrice = fund.marketPrice > 0;
  const dripEdge = hasNAV && hasPrice ? ((fund.marketPrice - fund.nav) / fund.nav) * 100 : 0;
  const navDays = navAgeDays(fund.navUpdatedAt);
  const navStale = navDays !== null && navDays > 7;

  const roStage: ROStage = roStatus?.status ?? 'none';
  const roMeta = RO_STAGE_META[roStage];
  const roGuidance = hasNAV && hasPrice ? roStrategyGuidance(roStage, fund.premiumDiscount) : null;
  const hasActiveRO = roStage !== 'none';

  return (
    <div className="bg-[#22263a] rounded-xl p-4 space-y-3 border border-[#2d3248]">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-white font-mono">{fund.ticker}</span>
          {hasNAV && hasPrice && <PremiumBadge pct={fund.premiumDiscount} />}
          {isLive && (
            <span className="text-[10px] text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
              ● live
            </span>
          )}
        </div>
        <button
          onClick={() => setShowNavEntry((s) => !s)}
          className={`text-xs px-2 py-1 rounded transition-colors ${showNavEntry ? 'bg-blue-600 text-white' : 'text-[#4a5070] hover:text-white border border-[#3d4260]'}`}
        >
          {showNavEntry ? 'Cancel' : 'Override NAV'}
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

      {/* Premium rule guidance */}
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

      {/* ─── Rights Offering Section ─── */}
      <div className="pt-1 border-t border-[#2d3248] space-y-2">
        {/* RO header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-[#7c82a0] font-medium">Rights Offering</span>
            <ROStageBadge stage={roStage} />
          </div>
          <button
            onClick={() => setShowROForm((s) => !s)}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
              showROForm ? 'bg-blue-600 text-white' : 'text-[#4a5070] hover:text-white border border-[#3d4260]'
            }`}
          >
            {showROForm ? (
              <><ChevronUp className="w-3 h-3" />Cancel</>
            ) : (
              <><ChevronDown className="w-3 h-3" />Update</>
            )}
          </button>
        </div>

        {/* RO notes if any */}
        {roStatus?.notes && (
          <div className="text-xs text-[#7c82a0] italic pl-1">{roStatus.notes}</div>
        )}

        {/* Combined RO + premium strategy guidance */}
        {roGuidance && (
          <div className={`flex items-start gap-1.5 text-xs rounded p-2 ${
            roGuidance.urgent
              ? 'bg-red-500/10 text-red-400 border border-red-500/20'
              : 'bg-blue-500/10 text-blue-300 border border-blue-500/20'
          }`}>
            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span>{roGuidance.text}</span>
          </div>
        )}

        {/* Updated at timestamp for RO */}
        {roStatus?.updatedAt && roStage !== 'none' && (
          <div className="text-xs text-[#4a5070]">
            Status updated {new Date(roStatus.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        )}

        {/* RO update form */}
        {showROForm && (
          <ROUpdateForm
            ticker={fund.ticker}
            current={roStatus ?? { ticker: fund.ticker, status: 'none', notes: '', updatedAt: '' }}
            onSave={(updated) => {
              onROUpdate(updated);
              setShowROForm(false);
            }}
          />
        )}
      </div>

      {/* NAV entry form */}
      {showNavEntry && (
        <NAVEntryForm
          ticker={fund.ticker}
          onSave={() => { setShowNavEntry(false); onRefresh(); }}
        />
      )}
    </div>
  );
}

export function CornerStoneCard() {
  const [funds, setFunds] = useState<CEFData[]>([]);
  const [roStatuses, setROStatuses] = useState<Record<string, ROStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState('');

  const [dataSource, setDataSource] = useState('');
  const [dataDate, setDataDate] = useState('');

  const fetchData = async (forceRefresh = false) => {
    setLoading(true);
    setError(false);
    try {
      const [navRes, roRes] = await Promise.all([
        fetch(forceRefresh ? '/api/cornerstone?refresh=true' : '/api/cornerstone'),
        fetch('/api/ro-status'),
      ]);

      if (!navRes.ok) throw new Error();
      const data = await navRes.json();
      setFunds(data.funds ?? []);
      setLastUpdated(new Date().toLocaleTimeString());
      setDataSource(data.source ?? '');
      if (data.dataDate) {
        const s = String(data.dataDate);
        const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
        setDataDate(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      }

      if (roRes.ok) {
        const roData = await roRes.json();
        const map: Record<string, ROStatus> = {};
        for (const s of (roData.statuses ?? [])) {
          map[s.ticker] = s;
        }
        setROStatuses(map);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 15 minutes — matches server-side cache TTL
    const interval = setInterval(() => fetchData(true), 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleROUpdate = (updated: ROStatus) => {
    setROStatuses((prev) => ({ ...prev, [updated.ticker]: updated }));
  };

  const boxAlerts  = funds.filter((f) => f.nav > 0 && f.premiumDiscount >= 20 && f.premiumDiscount < 30).length;
  const sellAlerts = funds.filter((f) => f.nav > 0 && f.premiumDiscount >= 30).length;
  const staleCount = funds.filter((f) => { const d = navAgeDays(f.navUpdatedAt); return d !== null && d > 7; }).length;
  const activeROCount = Object.values(roStatuses).filter((r) => r.status !== 'none').length;

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
          {activeROCount > 0 && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30">
              {activeROCount} RO Active
            </span>
          )}
          {staleCount > 0 && sellAlerts === 0 && boxAlerts === 0 && activeROCount === 0 && (
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
            <FundCard
              key={f.ticker}
              fund={f}
              roStatus={roStatuses[f.ticker] ?? null}
              onRefresh={() => fetchData(true)}
              onROUpdate={handleROUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
