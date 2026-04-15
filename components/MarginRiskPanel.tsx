'use client';

/**
 * Phase 3 — Margin & Risk Intelligence
 *
 * Based on Vol 3 (margin rules) and Vol 7 (Triple C's strategy):
 * - Three-tier margin alerts: 20% warn → 30% critical → 50% emergency
 * - Position concentration monitor with trim reminders
 * - Margin interest vs dividend income coverage
 * - Fund family concentration cap (Yieldmax, Defiance, Roundhill, RexShares)
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle, AlertCircle, TrendingDown, DollarSign, ChevronDown, ChevronUp } from 'lucide-react';
import { getFundFamilyConcentrations } from '@/lib/classify';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { fmt$, fmtDollar } from '@/lib/utils';

interface Props {
  equity: number;
  marginBalance: number;
  totalValue: number;
  positions: EnrichedPosition[];
  dividendsAnnual: number;   // from /api/dividends
  marginRate?: number;        // e.g. 0.0775 for 7.75% (decimal, from settings)
  familyCapPct?: number;      // fund family concentration cap (default 25%)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


// ─── Section 1: Three-tier Margin Meter ───────────────────────────────────────

function MarginMeter3({ equity, marginBalance }: { equity: number; marginBalance: number }) {
  const margin = Math.abs(marginBalance);
  const total = equity + margin;
  const pct = total > 0 ? (margin / total) * 100 : 0;

  const { color, bgColor, label, zone } =
    pct > 50 ? { color: '#ef4444', bgColor: 'bg-red-500/20', label: 'EMERGENCY — Reduce Now', zone: 'emergency' } :
    pct > 30 ? { color: '#ef4444', bgColor: 'bg-red-500/10', label: 'CRITICAL — Above 30% Target', zone: 'critical' } :
    pct > 20 ? { color: '#f97316', bgColor: 'bg-orange-500/10', label: 'WARNING — Approaching Limit', zone: 'warn' } :
               { color: '#22c55e', bgColor: 'bg-emerald-500/10', label: 'Healthy — Below 20%', zone: 'ok' };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">Margin Usage</span>
        <span className="text-sm font-bold" style={{ color }}>
          {pct.toFixed(1)}%
        </span>
      </div>

      {/* Bar */}
      <div className="relative h-3 bg-[#2d3248] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }}
        />
        {/* Zone markers */}
        <div className="absolute top-0 bottom-0 w-0.5 bg-orange-400/70" style={{ left: '20%' }} title="20% warning" />
        <div className="absolute top-0 bottom-0 w-0.5 bg-red-400/70" style={{ left: '30%' }} title="30% critical" />
        <div className="absolute top-0 bottom-0 w-0.5 bg-red-600/70" style={{ left: '50%' }} title="50% emergency max" />
      </div>

      {/* Zone labels */}
      <div className="flex justify-between text-xs text-[#4a5070]">
        <span className="text-emerald-600">Safe</span>
        <span className="text-orange-500">20% warn</span>
        <span className="text-red-400">30% critical</span>
        <span className="text-red-600">50% MAX</span>
      </div>

      {/* Status badge */}
      <div className={`rounded-lg px-3 py-2 text-xs font-medium ${bgColor}`} style={{ color }}>
        {label}
        {pct > 20 && pct <= 50 && (
          <span className="ml-2 font-normal opacity-80">
            — target is below 30%, use less than half your purchasing power (Vol 3)
          </span>
        )}
      </div>

      {/* Dollar breakdown */}
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="bg-[#22263a] rounded-lg p-2">
          <div className="text-[#4a5070]">Equity</div>
          <div className="text-white font-mono font-medium">{fmt$(equity)}</div>
        </div>
        <div className="bg-[#22263a] rounded-lg p-2">
          <div className="text-[#4a5070]">Margin Used</div>
          <div className="font-mono font-medium" style={{ color }}>{fmt$(margin)}</div>
        </div>
        <div className="bg-[#22263a] rounded-lg p-2">
          <div className="text-[#4a5070]">Total Assets</div>
          <div className="text-white font-mono font-medium">{fmt$(total)}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Section 2: Margin Interest vs Dividend Coverage ─────────────────────────

