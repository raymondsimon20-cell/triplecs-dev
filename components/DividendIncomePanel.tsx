'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  Flame,
  Target,
  BarChart2,
  Calendar,
  AlertTriangle,
  CheckCircle,
  Layers,
} from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DividendRecord {
  date: string;      // YYYY-MM-DD
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
  marginBalance?: number;    // negative means margin debt
}

// ─── Maintenance pressure hierarchy (Vol 3 rules) ────────────────────────────
// Funds with HIGH maintenance eat more margin; sell these first to raise equity.
// Score = approximate % of value that is "maintenance cost" to margin calculation.
// Higher score = sell first when you need to raise equity.
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

function getMaintenanceScore(symbol: string): { score: number; label: string; reason: string } {
  return MAINTENANCE_SCORES[symbol.toUpperCase()] ?? { score: 40, label: 'Unknown', reason: 'No maintenance data' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 1000) {
    return '$' + (n / 1000).toFixed(1) + 'K';
  }
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `-$${str}` : `$${str}`;
}

function fmt$Dec(n: number): string {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${str}` : `$${str}`;
}

/** Group dividends by month → { "2025-04": 1234.56 } */
function groupByMonth(dividends: DividendRecord[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const d of dividends) {
    const month = d.date.slice(0, 7);
    map[month] = (map[month] ?? 0) + d.amount;
  }
  return map;
}

/** Group dividends by symbol → sorted descending by total */
function groupBySymbol(dividends: DividendRecord[]): { symbol: string; total: number; count: number }[] {
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

/** Last 12 calendar months in order */
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

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  open,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between text-left py-3 px-4 hover:bg-[#232638] rounded-lg transition-colors"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-white">
        {icon}
        {title}
      </div>
      {open ? (
        <ChevronDown className="w-4 h-4 text-[#7c82a0]" />
      ) : (
        <ChevronRight className="w-4 h-4 text-[#7c82a0]" />
      )}
    </button>
  );
}

// ─── Section 1: Monthly Income Bar Chart ─────────────────────────────────────

function MonthlyIncomeSection({ dividends }: { dividends: DividendRecord[] }) {
  const months = last12Months();
  const byMonth = groupByMonth(dividends);
  const values = months.map((m) => byMonth[m] ?? 0);
  const maxVal = Math.max(...values, 1);
  const totalAnnual = values.reduce((s, v) => s + v, 0);
  const monthlyAvg = totalAnnual / 12;
  const lastMonth = values[values.length - 1];
  const prevMonth = values[values.length - 2];

  return (
    <div className="space-y-4 px-1">
      {/* Summary row */}
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

      {/* Bar chart */}
      <div className="space-y-1">
        {months.map((m, i) => {
          const val = values[i];
          const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
          const isCurrentMonth = i === months.length - 1;
          return (
            <div key={m} className="flex items-center gap-2 text-xs">
              <span className="text-[#7c82a0] w-8 flex-shrink-0">{shortMonth(m)}</span>
              <div className="flex-1 bg-[#2d3248] rounded-full h-5 relative overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${isCurrentMonth ? 'bg-blue-500/80' : 'bg-emerald-500/70'}`}
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
    </div>
  );
}

// ─── Section 2: Per-Symbol Breakdown ─────────────────────────────────────────

