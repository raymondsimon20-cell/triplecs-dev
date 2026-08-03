'use client';

/**
 * DividendsView — dividend income page.
 * Trailing stats → projections → projected 12-month chart → trailing
 * 12-month chart → by-symbol table. Data: /api/dividends records (fetched by
 * the page shell) + current positions for forward projections.
 *
 * Cadence is derived from observed payment spacing (lib/portfolio/dividend-cadence),
 * not the hand-maintained FREQ_MAP, which had gone stale on the YieldMax weeklies.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { BarChart as RBarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { StatCard as Stat } from '@/components/StatCard';
import { TickerAvatar, TableSkeleton } from '@/components/polish';
import { CalendarDays, ChevronRight, Coins, DollarSign, Download, Gauge, Hash, Percent, TrendingUp } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { estimateAnnualDividend, getFrequency } from '@/components/IncomeHub';
import { useSort, SortTh } from '@/components/sortable';
import {
  deriveCadence, annualiseFromHistory, projectDividendDates, distributeAnnualToMonths,
  CADENCE_LABEL, type Cadence, type CadenceResult,
} from '@/lib/portfolio/dividend-cadence';

export interface DividendRecord {
  date:        string;
  description: string;
  amount:      number;
  symbol:      string;
}

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(`${s}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Map the legacy FREQ_MAP vocabulary onto Cadence, for the thin-history fallback. */
const LEGACY_TO_CADENCE: Record<string, Cadence> = {
  weekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', annual: 'annual',
};

const CADENCE_CHIP: Record<Cadence, string> = {
  weekly:        'bg-violet-500/15 text-violet-300',
  'bi-weekly':   'bg-fuchsia-500/15 text-fuchsia-300',
  monthly:       'bg-emerald-500/15 text-emerald-300',
  quarterly:     'bg-blue-500/15 text-blue-300',
  'semi-annual': 'bg-cyan-500/15 text-cyan-300',
  annual:        'bg-amber-500/15 text-amber-300',
  irregular:     'bg-orange-500/15 text-orange-300',
  unknown:       'bg-[#2d3248] text-[#9aa2c0]',
};

