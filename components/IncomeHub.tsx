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
  CheckCircle, RefreshCw, Gauge, Plus, Minus, ArrowRight,
  Receipt, Trash2, Edit2, X,
} from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';

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

interface PillarSummary {
  pillar: PillarType;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
  dayGainLoss: number;
}

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
  equity: number;
  marginBalance?: number;
  pillarSummary?: PillarSummary[];
  onProjectedMonthly?: (monthly: number) => void;
}

type Tab = 'historical' | 'projected' | 'fire' | 'expenses' | 'margin';
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

// ─── Simulator constants ──────────────────────────────────────────────────────

const SIM_PILLAR_MAP: Record<string, PillarType> = {
  UPRO: 'triples', TQQQ: 'triples', SPXL: 'triples', UDOW: 'triples', UMDD: 'triples', URTY: 'triples',
  CLM: 'cornerstone', CRF: 'cornerstone',
  SQQQ: 'hedge', SPXS: 'hedge', UVXY: 'hedge',
};

const WARN_MARGIN_PCT = 30;
const MAX_MARGIN_PCT  = 50;

function fmtPct(n: number) { return `${n.toFixed(1)}%`; }

const PILLAR_COLORS: Record<PillarType, string> = {
  triples:     'text-violet-400',
  cornerstone: 'text-amber-400',
  income:      'text-emerald-400',
  hedge:       'text-blue-400',
  other:       'text-[#7c82a0]',
};

