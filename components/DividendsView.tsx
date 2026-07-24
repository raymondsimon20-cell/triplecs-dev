'use client';

/**
 * DividendsView — dividend income page (P2P-style redesign, page 5).
 * Trailing stats → projections → projected 12-month chart → trailing
 * 12-month chart → by-symbol table. Data: /api/dividends records (fetched by
 * the page shell) + current positions for forward projections.
 */

import React, { useMemo, useState } from 'react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { estimateAnnualDividend, getFrequency, distributeToMonths } from '@/components/IncomeHub';

export interface DividendRecord {
  date:        string;
  description: string;
  amount:      number;
  symbol:      string;
}

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

const FREQ_LABEL: Record<string, string> = {
  weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual',
};

function Stat({ label, value, sub, valueClass = 'text-white' }: {
  label: string; value: string; sub?: string; valueClass?: string;
}) {
  return (
    <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3.5">
      <div className="text-[11px] text-[#7c82a0] mb-1">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-[#4a5070] mt-0.5">{sub}</div>}
    </div>
  );
}

function BarChart({ labels, values, barClass }: { labels: string[]; values: number[]; barClass: string }) {
  const max = Math.max(...values, 1);
  return (
    <div>
      <div className="flex items-end gap-1.5 h-36">
        {values.map((v, i) => (
          <div key={i} className="flex-1 flex flex-col justify-end h-full" title={`${labels[i]}: ${fmt$(v)}`}>
            <div className={`${barClass} rounded-t-sm`} style={{ height: `${(v / max) * 100}%`, minHeight: v > 0 ? '3px' : '0' }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {labels.map((l, i) => (
          <div key={i} className="flex-1 text-center text-[9px] text-[#4a5070] truncate">{l}</div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  dividends: DividendRecord[];
  loading:   boolean;
  positions: EnrichedPosition[];
}

export function DividendsView({ dividends, loading, positions }: Props) {
  const [showAll, setShowAll] = useState(false);

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
    const byMonth = new Map<string, number>();
    const bySymbol = new Map<string, { total: number; count: number; last: string }>();
    let total = 0, payments = 0;
    for (const r of dividends) {
      total += r.amount;
      payments += 1;
      byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + r.amount);
      const s = bySymbol.get(r.symbol) ?? { total: 0, count: 0, last: '' };
      s.total += r.amount; s.count += 1;
      if (r.date > s.last) s.last = r.date;
      bySymbol.set(r.symbol, s);
    }
    const monthValues = months.map((m) => byMonth.get(m.key) ?? 0);
    return {
      months, monthValues, total, payments, bySymbol,
      activeMonths: monthValues.filter((v) => v > 0).length,
    };
  }, [dividends]);

  // ── Forward projections ─────────────────────────────────────────────────────
  const projection = useMemo(() => {
    let annual = 0, payerValue = 0, costBasis = 0, payerCount = 0;
    const monthTotals = new Array(12).fill(0);
    const bySymbolAnnual = new Map<string, number>();
    for (const p of positions) {
      if (p.instrument?.assetType === 'OPTION' || p.instrument.symbol.includes(' ')) continue;
      costBasis += (p.averagePrice ?? 0) * (p.longQuantity ?? 0);
      const est = estimateAnnualDividend(p);
      if (est < 0.5) continue;
      annual += est;
      payerValue += Math.abs(p.marketValue ?? 0);
      payerCount += 1;
      bySymbolAnnual.set(p.instrument.symbol, est);
      const dist = distributeToMonths(est, getFrequency(p.instrument.symbol));
      // Rotate so index 0 = current month.
      const nowM = new Date().getMonth();
      for (let i = 0; i < 12; i += 1) monthTotals[i] += dist[(nowM + i) % 12];
    }
    const labels: string[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    }
    return {
      annual, monthTotals, labels, bySymbolAnnual, payerCount,
      yieldOnCost: costBasis > 0 ? (annual / costBasis) * 100 : 0,
      forwardYield: payerValue > 0 ? (annual / payerValue) * 100 : 0,
      totalSymbols: positions.filter((p) => !p.instrument.symbol.includes(' ')).length,
    };
  }, [positions]);

  // ── By-symbol table rows ────────────────────────────────────────────────────
  const symbolRows = useMemo(() => {
    const posBySym = new Map(positions.map((p) => [p.instrument.symbol, p]));
    const rows = Array.from(trailing.bySymbol.entries()).map(([sym, s]) => {
      const pos = posBySym.get(sym);
      const cost = pos ? (pos.averagePrice ?? 0) * (pos.longQuantity ?? 0) : 0;
      const value = pos ? Math.abs(pos.marketValue ?? 0) : 0;
      const estAnnual = projection.bySymbolAnnual.get(sym) ?? 0;
      return {
        sym,
        freq: FREQ_LABEL[getFrequency(sym)] ?? '—',
        t12m: s.total,
        payments: s.count,
        avg: s.count > 0 ? s.total / s.count : 0,
        last: s.last,
        yieldOnCost: cost > 0 ? (estAnnual / cost) * 100 : 0,
        forwardYield: value > 0 ? (estAnnual / value) * 100 : 0,
      };
    });
    return rows.sort((a, b) => b.t12m - a.t12m);
  }, [trailing.bySymbol, positions, projection.bySymbolAnnual]);

  const visibleRows = showAll ? symbolRows : symbolRows.slice(0, 25);
  const asOf = new Date().toISOString().split('T')[0];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-white">Dividend Income</h1>
        <p className="text-xs text-[#7c82a0] mt-0.5">As of {asOf}</p>
      </div>

      {loading && <div className="text-xs text-[#7c82a0]">Loading dividend history…</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Trailing 12M Income" value={fmt$(trailing.total)} sub={`${trailing.activeMonths}/12 months active`} valueClass="text-emerald-400" />
        <Stat label="Monthly Average"     value={fmt$(trailing.total / 12)} />
        <Stat label="Dividend Symbols"    value={String(trailing.bySymbol.size)} sub={`${trailing.payments} total payments`} />
        <Stat label="12M Income (fetched window)" value={fmt$(trailing.total)} />
      </div>

      <div className="text-xs font-semibold text-[#9aa2c0] uppercase tracking-wider pt-1">Projections</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Est. Annual Income"  value={fmt$(projection.annual)} valueClass="text-violet-300" />
        <Stat label="Est. Monthly Income" value={fmt$(projection.annual / 12)} valueClass="text-violet-300" />
        <Stat label="Yield on Cost"       value={`${projection.yieldOnCost.toFixed(2)}%`} sub={`${projection.payerCount} of ${projection.totalSymbols} symbols`} />
        <Stat label="Forward Yield"       value={`${projection.forwardYield.toFixed(2)}%`} />
      </div>
      <p className="text-[10px] text-[#4a5070]">
        Projected dividend income is an estimate based on current holdings, Schwab yields, and trailing history.
        Past distributions are not a guarantee of future distributions. Actual income may differ materially.
      </p>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="mb-3">
          <span className="text-sm font-semibold text-white">Projected Future Payments (Next 12 Months)</span>
          <div className="text-[10px] text-[#4a5070]">12-month projected total: {fmt$(projection.annual)}</div>
        </div>
        <BarChart labels={projection.labels} values={projection.monthTotals} barClass="bg-violet-500/70" />
      </div>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="mb-3">
          <span className="text-sm font-semibold text-white">Monthly Dividend Income (Trailing 12 Months)</span>
          <div className="text-[10px] text-[#4a5070]">12-month total: {fmt$(trailing.total)} (current month may be partial)</div>
        </div>
        <BarChart labels={trailing.months.map((m) => m.label)} values={trailing.monthValues} barClass="bg-emerald-500/70" />
      </div>

      {/* By-symbol table */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1f2334]">
          <span className="text-sm font-semibold text-white">Dividends by Symbol</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[#4a5070] border-b border-[#1a1e2e]">
                <th className="text-left px-4 py-2.5 font-medium">Symbol</th>
                <th className="text-left px-2 py-2.5 font-medium">Frequency</th>
                <th className="text-right px-2 py-2.5 font-medium">Trailing 12M</th>
                <th className="text-right px-2 py-2.5 font-medium">Payments</th>
                <th className="text-right px-2 py-2.5 font-medium">Avg Payment</th>
                <th className="text-right px-2 py-2.5 font-medium">Yield on Cost</th>
                <th className="text-right px-2 py-2.5 font-medium">Fwd Yield</th>
                <th className="text-right px-4 py-2.5 font-medium">Last Payment</th>
              </tr>
            </thead>
            <tbody>
              {symbolRows.length === 0 && !loading && (
                <tr><td colSpan={8} className="px-4 py-6 text-[#4a5070]">No dividend payments in the trailing window.</td></tr>
              )}
              {visibleRows.map((r) => (
                <tr key={r.sym} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                  <td className="px-4 py-2 font-mono font-semibold text-white">{r.sym}</td>
                  <td className="px-2 py-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      r.freq === 'Weekly' ? 'bg-violet-500/15 text-violet-300'
                      : r.freq === 'Monthly' ? 'bg-emerald-500/15 text-emerald-300'
                      : r.freq === 'Quarterly' ? 'bg-blue-500/15 text-blue-300'
                      : 'bg-[#2d3248] text-[#9aa2c0]'
                    }`}>{r.freq}</span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-emerald-400">{fmt$(r.t12m)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{r.payments}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{fmt$(r.avg)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{r.yieldOnCost > 0 ? `${r.yieldOnCost.toFixed(2)}%` : '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{r.forwardYield > 0 ? `${r.forwardYield.toFixed(2)}%` : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#7c82a0] whitespace-nowrap">
                    {(() => {
                      const d = r.last ? new Date(r.last + 'T12:00:00') : null;
                      return d && !Number.isNaN(d.getTime())
                        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : '—';
                    })()}
                  </td>
                </tr>
              ))}
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