function BarChart({ labels, values, color }: { labels: string[]; values: number[]; color: string }) {
  const data = labels.map((label, i) => ({ label, value: Math.round(values[i] * 100) / 100 }));
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <RBarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <XAxis dataKey="label" tick={{ fill: '#4a5070', fontSize: 10 }} axisLine={{ stroke: '#1f2334' }} tickLine={false} interval={0} angle={-30} height={38} textAnchor="end" />
          <YAxis
            tick={{ fill: '#4a5070', fontSize: 10 }}
            tickFormatter={(v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v}`)}
            axisLine={false} tickLine={false} width={44}
          />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            contentStyle={{ background: '#1a1d27', border: '1px solid #3d4468', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#7c82a0' }}
            formatter={(v) => [fmt$(Number(v)), 'Income']}
          />
          <Bar dataKey="value" fill={color} fillOpacity={0.85} radius={[3, 3, 0, 0]} maxBarSize={32} />
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Declared dividend dates from Schwab fundamentals, via /api/dividend-calendar. */
interface DeclaredDates {
  nextExDate:  string | null;
  nextPayDate: string | null;
}

interface Coverage {
  requested:       number;
  resolved:        number;
  withNextExDate:  number;
  withNextPayDate: number;
}

interface SymbolRow {
  sym:         string;
  /** Currently held. False for symbols that paid in the past but have since been sold. */
  held:        boolean;
  cadence:     CadenceResult;
  cadenceLabel:string;
  t12m:        number;
  allTime:     number;
  payments:    number;
  avg:         number;
  last:        string | null;
  exDate:      string | null;
  payDate:     string | null;
  /** True when ex/pay came from Schwab's declared data rather than extrapolation. */
  datesDeclared: boolean;
  projAnnual:  number;
  yieldOnCost: number;
  forwardYield:number;
  history:     { date: string; amount: number }[];
}

interface Props {
  dividends: DividendRecord[];
  loading:   boolean;
  positions: EnrichedPosition[];
}

export function DividendsView({ dividends, loading, positions }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [declared, setDeclared] = useState<Record<string, DeclaredDates>>({});
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  const toggleRow = (sym: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym); else next.add(sym);
      return next;
    });

  // ── Declared dividend dates (Schwab fundamentals) ───────────────────────────
  // Symbols come from held positions, since that is what a forward calendar is
  // for. Failure is non-fatal: rows fall back to the cadence-derived estimate.
  const calendarSymbols = useMemo(() => Array.from(new Set(
    positions
      .filter((p) => p.instrument?.assetType !== 'OPTION' && !p.instrument.symbol.includes(' '))
      .map((p) => p.instrument.symbol.toUpperCase()),
  )).sort(), [positions]);

  useEffect(() => {
    if (calendarSymbols.length === 0) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/dividend-calendar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: calendarSymbols }),
        });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;

        const map: Record<string, DeclaredDates> = {};
        for (const [sym, d] of Object.entries(json.dates ?? {})) {
          const entry = d as { nextExDate?: string | null; nextPayDate?: string | null };
          map[sym] = { nextExDate: entry.nextExDate ?? null, nextPayDate: entry.nextPayDate ?? null };
        }
        setDeclared(map);
        if (json.coverage) setCoverage(json.coverage as Coverage);
      } catch (err) {
        console.warn('[DividendsView] declared dividend dates unavailable:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [calendarSymbols]);

  // ── Trailing 12-month aggregation ───────────────────────────────────────────
  const trailing = useMemo(() => {
    const months: { key: string; label: string }[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      });
    }
    // Anything on or after this date counts toward the trailing-12M figures;
    // everything is retained for all-time.
    const cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
      .toISOString().slice(0, 10);

    const byMonth = new Map<string, number>();
    const bySymbol = new Map<string, {
      t12m: number; allTime: number; count12m: number;
      history: { date: string; amount: number }[];
    }>();
    let total = 0, allTimeTotal = 0, payments = 0;

    for (const r of dividends) {
      allTimeTotal += r.amount;
      const s = bySymbol.get(r.symbol) ?? { t12m: 0, allTime: 0, count12m: 0, history: [] };
      s.allTime += r.amount;
      s.history.push({ date: r.date, amount: r.amount });
      if (r.date >= cutoff) {
        total += r.amount;
        payments += 1;
        s.t12m += r.amount;
        s.count12m += 1;
        byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + r.amount);
      }
      bySymbol.set(r.symbol, s);
    }

    const monthValues = months.map((m) => byMonth.get(m.key) ?? 0);
    return {
      months, monthValues, total, allTimeTotal, payments, bySymbol,
      activeMonths: monthValues.filter((v) => v > 0).length,
    };
  }, [dividends]);

  // ── Per-symbol cadence + projections ────────────────────────────────────────
  // Cadence comes from payment spacing; the annual estimate prefers that history
  // and only falls back to Schwab's quoted yield when history is too thin.
  const symbolRows = useMemo<SymbolRow[]>(() => {
    const posBySym = new Map(positions.map((p) => [p.instrument.symbol, p]));

    return Array.from(trailing.bySymbol.entries()).map(([sym, s]) => {
      const history = [...s.history].sort((a, b) => b.date.localeCompare(a.date));
      const fallback = LEGACY_TO_CADENCE[getFrequency(sym)] ?? 'unknown';
      const cadence = deriveCadence(history.map((h) => h.date), fallback);
      const estimated = projectDividendDates(cadence);

      // Declared beats derived. Schwab covers these only patchily, so fall back
      // per-field rather than all-or-nothing — a symbol may have a declared
      // ex-date with no pay date yet.
      const dec = declared[sym];
      const exDate = dec?.nextExDate ?? estimated.exDate;
      const payDate = dec?.nextPayDate ?? estimated.payDate;
      const datesDeclared = Boolean(dec?.nextExDate || dec?.nextPayDate);

      const pos = posBySym.get(sym);
      const cost = pos ? (pos.averagePrice ?? 0) * (pos.longQuantity ?? 0) : 0;
      const value = pos ? Math.abs(pos.marketValue ?? 0) : 0;

      // Prefer history-derived annualisation once we have a real cadence and at
      // least two observations; otherwise use the quote-based estimate.
      const fromHistory = annualiseFromHistory(history, cadence);
      const fromQuote = pos ? estimateAnnualDividend(pos) : 0;
      const projAnnual = cadence.derived && fromHistory > 0 ? fromHistory : fromQuote;

      return {
        sym,
        held: Boolean(pos),
        cadence,
        cadenceLabel: CADENCE_LABEL[cadence.cadence],
        t12m: s.t12m,
        allTime: s.allTime,
        payments: s.count12m,
        avg: s.count12m > 0 ? s.t12m / s.count12m : 0,
        last: cadence.lastPaymentDate,
        exDate,
        payDate,
        datesDeclared,
        projAnnual,
        yieldOnCost: cost > 0 ? (projAnnual / cost) * 100 : 0,
        forwardYield: value > 0 ? (projAnnual / value) * 100 : 0,
        history,
      };
    }).sort((a, b) => b.t12m - a.t12m);
  }, [trailing.bySymbol, positions, declared]);

  // ── Portfolio-level projection ──────────────────────────────────────────────
  const projection = useMemo(() => {
    const rowBySym = new Map(symbolRows.map((r) => [r.sym, r]));
    const monthTotals = new Array(12).fill(0);
    const nowM = new Date().getMonth();
    let annual = 0, payerValue = 0, costBasis = 0, payerCount = 0;

    for (const p of positions) {
      if (p.instrument?.assetType === 'OPTION' || p.instrument.symbol.includes(' ')) continue;
      // Single source of truth — see enrichPositions.
      costBasis += Math.abs(p.costBasis ?? 0);

      const row = rowBySym.get(p.instrument.symbol);
      const est = row ? row.projAnnual : estimateAnnualDividend(p);
      if (est < 0.5) continue;

      annual += est;
      payerValue += Math.abs(p.marketValue ?? 0);
      payerCount += 1;

      const cadence = row?.cadence.cadence
        ?? (LEGACY_TO_CADENCE[getFrequency(p.instrument.symbol)] ?? 'unknown');
      const anchor = row?.last ? new Date(`${row.last}T12:00:00`).getMonth() : null;
      const dist = distributeAnnualToMonths(est, cadence, nowM, anchor);
      for (let i = 0; i < 12; i += 1) monthTotals[i] += dist[i];
    }

    const labels: string[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    }
    return {
      annual, monthTotals, labels, payerCount,
      yieldOnCost: costBasis > 0 ? (annual / costBasis) * 100 : 0,
      forwardYield: payerValue > 0 ? (annual / payerValue) * 100 : 0,
      totalSymbols: positions.filter((p) => !p.instrument.symbol.includes(' ')).length,
      derivedCount: symbolRows.filter((r) => r.cadence.derived).length,
    };
  }, [positions, symbolRows]);

  // Why rows fall back, so the disclaimer can say something useful rather than
  // just reporting a ratio the reader has to interpret.
  const sourceStats = useMemo(() => {
    const fallbacks = symbolRows.filter((r) => !r.cadence.derived);
    return {
      historicalOnly: symbolRows.filter((r) => !r.held).length,
      // Fewer than two payments means cadence is unmeasurable, not unknown.
      singlePayment:  fallbacks.filter((r) => r.cadence.observations <= 1).length,
    };
  }, [symbolRows]);

  const { sortKey, sortDir, requestSort, sortRows } = useSort<SymbolRow>('t12m');
  const sortedRows = useMemo(() => sortRows(symbolRows, {
    sym:          (r) => r.sym,
    cadenceLabel: (r) => r.cadenceLabel,
    t12m:         (r) => r.t12m,
    allTime:      (r) => r.allTime,
    yieldOnCost:  (r) => r.yieldOnCost,
    forwardYield: (r) => r.forwardYield,
    projAnnual:   (r) => r.projAnnual,
    payments:     (r) => r.payments,
    avg:          (r) => r.avg,
    last:         (r) => r.last ?? '',
    exDate:       (r) => r.exDate ?? '',
    payDate:      (r) => r.payDate ?? '',
  }), [symbolRows, sortRows]);

  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, 25);
  const asOf = new Date().toISOString().split('T')[0];

  const exportCsv = () => {
    const header = ['Symbol', 'Cadence', 'Cadence Source', 'T12M', 'All-Time', 'YoC %', 'Fwd %', 'Proj. Annual', 'Payments (12M)', 'Avg Payment', 'Last Payment', 'Ex-Date', 'Pay Date', 'Date Source'];
    const lines = sortedRows.map((r) => [
      r.sym, r.cadenceLabel, r.cadence.derived ? 'derived' : 'fallback',
      r.t12m.toFixed(2), r.allTime.toFixed(2), r.yieldOnCost.toFixed(2), r.forwardYield.toFixed(2),
      r.projAnnual.toFixed(2), String(r.payments), r.avg.toFixed(2),
      r.last ?? '', r.exDate ?? '', r.payDate ?? '', r.datesDeclared ? 'declared' : 'estimated',
    ]);
    const csv = [header, ...lines]
      .map((row) => row.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `dividends-${asOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const COLS = 12;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <DollarSign className="w-[18px] h-[18px] text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Dividend Income</h1>
            <p className="text-xs text-[#7c82a0] mt-0.5">As of {asOf}</p>
          </div>
        </div>
        <button
          onClick={exportCsv}
          disabled={sortedRows.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {loading && <div className="text-xs text-[#7c82a0]">Loading dividend history…</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={DollarSign} label="Trailing 12M Income" value={fmt$(trailing.total)} sub={`${trailing.activeMonths}/12 months active`} valueClass="text-emerald-400" accentClass="border-t-emerald-500/60" index={0} />
        <Stat icon={CalendarDays} label="Monthly Average" value={fmt$(trailing.total / 12)} accentClass="border-t-emerald-500/60" index={1} />
        <Stat icon={Hash} label="Dividend Symbols" value={String(trailing.bySymbol.size)} sub={`${trailing.payments} payments in 12M`} accentClass="border-t-emerald-500/60" index={0} />
        <Stat icon={Coins} label="All-Time Income" value={fmt$(trailing.allTimeTotal)} accentClass="border-t-emerald-500/60" index={1} />
      </div>

      <div className="text-xs font-semibold text-[#9aa2c0] uppercase tracking-wider pt-1">Projections</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={TrendingUp} label="Est. Annual Income" value={fmt$(projection.annual)} valueClass="text-violet-300" accentClass="border-t-emerald-500/60" index={2} />
        <Stat icon={CalendarDays} label="Est. Monthly Income" value={fmt$(projection.annual / 12)} valueClass="text-violet-300" accentClass="border-t-emerald-500/60" index={5} />
        <Stat icon={Percent} label="Yield on Cost" value={`${projection.yieldOnCost.toFixed(2)}%`} sub={`${projection.payerCount} of ${projection.totalSymbols} symbols`} accentClass="border-t-emerald-500/60" index={3} />
        <Stat icon={Gauge} label="Forward Yield" value={`${projection.forwardYield.toFixed(2)}%`} accentClass="border-t-emerald-500/60" index={4} />
      </div>
      <p className="text-[10px] text-[#4a5070]">
        Projected income is an estimate.{' '}
        <strong className="text-[#7c82a0] font-medium">Cadence</strong> is derived from payment
        history for {projection.derivedCount} of {symbolRows.length} symbols in this table
        {sourceStats.historicalOnly > 0 && <> (which includes {sourceStats.historicalOnly} no
        longer held)</>}
        . The other {symbolRows.length - projection.derivedCount} fall back to the static frequency
        table{sourceStats.singlePayment > 0 && <>, almost all because they have only one payment on
        record — two are needed to measure spacing, so newer positions resolve on their next
        distribution</>}
        .{' '}
        <strong className="text-[#7c82a0] font-medium">Ex-dates and pay dates</strong>{' '}
        {coverage
          ? <>are declared by the issuer for {coverage.withNextExDate} of your {coverage.requested}{' '}
             current holdings (via Schwab fundamentals). A forward calendar only applies to what you
             still own, which is why that count differs from the table above. The remainder are{' '}
             <span className="italic">estimated from cadence</span> and shown in grey italics.</>
          : <>are estimated from cadence until declared data loads.</>}
        {' '}Past distributions are not a guarantee of future distributions and actual income may
        differ materially.
      </p>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="mb-3">
          <span className="text-sm font-semibold text-white">Projected Future Payments (Next 12 Months)</span>
          <div className="text-[10px] text-[#4a5070]">12-month projected total: {fmt$(projection.annual)}</div>
        </div>
        <BarChart labels={projection.labels} values={projection.monthTotals} color="#8b5cf6" />
      </div>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="mb-3">
          <span className="text-sm font-semibold text-white">Monthly Dividend Income (Trailing 12 Months)</span>
          <div className="text-[10px] text-[#4a5070]">12-month total: {fmt$(trailing.total)} (current month may be partial)</div>
        </div>
        <BarChart labels={trailing.months.map((m) => m.label)} values={trailing.monthValues} color="#10b981" />
      </div>

      {/* By-symbol table */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1f2334] flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Dividends by Symbol</span>
          <span className="text-[10px] text-[#4a5070]">Click a row to see payment history</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1a1e2e]">
                <th className="w-6" aria-label="Expand" />
                <SortTh id="sym"          label="Symbol"       first sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="cadenceLabel" label="Cadence"      sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="t12m"         label="T12M"         align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="allTime"      label="All-Time"     align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="yieldOnCost"  label="YoC %"        align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="forwardYield" label="Fwd %"        align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="projAnnual"   label="Proj. Annual" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="payments"     label="Payments"     align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="avg"          label="Avg Payment"  align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="last"         label="Last Payment" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="exDate"       label="Ex-Date"      align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="payDate"      label="Pay Date"     align="right" last sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
              </tr>
            </thead>
            <tbody>
              {loading && symbolRows.length === 0 && <TableSkeleton cols={COLS} rows={6} />}
              {symbolRows.length === 0 && !loading && (
                <tr><td colSpan={COLS + 1} className="px-4 py-6 text-[#4a5070]">No dividend payments in the trailing window.</td></tr>
              )}
              {visibleRows.map((r) => {
                const isOpen = expanded.has(r.sym);
                return (
                  <React.Fragment key={r.sym}>
                    <tr
                      onClick={() => toggleRow(r.sym)}
                      className="border-b border-[#1a1e2e] hover:bg-[#161a28] cursor-pointer"
                    >
                      <td className="pl-3">
                        <ChevronRight className={`w-3.5 h-3.5 text-[#4a5070] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      </td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-2">
                          <TickerAvatar symbol={r.sym} size="sm" />
                          <span className="font-mono font-semibold text-white">{r.sym}</span>
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${CADENCE_CHIP[r.cadence.cadence]}`}
                          title={r.cadence.derived
                            ? `Derived from ${r.cadence.observations} payments, median ${r.cadence.medianGapDays}d apart`
                            : 'Fallback — not enough payment history to derive'}
                        >
                          {r.cadenceLabel}
                        </span>
                        {!r.cadence.derived && r.cadence.cadence !== 'unknown' && (
                          <span className="ml-1 text-[9px] text-[#4a5070]">est</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-emerald-400">{fmt$(r.t12m)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{fmt$(r.allTime)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{r.yieldOnCost > 0 ? `${r.yieldOnCost.toFixed(2)}%` : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{r.forwardYield > 0 ? `${r.forwardYield.toFixed(2)}%` : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-violet-300">{r.projAnnual > 0 ? fmt$(r.projAnnual) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{r.payments}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{fmt$(r.avg)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-[#7c82a0] whitespace-nowrap">{fmtDate(r.last)}</td>
                      <td
                        className={`px-2 py-2 text-right tabular-nums whitespace-nowrap ${r.datesDeclared ? 'text-[#9aa2c0]' : 'text-[#5a6080] italic'}`}
                        title={r.datesDeclared ? 'Declared by the issuer (Schwab fundamentals)' : 'Estimated from payment cadence — not declared'}
                      >
                        {fmtDate(r.exDate)}
                      </td>
                      <td
                        className={`px-4 py-2 text-right tabular-nums whitespace-nowrap ${r.datesDeclared ? 'text-[#9aa2c0]' : 'text-[#5a6080] italic'}`}
                        title={r.datesDeclared ? 'Declared by the issuer (Schwab fundamentals)' : 'Estimated from payment cadence — not declared'}
                      >
                        {fmtDate(r.payDate)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-[#1a1e2e] bg-[#0e111a]">
                        <td colSpan={COLS + 1} className="px-10 py-3">
                          <div className="text-[10px] text-[#7c82a0] mb-2">
                            {r.history.length} payment{r.history.length === 1 ? '' : 's'} on record
                            {r.cadence.derived && ` · median ${r.cadence.medianGapDays} days apart`}
                          </div>
                          <div className="max-h-56 overflow-y-auto">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="text-[#4a5070]">
                                  <th className="text-left font-medium py-1">Pay Date</th>
                                  <th className="text-right font-medium py-1">Amount</th>
                                  <th className="text-right font-medium py-1">Days Since Prior</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.history.map((h, i) => {
                                  const prior = r.history[i + 1];
                                  const gap = prior
                                    ? Math.round((Date.parse(`${h.date}T12:00:00Z`) - Date.parse(`${prior.date}T12:00:00Z`)) / 86_400_000)
                                    : null;
                                  return (
                                    <tr key={`${h.date}-${i}`} className="border-t border-[#161a28]">
                                      <td className="py-1 text-[#9aa2c0] tabular-nums">{fmtDate(h.date)}</td>
                                      <td className="py-1 text-right text-emerald-400 tabular-nums">{fmt$(h.amount)}</td>
                                      <td className="py-1 text-right text-[#4a5070] tabular-nums">{gap === null ? '—' : `${gap}d`}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {symbolRows.length > 25 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full px-4 py-2.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-[#161a28] transition-colors"
          >
            {showAll ? 'Show top 25' : `Show all ${symbolRows.length} symbols`}
          </button>
        )}
      </div>
    </div>
  );
}