function getSimPillar(symbol: string, positions: EnrichedPosition[]): PillarType {
  const upper = symbol.toUpperCase();
  if (SIM_PILLAR_MAP[upper]) return SIM_PILLAR_MAP[upper];
  const existing = positions.find((p) => p.instrument?.symbol?.toUpperCase() === upper);
  if (existing) return existing.pillar;
  return 'income';
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
  // Monthly avg is taken over the span from the first month with data through
  // the last month with data — not the full 12-month window. Otherwise a
  // brand-new account with one month of $570 reads "Monthly Avg $47", which
  // averages in 11 months that didn't exist yet.
  const firstActiveIdx = values.findIndex((v) => v > 0);
  const lastActiveIdx  = firstActiveIdx === -1
    ? -1
    : values.length - 1 - [...values].reverse().findIndex((v) => v > 0);
  const monthsActive = firstActiveIdx === -1 ? 0 : lastActiveIdx - firstActiveIdx + 1;
  const monthlyAvg = monthsActive > 0 ? totalAnnual / monthsActive : 0;
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
          <div className="text-xs text-[#7c82a0] mb-0.5">
            Monthly Avg{monthsActive > 0 && monthsActive < 12 ? ` (${monthsActive}-mo)` : ''}
          </div>
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

function FireTab({ projectedMonthly, marginBalance }: { projectedMonthly: number; marginBalance: number }) {
  const [config, setConfig] = useState<FireConfig>(() => {
    try {
      const saved = typeof window !== 'undefined' ? localStorage.getItem(FIRE_STORAGE_KEY) : null;
      return saved ? JSON.parse(saved) : { monthlyExpenses: 5000, monthlyMarginInterest: 500 };
    } catch { return { monthlyExpenses: 5000, monthlyMarginInterest: 500 }; }
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(config);

  const monthlyAvg = projectedMonthly;
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
            Projected monthly income {fmt$Dec(monthlyAvg)} vs target {fmt$Dec(totalTarget)}/mo
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
  projectedMonthly, marginBalance, totalValue, equity, positions, pillarSummary,
}: {
  projectedMonthly: number;
  marginBalance: number;
  totalValue: number;
  equity: number;
  positions: EnrichedPosition[];
  pillarSummary: PillarSummary[];
}) {
  // ── Coverage stats ──────────────────────────────────────────────────────────
  const monthlyAvg = projectedMonthly;
  const annualMarginInterest = marginBalance > 0 ? marginBalance * 0.085 : 0;
  const monthlyMarginInterest = annualMarginInterest / 12;
  const coverageRatio = monthlyMarginInterest > 0 ? monthlyAvg / monthlyMarginInterest : Infinity;
  const isFullyCovered = coverageRatio >= 1;
  const marginPct = totalValue > 0 ? (marginBalance / totalValue) * 100 : 0;
  const currentMarginPct = totalValue > 0 ? (marginBalance / totalValue) * 100 : 0;

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

  // ── Simulator state ─────────────────────────────────────────────────────────
  const [simSymbol,     setSimSymbol]     = useState('');
  const [simAction,     setSimAction]     = useState<'BUY' | 'SELL'>('BUY');
  const [simSharesStr,  setSimSharesStr]  = useState('');
  const [simManualPrice,setSimManualPrice]= useState('');

  const knownPos = useMemo(
    () => positions.find((p) => p.instrument?.symbol?.toUpperCase() === simSymbol.toUpperCase()),
    [positions, simSymbol]
  );
  const knownPrice = knownPos ? (knownPos.marketValue / (knownPos.longQuantity || 1)) : null;
  const effectivePrice = simManualPrice ? parseFloat(simManualPrice) : (knownPrice ?? 0);
  const simShares = parseInt(simSharesStr) || 0;
  const tradeValue = effectivePrice * simShares;

  const simResult = useMemo(() => {
    if (!simSymbol || simShares <= 0 || effectivePrice <= 0) return null;
    const pillar = getSimPillar(simSymbol, positions);
    let newTotalValue    = totalValue;
    let newEquity        = equity;
    let newMarginBalance = marginBalance;

    if (simAction === 'BUY') {
      newTotalValue    += tradeValue;
      newMarginBalance += tradeValue * 0.5;
      newEquity        -= tradeValue * 0.5;
    } else {
      const heldQty = knownPos?.longQuantity ?? 0;
      const actualValue = effectivePrice * Math.min(simShares, heldQty > 0 ? heldQty : simShares);
      newTotalValue    -= actualValue;
      const paydown     = Math.min(actualValue, newMarginBalance);
      newMarginBalance -= paydown;
      newEquity        += actualValue - paydown;
    }

    const newMarginUtilPct = newTotalValue > 0 ? (newMarginBalance / newTotalValue) * 100 : 0;
    const marginStatus = newMarginUtilPct >= MAX_MARGIN_PCT ? 'danger' : newMarginUtilPct >= WARN_MARGIN_PCT ? 'warn' : 'safe';

    const pillarDeltas = pillarSummary.map((ps) => {
      let afterValue = ps.totalValue;
      if (ps.pillar === pillar)
        afterValue += simAction === 'BUY' ? tradeValue : -Math.min(tradeValue, ps.totalValue);
      return { pillar: ps.pillar, label: ps.label, before: ps.portfolioPercent, after: newTotalValue > 0 ? (afterValue / newTotalValue) * 100 : 0 };
    });

    const alerts: string[] = [];
    if (marginStatus === 'danger') alerts.push(`Margin would hit ${fmtPct(newMarginUtilPct)} — exceeds 50% hard cap.`);
    else if (marginStatus === 'warn') alerts.push(`Margin would reach ${fmtPct(newMarginUtilPct)} — in warning zone (30–50%).`);
    const triplesDelta = pillarDeltas.find((p) => p.pillar === 'triples');
    if (triplesDelta && triplesDelta.after > 45)
      alerts.push(`Triples would be ${fmtPct(triplesDelta.after)} — very high concentration.`);
    if (simAction === 'BUY' && pillar === 'income') {
      const incomeAfter = pillarDeltas.find((p) => p.pillar === 'income')?.after ?? 0;
      if (incomeAfter > 70) alerts.push(`Income pillar would reach ${fmtPct(incomeAfter)} — consider 1/3 rule.`);
    }

    return { newTotalValue, newEquity, newMarginBalance, newMarginUtilPct, marginStatus, pillarDeltas, alerts };
  }, [simSymbol, simAction, simShares, effectivePrice, positions, totalValue, equity, marginBalance, pillarSummary, tradeValue, knownPos]);

  return (
    <div className="space-y-5">
      {/* ── Coverage stats ────────────────────────────────────────────────── */}
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
        isFullyCovered ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'
      }`}>
        {isFullyCovered ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
        <span>
          {marginBalance === 0 ? 'No margin debt — 100% equity position.'
            : isFullyCovered ? `Dividends cover margin interest ${coverageRatio.toFixed(1)}x — margin is self-sustaining.`
            : `Dividends don't fully cover margin interest. Gap: ${fmt$Dec(monthlyMarginInterest - monthlyAvg)}/mo.`}
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[#7c82a0]">Margin Utilization</span>
          <span className={`font-semibold ${marginPct > 50 ? 'text-red-400' : marginPct > 30 ? 'text-orange-400' : 'text-emerald-400'}`}>
            {marginPct.toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-[#2d3248] rounded-full h-3 relative overflow-hidden">
          <div className={`h-full rounded-full ${marginPct > 50 ? 'bg-red-500' : marginPct > 30 ? 'bg-orange-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(marginPct * 2, 100)}%` }} />
          <div className="absolute top-0 h-full w-px bg-orange-400/60" style={{ left: '60%' }} />
          <div className="absolute top-0 h-full w-px bg-red-400/60" style={{ left: '100%' }} />
        </div>
        <div className="flex justify-between text-xs text-[#4a5070]">
          <span>0%</span><span className="text-orange-400">30% warn</span><span className="text-red-400">50% MAX</span>
        </div>
      </div>

      {/* ── Pressure valve hierarchy ───────────────────────────────────────── */}
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
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${labelColor[label] ?? labelColor['Unknown']}`}>{label}</span>
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

      {/* ── "What If" Simulator ────────────────────────────────────────────── */}
      <div className="border-t border-[#2d3248] pt-5 space-y-4">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-white">"What If" Simulator</span>
          <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">
            margin now: {fmtPct(currentMarginPct)}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Action</label>
            <div className="flex gap-1">
              {(['BUY', 'SELL'] as const).map((a) => (
                <button key={a} onClick={() => setSimAction(a)}
                  className={`flex-1 flex items-center justify-center gap-1 text-xs py-2 rounded transition-colors ${
                    simAction === a
                      ? a === 'BUY' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                      : 'bg-[#0f1117] border border-[#2d3248] text-[#7c82a0]'
                  }`}>
                  {a === 'BUY' ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}{a}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Symbol</label>
            <input type="text" value={simSymbol}
              onChange={(e) => { setSimSymbol(e.target.value.toUpperCase()); setSimManualPrice(''); }}
              placeholder="TQQQ"
              className="w-full bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-blue-500/50 uppercase"
            />
            {knownPrice && <p className="text-[10px] text-emerald-400">Current: ${knownPrice.toFixed(2)}</p>}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Shares</label>
            <input type="number" min={1} value={simSharesStr} onChange={(e) => setSimSharesStr(e.target.value)}
              placeholder="100"
              className="w-full bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-blue-500/50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Price {knownPrice ? '(override)' : '(required)'}</label>
            <input type="number" min={0} step="0.01" value={simManualPrice}
              onChange={(e) => setSimManualPrice(e.target.value)}
              placeholder={knownPrice ? knownPrice.toFixed(2) : '0.00'}
              className="w-full bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-blue-500/50"
            />
          </div>
        </div>

        {simShares > 0 && effectivePrice > 0 && (
          <div className="text-xs text-[#7c82a0] bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2">
            {simAction} <span className="text-white font-semibold">{simShares} × {simSymbol}</span>
            {' '}@ ${effectivePrice.toFixed(2)} = <span className="text-white font-semibold">{fmt$(tradeValue)}</span>
            {' '}in <span className={PILLAR_COLORS[getSimPillar(simSymbol, positions)]}>{getSimPillar(simSymbol, positions)}</span> pillar
          </div>
        )}

        {simResult && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2">
                <p className="text-[10px] text-[#4a5070] font-semibold uppercase">Before</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-[#7c82a0]">Portfolio</span><span className="text-white">{fmt$(totalValue)}</span></div>
                  <div className="flex justify-between"><span className="text-[#7c82a0]">Equity</span><span className="text-white">{fmt$(equity)}</span></div>
                  <div className="flex justify-between"><span className="text-[#7c82a0]">Margin used</span>
                    <span className={currentMarginPct >= MAX_MARGIN_PCT ? 'text-red-400' : currentMarginPct >= WARN_MARGIN_PCT ? 'text-orange-400' : 'text-emerald-400'}>
                      {fmtPct(currentMarginPct)}
                    </span>
                  </div>
                </div>
              </div>
              <div className={`rounded-lg p-3 space-y-2 border ${
                simResult.marginStatus === 'danger' ? 'bg-red-500/5 border-red-500/25' :
                simResult.marginStatus === 'warn'   ? 'bg-orange-500/5 border-orange-500/25' :
                                                      'bg-emerald-500/5 border-emerald-500/25'
              }`}>
                <p className="text-[10px] text-[#4a5070] font-semibold uppercase">After</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-[#7c82a0]">Portfolio</span><span className="text-white">{fmt$(simResult.newTotalValue)}</span></div>
                  <div className="flex justify-between"><span className="text-[#7c82a0]">Equity</span><span className="text-white">{fmt$(simResult.newEquity)}</span></div>
                  <div className="flex justify-between"><span className="text-[#7c82a0]">Margin used</span>
                    <span className={simResult.marginStatus === 'danger' ? 'text-red-400 font-bold' : simResult.marginStatus === 'warn' ? 'text-orange-400 font-bold' : 'text-emerald-400'}>
                      {fmtPct(simResult.newMarginUtilPct)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2">
              <p className="text-[10px] text-[#4a5070] font-semibold uppercase">Pillar Impact</p>
              {simResult.pillarDeltas.filter((p) => p.before !== p.after || p.pillar !== 'other').map((pd) => {
                const delta = pd.after - pd.before;
                const changed = Math.abs(delta) > 0.05;
                return (
                  <div key={pd.pillar} className="flex items-center gap-2 text-xs">
                    <span className={`w-24 capitalize ${PILLAR_COLORS[pd.pillar]}`}>{pd.label}</span>
                    <span className="text-[#7c82a0]">{fmtPct(pd.before)}</span>
                    <ArrowRight className="w-3 h-3 text-[#4a5070]" />
                    <span className={changed ? (delta > 0 ? 'text-emerald-400 font-semibold' : 'text-orange-400 font-semibold') : 'text-[#7c82a0]'}>
                      {fmtPct(pd.after)}
                    </span>
                    {changed && (
                      <span className={`text-[10px] ${delta > 0 ? 'text-emerald-400' : 'text-orange-400'}`}>
                        {delta > 0 ? '+' : ''}{delta.toFixed(1)}pp
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {simResult.alerts.length > 0 ? (
              <div className="space-y-2">
                {simResult.alerts.map((a, i) => (
                  <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                    simResult.marginStatus === 'danger'
                      ? 'bg-red-500/10 border border-red-500/25 text-red-300'
                      : 'bg-orange-500/10 border border-orange-500/25 text-orange-300'
                  }`}>
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{a}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 text-xs text-emerald-300">
                <CheckCircle className="w-3.5 h-3.5" />Trade looks safe — no rule violations projected.
              </div>
            )}
          </div>
        )}

        <p className="text-[10px] text-[#4a5070]">
          BUY assumes 50% Reg T margin financing. SELL assumes proceeds pay down margin first. Thresholds: warn 30%, cap 50%.
        </p>
      </div>
    </div>
  );
}

