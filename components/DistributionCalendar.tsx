'use client';

/**
 * Distribution Calendar — visualises estimated monthly income across 12 months.
 *
 * Uses:
 *   • divYield from Schwab quote data attached to each position
 *   • Static frequency map (weekly / monthly / quarterly) per ticker
 *
 * Weekly payers (XDTE, QDTE, etc.) contribute ~4.33× per month.
 * Monthly payers contribute once per month.
 * Quarterly payers are spread to their typical payment months (Mar/Jun/Sep/Dec).
 *
 * Shows: bar chart, month totals, annual total, highest/lowest months.
 */

import { useState, useMemo } from 'react';
import { Calendar, ChevronDown, ChevronUp, TrendingUp, DollarSign } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
}

// ─── Payment frequency map ────────────────────────────────────────────────────

type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'annual';

const FREQ_MAP: Record<string, Frequency> = {
  // Weekly payers (Roundhill)
  XDTE: 'weekly', QDTE: 'weekly', RDTE: 'weekly', WDTE: 'weekly', MDTE: 'weekly',

  // Monthly payers — YieldMax family
  TSLY: 'monthly', NVDY: 'monthly', AMZY: 'monthly', GOOGY: 'monthly',
  MSFO: 'monthly', CONY: 'monthly', JPMO: 'monthly', NFLXY: 'monthly',
  AMDY: 'monthly', PYPLY: 'monthly', AIYY: 'monthly', OILY: 'monthly',
  CVNY: 'monthly', MRNY: 'monthly', SNOY: 'monthly', BIOY: 'monthly',
  DISO: 'monthly', ULTY: 'monthly', YMAX: 'monthly', YMAG: 'monthly',
  FBY: 'monthly', GDXY: 'monthly', XOMO: 'monthly', TSMY: 'monthly',

  // Defiance
  QQQY: 'monthly', IWMY: 'monthly', JEPY: 'monthly',
  QDTY: 'monthly', SDTY: 'monthly',

  // RexShares / Neos
  FEPI: 'monthly', AIPI: 'monthly', SPYI: 'monthly', QDVO: 'monthly',
  JPEI: 'monthly', IWMI: 'monthly',

  // JPMorgan
  JEPI: 'monthly', JEPQ: 'monthly',

  // Cornerstone CEFs (monthly managed distribution)
  CLM: 'monthly', CRF: 'monthly',

  // Other CEFs — monthly
  OXLC: 'monthly', PDI: 'monthly', PDO: 'monthly', PTY: 'monthly',
  PCN: 'monthly', PFL: 'monthly', PFN: 'monthly',
  ETV: 'monthly', ETB: 'monthly', EOS: 'monthly', EOI: 'monthly',
  BST: 'monthly', BDJ: 'monthly', ECAT: 'monthly',
  RIV: 'monthly', OPP: 'monthly', GOF: 'monthly',
  STK: 'monthly', USA: 'monthly', KLIP: 'monthly',

  // Amplify
  DIVO: 'quarterly',

  // Global X covered-call (monthly)
  QYLD: 'monthly', RYLD: 'monthly', XYLD: 'monthly',

  // Quarterly — traditional ETFs / dividend stocks
  SCHD: 'quarterly', VYM: 'quarterly', QQQ: 'quarterly',
  SPY: 'quarterly', IVV: 'quarterly', VOO: 'quarterly', VTI: 'quarterly',
  NVDA: 'quarterly', AAPL: 'quarterly', MSFT: 'quarterly',
  SPYG: 'quarterly',

  // 3× ETFs — no dividend
  UPRO: 'annual', TQQQ: 'annual', SPXL: 'annual', UDOW: 'annual', SQQQ: 'annual',
};

// Months quarterly payers typically distribute (0-indexed)
const QUARTERLY_MONTHS = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getFrequency(symbol: string): Frequency {
  return FREQ_MAP[symbol.toUpperCase()] ?? 'quarterly';
}

// ─── Approximate annual distribution yields (%) ──────────────────────────────
// Schwab often reports divYield = 0 for covered-call ETFs and CEFs because
// their payouts are classified as "distributions" or "return of capital"
// rather than qualified dividends. This fallback table uses approximate
// trailing 12-month yields so the calendar always has something to show.
// These are conservative estimates — actual yields fluctuate.