function SymbolBreakdownSection({ dividends }: { dividends: DividendRecord[] }) {
  const bySymbol = groupBySymbol(dividends);
  const total = bySymbol.reduce((s, r) => s + r.total, 0);
  const top = bySymbol.slice(0, 20);

  if (bySymbol.length === 0) {
    return <p className="text-sm text-[#7c82a0] px-1">No dividend data available.</p>;
  }

  return (
    <div className="space-y-2 px-1">
      <p className="text-xs text-[#7c82a0]">Top contributors — last 12 months</p>
      <div className="space-y-1.5">
        {top.map(({ symbol, total: amt }) => {
          const pct = total > 0 ? (amt / total) * 100 : 0;
          return (
            <div key={symbol} className="flex items-center gap-2 text-xs">
              <span className="w-14 text-white font-mono font-semibold flex-shrink-0">{symbol}</span>
              <div className="flex-1 bg-[#2d3248] rounded-full h-4 relative overflow-hidden">
                <div
                  className="h-full rounded-full bg-purple-500/70"
                  style={{ width: `${Math.min(pct * 3, 100)}%` }}
                />
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
  );
}

// ─── Section 3: FIRE Progress Tracker ────────────────────────────────────────

const FIRE_STORAGE_KEY = 'triple-c-fire-config';

interface FireConfig {
  monthlyExpenses: number;
  monthlyMarginInterest: number;
}

function FireProgressSection({
  dividends,
  marginBalance,
}: {
  dividends: DividendRecord[];
  marginBalance: number;
}) {
  const [config, setConfig] = useState<FireConfig>(() => {
    try {
      const saved = typeof window !== 'undefined' ? localStorage.getItem(FIRE_STORAGE_KEY) : null;
      return saved ? JSON.parse(saved) : { monthlyExpenses: 5000, monthlyMarginInterest: 500 };
    } catch {
      return { monthlyExpenses: 5000, monthlyMarginInterest: 500 };
    }
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

  // Estimated margin interest from balance (rough: 8.5% annual / 12)
  const estMarginInterest = marginBalance > 0 ? (marginBalance * 0.085) / 12 : 0;

  function saveConfig() {
    setConfig(draft);
    try { localStorage.setItem(FIRE_STORAGE_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
    setEditing(false);
  }

  return (
    <div className="space-y-4 px-1">
      {/* FIRE status banner */}
      <div className={`rounded-lg p-4 border flex items-start gap-3 ${
        isFire
          ? 'bg-emerald-500/10 border-emerald-500/25'
          : 'bg-orange-500/10 border-orange-500/25'
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

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-[#7c82a0]">
          <span>FIRE Progress</span>
          <span>{fireProgress.toFixed(0)}%</span>
        </div>
        <div className="w-full bg-[#2d3248] rounded-full h-4 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isFire ? 'bg-emerald-500' : 'bg-orange-500'}`}
            style={{ width: `${fireProgress}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-[#4a5070]">
          <span>$0 income</span>
          <span>Target: {fmt$(totalTarget)}/mo</span>
        </div>
      </div>

      {/* Config */}
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
              <span className="text-[#7c82a0]">Margin Interest (estimated @ 8.5%)</span>
              <span className="text-orange-300">{fmt$Dec(estMarginInterest)}</span>
            </div>
          )}
          <div className="border-t border-[#2d3248] pt-2 flex justify-between text-xs font-semibold">
            <span className="text-[#7c82a0]">Total FIRE Target</span>
            <span className="text-white">{fmt$Dec(totalTarget)}/mo</span>
          </div>
          <button
            onClick={() => { setDraft(config); setEditing(true); }}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Edit targets →
          </button>
        </div>
      ) : (
        <div className="bg-[#0f1117] rounded-lg p-3 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Monthly Bills / Expenses ($)</label>
            <input
              type="number"
              value={draft.monthlyExpenses}
              onChange={(e) => setDraft({ ...draft, monthlyExpenses: Number(e.target.value) })}
              className="w-full bg-[#1a1d27] border border-[#2d3248] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-[#7c82a0]">Monthly Margin Interest ($)</label>
            <input
              type="number"
              value={draft.monthlyMarginInterest}
              onChange={(e) => setDraft({ ...draft, monthlyMarginInterest: Number(e.target.value) })}
              className="w-full bg-[#1a1d27] border border-[#2d3248] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex gap-2">
            <button onClick={saveConfig} className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-[#7c82a0] hover:text-white transition-colors px-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Vol 3 model reminder */}
      <div className="text-xs text-[#4a5070] bg-[#0f1117] rounded-lg p-3 space-y-0.5">
        <div className="text-[#7c82a0] font-medium mb-1">Vol 3 FIRE Model ($10K/mo example)</div>
        <div>• $5,000/mo bills + $5,000/mo margin paydown = Financially Free</div>
        <div>• Spend dividends only — never touch principal</div>
        <div>• Dividends also qualify as income for bank loans</div>
      </div>
    </div>
  );
}

// ─── Section 4: Maintenance Pressure Valve Hierarchy ─────────────────────────

function MaintenanceHierarchySection({ positions }: { positions: EnrichedPosition[] }) {
  // Only show positions that have a current value
  const ranked = positions
    .filter((p) => !p.instrument.symbol.includes(' ') && (p.currentValue ?? 0) > 0)
    .map((p) => {
      const ms = getMaintenanceScore(p.instrument.symbol);
      return {
        symbol: p.instrument.symbol,
        value: p.currentValue ?? 0,
        score: ms.score,
        label: ms.label,
        reason: ms.reason,
        gainLossPercent: p.gainLossPercent ?? 0,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  if (ranked.length === 0) {
    return <p className="text-sm text-[#7c82a0] px-1">No positions to rank.</p>;
  }

  const labelColor: Record<string, string> = {
    'Very High': 'text-red-400 bg-red-500/10',
    'High':      'text-orange-400 bg-orange-500/10',
    'Moderate':  'text-yellow-400 bg-yellow-500/10',
    'Low':       'text-emerald-400 bg-emerald-500/10',
    'Unknown':   'text-[#7c82a0] bg-[#2d3248]',
  };

  return (
    <div className="space-y-3 px-1">
      <p className="text-xs text-[#7c82a0]">
        Sell <span className="text-red-300 font-semibold">higher-maintenance</span> funds first to free the most equity per dollar sold. Preserve low-maintenance core holdings.
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
  );
}

// ─── Section 5: Dividend Calendar (forward-looking) ──────────────────────────
// Shows the next 12 months of ESTIMATED dividend payments per symbol, built
// from current positions + each holding's yield / frequency — not from the
// historical ledger. Historical totals are not forward-looking; this section
// answers "when do I get paid next?" rather than "what did I get paid last year?"

type PayFreq = 'weekly' | 'monthly' | 'quarterly' | 'annual';

const MONTHLY_PAYERS = new Set([
  'CLM', 'CRF', 'OXLC', 'GOF', 'PTY', 'RIV', 'JEPI', 'JEPQ', 'QQQY', 'JEPY',
  'XDTE', 'QDTE', 'RDTE', 'TSLY', 'NVDY', 'CONY', 'YMAX', 'YMAG', 'ULTY',
  'FEPI', 'AIPI', 'WDTE', 'BDTE', 'IDTE', 'KLIP', 'DISO', 'SQY', 'AMZY', 'GOOGY',
  'MSFO', 'APLY', 'SMCY', 'NFLY', 'OARK', 'JPMO', 'IWMY', 'WEEK', 'SPYI', 'QDVO',
]);

const WEEKLY_PAYERS = new Set(['XDTE', 'QDTE', 'RDTE', 'WDTE', 'MDTE']);

const QUARTERLY_PAYERS = new Set([
  'SCHD', 'DIVO', 'QQQ', 'SPY', 'VOO', 'VTI', 'VGT', 'SPYG', 'AGG', 'BND',
  'TLT', 'IEF', 'BST', 'STK', 'BDJ', 'EOS', 'USA',
]);

// Conservative fallback yields (%) for funds whose Schwab quote reports 0 yield
// because payouts are classified as return-of-capital rather than qualified divs.
const FALLBACK_YIELD_PCT: Record<string, number> = {
  XDTE: 30, QDTE: 35, RDTE: 28,
  TSLY: 55, NVDY: 50, CONY: 70, ULTY: 55, YMAX: 40, YMAG: 35,
  QQQY: 50, IWMY: 55, JEPY: 35,
  FEPI: 20, AIPI: 25, SPYI: 12, QDVO: 10,
  JEPI: 7.5, JEPQ: 9.5,
  CLM: 18, CRF: 18, OXLC: 18,
  GOF: 14, PTY: 10, RIV: 12, KLIP: 35,
  BST: 6, BDJ: 7, STK: 7, USA: 10, EOS: 8,
  SCHD: 3.5, DIVO: 4.5,
};

function getFreq(symbol: string): PayFreq {
  if (WEEKLY_PAYERS.has(symbol)) return 'weekly';
  if (MONTHLY_PAYERS.has(symbol)) return 'monthly';
  if (QUARTERLY_PAYERS.has(symbol)) return 'quarterly';
  return 'quarterly';
}

function estimateAnnualIncome(pos: EnrichedPosition): number {
  const symbol = (pos.instrument?.symbol ?? '').toUpperCase();
  // 1) Live quote yield
  const qYield = pos.quote?.divYield;
  if (qYield && qYield > 0 && pos.marketValue > 0) {
    return pos.marketValue * (qYield / 100);
  }
  // 2) Live per-payment amount × frequency
  const divAmt = pos.quote?.divAmount;
  if (divAmt && divAmt > 0 && pos.longQuantity > 0) {
    const freq = getFreq(symbol);
    const perYear = freq === 'weekly' ? 52 : freq === 'monthly' ? 12 : freq === 'quarterly' ? 4 : 1;
    return divAmt * perYear * pos.longQuantity;
  }
  // 3) Conservative fallback yield
  const fb = FALLBACK_YIELD_PCT[symbol];
  if (fb && fb > 0 && pos.marketValue > 0) {
    return pos.marketValue * (fb / 100);
  }
  return 0;
}

const QUARTERLY_MONTHS = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec

function distributeAnnualToMonths(annual: number, freq: PayFreq): number[] {
  const months = new Array(12).fill(0);
  if (annual <= 0) return months;
  switch (freq) {
    case 'weekly':
      for (let i = 0; i < 12; i++) months[i] = annual / 12; // even monthly equivalent
      break;
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

function DividendCalendarSection({ positions }: { positions: EnrichedPosition[]; dividends: DividendRecord[] }) {
  // Build a forward-looking 12-month forecast from current holdings
  const forecast: { symbol: string; freq: PayFreq; annual: number; months: number[] }[] = [];
  const totalsByMonth = new Array(12).fill(0);

  for (const p of positions) {
    const symbol = (p.instrument?.symbol ?? '').toUpperCase();
    if (!symbol || symbol.includes(' ') || p.instrument?.assetType === 'OPTION') continue;
    if ((p.currentValue ?? 0) < 100) continue;

    const annual = estimateAnnualIncome(p);
    if (annual < 1) continue;
    const freq = getFreq(symbol);
    const months = distributeAnnualToMonths(annual, freq);
    for (let i = 0; i < 12; i++) totalsByMonth[i] += months[i];
    forecast.push({ symbol, freq, annual, months });
  }

  forecast.sort((a, b) => b.annual - a.annual);

  const annualTotal = totalsByMonth.reduce((s, v) => s + v, 0);
  const avgMonthly = annualTotal / 12;
  const currentMo = new Date().getMonth();
  const maxMonth = Math.max(...totalsByMonth, 1);

  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const monthly = forecast.filter((f) => f.freq === 'monthly' || f.freq === 'weekly');
  const quarterly = forecast.filter((f) => f.freq === 'quarterly');

  return (
    <div className="space-y-4 px-1">
      <div className="text-xs text-[#7c82a0] bg-[#0f1117] rounded-lg p-3 border border-[#2d3248]">
        <span className="text-emerald-400 font-semibold">Forward-looking estimate</span> — built from your
        current holdings × per-ticker yield/frequency. Actual payments may vary; use this to plan the
        next 12 months of income, not as a declared-dividend calendar.
      </div>

      {/* Monthly forecast bar chart */}
      <div className="bg-[#0f1117] rounded-lg p-3 border border-[#2d3248] space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[#7c82a0] flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Next 12 months — estimated
          </span>
          <span className="text-emerald-400 font-semibold">
            ~{fmt$(annualTotal, true)}/yr · {fmt$(avgMonthly, true)}/mo avg
          </span>
        </div>
        <div className="space-y-1">
          {totalsByMonth.map((v, i) => {
            const pct = maxMonth > 0 ? (v / maxMonth) * 100 : 0;
            const isCurrent = i === currentMo;
            return (
              <div key={i} className="flex items-center gap-2">
                <span className={`text-xs w-8 text-right ${isCurrent ? 'text-white font-semibold' : 'text-[#7c82a0]'}`}>
                  {MONTH_LABELS[i]}
                </span>
                <div className="flex-1 h-4 bg-[#1a1d27] rounded relative overflow-hidden">
                  <div
                    className={`h-full ${isCurrent ? 'bg-violet-500' : 'bg-emerald-500/60'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={`text-xs w-16 text-right font-mono ${isCurrent ? 'text-violet-300 font-semibold' : 'text-[#7c82a0]'}`}>
                  {fmt$(v, true)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Frequency groupings */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-[#0f1117] rounded-lg p-3">
          <div className="text-xs text-[#7c82a0] mb-2 flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Monthly / Weekly payers ({monthly.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {monthly.length === 0 ? (
              <span className="text-xs text-[#4a5070]">None held</span>
            ) : (
              monthly.map((f) => (
                <span key={f.symbol} className="bg-emerald-500/15 text-emerald-300 text-xs px-2 py-0.5 rounded font-mono">
                  {f.symbol}
                </span>
              ))
            )}
          </div>
          <div className="mt-2 text-xs text-emerald-400 font-semibold">
            {fmt$(monthly.reduce((s, f) => s + f.annual / 12, 0), true)}/mo avg
          </div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3">
          <div className="text-xs text-[#7c82a0] mb-2 flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Quarterly payers ({quarterly.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {quarterly.length === 0 ? (
              <span className="text-xs text-[#4a5070]">None held</span>
            ) : (
              quarterly.map((f) => (
                <span key={f.symbol} className="bg-blue-500/15 text-blue-300 text-xs px-2 py-0.5 rounded font-mono">
                  {f.symbol}
                </span>
              ))
            )}
          </div>
          <div className="mt-2 text-xs text-blue-400 font-semibold">
            {fmt$(quarterly.reduce((s, f) => s + f.annual / 12, 0), true)}/mo avg
          </div>
        </div>
      </div>

      {/* Per-ticker forecast table */}
      {forecast.length > 0 && (
        <div className="bg-[#0f1117] rounded-lg p-3 border border-[#2d3248] overflow-x-auto">
          <div className="text-xs text-[#7c82a0] mb-2">Estimated distributions per holding (next 12 months)</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#2d3248] text-[#4a5070]">
                <th className="text-left px-2 py-1.5 font-medium">Symbol</th>
                <th className="text-left px-2 py-1.5 font-medium">Freq</th>
                <th className="text-right px-2 py-1.5 font-medium">Est. / yr</th>
                <th className="text-right px-2 py-1.5 font-medium">Est. / mo</th>
              </tr>
            </thead>
            <tbody>
              {forecast.map((f) => (
                <tr key={f.symbol} className="border-b border-[#1a1d27] hover:bg-[#0f1117]">
                  <td className="px-2 py-2 font-mono font-semibold text-white">{f.symbol}</td>
                  <td className="px-2 py-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      f.freq === 'weekly'    ? 'bg-violet-500/20 text-violet-300' :
                      f.freq === 'monthly'   ? 'bg-emerald-500/20 text-emerald-300' :
                      f.freq === 'quarterly' ? 'bg-blue-500/20 text-blue-300' :
                                               'bg-[#2d3248] text-[#7c82a0]'
                    }`}>
                      {f.freq}
                    </span>
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-emerald-400">{fmt$(f.annual, true)}</td>
                  <td className="text-right px-2 py-2 font-mono text-[#7c82a0]">{fmt$(f.annual / 12, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs text-[#4a5070] bg-[#0f1117] rounded-lg p-3">
        <span className="text-[#7c82a0] font-medium">Income Smoothing Tip: </span>
        Monthly payers (CLM, CRF, OXLC, Yieldmax family) provide consistent cash flow — ideal for covering monthly bills without timing the market.
      </div>
    </div>
  );
}

// ─── Section 6: Margin Coverage ───────────────────────────────────────────────

function MarginCoverageSection({
  dividends,
  marginBalance,
  totalValue,
}: {
  dividends: DividendRecord[];
  marginBalance: number;
  totalValue: number;
}) {
  const byMonth = groupByMonth(dividends);
  const months = last12Months();
  const values = months.map((m) => byMonth[m] ?? 0);
  const monthlyAvg = values.reduce((s, v) => s + v, 0) / 12;

  // Estimate annual margin interest at ~8.5% (Schwab standard margin rate approximation)
  const annualMarginInterest = marginBalance > 0 ? marginBalance * 0.085 : 0;
  const monthlyMarginInterest = annualMarginInterest / 12;

  const coverageRatio = monthlyMarginInterest > 0 ? monthlyAvg / monthlyMarginInterest : Infinity;
  const isFullyCovered = coverageRatio >= 1;
  const marginPct = totalValue > 0 ? (marginBalance / totalValue) * 100 : 0;

  return (
    <div className="space-y-4 px-1">
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

      {/* Coverage status */}
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
              : `Dividends don't fully cover margin interest. Gap: ${fmt$Dec(monthlyMarginInterest - monthlyAvg)}/mo. Consider reducing margin or growing income.`
          }
        </span>
      </div>

      {/* Margin threshold indicators */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[#7c82a0]">Margin Utilization</span>
          <span className={`font-semibold ${
            marginPct > 50 ? 'text-red-400' :
            marginPct > 30 ? 'text-orange-400' :
            'text-emerald-400'
          }`}>{marginPct.toFixed(1)}%</span>
        </div>
        <div className="w-full bg-[#2d3248] rounded-full h-3 relative overflow-hidden">
          <div
            className={`h-full rounded-full ${
              marginPct > 50 ? 'bg-red-500' :
              marginPct > 30 ? 'bg-orange-500' :
              'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(marginPct * 2, 100)}%` }}
          />
          {/* Threshold markers */}
          <div className="absolute top-0 h-full w-px bg-orange-400/60" style={{ left: '60%' }} />
          <div className="absolute top-0 h-full w-px bg-red-400/60" style={{ left: '100%' }} />
        </div>
        <div className="flex justify-between text-xs text-[#4a5070]">
          <span>0%</span>
          <span className="text-orange-400">30% warn</span>
          <span className="text-red-400">50% MAX</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function DividendIncomePanel({ positions, totalValue, marginBalance = 0 }: Props) {
  const [data, setData] = useState<DividendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    monthly: true,
    symbols: false,
    fire: true,
    maintenance: false,
    calendar: false,
    margin: true,
  });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/dividends');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dividend data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  function toggle(key: string) {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const dividends = data?.dividends ?? [];
  const marginDebt = Math.abs(marginBalance); // marginBalance is typically negative

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-2">
      {/* Panel header */}
      <div className="flex items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">Income & Dividend Dashboard</h2>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <span className="text-xs text-[#4a5070]">
              {data.startDate} → {data.endDate}
            </span>
          )}
          {loading && (
            <div className="w-4 h-4 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/25 text-red-300 text-xs rounded-lg p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="divide-y divide-[#2d3248]">
        {/* 1. Monthly Income */}
        <div>
          <SectionHeader
            icon={<BarChart2 className="w-4 h-4 text-emerald-400" />}
            title="Monthly Income (12-Month History)"
            open={openSections.monthly}
            onToggle={() => toggle('monthly')}
          />
          {openSections.monthly && (
            <div className="pb-4 pt-2">
              {loading ? (
                <div className="text-xs text-[#7c82a0] px-4">Loading…</div>
              ) : (
                <MonthlyIncomeSection dividends={dividends} />
              )}
            </div>
          )}
        </div>

        {/* 2. Per-Symbol Breakdown */}
        <div>
          <SectionHeader
            icon={<Layers className="w-4 h-4 text-purple-400" />}
            title="Dividend Leaders by Symbol"
            open={openSections.symbols}
            onToggle={() => toggle('symbols')}
          />
          {openSections.symbols && (
            <div className="pb-4 pt-2">
              {loading ? (
                <div className="text-xs text-[#7c82a0] px-4">Loading…</div>
              ) : (
                <SymbolBreakdownSection dividends={dividends} />
              )}
            </div>
          )}
        </div>

        {/* 3. FIRE Progress */}
        <div>
          <SectionHeader
            icon={<Flame className="w-4 h-4 text-orange-400" />}
            title="FIRE Progress Tracker"
            open={openSections.fire}
            onToggle={() => toggle('fire')}
          />
          {openSections.fire && (
            <div className="pb-4 pt-2">
              {loading ? (
                <div className="text-xs text-[#7c82a0] px-4">Loading…</div>
              ) : (
                <FireProgressSection dividends={dividends} marginBalance={marginDebt} />
              )}
            </div>
          )}
        </div>

        {/* 4. Maintenance Hierarchy */}
        <div>
          <SectionHeader
            icon={<TrendingUp className="w-4 h-4 text-red-400" />}
            title="Pressure Valve Hierarchy — What to Sell First"
            open={openSections.maintenance}
            onToggle={() => toggle('maintenance')}
          />
          {openSections.maintenance && (
            <div className="pb-4 pt-2">
              <MaintenanceHierarchySection positions={positions} />
            </div>
          )}
        </div>

        {/* 5. Dividend Calendar */}
        <div>
          <SectionHeader
            icon={<Calendar className="w-4 h-4 text-blue-400" />}
            title="Dividend Payment Calendar (Forward-Looking)"
            open={openSections.calendar}
            onToggle={() => toggle('calendar')}
          />
          {openSections.calendar && (
            <div className="pb-4 pt-2">
              {loading ? (
                <div className="text-xs text-[#7c82a0] px-4">Loading…</div>
              ) : (
                <DividendCalendarSection positions={positions} dividends={dividends} />
              )}
            </div>
          )}
        </div>

        {/* 6. Margin Coverage */}
        <div>
          <SectionHeader
            icon={<Target className="w-4 h-4 text-yellow-400" />}
            title="Margin Interest Coverage"
            open={openSections.margin}
            onToggle={() => toggle('margin')}
          />
          {openSections.margin && (
            <div className="pb-4 pt-2">
              {loading ? (
                <div className="text-xs text-[#7c82a0] px-4">Loading…</div>
              ) : (
                <MarginCoverageSection
                  dividends={dividends}
                  marginBalance={marginDebt}
                  totalValue={totalValue}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
