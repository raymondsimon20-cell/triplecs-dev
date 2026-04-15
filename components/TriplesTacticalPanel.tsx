'use client';

/**
 * Phase 4 — Triple ETF Tactical Engine
 *
 * Rules source: Vol 7 (Triple C strategy guide)
 *   • Bull-market target: ~10% of portfolio in triples
 *   • Correction deployment: ~$100K (or 10% of acct) per 10% drop — up to 30% at -30%
 *   • Trim-at-highs: when collective triples exceed original size, sell back to target
 *   • Preferred spreads: TQQQ / UPRO (3-4 cent even in down markets)
 *   • Hedge pairs: SPXL↔SPXS, TQQQ↔SQQQ, SOXL↔SOXS, FAS↔FAZ, TNA↔SRTY
 */

import { useState, useEffect, useCallback } from 'react';
import {
  TrendingDown, TrendingUp, AlertTriangle, CheckCircle,
  ChevronDown, ChevronUp, RefreshCw, Settings, Zap, Shield,
} from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { HEDGE_SYMBOLS } from '@/lib/classify';
import { fmt$, fmtPct } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IndexData {
  price: number;
  prevClose: number;
  ath: number;
  correctionPct: number;
  dayChangePct: number;
}

interface CorrectionData {
  SPY: IndexData;
  QQQ: IndexData;
  avgCorrectionPct: number;
  athUpdatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


/** Correction zone label based on % off ATH */
function correctionZone(pct: number): { label: string; color: string; bg: string } {
  if (pct <= 5)  return { label: 'Bull Market', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25' };
  if (pct <= 10) return { label: 'Minor Dip (-10%)', color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/25' };
  if (pct <= 20) return { label: 'Correction (-20%)', color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/25' };
  if (pct <= 30) return { label: 'Deep Correction (-30%)', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/25' };
  return { label: 'Bear Market (>30%)', color: 'text-red-500', bg: 'bg-red-600/20 border-red-600/30' };
}

/** Suggested triples deployment tiers based on correction depth */
function deploymentTiers(correctionPct: number, portfolioValue: number) {
  const unitSize = portfolioValue * 0.10; // 10% of portfolio = 1 unit
  const tiers = [
    { threshold: 0,  label: 'Core Position (0–10% drop)',  units: 1, active: correctionPct >= 0 },
    { threshold: 10, label: 'Tier 1 add (10–20% drop)',    units: 1, active: correctionPct >= 10 },
    { threshold: 20, label: 'Tier 2 add (20–30% drop)',    units: 1, active: correctionPct >= 20 },
    { threshold: 30, label: 'Tier 3 add (≥30% drop)',      units: 1, active: correctionPct >= 30 },
  ];

  const activeTiers = tiers.filter((t) => t.active);
  const totalUnits = activeTiers.reduce((s, t) => s + t.units, 0);
  const totalTarget = Math.min(unitSize * totalUnits, portfolioValue * 0.30); // max 30%

  return { tiers, totalTarget, unitSize, activeTiers };
}

// ─── Hedge Pair definitions ───────────────────────────────────────────────────

const HEDGE_PAIRS: { long: string; short: string; label: string }[] = [
  { long: 'SPXL', short: 'SPXS', label: 'S&P 500 3x' },
  { long: 'SPXL', short: 'SPXU', label: 'S&P 500 3x (ProShares)' },
  { long: 'TQQQ', short: 'SQQQ', label: 'Nasdaq 3x' },
  { long: 'SOXL', short: 'SOXS', label: 'Semiconductors 3x' },
  { long: 'FAS',  short: 'FAZ',  label: 'Financials 3x' },
  { long: 'TNA',  short: 'SRTY', label: 'Small-Cap 3x' },
  { long: 'UDOW', short: 'SDOW', label: 'Dow Jones 3x' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Horizontal gradient bar for correction level */
function CorrectionMeter({ pct }: { pct: number }) {
  const clampedPct = Math.min(pct, 40);
  const barWidth = (clampedPct / 40) * 100;

  // Gradient stops: green (0%) → yellow (10%) → orange (20%) → red (30%+)
  return (
    <div className="space-y-1">
      <div className="relative h-4 rounded-full bg-[#22263a] overflow-hidden">
        {/* Color zones */}
        <div className="absolute inset-0 flex">
          <div className="flex-1 bg-emerald-500/20" style={{ maxWidth: '25%' }} />
          <div className="flex-1 bg-yellow-500/20" style={{ maxWidth: '25%' }} />
          <div className="flex-1 bg-orange-500/20" style={{ maxWidth: '25%' }} />
          <div className="flex-1 bg-red-500/20" />
        </div>
        {/* Progress fill */}
        <div
          className="absolute top-0 left-0 h-full rounded-full transition-all duration-500"
          style={{
            width: `${barWidth}%`,
            background: pct <= 5
              ? '#10b981'
              : pct <= 10
              ? '#f59e0b'
              : pct <= 20
              ? '#f97316'
              : '#ef4444',
          }}
        />
        {/* Marker lines at 10%, 20%, 30% */}
        {[10, 20, 30].map((mark) => (
          <div
            key={mark}
            className="absolute top-0 bottom-0 w-px bg-[#0f1117]/60"
            style={{ left: `${(mark / 40) * 100}%` }}
          />
        ))}
      </div>
      {/* Labels */}
      <div className="flex justify-between text-[10px] text-[#4a5070]">
        <span>0% (Bull)</span>
        <span>10%</span>
        <span>20%</span>
        <span>30%</span>
        <span>40%+</span>
      </div>
    </div>
  );
}

/** Section for market correction monitor + ATH configuration */
function CorrectionMonitorSection({
  data,
  onRefresh,
  refreshing,
}: {
  data: CorrectionData | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [showATHForm, setShowATHForm] = useState(false);
  const [spyATH, setSpyATH] = useState('');
  const [qqqATH, setQqqATH] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setSpyATH(data.SPY.ath.toFixed(2));
      setQqqATH(data.QQQ.ath.toFixed(2));
    }
  }, [data]);

  const saveATH = async () => {
    setSaving(true);
    try {
      await fetch('/api/market-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ SPY: parseFloat(spyATH), QQQ: parseFloat(qqqATH) }),
      });
      setShowATHForm(false);
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return (
      <div className="py-6 text-center text-[#7c82a0] text-sm">
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
        Loading market data…
      </div>
    );
  }

  const zone = correctionZone(data.avgCorrectionPct);

  return (
    <div className="space-y-4">
      {/* Zone badge + refresh */}
      <div className="flex items-center justify-between">
        <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${zone.bg} ${zone.color}`}>
          {data.avgCorrectionPct <= 5 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          {zone.label} — {data.avgCorrectionPct.toFixed(1)}% avg off ATH
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowATHForm((v) => !v)}
            className="text-[#7c82a0] hover:text-white transition-colors"
            title="Configure ATH"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-[#7c82a0] hover:text-white transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ATH config form */}
      {showATHForm && (
        <div className="bg-[#22263a] rounded-lg p-3 space-y-2 border border-[#2d3248]">
          <p className="text-xs text-[#7c82a0]">Set All-Time Highs (used to compute drawdown)</p>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-[#7c82a0] block mb-1">SPY ATH</label>
              <input
                type="number"
                value={spyATH}
                onChange={(e) => setSpyATH(e.target.value)}
                className="w-full bg-[#1a1d27] border border-[#3d4260] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-[#7c82a0] block mb-1">QQQ ATH</label>
              <input
                type="number"
                value={qqqATH}
                onChange={(e) => setQqqATH(e.target.value)}
                className="w-full bg-[#1a1d27] border border-[#3d4260] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-end gap-1">
              <button
                onClick={saveATH}
                disabled={saving}
                className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => setShowATHForm(false)}
                className="text-[#7c82a0] hover:text-white px-2 py-1 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
          <p className="text-[10px] text-[#4a5070]">
            Last updated: {new Date(data.athUpdatedAt).toLocaleDateString()}
          </p>
        </div>
      )}

      {/* Correction meter */}
      <CorrectionMeter pct={data.avgCorrectionPct} />

      {/* SPY / QQQ cards */}
      <div className="grid grid-cols-2 gap-3">
        {(['SPY', 'QQQ'] as const).map((sym) => {
          const d = data[sym];
          const isUp = d.dayChangePct >= 0;
          return (
            <div key={sym} className="bg-[#22263a] rounded-lg p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white font-mono">{sym}</span>
                <span className={`text-xs font-mono ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmtPct(d.dayChangePct)} today
                </span>
              </div>
              <div className="text-lg font-bold text-white font-mono">${d.price.toFixed(2)}</div>
              <div className="text-[10px] text-[#7c82a0]">
                ATH: ${d.ath.toFixed(2)} &nbsp;•&nbsp;
                <span className={d.correctionPct > 10 ? 'text-orange-400' : 'text-[#7c82a0]'}>
                  {d.correctionPct.toFixed(1)}% off high
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Deployment calculator — how much to put into triples based on correction level */
function DeploymentCalculatorSection({
  correctionPct,
  totalValue,
  currentTriplesValue,
}: {
  correctionPct: number;
  totalValue: number;
  currentTriplesValue: number;
}) {
  const { tiers, totalTarget, unitSize } = deploymentTiers(correctionPct, totalValue);
  const alreadyDeployed = currentTriplesValue;
  const additionalNeeded = Math.max(0, totalTarget - alreadyDeployed);
  const triplesPortfolioPct = totalValue > 0 ? (currentTriplesValue / totalValue) * 100 : 0;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[#7c82a0]">
        Based on Vol 7 rules: deploy ~10% of portfolio per 10% correction tier, up to 30% max.
        Each unit ≈ {fmt$(unitSize)}.
      </p>

      {/* Tier grid */}
      <div className="space-y-1.5">
        {tiers.map((tier, i) => (
          <div
            key={i}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs transition-colors ${
              tier.active
                ? 'bg-blue-500/15 border border-blue-500/30 text-white'
                : 'bg-[#22263a] text-[#4a5070]'
            }`}
          >
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${tier.active ? 'bg-blue-400' : 'bg-[#3d4260]'}`} />
            <span className="flex-1">{tier.label}</span>
            <span className="font-mono font-semibold">{fmt$(unitSize)}</span>
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="bg-[#22263a] rounded-lg p-3 space-y-2">
        <div className="flex justify-between text-xs">
          <span className="text-[#7c82a0]">Target triples allocation</span>
          <span className="text-white font-mono font-semibold">{fmt$(totalTarget)}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-[#7c82a0]">Currently deployed</span>
          <span className="font-mono" style={{ color: triplesPortfolioPct > 30 ? '#f87171' : '#a3e635' }}>
            {fmt$(alreadyDeployed)} ({triplesPortfolioPct.toFixed(1)}%)
          </span>
        </div>
        <div className="border-t border-[#3d4260] pt-2 flex justify-between text-xs">
          <span className="text-[#7c82a0]">
            {additionalNeeded > 0 ? 'Additional to deploy' : 'Surplus above target'}
          </span>
          <span className={`font-mono font-semibold ${additionalNeeded > 0 ? 'text-blue-400' : 'text-orange-400'}`}>
            {additionalNeeded > 0 ? fmt$(additionalNeeded) : fmt$(alreadyDeployed - totalTarget)}
          </span>
        </div>
      </div>

      {/* Leverage note */}
      <p className="text-[10px] text-[#4a5070]">
        ⚡ Remember: $100K in UPRO/SPXL = $300K S&P 500 exposure. Preferred for large lots: TQQQ, UPRO (tight 3-4¢ spreads).
      </p>
    </div>
  );
}

/** Trim-at-highs alert — compares current triples value to configured target */
function TrimAlertsSection({
  positions,
  totalValue,
  targetPct = 10,
}: {
  positions: EnrichedPosition[];
  totalValue: number;
  targetPct?: number;
}) {
  const [configPct, setConfigPct] = useState(targetPct);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(targetPct));

  const triplePositions = positions.filter((p) => p.pillar === 'triples');
  const totalTriplesValue = triplePositions.reduce((s, p) => s + p.marketValue, 0);
  const targetValue = totalValue * (configPct / 100);
  const excessValue = totalTriplesValue - targetValue;
  const isOverTarget = excessValue > 0;
  const triplesPortfolioPct = totalValue > 0 ? (totalTriplesValue / totalValue) * 100 : 0;

  if (triplePositions.length === 0) {
    return (
      <p className="text-xs text-[#4a5070] py-2">No triple ETF positions in this account.</p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Target configuration */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[#7c82a0]">Target allocation:</span>
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-14 bg-[#22263a] border border-[#3d4260] rounded px-1.5 py-0.5 text-white text-xs focus:outline-none focus:border-blue-500"
            />
            <span className="text-[#7c82a0]">%</span>
            <button
              onClick={() => { setConfigPct(Number(draft)); setEditing(false); }}
              className="text-blue-400 hover:text-blue-300 ml-1"
            >✓</button>
            <button onClick={() => setEditing(false)} className="text-[#7c82a0] hover:text-white">✕</button>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="font-semibold text-white hover:text-blue-400 underline underline-offset-2 decoration-dashed"
          >
            {configPct}%
          </button>
        )}
        <span className="text-[#4a5070]">= {fmt$(targetValue)}</span>
      </div>

      {/* Overall status banner */}
      <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
        isOverTarget
          ? 'bg-orange-500/10 border-orange-500/25 text-orange-300'
          : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
      }`}>
        {isOverTarget
          ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          : <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
        <div>
          <span className="font-semibold">
            {isOverTarget
              ? `Trim required — ${fmt$(excessValue)} above target`
              : `Within target — ${fmt$(Math.abs(excessValue))} below ceiling`}
          </span>
          <span className="ml-1 opacity-70">
            (Current: {fmt$(totalTriplesValue)} / {triplesPortfolioPct.toFixed(1)}%)
          </span>
        </div>
      </div>

      {/* Per-position trim guidance */}
      <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
              <th className="text-left px-3 py-2">Symbol</th>
              <th className="text-right px-3 py-2">Shares</th>
              <th className="text-right px-3 py-2">Value</th>
              <th className="text-right px-3 py-2">% Port</th>
              <th className="text-right px-3 py-2">Gain/Loss</th>
              <th className="text-right px-3 py-2">Today</th>
              <th className="text-right px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2d3248]">
            {triplePositions
              .sort((a, b) => b.marketValue - a.marketValue)
              .map((pos) => {
                const gl = pos.gainLoss;
                const today = pos.todayGainLoss ?? 0;
                // Pro-rata trim suggestion: each position trims proportional to its share of total
                const posPct = totalTriplesValue > 0 ? pos.marketValue / totalTriplesValue : 0;
                const trimForPos = isOverTarget ? excessValue * posPct : 0;
                const pricePerShare = pos.quote?.lastPrice ?? pos.averagePrice;
                const sharesToTrim = pricePerShare > 0 ? Math.floor(trimForPos / pricePerShare) : 0;

                return (
                  <tr key={pos.instrument.symbol} className="hover:bg-[#22263a]/60">
                    <td className="px-3 py-2 font-mono font-semibold text-white">
                      {pos.instrument.symbol}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[#e8eaf0]">
                      {pos.longQuantity.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-white">
                      {fmt$(pos.marketValue)}
                    </td>
                    <td className="px-3 py-2 text-right text-[#7c82a0]">
                      {pos.portfolioPercent.toFixed(1)}%
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmt$(gl)}
                      <div className="opacity-60">{pos.gainLossPercent >= 0 ? '+' : ''}{pos.gainLossPercent.toFixed(1)}%</div>
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${today >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {today !== 0 ? fmt$(today) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isOverTarget && sharesToTrim > 0 ? (
                        <span className="text-orange-400 font-semibold">
                          Sell ~{sharesToTrim} sh
                          <div className="text-[10px] opacity-70">{fmt$(trimForPos)}</div>
                        </span>
                      ) : (
                        <span className="text-emerald-400">Hold</span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {isOverTarget && (
        <p className="text-[10px] text-[#7c82a0]">
          Vol 7: "When triples collectively rise above original size, trim back — sell from whichever triple is UP that day."
          Trim suggestions above are pro-rata; prefer trimming whichever position has the best gain today.
        </p>
      )}
    </div>
  );
}

/** Volatility decay tracker — compares triple ETF performance vs implied 1x index */
function VolatilityDecaySection({ positions }: { positions: EnrichedPosition[] }) {
  const triplePositions = positions.filter((p) => p.pillar === 'triples');

  if (triplePositions.length === 0) {
    return <p className="text-xs text-[#4a5070] py-2">No triple ETF positions in this account.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-[#7c82a0]">
        Leveraged ETFs lose value over time due to daily rebalancing (volatility decay).
        Watch for underperformance vs the underlying index — signal to trim and rotate.
      </p>
      <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
              <th className="text-left px-3 py-2">Symbol</th>
              <th className="text-right px-3 py-2">Avg Price</th>
              <th className="text-right px-3 py-2">Current</th>
              <th className="text-right px-3 py-2">Total G/L</th>
              <th className="text-right px-3 py-2">G/L %</th>
              <th className="text-right px-3 py-2">Today</th>
              <th className="text-right px-3 py-2">Decay Risk</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2d3248]">
            {triplePositions
              .sort((a, b) => b.marketValue - a.marketValue)
              .map((pos) => {
                const gl = pos.gainLoss;
                const glPct = pos.gainLossPercent;
                const today = pos.todayGainLoss ?? 0;
                const currentPrice = pos.quote?.lastPrice ?? 0;

                // Heuristic: if G/L% < -15% after holding, flag high decay risk
                const decayRisk = glPct < -15
                  ? { label: 'High', color: 'text-red-400' }
                  : glPct < 0
                  ? { label: 'Moderate', color: 'text-orange-400' }
                  : { label: 'Low', color: 'text-emerald-400' };

                return (
                  <tr key={pos.instrument.symbol} className="hover:bg-[#22263a]/60">
                    <td className="px-3 py-2">
                      <div className="font-mono font-semibold text-white">{pos.instrument.symbol}</div>
                      <div className="text-[10px] text-[#7c82a0]">{pos.longQuantity} shares</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[#7c82a0]">
                      ${pos.averagePrice.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-white">
                      ${currentPrice > 0 ? currentPrice.toFixed(2) : '—'}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmt$(gl)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${glPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {glPct >= 0 ? '+' : ''}{glPct.toFixed(1)}%
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${today >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {today !== 0 ? fmt$(today) : '—'}
                    </td>
                    <td className={`px-3 py-2 text-right font-semibold ${decayRisk.color}`}>
                      {decayRisk.label}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-[#4a5070]">
        Decay risk is flagged when total G/L is below -15% from cost basis. Higher volatility periods amplify decay.
        Consider rotating to the underlying ETF (SPY, QQQ) when decay is severe.
      </p>
    </div>
  );
}

/** Hedge pair monitor — shows balance between long and short triple ETFs */
function HedgePairSection({ positions }: { positions: EnrichedPosition[] }) {
  const posMap = new Map(positions.map((p) => [p.instrument.symbol, p]));

  // Find all active pairs (where at least one side is held)
  const activePairs = HEDGE_PAIRS.filter(
    (pair) => posMap.has(pair.long) || posMap.has(pair.short),
  ).filter(
    // Deduplicate: SPXL↔SPXS and SPXL↔SPXU could both appear; only show unique pairs held
    (pair, idx, arr) =>
      arr.findIndex((p) => p.long === pair.long && p.short === pair.short) === idx,
  );

  // Also show any un-paired hedge positions
  const hedgePositions = positions.filter((p) => HEDGE_SYMBOLS.has(p.instrument.symbol));
  const pairedShortSymbols = new Set(activePairs.map((p) => p.short));
  const unpairedHedges = hedgePositions.filter(
    (p) => !pairedShortSymbols.has(p.instrument.symbol),
  );

  if (activePairs.length === 0 && unpairedHedges.length === 0) {
    return (
      <div className="py-3 text-center space-y-1">
        <p className="text-xs text-[#7c82a0]">No hedge positions detected.</p>
        <p className="text-[10px] text-[#4a5070]">
          Vol 7: "Hedge pairs are optional — used during high-volatility periods or bear markets to reduce net delta."
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {activePairs.map((pair) => {
        const longPos = posMap.get(pair.long);
        const shortPos = posMap.get(pair.short);
        const longVal = longPos?.marketValue ?? 0;
        const shortVal = shortPos?.marketValue ?? 0;
        const net = longVal - shortVal;
        const totalPairVal = longVal + shortVal;
        const longPct = totalPairVal > 0 ? (longVal / totalPairVal) * 100 : 0;

        return (
          <div key={`${pair.long}-${pair.short}`} className="bg-[#22263a] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">{pair.label}</span>
              <span className={`text-xs font-mono ${net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                Net: {fmt$(net)}
              </span>
            </div>

            {/* Long / Short balance bar */}
            <div className="h-2 rounded-full bg-[#1a1d27] overflow-hidden flex">
              <div
                className="bg-emerald-500 h-full transition-all"
                style={{ width: `${longPct}%` }}
              />
              <div
                className="bg-red-500 h-full transition-all"
                style={{ width: `${100 - longPct}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-emerald-400 font-mono font-semibold">
                  {pair.long} (Long) {longPos ? '' : <span className="text-[#4a5070]">— not held</span>}
                </div>
                <div className="text-white">{fmt$(longVal)}</div>
                {longPos && (
                  <div className={longPos.gainLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {fmt$(longPos.gainLoss)} ({longPos.gainLossPercent >= 0 ? '+' : ''}{longPos.gainLossPercent.toFixed(1)}%)
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-red-400 font-mono font-semibold">
                  {pair.short} (Short) {shortPos ? '' : <span className="text-[#4a5070]">— not held</span>}
                </div>
                <div className="text-white">{fmt$(shortVal)}</div>
                {shortPos && (
                  <div className={shortPos.gainLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {fmt$(shortPos.gainLoss)} ({shortPos.gainLossPercent >= 0 ? '+' : ''}{shortPos.gainLossPercent.toFixed(1)}%)
                  </div>
                )}
              </div>
            </div>

            {totalPairVal > 0 && (
              <p className="text-[10px] text-[#4a5070]">
                {longPct.toFixed(0)}% long / {(100 - longPct).toFixed(0)}% short
                {net > 0.5 * totalPairVal && ' — heavily net long (bull exposure dominant)'}
                {net < -0.5 * totalPairVal && ' — heavily net short (hedge dominant)'}
              </p>
            )}
          </div>
        );
      })}

      {unpairedHedges.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-[#7c82a0]">Standalone hedges (no matching long triple):</p>
          {unpairedHedges.map((pos) => (
            <div key={pos.instrument.symbol} className="flex justify-between text-xs px-2 py-1.5 bg-[#22263a] rounded">
              <span className="font-mono text-red-400 font-semibold">{pos.instrument.symbol}</span>
              <span className="text-white">{fmt$(pos.marketValue)}</span>
              <span className={pos.gainLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {fmt$(pos.gainLoss)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
}

const SECTIONS = [
  { id: 'correction', label: 'Market Correction Monitor', icon: TrendingDown },
  { id: 'deployment', label: 'Triple Deployment Calculator', icon: Zap },
  { id: 'trim', label: 'Trim-at-Highs Alerts', icon: AlertTriangle },
  { id: 'decay', label: 'Volatility Decay Tracker', icon: TrendingUp },
  { id: 'hedges', label: 'Hedge Pair Monitor', icon: Shield },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function TriplesTacticalPanel({ positions, totalValue }: Props) {
  const [correctionData, setCorrectionData] = useState<CorrectionData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Set<SectionId>>(new Set(['correction', 'trim']));

  const fetchCorrection = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/market-correction');
      if (res.ok) {
        const data = await res.json();
        setCorrectionData(data);
      }
    } catch {
      // fail silently — non-critical
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchCorrection();
    const interval = setInterval(fetchCorrection, 120_000); // refresh every 2 min
    return () => clearInterval(interval);
  }, [fetchCorrection]);

  const toggleSection = (id: SectionId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const triplePositions = positions.filter((p) => p.pillar === 'triples');
  const currentTriplesValue = triplePositions.reduce((s, p) => s + p.marketValue, 0);
  const correctionPct = correctionData?.avgCorrectionPct ?? 0;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-blue-400" />
          <h2 className="text-sm font-semibold text-white">Triple ETF Tactical Engine</h2>
          <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full border border-blue-500/30">
            Phase 4
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#4a5070]">
          {triplePositions.length > 0 && (
            <span>
              {triplePositions.length} triple{triplePositions.length !== 1 ? 's' : ''} held •{' '}
              {fmt$(currentTriplesValue)} deployed
            </span>
          )}
        </div>
      </div>

      {/* Accordion sections */}
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const isOpen = expanded.has(id);
        return (
          <div key={id} className="border border-[#2d3248] rounded-lg overflow-hidden">
            <button
              onClick={() => toggleSection(id)}
              className="w-full flex items-center justify-between px-4 py-3 bg-[#22263a] hover:bg-[#2a2f45] transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-sm font-medium text-white">{label}</span>
              </div>
              {isOpen ? (
                <ChevronUp className="w-4 h-4 text-[#7c82a0]" />
              ) : (
                <ChevronDown className="w-4 h-4 text-[#7c82a0]" />
              )}
            </button>

            {isOpen && (
              <div className="px-4 py-4">
                {id === 'correction' && (
                  <CorrectionMonitorSection
                    data={correctionData}
                    onRefresh={fetchCorrection}
                    refreshing={refreshing}
                  />
                )}
                {id === 'deployment' && (
                  <DeploymentCalculatorSection
                    correctionPct={correctionPct}
                    totalValue={totalValue}
                    currentTriplesValue={currentTriplesValue}
                  />
                )}
                {id === 'trim' && (
                  <TrimAlertsSection
                    positions={positions}
                    totalValue={totalValue}
                  />
                )}
                {id === 'decay' && (
                  <VolatilityDecaySection positions={positions} />
                )}
                {id === 'hedges' && (
                  <HedgePairSection positions={positions} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Vol 7 strategy reminder */}
      <div className="text-[10px] text-[#4a5070] border-t border-[#2d3248] pt-3">
        Vol 7 strategy: Bull target 10% • Deploy +10% per tier at 10/20/30% corrections • Trim when triples rise above original size • After rally, rotate income funds back in.
      </div>
    </div>
  );
}