const FALLBACK_YIELDS: Record<string, number> = {
  // Roundhill weekly payers (~25–60% trailing yields)
  XDTE: 30, QDTE: 35, RDTE: 28, WDTE: 30, MDTE: 28,

  // YieldMax single-stock (~20–80% trailing)
  TSLY: 55, NVDY: 50, CONY: 70, MSFO: 30, AMZY: 45,
  GOOGY: 25, JPMO: 15, NFLXY: 35, AMDY: 40, PYPLY: 30,
  AIYY: 35, OILY: 35, CVNY: 30, MRNY: 40, SNOY: 25,
  BIOY: 25, DISO: 30, ULTY: 55, YMAX: 40, YMAG: 35,
  FBY: 35, GDXY: 25, XOMO: 30, TSMY: 30,

  // Defiance (~30–60%)
  QQQY: 50, IWMY: 55, JEPY: 35, QDTY: 30, SDTY: 30,

  // RexShares / Neos (~10–30%)
  FEPI: 20, AIPI: 25, SPYI: 12, QDVO: 10, JPEI: 12, IWMI: 15,

  // JPMorgan (~7–10%)
  JEPI: 7.5, JEPQ: 9.5,

  // Cornerstone CEFs (~15–20% managed distribution)
  CLM: 18, CRF: 18,

  // Other CEFs (~8–15%)
  OXLC: 18, PDI: 13, PDO: 12, PTY: 10, PCN: 9, PFL: 10, PFN: 10,
  ETV: 8.5, ETB: 8, EOS: 8, EOI: 8,
  BST: 6, BDJ: 7, ECAT: 9, RIV: 12, OPP: 12, GOF: 14,
  STK: 7, USA: 10, KLIP: 35,

  // Global X covered-call (~10–12%)
  QYLD: 12, RYLD: 12, XYLD: 11,

  // Amplify
  DIVO: 4.5,

  // Traditional dividend ETFs / stocks (~1–4%)
  SCHD: 3.5, VYM: 3, QQQ: 0.6, SPY: 1.3, IVV: 1.3,
  VOO: 1.3, VTI: 1.3, NVDA: 0.03, AAPL: 0.5, MSFT: 0.7, SPYG: 0.8,

  // 3× ETFs (negligible)
  UPRO: 0, TQQQ: 0, SPXL: 0, UDOW: 0, SQQQ: 0,
};

function estimateAnnualDividend(pos: EnrichedPosition): number {
  const symbol = pos.instrument?.symbol?.toUpperCase() ?? '';

  // 1) Prefer Schwab quote divYield if it's actually populated
  if (pos.quote?.divYield && pos.quote.divYield > 0) {
    return pos.marketValue * (pos.quote.divYield / 100);
  }

  // 2) Try divAmount × frequency as annual estimate
  if (pos.quote?.divAmount && pos.quote.divAmount > 0) {
    const freq = getFrequency(symbol);
    const paymentsPerYear = freq === 'weekly' ? 52 : freq === 'monthly' ? 12 : freq === 'quarterly' ? 4 : 1;
    return pos.quote.divAmount * paymentsPerYear * pos.longQuantity;
  }

  // 3) Fallback to known approximate yields
  const fallbackYield = FALLBACK_YIELDS[symbol];
  if (fallbackYield && fallbackYield > 0) {
    return pos.marketValue * (fallbackYield / 100);
  }

  return 0;
}

function distributeToMonths(annualDiv: number, freq: Frequency): number[] {
  const months = new Array(12).fill(0);
  if (annualDiv <= 0) return months;

  switch (freq) {
    case 'weekly': {
      // 52 payments / year — distribute evenly but weight by weeks per month
      const weeklyAmt = annualDiv / 52;
      const weeksPerMonth = [4.33, 3.86, 4.33, 4.33, 4.33, 4.33, 4.43, 4.43, 4.33, 4.43, 4.33, 4.33];
      for (let i = 0; i < 12; i++) months[i] = weeklyAmt * weeksPerMonth[i];
      break;
    }
    case 'monthly':
      for (let i = 0; i < 12; i++) months[i] = annualDiv / 12;
      break;
    case 'quarterly':
      for (const m of QUARTERLY_MONTHS) months[m] = annualDiv / 4;
      break;
    case 'annual':
      months[11] = annualDiv; // December typical
      break;
  }
  return months;
}