// ─── Tab: Expenses ────────────────────────────────────────────────────────────

const EXPENSE_CATEGORIES = [
  'Housing', 'Utilities', 'Food', 'Transport', 'Insurance',
  'Subscriptions', 'Healthcare', 'Margin Interest', 'Entertainment', 'Other',
] as const;
type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];

interface Expense {
  id: string;
  name: string;
  amount: number;
  category: ExpenseCategory;
  frequency: 'monthly' | 'annual';
}

const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  'Housing':          'bg-blue-500/15 text-blue-300',
  'Utilities':        'bg-yellow-500/15 text-yellow-300',
  'Food':             'bg-emerald-500/15 text-emerald-300',
  'Transport':        'bg-orange-500/15 text-orange-300',
  'Insurance':        'bg-purple-500/15 text-purple-300',
  'Subscriptions':    'bg-pink-500/15 text-pink-300',
  'Healthcare':       'bg-red-500/15 text-red-300',
  'Margin Interest':  'bg-rose-500/15 text-rose-300',
  'Entertainment':    'bg-cyan-500/15 text-cyan-300',
  'Other':            'bg-[#2d3248] text-[#7c82a0]',
};

async function fetchSavedExpenses(): Promise<Expense[]> {
  const res = await fetch('/api/expenses/saved');
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.expenses) ? data.expenses : [];
}

