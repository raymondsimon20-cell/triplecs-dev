'use client';

/**
 * IncomeHub — merged Income & Dividend Dashboard + Distribution Calendar.
 *
 * Tabs:
 *   Historical  — actual 12-month paid dividends from Schwab
 *   Projected   — estimated forward 12-month distribution calendar
 *   FIRE        — FIRE progress tracker
 *   Margin      — margin interest coverage + maintenance pressure valve
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DollarSign, TrendingUp, ChevronDown, ChevronUp,
  Flame, Target, BarChart2, Calendar, AlertTriangle,
  CheckCircle, Layers, RefreshCw,
} from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DividendRecord {
  date: string;
  description: string;
  amount: number;
  symbol: string;
}

interface DividendData {
  dividends: DividendRecord[];
  total: number;
  startDate: string;
  endDate: string;
}

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
  marginBalance?: number;
}

type Tab = 'historical' | 'projected' | 'fire' | 'margin';
type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'annual';

// ─── Distribution calendar data ───────────────────────────────────────────────

const FREQ_MAP: Record<string, Frequency> = {
  // Weekly — Roundhill
  XDTE: 'weekly', QDTE: 'weekly', RDTE: 'weekly', WDTE: 'weekly', MDTE: 'weekly',
  TOPW: 'weekly', BRKW: 'weekly', WEEK: 'weekly',

  // Monthly — YieldMax
  TSLY: 'monthly', NVDY: 'monthly', AMZY: 'monthly', GOOGY: 'monthly',
  MSFO: 'monthly', CONY: 'monthly', JPMO: 'monthly', NFLXY: 'monthly',
  AMDY: 'monthly', PYPLY: 'monthly', AIYY: 'monthly', OILY: 'monthly',
  CVNY: 'monthly', MRNY: 'monthly', SNOY: 'monthly', BIOY: 'monthly',
  DISO: 'monthly', ULTY: 'monthly', YMAX: 'monthly', YMAG: 'monthly',
  FBY: 'monthly', GDXY: 'monthly', XOMO: 'monthly', TSMY: 'monthly',
  APLY: 'monthly', OARK: 'monthly', DIPS: 'monthly', CRSH: 'monthly',
  KLIP: 'monthly', MSTY: 'monthly', PLTY: 'monthly',
  MSFO2: 'monthly', AMZY2: 'monthly',
  FIAT: 'monthly', FIVY: 'monthly',
  NFLY: 'monthly', SQY: 'monthly', SMCY: 'monthly',

  // Monthly — Defiance
  QQQY: 'monthly', IWMY: 'monthly', JEPY: 'monthly',
  QDTY: 'monthly', SDTY: 'monthly', DFNV: 'monthly', IWMY2: 'monthly',
  DEFI: 'monthly', BDTE: 'monthly', IDTE: 'monthly', QDTU: 'monthly', YBTC: 'monthly',

  // Monthly — RexShares / Neos
  FEPI: 'monthly', AIPI: 'monthly', REXQ: 'monthly', REXS: 'monthly', SPYI2: 'monthly',
  SPYI: 'monthly', QDVO: 'monthly', JPEI: 'monthly', IWMI: 'monthly',
  QQQI: 'monthly', BTCI: 'monthly', NIHI: 'monthly', IAUI: 'monthly',

  // Monthly — GraniteShares / Kurv
  TSYY: 'monthly', KSLV: 'monthly',

  // Monthly — JPMorgan
  JEPI: 'monthly', JEPQ: 'monthly',

  // Monthly — Cornerstone CEFs
  CLM: 'monthly', CRF: 'monthly',

  // Monthly — other CEFs
  OXLC: 'monthly', OXSQ: 'monthly',
  PDI: 'monthly', PDO: 'monthly', PTY: 'monthly',
  PCN: 'monthly', PFL: 'monthly', PFN: 'monthly', PHK: 'monthly',
  ETV: 'monthly', ETB: 'monthly', EOS: 'monthly', EOI: 'monthly', EVT: 'monthly',
  BST: 'monthly', BDJ: 'monthly', ECAT: 'monthly', BGY: 'monthly', BCAT: 'monthly', BUI: 'monthly',
  RIV: 'monthly', OPP: 'monthly', GOF: 'monthly',
  STK: 'monthly', USA: 'monthly',
  GAB: 'monthly', GGT: 'monthly', KMLM: 'monthly',
  COWS: 'monthly',
  CHW: 'monthly', CSQ: 'monthly', EXG: 'monthly',

  // Monthly — Global X covered-call
  QYLD: 'monthly', RYLD: 'monthly', XYLD: 'monthly', NVDL: 'monthly',

  // Monthly — REIT
  O: 'monthly',

  // Monthly — bond funds
  AGG: 'monthly', BND: 'monthly', TLT: 'monthly', IEF: 'monthly',
  SGOV: 'monthly', USFR: 'monthly',

  // Monthly — Vol 7 additions
  IQQQ: 'monthly', SPYT: 'monthly', FNGA: 'monthly', FNGB: 'monthly',
  XPAY: 'monthly', MAGY: 'monthly',

  // Quarterly — dividend ETFs / stocks
  DIVO: 'quarterly',
  SCHD: 'quarterly', VYM: 'quarterly', VXUS: 'quarterly',
  QQQ: 'quarterly', QQQM: 'quarterly', RSP: 'quarterly',
  SPY: 'quarterly', IVV: 'quarterly', VOO: 'quarterly', VTI: 'quarterly',
  IWM: 'quarterly', SCHB: 'quarterly', SCHG: 'quarterly',
  NVDA: 'quarterly', AAPL: 'quarterly', MSFT: 'quarterly',
  SPYG: 'quarterly', DJIA: 'quarterly',
  GDV: 'quarterly', LICT: 'quarterly', TPVG: 'quarterly',
  ITA: 'quarterly', MCD: 'quarterly', COST: 'quarterly',
  VGT: 'quarterly', KGC: 'quarterly',

  // Annual / no meaningful dividend
  UPRO: 'annual', TQQQ: 'annual', SPXL: 'annual', UDOW: 'annual', SQQQ: 'annual',
  TECL: 'annual', SOXL: 'annual', FNGU: 'annual', LABU: 'annual',
  TNA: 'annual', FAS: 'annual', UMDD: 'annual', URTY: 'annual',
  CURE: 'annual', HIBL: 'annual',
  SPXU: 'annual', SDOW: 'annual', SOXS: 'annual', FNGD: 'annual',
  FAZ: 'annual', SRTY: 'annual', SPXS: 'annual', UVXY: 'annual',
  SH: 'annual', PSQ: 'annual', DOG: 'annual',
  GLD: 'annual', IAU: 'annual', AAAU: 'annual',
  TSLL: 'annual', BLOK: 'annual', MSTR: 'annual',
  AMZN: 'annual', GOOGL: 'annual', META: 'annual', 'BRK.B': 'annual',
};

const FALLBACK_YIELDS: Record<string, number> = {
  XDTE: 30, QDTE: 35, RDTE: 28, WDTE: 30, MDTE: 28, TOPW: 25, BRKW: 25, WEEK: 25,
  TSLY: 55, NVDY: 50, CONY: 70, MSFO: 30, AMZY: 45, GOOGY: 25, JPMO: 15,
  NFLXY: 35, AMDY: 40, PYPLY: 30, AIYY: 35, OILY: 35, CVNY: 30, MRNY: 40,
  SNOY: 25, BIOY: 25, DISO: 30, ULTY: 55, YMAX: 40, YMAG: 35,
  FBY: 35, GDXY: 25, XOMO: 30, TSMY: 30, APLY: 35, OARK: 45, DIPS: 35, CRSH: 35,
  KLIP: 35, MSTY: 75, PLTY: 130, MSFO2: 30, AMZY2: 45,
  FIAT: 30, FIVY: 30, NFLY: 35, SQY: 35, SMCY: 35,
  QQQY: 50, IWMY: 55, JEPY: 35, QDTY: 30, SDTY: 30, DFNV: 30, IWMY2: 55,
  DEFI: 35, BDTE: 30, IDTE: 30, QDTU: 30, YBTC: 40,
  FEPI: 20, AIPI: 25, REXQ: 18, REXS: 18, SPYI2: 12,
  SPYI: 12, QDVO: 10, JPEI: 12, IWMI: 15, QQQI: 20, BTCI: 25, NIHI: 20, IAUI: 18,
  TSYY: 40, KSLV: 25,
  JEPI: 7.5, JEPQ: 9.5,
  CLM: 18, CRF: 18,
  OXLC: 18, OXSQ: 15,
  PDI: 13, PDO: 12, PTY: 10, PCN: 9, PFL: 10, PFN: 10, PHK: 9,
  CHW: 9, CSQ: 8.5, EXG: 9,
  ETV: 8.5, ETB: 8, EOS: 8, EOI: 8, EVT: 7.5,
  BST: 6, BDJ: 7, ECAT: 9, BGY: 10, BCAT: 9, BUI: 7,
  RIV: 12, OPP: 12, GOF: 14,
  STK: 7, USA: 10, GAB: 8, GGT: 8, GDV: 6, LICT: 5,
  KMLM: 10, TPVG: 10, COWS: 5,
  QYLD: 12, RYLD: 12, XYLD: 11, NVDL: 8, TSLL: 0,
  IQQQ: 20, SPYT: 18, FNGA: 8, FNGB: 8, XPAY: 15, MAGY: 20,
  O: 5, AGG: 4, BND: 3.5, TLT: 3.8, IEF: 3.5, SGOV: 5, USFR: 5,
  DIVO: 4.5, BLOK: 0,
  SCHD: 3.5, VYM: 3, VXUS: 3,
  QQQ: 0.6, QQQM: 0.6, RSP: 1.5,
  SPY: 1.3, IVV: 1.3, VOO: 1.3, VTI: 1.3,
  IWM: 1.5, SCHB: 1.3, SCHG: 0.5,
  NVDA: 0.03, AAPL: 0.5, MSFT: 0.7, SPYG: 0.8,
  DJIA: 3, ITA: 1, MCD: 2.2, COST: 0.6,
  VGT: 0.7, KGC: 0.5, AMZN: 0, GOOGL: 0, META: 0, 'BRK.B': 0,
};

const QUARTERLY_MONTHS = [2, 5, 8, 11];
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getFrequency(symbol: string): Frequency {
  return FREQ_MAP[symbol.toUpperCase()] ?? 'quarterly';
}

function estimateAnnualDividend(pos: EnrichedPosition): number {
  const symbol = pos.instrument?.symbol?.toUpperCase() ?? '';
  if (pos.quote?.divYield && pos.quote.divYield > 0)
    return pos.marketValue * (pos.quote.divYield / 100);
  if (pos.quote?.divAmount && pos.quote.divAmount > 0) {
    const freq = getFrequency(symbol);
    const ppy = freq === 'weekly' ? 52 : freq === 'monthly' ? 12 : freq === 'quarterly' ? 4 : 1;
    return pos.quote.divAmount * ppy * pos.longQuantity;
  }
  const fy = FALLBACK_YIELDS[symbol];
  if (fy && fy > 0) return pos.marketValue * (fy / 100);
  return 0;
}

function distributeToMonths(annual: number, freq: Frequency): number[] {
  const months = new Array(12).fill(0);
  if (annual <= 0) return months;
  switch (freq) {
    case 'weekly': {
      const wkly = annual / 52;
      const wpm = [4.33,3.86,4.33,4.33,4.33,4.33,4.43,4.43,4.33,4.43,4.33,4.33];
      for (let i = 0; i < 12; i++) months[i] = wkly * wpm[i];
      break;
    }
    case 'monthly':
      for (let i = 0; i < 12; i++) months[i] = annual / 12;
      break;
    case 'quarterly':
      for (const m of QUARTERLY_MONTHS) months[m] = annual / 4;
      break;
    case 'annual':
      months[11] = annual;
      break;
  }
  return months;
}

// ─── Maintenance scores ───────────────────────────────────────────────────────

const MAINTENANCE_SCORES: Record<string, { score: number; label: string; reason: string }> = {
  OXLC: { score: 100, label: 'Very High', reason: '$1 sold → $1 equity freed (full maintenance)' },
  KLIP: { score: 90,  label: 'Very High', reason: 'High-volatility CEF; high margin requirement' },
  ULTY: { score: 85,  label: 'Very High', reason: 'Leveraged yield fund; steep margin weight' },
  YMAX: { score: 75,  label: 'High',      reason: 'Fund-of-funds overlay; elevated maintenance' },
  YMAG: { score: 75,  label: 'High',      reason: 'Fund-of-funds overlay; elevated maintenance' },
  TSLY: { score: 70,  label: 'High',      reason: 'Single-stock covered-call; high volatility' },
  NVDY: { score: 70,  label: 'High',      reason: 'Single-stock covered-call; high volatility' },
  CONY: { score: 70,  label: 'High',      reason: 'Single-stock covered-call; high volatility' },
  QQQY: { score: 60,  label: 'Moderate',  reason: 'Index covered-call fund; moderate maintenance' },
  JEPY: { score: 60,  label: 'Moderate',  reason: 'Index covered-call fund; moderate maintenance' },
  FEPI: { score: 55,  label: 'Moderate',  reason: 'Equity premium income; moderate' },
  AIPI: { score: 55,  label: 'Moderate',  reason: 'Equity premium income; moderate' },
  XDTE: { score: 50,  label: 'Moderate',  reason: 'Weekly distribution; solid underlying' },
  QDTE: { score: 50,  label: 'Moderate',  reason: 'Weekly distribution; solid underlying' },
  JEPI: { score: 30,  label: 'Low',       reason: 'Large-cap covered-call; low maintenance (~30%)' },
  JEPQ: { score: 30,  label: 'Low',       reason: 'Nasdaq covered-call; low maintenance (~30%)' },
  SCHD: { score: 25,  label: 'Low',       reason: 'Dividend quality ETF; low maintenance' },
  DIVO: { score: 25,  label: 'Low',       reason: 'Active dividend; low maintenance' },
  GOF:  { score: 30,  label: 'Low',       reason: 'Multi-sector bond CEF; moderate' },
  PTY:  { score: 30,  label: 'Low',       reason: 'PIMCO bond CEF; moderate' },
  RIV:  { score: 30,  label: 'Low',       reason: 'RiverNorth Opp CEF; moderate' },
  CLM:  { score: 20,  label: 'Low',       reason: 'Cornerstone; stable long-term holding' },
  CRF:  { score: 20,  label: 'Low',       reason: 'Cornerstone; stable long-term holding' },
  BST:  { score: 20,  label: 'Low',       reason: 'BlackRock tech CEF; low maintenance' },
  STK:  { score: 20,  label: 'Low',       reason: 'Columbia Seligman; low maintenance' },
  BDJ:  { score: 20,  label: 'Low',       reason: 'BlackRock enhanced equity; low' },
  EOS:  { score: 20,  label: 'Low',       reason: 'Eaton Vance equity CEF; low' },
  USA:  { score: 20,  label: 'Low',       reason: 'Liberty All-Star; low maintenance' },
};

function getMaintenanceScore(symbol: string) {
  return MAINTENANCE_SCORES[symbol.toUpperCase()] ?? { score: 40, label: 'Unknown', reason: 'No maintenance data' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `-$${str}` : `$${str}`;
}

function fmt$Dec(n: number): string {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${str}` : `$${str}`;
}

function groupByMonth(dividends: DividendRecord[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const d of dividends) {
    const month = d.date.slice(0, 7);
    map[month] = (map[month] ?? 0) + d.amount;
  }
  return map;
}

function groupBySymbol(dividends: DividendRecord[]) {
  const map: Record<string, { total: number; count: number }> = {};
  for (const d of dividends) {
    const s = d.symbol || 'UNKNOWN';
    if (!map[s]) map[s] = { total: 0, count: 0 };
    map[s].total += d.amount;
    map[s].count += 1;
  }
  return Object.entries(map)
    .map(([symbol, v]) => ({ symbol, ...v }))
    .sort((a, b) => b.total - a.total);
}

function last12Months(): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return result;
}

function shortMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' });
}

// ─── Tab: Historical ──────────────────────────────────────────────────────────

function HistoricalTab({ dividends }: { dividends: DividendRecord[] }) {
  const months = last12Months();
  const byMonth = groupByMonth(dividends);
  const values = months.map((m) => byMonth[m] ?? 0);
  const maxVal = Math.max(...values, 1);
  const totalAnnual = values.reduce((s, v) => s + v, 0);
  const monthlyAvg = totalAnnual / 12;
  const lastMonth = values[values.length - 1];
  const prevMonth = values[values.length - 2];

  const bySymbol = groupBySymbol(dividends);
  const symbolTotal = bySymbol.reduce((s, r) => s + r.total, 0);
  const top20 = bySymbol.slice(0, 20);

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">12-Mo Total</div>
          <div className="text-lg font-bold text-emerald-400">{fmt$(totalAnnual, true)}</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Monthly Avg</div>
          <div className="text-lg font-bold text-blue-400">{fmt$(monthlyAvg, true)}</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Last Month</div>
          <div className={`text-lg font-bold ${lastMonth >= prevMonth ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmt$(lastMonth, true)}
          </div>
        </div>
      </div>

      {/* Monthly bar chart */}
      <div className="space-y-1">
        {months.map((m, i) => {
          const val = values[i];
          const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
          const isCurrent = i === months.length - 1;
          return (
            <div key={m} className="flex items-center gap-2 text-xs">
              <span className="text-[#7c82a0] w-8 flex-shrink-0">{shortMonth(m)}</span>
              <div className="flex-1 bg-[#2d3248] rounded-full h-5 relative overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${isCurrent ? 'bg-blue-500/80' : 'bg-emerald-500/70'}`}
                  style={{ width: `${pct}%` }}
                />
                {val > 0 && (
                  <span className="absolute inset-0 flex items-center px-2 text-white font-medium" style={{ fontSize: '10px' }}>
                    {fmt$(val, true)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Symbol breakdown */}
      {top20.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-[#7c82a0]">Top contributors — last 12 months</p>
          <div className="space-y-1.5">
            {top20.map(({ symbol, total: amt }) => {
              const pct = symbolTotal > 0 ? (amt / symbolTotal) * 100 : 0;
              return (
                <div key={symbol} className="flex items-center gap-2 text-xs">
                  <span className="w-14 text-white font-mono font-semibold flex-shrink-0">{symbol}</span>
                  <div className="flex-1 bg-[#2d3248] rounded-full h-4 relative overflow-hidden">
                    <div className="h-full rounded-full bg-purple-500/70" style={{ width: `${Math.min(pct * 3, 100)}%` }} />
                  </div>
                  <span className="text-[#7c82a0] w-16 text-right">{fmt$Dec(amt)}</span>
                  <span className="text-[#4a5070] w-8 text-right">{pct.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
          {bySymbol.length > 20 && (
            <p className="text-xs text-[#4a5070]">+ {bySymbol.length - 20} more symbols</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tab: Projected ───────────────────────────────────────────────────────────

function ProjectedTab({ positions }: { positions: EnrichedPosition[] }) {
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');

  const { monthlyTotals, annualTotal, byTicker } = useMemo(() => {
    const totals = new Array(12).fill(0);
    const byTicker: { symbol: string; annual: number; freq: Frequency; months: number[] }[] = [];

    for (const pos of positions) {
      const symbol = pos.instrument?.symbol?.toUpperCase() ?? '';
      if (!symbol || pos.instrument?.assetType === 'OPTION') continue;
      const annual = estimateAnnualDividend(pos);
      if (annual < 1) continue;
      const freq = getFrequency(symbol);
      const months = distributeToMonths(annual, freq);
      for (let i = 0; i < 12; i++) totals[i] += months[i];
      byTicker.push({ symbol, annual, freq, months });
    }
    byTicker.sort((a, b) => b.annual - a.annual);
    return { monthlyTotals: totals, annualTotal: totals.reduce((s, v) => s + v, 0), byTicker };
  }, [positions]);

  const maxMonth = Math.max(...monthlyTotals, 1);
  const avgMonthly = annualTotal / 12;
  const currentMo = new Date().getMonth();

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Est. Annual</div>
          <div className="text-lg font-bold text-emerald-400">{fmt$(annualTotal)}</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Avg / Month</div>
          <div className="text-lg font-bold text-white">{fmt$(avgMonthly)}</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">This Month (est.)</div>
          <div className="text-lg font-bold text-violet-400">{fmt$(monthlyTotals[currentMo])}</div>
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
        <div className="space-y-1">
          {monthlyTotals.map((val, i) => {
            const isCurrent = i === currentMo;
            const barPct = maxMonth > 0 ? (val / maxMonth) * 100 : 0;
            const isBelowAvg = val < avgMonthly * 0.7;
            return (
              <div key={i} className="flex items-center gap-3">
                <span className={`text-xs w-8 text-right flex-shrink-0 ${isCurrent ? 'text-white font-semibold' : 'text-[#7c82a0]'}`}>
                  {MONTH_LABELS[i]}
                </span>
                <div className="flex-1 relative h-6 bg-[#0f1117] rounded overflow-hidden">
                  <div
                    className={`h-full rounded transition-all ${
                      isCurrent ? 'bg-violet-500' : isBelowAvg ? 'bg-orange-500/60' : 'bg-emerald-500/70'
                    }`}
                    style={{ width: `${barPct}%` }}
                  />
                  {isCurrent && <div className="absolute inset-0 ring-1 ring-violet-400/50 rounded pointer-events-none" />}
                </div>
                <span className={`text-xs w-16 text-right flex-shrink-0 font-mono ${
                  isCurrent ? 'text-violet-300 font-semibold' : isBelowAvg ? 'text-orange-400' : 'text-[#7c82a0]'
                }`}>
                  {fmt$(val, true)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
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
                const ppy = t.freq === 'weekly' ? 52 : t.freq === 'monthly' ? 12 : t.freq === 'quarterly' ? 4 : 1;
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
                    <td className="text-right px-2 py-2 font-mono text-[#7c82a0]">{fmt$(t.annual / ppy)}</td>
                    <td className="text-right px-2 py-2 text-[#7c82a0]">
                      {annualTotal > 0 ? ((t.annual / annualTotal) * 100).toFixed(1) : '0'}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {monthlyTotals.some((v) => v < avgMonthly * 0.5) && (
        <div className="flex items-start gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-xs text-orange-300">
          <TrendingUp className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            {MONTH_LABELS.filter((_, i) => monthlyTotals[i] < avgMonthly * 0.5).join(', ')} may be light.
            Consider adding monthly/weekly payers to smooth income.
          </span>
        </div>
      )}

      <p className="text-[10px] text-[#4a5070]">
        Estimates use Schwab div yield when available, otherwise fallback table yields. Actual distributions vary.
      </p>
    </div>
  );
}

// ─── Tab: FIRE ────────────────────────────────────────────────────────────────

const FIRE_STORAGE_KEY = 'triple-c-fire-config';
interface FireConfig { monthlyExpenses: number; monthlyMarginInterest: number; }

function FireTab({ dividends, marginBalance }: { dividends: DividendRecord[]; marginBalance: number }) {
  const [config, setConfig] = useState<FireConfig>(() => {
    try {
      const saved = typeof window !== 'undefined' ? localStorage.getItem(FIRE_STORAGE_KEY) : null;
      return saved ? JSON.parse(saved) : { monthlyExpenses: 5000, monthlyMarginInterest: 500 };
    } catch { return { monthlyExpenses: 5000, monthlyMarginInterest: 500 }; }
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(config);

  const months = last12Months();
  const byMonth = groupByMonth(dividends);
  const values = months.map((m) => byMonth[m] ?? 0);
  const monthlyAvg = values.reduce((s, v) => s + v, 0) / 12;
  const totalTarget = config.monthlyExpenses + config.monthlyMarginInterest;
  const fireProgress = totalTarget > 0 ? Math.min((monthlyAvg / totalTarget) * 100, 100) : 0;
  const isFire = monthlyAvg >= totalTarget;
  const gap = totalTarget - monthlyAvg;
  const estMarginInterest = marginBalance > 0 ? (marginBalance * 0.085) / 12 : 0;

  function saveConfig() {
    setConfig(draft);
    try { localStorage.setItem(FIRE_STORAGE_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
    setEditing(false);
  }

  return (
    <div className="space-y-4">
      <div className={`rounded-lg p-4 border flex items-start gap-3 ${
        isFire ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-orange-500/10 border-orange-500/25'
      }`}>
        {isFire
          ? <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
          : <Flame className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
        }
        <div>
          <div className={`font-semibold text-sm ${isFire ? 'text-emerald-300' : 'text-orange-300'}`}>
            {isFire ? '🎉 Financially Free!' : `${fmt$(gap, true)}/mo gap to FIRE`}
          </div>
          <div className="text-xs text-[#7c82a0] mt-0.5">
            Avg monthly income {fmt$Dec(monthlyAvg)} vs target {fmt$Dec(totalTarget)}/mo
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-[#7c82a0]">
          <span>FIRE Progress</span><span>{fireProgress.toFixed(0)}%</span>
        </div>
        <div className="w-full bg-[#2d3248] rounded-full h-4 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isFire ? 'bg-emerald-500' : 'bg-orange-500'}`}
            style={{ width: `${fireProgress}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-[#4a5070]">
          <span>$0 income</span><span>Target: {fmt$(totalTarget)}/mo</span>
        </div>
      </div>

      {!editing ? (
        <div className="bg-[#0f1117] rounded-lg p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-[#7c82a0]">Monthly Bills</span>
            <span className="text-white">{fmt$Dec(config.monthlyExpenses)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-[#7c82a0]">Margin Interest (configured)</span>
            <span className="text-white">{fmt$Dec(config.monthlyMarginInterest)}</span>
          </div>
          {estMarginInterest > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-[#7c82a0]">Margin Interest (est. @ 8.5%)</span>
              <span className="text-orange-300">{fmt$Dec(estMarginInterest)}</span>
            </div>
          )}
          <div className="border-t border-[#2d3248] pt-2 flex justify-between text-xs font-semibold">
            <span className="text-[#7c82a0]">Total FIRE Target</span>
            <span className="text-white">{fmt$Dec(totalTarget)}/mo</span>
          </div>
          <button onClick={() => { setDraft(config); setEditing(true); }} className="text-xs text-blue-400 hover:text-blue-300">
            Edit targets →
          </button>
        </div>
      ) : (
        <div className="bg-[#0f1117] rounded-lg p-3 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Monthly Bills / Expenses ($)</label>
            <input type="number" value={draft.monthlyExpenses}
              onChange={(e) => setDraft({ ...draft, monthlyExpenses: Number(e.target.value) })}
              className="w-full bg-[#1a1d27] border border-[#2d3248] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Monthly Margin Interest ($)</label>
            <input type="number" value={draft.monthlyMarginInterest}
              onChange={(e) => setDraft({ ...draft, monthlyMarginInterest: Number(e.target.value) })}
              className="w-full bg-[#1a1d27] border border-[#2d3248] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex gap-2">
            <button onClick={saveConfig} className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-[#7c82a0] hover:text-white px-2">Cancel</button>
          </div>
        </div>
      )}

      <div className="text-xs text-[#4a5070] bg-[#0f1117] rounded-lg p-3 space-y-0.5">
        <div className="text-[#7c82a0] font-medium mb-1">Vol 3 FIRE Model ($10K/mo example)</div>
        <div>• $5,000/mo bills + $5,000/mo margin paydown = Financially Free</div>
        <div>• Spend dividends only — never touch principal</div>
        <div>• Dividends also qualify as income for bank loans</div>
      </div>
    </div>
  );
}

// ─── Tab: Margin ──────────────────────────────────────────────────────────────

function MarginTab({
  dividends, marginBalance, totalValue, positions,
}: {
  dividends: DividendRecord[];
  marginBalance: number;
  totalValue: number;
  positions: EnrichedPosition[];
}) {
  const byMonth = groupByMonth(dividends);
  const months = last12Months();
  const values = months.map((m) => byMonth[m] ?? 0);
  const monthlyAvg = values.reduce((s, v) => s + v, 0) / 12;
  const annualMarginInterest = marginBalance > 0 ? marginBalance * 0.085 : 0;
  const monthlyMarginInterest = annualMarginInterest / 12;
  const coverageRatio = monthlyMarginInterest > 0 ? monthlyAvg / monthlyMarginInterest : Infinity;
  const isFullyCovered = coverageRatio >= 1;
  const marginPct = totalValue > 0 ? (marginBalance / totalValue) * 100 : 0;

  const ranked = positions
    .filter((p) => !p.instrument.symbol.includes(' ') && (p.currentValue ?? 0) > 0)
    .map((p) => {
      const ms = getMaintenanceScore(p.instrument.symbol);
      return { symbol: p.instrument.symbol, value: p.currentValue ?? 0, ...ms };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  const labelColor: Record<string, string> = {
    'Very High': 'text-red-400 bg-red-500/10',
    'High':      'text-orange-400 bg-orange-500/10',
    'Moderate':  'text-yellow-400 bg-yellow-500/10',
    'Low':       'text-emerald-400 bg-emerald-500/10',
    'Unknown':   'text-[#7c82a0] bg-[#2d3248]',
  };

  return (
    <div className="space-y-5">
      {/* Coverage stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Margin Debt</div>
          <div className="text-base font-bold text-orange-400">{fmt$(marginBalance, true)}</div>
          <div className="text-xs text-[#4a5070]">{marginPct.toFixed(1)}% of portfolio</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Est. Monthly Interest</div>
          <div className="text-base font-bold text-red-400">{fmt$(monthlyMarginInterest, true)}</div>
          <div className="text-xs text-[#4a5070]">@ ~8.5% APR</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Dividend Income / mo</div>
          <div className="text-base font-bold text-emerald-400">{fmt$(monthlyAvg, true)}</div>
          <div className="text-xs text-[#4a5070]">12-mo avg</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Coverage Ratio</div>
          <div className={`text-base font-bold ${isFullyCovered ? 'text-emerald-400' : 'text-red-400'}`}>
            {isFinite(coverageRatio) ? coverageRatio.toFixed(1) + 'x' : '∞'}
          </div>
          <div className="text-xs text-[#4a5070]">income / interest</div>
        </div>
      </div>

      <div className={`rounded-lg p-3 border text-sm flex items-start gap-2 ${
        isFullyCovered
          ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
          : 'bg-red-500/10 border-red-500/25 text-red-300'
      }`}>
        {isFullyCovered
          ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        }
        <span>
          {marginBalance === 0
            ? 'No margin debt — 100% equity position.'
            : isFullyCovered
              ? `Dividends cover margin interest ${coverageRatio.toFixed(1)}x — margin is self-sustaining.`
              : `Dividends don't fully cover margin interest. Gap: ${fmt$Dec(monthlyMarginInterest - monthlyAvg)}/mo.`
          }
        </span>
      </div>

      {/* Margin utilization bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[#7c82a0]">Margin Utilization</span>
          <span className={`font-semibold ${marginPct > 50 ? 'text-red-400' : marginPct > 30 ? 'text-orange-400' : 'text-emerald-400'}`}>
            {marginPct.toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-[#2d3248] rounded-full h-3 relative overflow-hidden">
          <div
            className={`h-full rounded-full ${marginPct > 50 ? 'bg-red-500' : marginPct > 30 ? 'bg-orange-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(marginPct * 2, 100)}%` }}
          />
          <div className="absolute top-0 h-full w-px bg-orange-400/60" style={{ left: '60%' }} />
          <div className="absolute top-0 h-full w-px bg-red-400/60" style={{ left: '100%' }} />
        </div>
        <div className="flex justify-between text-xs text-[#4a5070]">
          <span>0%</span><span className="text-orange-400">30% warn</span><span className="text-red-400">50% MAX</span>
        </div>
      </div>

      {/* Pressure valve hierarchy */}
      {ranked.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-[#7c82a0]">
            Sell <span className="text-red-300 font-semibold">higher-maintenance</span> funds first to free the most equity per dollar sold.
          </p>
          <div className="space-y-1.5">
            {ranked.map(({ symbol, value, score, label, reason }, i) => (
              <div key={symbol} className="flex items-center gap-3 bg-[#0f1117] rounded-lg px-3 py-2 text-xs">
                <span className="text-[#4a5070] w-4 flex-shrink-0">#{i + 1}</span>
                <span className="font-mono font-bold text-white w-14 flex-shrink-0">{symbol}</span>
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${labelColor[label] ?? labelColor['Unknown']}`}>
                  {label}
                </span>
                <span className="text-[#7c82a0] flex-1 hidden sm:block truncate">{reason}</span>
                <span className="text-white font-medium flex-shrink-0">{fmt$(value, true)}</span>
                <span className="text-[#4a5070] flex-shrink-0 w-6 text-right">{score}</span>
              </div>
            ))}
          </div>
          <div className="text-xs text-[#4a5070] bg-[#0f1117] rounded-lg p-3 space-y-0.5">
            <div className="text-[#7c82a0] font-medium mb-1">Pressure Release Valve Order (Vol 3)</div>
            <div>• OXLC first → $1 sold = $1 equity freed (100% maintenance)</div>
            <div>• JEPI last → $1 sold = only $0.30 equity freed (30% maintenance)</div>
            <div>• Always sell highest-maintenance until margin ≤ 30%</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function IncomeHub({ positions, totalValue, marginBalance = 0 }: Props) {
  const [open, setOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('historical');
  const [data, setData] = useState<DividendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/dividends');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dividend data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const dividends = data?.dividends ?? [];
  const marginDebt = Math.abs(marginBalance);

  // Quick header stats
  const months = last12Months();
  const byMonth = groupByMonth(dividends);
  const actualAnnual = months.map((m) => byMonth[m] ?? 0).reduce((s, v) => s + v, 0);
  const projectedAnnual = useMemo(() => {
    let total = 0;
    for (const pos of positions) {
      if (pos.instrument?.assetType === 'OPTION') continue;
      total += estimateAnnualDividend(pos);
    }
    return total;
  }, [positions]);

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'historical', label: 'Historical', icon: <BarChart2 className="w-3.5 h-3.5" /> },
    { id: 'projected',  label: 'Projected',  icon: <Calendar   className="w-3.5 h-3.5" /> },
    { id: 'fire',       label: 'FIRE',        icon: <Flame      className="w-3.5 h-3.5" /> },
    { id: 'margin',     label: 'Margin',      icon: <Target     className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5 flex-wrap">
          <DollarSign className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          <span className="font-semibold text-white text-sm">Income Hub</span>
          {!loading && actualAnnual > 0 && (
            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
              {fmt$(actualAnnual, true)} actual
            </span>
          )}
          {projectedAnnual > 0 && (
            <span className="text-xs text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full">
              ~{fmt$(projectedAnnual, true)} projected
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <div className="w-3.5 h-3.5 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />}
          <button
            onClick={(e) => { e.stopPropagation(); fetchData(); }}
            className="p-1 text-[#7c82a0] hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-[#2d3248]">
          {/* Tab bar */}
          <div className="flex border-b border-[#2d3248] px-4 pt-2 gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-t border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === t.id
                    ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
                    : 'border-transparent text-[#7c82a0] hover:text-white'
                }`}
              >
                {t.icon}{t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="px-5 py-4">
            {error && (
              <div className="mb-4 bg-red-500/10 border border-red-500/25 text-red-300 text-xs rounded-lg p-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />{error}
              </div>
            )}

            {loading && (activeTab === 'historical' || activeTab === 'fire' || activeTab === 'margin') ? (
              <div className="flex items-center gap-2 text-xs text-[#7c82a0] py-4">
                <div className="w-4 h-4 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
                Loading dividend history…
              </div>
            ) : activeTab === 'historical' ? (
              <HistoricalTab dividends={dividends} />
            ) : activeTab === 'projected' ? (
              <ProjectedTab positions={positions} />
            ) : activeTab === 'fire' ? (
              <FireTab dividends={dividends} marginBalance={marginDebt} />
            ) : (
              <MarginTab dividends={dividends} marginBalance={marginDebt} totalValue={totalValue} positions={positions} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