function fmt$(n: number, compact = false) {
  if (compact) return n >= 1000
    ? `$${(n / 1000).toFixed(1)}k`
    : `$${n.toFixed(0)}`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function DistributionCalendar({ positions }: Props) {
  const [open,     setOpen]     = useState(false);
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');

  const { monthlyTotals, annualTotal, byTicker } = useMemo(() => {
    const totals = new Array(12).fill(0);
    const byTicker: { symbol: string; annual: number; freq: Frequency; months: number[] }[] = [];

    for (const pos of positions) {
      const symbol = pos.instrument?.symbol?.toUpperCase() ?? '';
      if (!symbol || pos.instrument?.assetType === 'OPTION') continue;

      const annual = estimateAnnualDividend(pos);
      if (annual < 1) continue;

      const freq   = getFrequency(symbol);
      const months = distributeToMonths(annual, freq);

      for (let i = 0; i < 12; i++) totals[i] += months[i];
      byTicker.push({ symbol, annual, freq, months });
    }

    byTicker.sort((a, b) => b.annual - a.annual);

    return {
      monthlyTotals: totals,
      annualTotal:   totals.reduce((s, v) => s + v, 0),
      byTicker,
    };
  }, [positions]);

  const maxMonth   = Math.max(...monthlyTotals, 1);
  const avgMonthly = annualTotal / 12;
  const today      = new Date();
  const currentMo  = today.getMonth();

  // Top 5 income contributors
  const top5 = byTicker.slice(0, 5);

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Calendar className="w-5 h-5 text-emerald-400" />
          <span className="font-semibold text-white text-sm">Distribution Calendar</span>
          {annualTotal > 0 && (
            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
              ~{fmt$(annualTotal)}/yr est.
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-5">

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
              <div className="text-[10px] text-[#7c82a0] mb-1">Est. Annual</div>
              <div className="text-sm font-bold text-emerald-400">{fmt$(annualTotal)}</div>
            </div>
            <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
              <div className="text-[10px] text-[#7c82a0] mb-1">Avg / Month</div>
              <div className="text-sm font-bold text-white">{fmt$(avgMonthly)}</div>
            </div>
            <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
              <div className="text-[10px] text-[#7c82a0] mb-1">This Month (est.)</div>
              <div className="text-sm font-bold text-violet-400">{fmt$(monthlyTotals[currentMo])}</div>
            </div>
          </div>

          {/* View toggle */}
          <div className="flex gap-1">
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setViewMode(v)}
                className={`text-xs px-3 py-1.5 rounded transition-colors ${
                  viewMode === v
                    ? 'bg-emerald-600 text-white'
                    : 'text-[#4a5070] hover:text-white border border-[#2d3248]'
                }`}
              >
                {v === 'chart' ? 'Bar Chart' : 'By Ticker'}
              </button>
            ))}
          </div>

          {viewMode === 'chart' ? (
            /* Bar chart */
            <div className="space-y-1">
              {monthlyTotals.map((val, i) => {
                const isCurrentMonth = i === currentMo;
                const barPct = maxMonth > 0 ? (val / maxMonth) * 100 : 0;
                const isBelowAvg = val < avgMonthly * 0.7;

                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className={`text-xs w-8 text-right flex-shrink-0 ${isCurrentMonth ? 'text-white font-semibold' : 'text-[#7c82a0]'}`}>
                      {MONTH_LABELS[i]}
                    </span>
                    <div className="flex-1 relative h-6 bg-[#0f1117] rounded overflow-hidden">
                      <div
                        className={`h-full rounded transition-all ${
                          isCurrentMonth ? 'bg-violet-500' :
                          isBelowAvg    ? 'bg-orange-500/60' : 'bg-emerald-500/70'
                        }`}
                        style={{ width: `${barPct}%` }}
                      />
                      {isCurrentMonth && (
                        <div className="absolute inset-0 ring-1 ring-violet-400/50 rounded pointer-events-none" />
                      )}
                    </div>
                    <span className={`text-xs w-16 text-right flex-shrink-0 font-mono ${
                      isCurrentMonth ? 'text-violet-300 font-semibold' :
                      isBelowAvg    ? 'text-orange-400' : 'text-[#7c82a0]'
                    }`}>
                      {fmt$(val, true)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            /* By ticker table */
            <div className="space-y-2">
              <p className="text-xs text-[#4a5070]">Top income contributors (estimated annual)</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[#2d3248] text-[#4a5070]">
                      <th className="text-left px-2 py-1.5 font-medium">Symbol</th>
                      <th className="text-left px-2 py-1.5 font-medium">Freq</th>
                      <th className="text-right px-2 py-1.5 font-medium">Annual Est.</th>
                      <th className="text-right px-2 py-1.5 font-medium">Per Payment</th>
                      <th className="text-right px-2 py-1.5 font-medium">% of Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byTicker.map((t) => {
                      const paymentsPerYear = t.freq === 'weekly' ? 52 : t.freq === 'monthly' ? 12 : t.freq === 'quarterly' ? 4 : 1;
                      return (
                        <tr key={t.symbol} className="border-b border-[#1a1d27] hover:bg-[#0f1117]">
                          <td className="px-2 py-2 font-mono font-semibold text-white">{t.symbol}</td>
                          <td className="px-2 py-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                              t.freq === 'weekly'    ? 'bg-violet-500/20 text-violet-300' :
                              t.freq === 'monthly'   ? 'bg-emerald-500/20 text-emerald-300' :
                              t.freq === 'quarterly' ? 'bg-blue-500/20 text-blue-300' :
                                                       'bg-[#2d3248] text-[#7c82a0]'
                            }`}>{t.freq}</span>
                          </td>
                          <td className="text-right px-2 py-2 font-mono text-emerald-400">{fmt$(t.annual)}</td>
                          <td className="text-right px-2 py-2 font-mono text-[#7c82a0]">{fmt$(t.annual / paymentsPerYear)}</td>
                          <td className="text-right px-2 py-2 text-[#7c82a0]">
                            {annualTotal > 0 ? ((t.annual / annualTotal) * 100).toFixed(1) : '0'}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Gap months warning */}
          {monthlyTotals.some((v) => v < avgMonthly * 0.5) && (
            <div className="flex items-start gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-xs text-orange-300">
              <TrendingUp className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                {MONTH_LABELS.filter((_, i) => monthlyTotals[i] < avgMonthly * 0.5).join(', ')} may be light months.
                Consider adding more monthly/weekly payers to smooth income flow.
              </span>
            </div>
          )}

          <p className="text-[10px] text-[#4a5070]">
            Estimates based on current positions × div yield from Schwab quotes. Actual distributions may vary.
            Weekly payers use average weeks-per-month weighting.
          </p>
        </div>
      )}
    </div>
  );
}