async function persistExpenses(items: Expense[]): Promise<void> {
  await fetch('/api/expenses/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expenses: items }),
  });
}

const EMPTY_FORM = { name: '', amount: '', category: 'Other' as ExpenseCategory, frequency: 'monthly' as 'monthly' | 'annual' };

interface DetectedExpense {
  description: string;
  category: string;
  totalPaid: number;
  avgMonthly: number;
  occurrences: number;
  lastDate: string;
  isRecurring: boolean;
}

function mapApiCategory(cat: string): ExpenseCategory {
  if (cat === 'Margin Interest') return 'Margin Interest';
  if (cat === 'Transfer Out')    return 'Other';
  return 'Other';
}

function ExpensesTab({ monthlyIncome }: { monthlyIncome: number }) {
  const [expenses, setExpenses]   = useState<Expense[]>([]);
  const [editing, setEditing]     = useState<string | null>(null);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [detected, setDetected]   = useState<DetectedExpense[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError]     = useState<string | null>(null);
  const [showImport, setShowImport]       = useState(false);

  useEffect(() => {
    fetchSavedExpenses().then(setExpenses);
  }, []);

  function persist(next: Expense[]) {
    setExpenses(next);
    persistExpenses(next);
  }

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(e: Expense) {
    setEditing(e.id);
    setForm({ name: e.name, amount: String(e.amount), category: e.category, frequency: e.frequency });
    setShowForm(true);
  }

  function submitForm() {
    const amount = parseFloat(form.amount);
    if (!form.name.trim() || isNaN(amount) || amount <= 0) return;
    if (editing) {
      persist(expenses.map((e) => e.id === editing ? { ...e, name: form.name.trim(), amount, category: form.category, frequency: form.frequency } : e));
    } else {
      persist([...expenses, { id: Date.now().toString(), name: form.name.trim(), amount, category: form.category, frequency: form.frequency }]);
    }
    setShowForm(false);
    setEditing(null);
  }

  function remove(id: string) {
    persist(expenses.filter((e) => e.id !== id));
  }

  async function fetchFromSchwab() {
    setImportLoading(true);
    setImportError(null);
    try {
      const res = await fetch('/api/expenses');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDetected(data.detected ?? []);
      setShowImport(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportLoading(false);
    }
  }

  function addDetected(d: DetectedExpense) {
    const alreadyAdded = expenses.some((e) => e.name.toLowerCase() === d.description.toLowerCase());
    if (alreadyAdded) return;
    persist([...expenses, {
      id: Date.now().toString(),
      name: d.description,
      amount: parseFloat(d.avgMonthly.toFixed(2)),
      category: mapApiCategory(d.category),
      frequency: 'monthly',
    }]);
  }

  const totalMonthly = expenses.reduce((s, e) => s + (e.frequency === 'monthly' ? e.amount : e.amount / 12), 0);
  const surplus = monthlyIncome - totalMonthly;
  const coveragePct = totalMonthly > 0 ? Math.min((monthlyIncome / totalMonthly) * 100, 999) : 100;

  const byCategory = EXPENSE_CATEGORIES
    .map((cat) => ({
      cat,
      total: expenses
        .filter((e) => e.category === cat)
        .reduce((s, e) => s + (e.frequency === 'monthly' ? e.amount : e.amount / 12), 0),
    }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-5">
      {/* Summary bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Monthly Expenses</div>
          <div className="text-lg font-bold text-red-400">{fmt$(totalMonthly, true)}</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Income / mo</div>
          <div className="text-lg font-bold text-emerald-400">{monthlyIncome > 0 ? fmt$(monthlyIncome, true) : '–'}</div>
          <div className="text-[10px] text-[#4a5070]">12-mo avg</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3 text-center">
          <div className="text-xs text-[#7c82a0] mb-0.5">Surplus / Deficit</div>
          <div className={`text-lg font-bold ${surplus >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {surplus >= 0 ? '+' : ''}{fmt$(surplus, true)}
          </div>
        </div>
      </div>

      {/* Coverage bar */}
      {totalMonthly > 0 && monthlyIncome > 0 && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-[#7c82a0]">
            <span>Income covers expenses</span>
            <span className={coveragePct >= 100 ? 'text-emerald-400' : 'text-red-400'}>{coveragePct.toFixed(0)}%</span>
          </div>
          <div className="w-full bg-[#2d3248] rounded-full h-2.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${coveragePct >= 100 ? 'bg-emerald-500' : 'bg-red-500'}`}
              style={{ width: `${Math.min(coveragePct, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Category breakdown */}
      {byCategory.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-[#7c82a0]">By category (monthly equiv.)</p>
          {byCategory.map(({ cat, total }) => (
            <div key={cat} className="flex items-center gap-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 w-28 text-center ${CATEGORY_COLORS[cat]}`}>{cat}</span>
              <div className="flex-1 bg-[#2d3248] rounded-full h-2 overflow-hidden">
                <div className="h-full bg-[#4a5070] rounded-full" style={{ width: `${totalMonthly > 0 ? (total / totalMonthly) * 100 : 0}%` }} />
              </div>
              <span className="text-[#7c82a0] w-14 text-right font-mono">{fmt$(total, true)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex justify-between items-center">
        <p className="text-xs text-[#4a5070]">{expenses.length} expense{expenses.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-2">
          <button
            onClick={fetchFromSchwab}
            disabled={importLoading}
            className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
          >
            {importLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Import from Schwab
          </button>
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />Add
          </button>
        </div>
      </div>

      {/* Import error */}
      {importError && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
          {importError}
        </div>
      )}

      {/* Detected charges panel */}
      {showImport && detected.length > 0 && (
        <div className="bg-[#0f1117] border border-blue-800/40 rounded-lg p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-xs font-semibold text-blue-300">Detected Brokerage Charges</span>
            <button onClick={() => setShowImport(false)}><X className="w-4 h-4 text-[#7c82a0] hover:text-white" /></button>
          </div>
          <p className="text-[10px] text-[#4a5070]">These are fees and charges found in your Schwab account. Click + to add as a tracked expense.</p>
          <div className="space-y-1.5">
            {detected.map((d, i) => {
              const alreadyAdded = expenses.some((e) => e.name.toLowerCase() === d.description.toLowerCase());
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <div className="flex-1 min-w-0">
                    <span className="text-white truncate block">{d.description}</span>
                    <span className="text-[#4a5070]">
                      {fmt$(d.avgMonthly, true)}/mo avg · {d.occurrences}×
                      {d.isRecurring && <span className="text-blue-400 ml-1">recurring</span>}
                    </span>
                  </div>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${CATEGORY_COLORS[mapApiCategory(d.category)]}`}>
                    {d.category}
                  </span>
                  <button
                    onClick={() => addDetected(d)}
                    disabled={alreadyAdded}
                    className={`flex-shrink-0 p-1.5 rounded transition-colors ${alreadyAdded ? 'text-[#4a5070] cursor-default' : 'text-emerald-400 hover:bg-emerald-900/30'}`}
                    title={alreadyAdded ? 'Already added' : 'Add to tracker'}
                  >
                    {alreadyAdded ? <CheckCircle className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showImport && detected.length === 0 && (
        <div className="text-xs text-[#4a5070] bg-[#0f1117] border border-[#2d3248] rounded-lg px-3 py-3 text-center">
          No brokerage charges found in the last 90 days.
        </div>
      )}

      {/* Add / edit form */}
      {showForm && (
        <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-xs font-semibold text-white">{editing ? 'Edit Expense' : 'New Expense'}</span>
            <button onClick={() => setShowForm(false)}><X className="w-4 h-4 text-[#7c82a0] hover:text-white" /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-[#7c82a0]">Name</label>
              <input
                type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Rent, Netflix, Car insurance"
                className="w-full bg-[#1a1d27] border border-[#2d3248] rounded px-3 py-1.5 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[#7c82a0]">Amount ($)</label>
              <input
                type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="0.00"
                className="w-full bg-[#1a1d27] border border-[#2d3248] rounded px-3 py-1.5 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[#7c82a0]">Frequency</label>
              <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as 'monthly' | 'annual' })}
                className="w-full bg-[#1a1d27] border border-[#2d3248] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500/50">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-[#7c82a0]">Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as ExpenseCategory })}
                className="w-full bg-[#1a1d27] border border-[#2d3248] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500/50">
                {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={submitForm} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 rounded-lg transition-colors">
              {editing ? 'Save' : 'Add'}
            </button>
            <button onClick={() => setShowForm(false)} className="text-xs text-[#7c82a0] hover:text-white px-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Expense list */}
      {expenses.length > 0 && (
        <div className="space-y-1.5">
          {expenses.map((e) => {
            const monthly = e.frequency === 'monthly' ? e.amount : e.amount / 12;
            return (
              <div key={e.id} className="flex items-center gap-3 bg-[#0f1117] rounded-lg px-3 py-2 text-xs group">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${CATEGORY_COLORS[e.category]}`}>{e.category}</span>
                <span className="text-white flex-1 truncate">{e.name}</span>
                <span className="text-[#7c82a0] flex-shrink-0 font-mono">{fmt$(monthly, true)}/mo</span>
                {e.frequency === 'annual' && (
                  <span className="text-[10px] text-[#4a5070] flex-shrink-0">{fmt$(e.amount, true)}/yr</span>
                )}
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => openEdit(e)} className="p-1 text-[#7c82a0] hover:text-white transition-colors">
                    <Edit2 className="w-3 h-3" />
                  </button>
                  <button onClick={() => remove(e.id)} className="p-1 text-[#7c82a0] hover:text-red-400 transition-colors">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {expenses.length === 0 && !showForm && (
        <div className="text-center py-6 text-xs text-[#4a5070]">
          No expenses yet — add your monthly bills to track income vs expenses.
        </div>
      )}

      <p className="text-[10px] text-[#4a5070]">Synced to your account. Annual expenses are divided by 12 for monthly comparison.</p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function IncomeHub({ positions, totalValue, equity = 0, marginBalance = 0, pillarSummary = [], onProjectedMonthly }: Props) {
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

  useEffect(() => {
    if (projectedAnnual > 0) onProjectedMonthly?.(projectedAnnual / 12);
  }, [projectedAnnual, onProjectedMonthly]);

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'historical', label: 'Historical', icon: <BarChart2 className="w-3.5 h-3.5" /> },
    { id: 'projected',  label: 'Projected',  icon: <Calendar   className="w-3.5 h-3.5" /> },
    { id: 'fire',       label: 'FIRE',        icon: <Flame      className="w-3.5 h-3.5" /> },
    { id: 'expenses',   label: 'Expenses',    icon: <Receipt    className="w-3.5 h-3.5" /> },
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
              <FireTab projectedMonthly={projectedAnnual / 12} marginBalance={marginDebt} />
            ) : activeTab === 'expenses' ? (
              <ExpensesTab monthlyIncome={projectedAnnual / 12} />
            ) : (
              <MarginTab projectedMonthly={projectedAnnual / 12} marginBalance={marginDebt} totalValue={totalValue} equity={equity} positions={positions} pillarSummary={pillarSummary} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