function InterestCoverageSection({
  marginBalance,
  dividendsAnnual,
  marginRate,
}: {
  marginBalance: number;
  dividendsAnnual: number;
  marginRate: number;
}) {
  const [rate, setRate] = useState((marginRate * 100).toFixed(2));
  const rateNum = Math.max(0, parseFloat(rate) || 0) / 100;

  const margin = Math.abs(marginBalance);
  const annualInterest = margin * rateNum;
  const monthlyInterest = annualInterest / 12;
  const monthlyDividends = dividendsAnnual / 12;
  const coverageRatio = monthlyInterest > 0 ? monthlyDividends / monthlyInterest : Infinity;
  const isCovered = coverageRatio >= 1;
  const surplus = monthlyDividends - monthlyInterest;

  return (
    <div className="space-y-3">
      {/* Header with rate input */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">Margin Interest vs Dividends</span>
        <div className="flex items-center gap-1 text-xs text-[#7c82a0]">
          <span>Rate:</span>
          <input
            type="number"
            step="0.25"
            min="0"
            max="30"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            className="w-14 bg-[#2d3248] border border-[#3d4260] rounded px-1.5 py-0.5 text-xs text-white text-center focus:outline-none focus:border-blue-500"
          />
          <span>%</span>
        </div>
      </div>

      {/* Coverage grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-[#22263a] rounded-lg p-3 space-y-1">
          <div className="text-xs text-[#4a5070]">Monthly Margin Interest</div>
          <div className="text-base font-mono font-semibold text-red-400">{fmtDollar(monthlyInterest)}</div>
          <div className="text-xs text-[#4a5070]">{fmtDollar(annualInterest)}/yr @ {(rateNum * 100).toFixed(2)}%</div>
        </div>
        <div className="bg-[#22263a] rounded-lg p-3 space-y-1">
          <div className="text-xs text-[#4a5070]">Monthly Dividends</div>
          <div className="text-base font-mono font-semibold text-emerald-400">{fmtDollar(monthlyDividends)}</div>
          <div className="text-xs text-[#4a5070]">{fmtDollar(dividendsAnnual)}/yr (trailing)</div>
        </div>
      </div>

      {/* Coverage status */}
      {margin > 0 ? (
        <div className={`rounded-lg px-3 py-2 text-xs font-medium flex items-start gap-2 ${
          isCovered
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {isCovered
            ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          <span>
            {isCovered
              ? `Dividends cover margin interest ${coverageRatio === Infinity ? '✓' : `(${coverageRatio.toFixed(1)}× coverage)`} — surplus ${fmtDollar(surplus)}/mo`
              : `Dividends do NOT cover margin interest — shortfall ${fmtDollar(Math.abs(surplus))}/mo. Reduce margin or grow dividend income.`}
          </span>
        </div>
      ) : (
        <div className="text-xs text-[#4a5070] text-center py-1">No margin balance — no interest cost.</div>
      )}
    </div>
  );
}

// ─── Section 3: Position Concentration Bars + Trim Reminders ─────────────────

function ConcentrationSection({
  positions,
  totalValue,
}: {
  positions: EnrichedPosition[];
  totalValue: number;
}) {
  const [showAll, setShowAll] = useState(false);

  // Sort by concentration descending, exclude options/zero-value
  const sorted = [...positions]
    .filter((p) => p.marketValue > 0 && !p.instrument.symbol.includes(' '))
    .sort((a, b) => b.portfolioPercent - a.portfolioPercent);

  const overLimit = sorted.filter((p) => p.portfolioPercent > 20);
  const nearLimit = sorted.filter((p) => p.portfolioPercent > 15 && p.portfolioPercent <= 20);
  const visible = showAll ? sorted : sorted.slice(0, 8);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">Position Concentration</span>
        <div className="flex items-center gap-2 text-xs text-[#4a5070]">
          {overLimit.length > 0 && (
            <span className="text-red-400 font-medium">{overLimit.length} over 20% cap</span>
          )}
          {nearLimit.length > 0 && overLimit.length === 0 && (
            <span className="text-amber-400 font-medium">{nearLimit.length} near cap</span>
          )}
          <span>Cap: 20%</span>
        </div>
      </div>

      <div className="space-y-1.5">
        {visible.map((pos) => {
          const pct = pos.portfolioPercent;
          const isOver = pct > 20;
          const isNear = pct > 15 && pct <= 20;
          const barColor = isOver ? '#ef4444' : isNear ? '#f97316' : '#22c55e';

          // Trim amount: how much to sell to reach 15% target
          const targetPct = 15;
          const targetValue = totalValue * (targetPct / 100);
          const trimAmount = isOver ? pos.marketValue - targetValue : 0;
          const trimShares = trimAmount > 0 && pos.quote?.lastPrice
            ? Math.ceil(trimAmount / pos.quote.lastPrice)
            : 0;

          return (
            <div key={pos.instrument.symbol} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className={`font-mono font-semibold ${isOver ? 'text-red-400' : isNear ? 'text-amber-400' : 'text-[#e8eaf0]'}`}>
                  {pos.instrument.symbol}
                </span>
                <div className="flex items-center gap-2">
                  {isOver && trimAmount > 0 && (
                    <span className="text-red-400/80">
                      Trim ~{fmtDollar(trimAmount)}{trimShares > 0 ? ` (≈${trimShares} sh)` : ''} → reach 15%
                    </span>
                  )}
                  <span className={`font-mono ${isOver ? 'text-red-400 font-bold' : isNear ? 'text-amber-400' : 'text-[#7c82a0]'}`}>
                    {pct.toFixed(1)}%
                  </span>
                </div>
              </div>
              <div className="h-1.5 bg-[#2d3248] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: barColor }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {sorted.length > 8 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="text-xs text-[#4a5070] hover:text-white flex items-center gap-1 transition-colors"
        >
          {showAll ? <><ChevronUp className="w-3 h-3" />Show less</> : <><ChevronDown className="w-3 h-3" />Show all {sorted.length} positions</>}
        </button>
      )}

      {sorted.length === 0 && (
        <div className="text-xs text-[#4a5070] text-center py-2">No positions loaded.</div>
      )}
    </div>
  );
}

// ─── Section 4: Fund Family Concentration ────────────────────────────────────

function FundFamilySection({
  positions,
  totalValue,
  familyCapPct,
}: {
  positions: EnrichedPosition[];
  totalValue: number;
  familyCapPct: number;
}) {
  const families = getFundFamilyConcentrations(positions, totalValue);

  if (families.length === 0) {
    return (
      <div className="space-y-2">
        <span className="text-sm font-medium text-white">Fund Family Concentration</span>
        <div className="text-xs text-[#4a5070]">No recognized fund families in portfolio.</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">Fund Family Concentration</span>
        <span className="text-xs text-[#4a5070]">Cap: {familyCapPct}% per family</span>
      </div>

      <div className="space-y-2">
        {families.map((f) => {
          const isOver = f.portfolioPercent > familyCapPct;
          const isNear = f.portfolioPercent > familyCapPct * 0.75 && !isOver;
          const barColor = isOver ? '#ef4444' : isNear ? '#f97316' : '#3b82f6';
          const barPct = Math.min((f.portfolioPercent / familyCapPct) * 100, 100);

          // Income families that can erode — flag Yieldmax/Defiance more strongly
          const isHighDecay = ['Yieldmax', 'Defiance', 'Roundhill', 'RexShares'].includes(f.family);

          return (
            <div key={f.family} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <span className={`font-medium ${isOver ? 'text-red-400' : isNear ? 'text-amber-400' : 'text-[#e8eaf0]'}`}>
                    {f.family}
                  </span>
                  {isHighDecay && (
                    <span className="text-[#4a5070] italic">decay risk</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-right">
                  <span className="text-[#4a5070]">{f.symbols.slice(0, 4).join(', ')}{f.symbols.length > 4 ? ` +${f.symbols.length - 4}` : ''}</span>
                  <span className={`font-mono font-semibold ${isOver ? 'text-red-400' : isNear ? 'text-amber-400' : 'text-[#7c82a0]'}`}>
                    {f.portfolioPercent.toFixed(1)}%
                  </span>
                </div>
              </div>
              {/* Bar scaled to cap */}
              <div className="h-1.5 bg-[#2d3248] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${barPct}%`, backgroundColor: barColor }}
                />
              </div>
              {isOver && (
                <div className="text-xs text-red-400/80 pl-0.5">
                  {f.portfolioPercent.toFixed(1)}% exceeds {familyCapPct}% family cap — consider trimming {f.family} positions
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function MarginRiskPanel({
  equity,
  marginBalance,
  totalValue,
  positions,
  dividendsAnnual,
  marginRate = 0.0775,
  familyCapPct = 25,
}: Props) {
  const margin = Math.abs(marginBalance);
  const marginPct = (equity + margin) > 0 ? (margin / (equity + margin)) * 100 : 0;
  const overCap = positions.filter((p) => p.portfolioPercent > 20).length;
  const nearCap = positions.filter((p) => p.portfolioPercent > 15 && p.portfolioPercent <= 20).length;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-white">Margin & Risk Intelligence</h2>
        {marginPct > 30 && (
          <span className="px-1.5 py-0.5 rounded text-xs bg-red-500/20 text-red-400 border border-red-500/30">
            Margin Critical
          </span>
        )}
        {marginPct > 20 && marginPct <= 30 && (
          <span className="px-1.5 py-0.5 rounded text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30">
            Margin Warning
          </span>
        )}
        {overCap > 0 && (
          <span className="px-1.5 py-0.5 rounded text-xs bg-red-500/20 text-red-400 border border-red-500/30">
            {overCap} Trim Alert{overCap > 1 ? 's' : ''}
          </span>
        )}
        {nearCap > 0 && overCap === 0 && (
          <span className="px-1.5 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400 border border-amber-500/30">
            {nearCap} Near Cap
          </span>
        )}
      </div>

      {/* Section 1: Margin meter */}
      <MarginMeter3 equity={equity} marginBalance={marginBalance} />

      <div className="border-t border-[#2d3248]" />

      {/* Section 2: Interest vs dividends */}
      <InterestCoverageSection
        marginBalance={marginBalance}
        dividendsAnnual={dividendsAnnual}
        marginRate={marginRate}
      />

      <div className="border-t border-[#2d3248]" />

      {/* Section 3: Position concentration */}
      <ConcentrationSection positions={positions} totalValue={totalValue} />

      <div className="border-t border-[#2d3248]" />

      {/* Section 4: Fund family caps */}
      <FundFamilySection
        positions={positions}
        totalValue={totalValue}
        familyCapPct={familyCapPct}
      />

      {/* Footer rule reminder */}
      <div className="flex items-start gap-2 text-xs text-[#4a5070] bg-[#22263a] rounded-lg p-3">
        <DollarSign className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>
          Vol 3 rules: Never exceed 30% margin (50% absolute max) · No single position above 20% · Only spend dividends, not principal · Sell highest-maintenance funds first in a downturn
        </span>
      </div>
    </div>
  );
}
