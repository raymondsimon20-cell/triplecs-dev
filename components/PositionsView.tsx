'use client';

/**
 * PositionsView — full positions table (P2P-style redesign, page 2).
 * Stat cards → symbol filter → 11-column table with a Portfolio Total row.
 * "Total Return" = unrealized gain + dividends received on the symbol
 * (trailing 12 months — the data we have).
 */

import React, { useMemo, useState } from 'react';
import { StatCard as Stat } from '@/components/StatCard';
import { TickerAvatar, PlChip, WeightBar } from '@/components/polish';
import { BarChart2, Download, Hash, List, Trophy, Wallet } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { useSort, SortTh } from '@/components/sortable';

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

interface Props {
  positions:        EnrichedPosition[];
  totalValue:       number;
  lastUpdated:      Date | null;
  /** Per-symbol dividend totals (trailing 12 months) for the return column. */
  dividendsBySymbol: Record<string, number>;
  /** Per-symbol realized P/L (app-placed sales, trailing window). */
  realizedBySymbol?: Record<string, number>;
}

export function PositionsView({ positions, totalValue, lastUpdated, dividendsBySymbol, realizedBySymbol = {} }: Props) {
  const [symbolFilter, setSymbolFilter] = useState('');

  // Options were previously filtered out with `!symbol.includes(' ')`, which
  // hid short puts from both the table and the CSV export while the dashboard
  // counted them — so the two totals could never agree. Verified against the
  // Schwab export of 2026-08-03: two short puts carrying -$180.66 unrealized
  // and -$159.78 of day change were invisible here.
  const rows = useMemo(() => {
    return positions
      .map((p) => {
        const sym  = p.instrument.symbol;
        const v    = p.currentValue ?? 0;
        // Signed quantity, so a short position reads negative the way Schwab
        // prints it (their export shows the put quantities as -1 and -3).
        const qty  = (p.longQuantity ?? 0) - (p.shortQuantity ?? 0);
        // Per-CONTRACT price for options: marketValue already has the ×100
        // multiplier baked in, so dividing by bare quantity would report a
        // price 100× too high.
        const multiplier = p.instrument.assetType === 'OPTION' ? 100 : 1;
        const price = qty !== 0 ? v / (qty * multiplier) : 0;
        const day  = p.todayGainLoss ?? 0;
        const gain = p.gainLoss ?? 0;
        // `costBasis` is signed and dollar-denominated (see enrichPositions).
        // A short's basis is negative — the credit received — which is exactly
        // how Schwab reports it, so percentages need the magnitude.
        const cost = Math.abs(p.costBasis ?? 0);
        // Day % is computed once in enrichPositions (lib/classify.ts) so this
        // view and DashboardOverview cannot drift apart. null = the position
        // did not exist at yesterday's close, so there is no day percentage.
        const dayPct = p.todayGainLossPercent;
        const divs = dividendsBySymbol[sym] ?? 0;
        const realized = realizedBySymbol[sym] ?? 0;
        const ret  = gain + divs + realized;
        const retPct = cost > 0 ? (ret / cost) * 100 : 0;
        return { sym, qty, price, day, dayPct, gain, gainPct: p.gainLossPercent ?? 0, ret, retPct, value: v, cost };
      })
      .sort((a, b) => b.value - a.value);
  }, [positions, dividendsBySymbol, realizedBySymbol]);

  const { sortKey, sortDir, requestSort, sortRows } = useSort<typeof rows[number]>('value');

  const filtered = useMemo(() => {
    const base = symbolFilter
      ? rows.filter((r) => r.sym.toUpperCase().includes(symbolFilter.toUpperCase()))
      : rows;
    return sortRows(base, {
      sym:    (r) => r.sym,
      qty:    (r) => r.qty,
      price:  (r) => r.price,
      day:    (r) => r.day,
      dayPct: (r) => r.dayPct ?? 0,
      gain:   (r) => r.gain,
      gainPct:(r) => r.gainPct,
      ret:    (r) => r.ret,
      retPct: (r) => r.retPct,
      value:  (r) => r.value,
    });
  }, [rows, symbolFilter, sortRows]);

  const totals = useMemo(() => {
    let day = 0, gain = 0, ret = 0, value = 0, cost = 0, dayBase = 0;
    // Sum the real per-position cost basis rather than back-solving it from
    // value minus gain, which broke on any row where gainPct happened to be 0.
    for (const r of rows) {
      day += r.day; gain += r.gain; ret += r.ret; value += r.value; cost += r.cost;
      // Portfolio Day % needs the sum of each position's OWN day base, not
      // `value - day` for the book as a whole. The latter counts every dollar
      // deployed today as if it had been at risk since yesterday's close,
      // which drags the headline percentage toward zero on any day with buys.
      dayBase += r.dayPct != null && r.dayPct !== 0 && r.day !== 0
        ? Math.abs(r.day / (r.dayPct / 100))
        : Math.abs(r.value - r.day);
    }
    const dayPct  = dayBase > 0 ? (day / dayBase) * 100 : 0;
    const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
    const retPct  = cost > 0 ? (ret / cost) * 100 : 0;
    return { day, dayPct, gain, gainPct, ret, retPct, value, cost };
  }, [rows]);

  const top = rows[0];
  const asOf = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const pricesAgo = lastUpdated && Date.now() - lastUpdated.getTime() < 90_000 ? 'Just now'
    : lastUpdated ? `${Math.floor((Date.now() - lastUpdated.getTime()) / 60_000)}m ago` : '—';

  // Exports what is currently on screen — filter and sort included — so the file
  // matches what the user is looking at rather than a hidden full set.
  const exportCsv = () => {
    // Cost Basis is included so this file can be joined directly against
    // Schwab's own Positions export, which carries a "Cost Basis" column.
    // That diff is the only practical way to chase a reconciliation gap.
    const header = ['Symbol', 'Shares', 'Price', 'Day Chg $', 'Day Chg %', 'Total Gain $', 'Total Gain %', 'Total Return $', 'Total Return %', 'Cost Basis', 'Value', '% Portfolio'];
    const pct = (v: number) => (totalValue > 0 ? (v / totalValue) * 100 : 0);
    const body = filtered.map((r) => [
      r.sym, String(r.qty), r.price.toFixed(2), r.day.toFixed(2),
      r.dayPct == null ? '' : r.dayPct.toFixed(2),
      r.gain.toFixed(2), r.gainPct.toFixed(2), r.ret.toFixed(2), r.retPct.toFixed(2),
      r.cost.toFixed(2), r.value.toFixed(2), pct(r.value).toFixed(2),
    ]);
    const totalRow = [
      'PORTFOLIO TOTAL', '', '', totals.day.toFixed(2), totals.dayPct.toFixed(2),
      totals.gain.toFixed(2), totals.gainPct.toFixed(2), totals.ret.toFixed(2), totals.retPct.toFixed(2),
      totals.cost.toFixed(2), totals.value.toFixed(2), '100.00',
    ];
    const csv = [header, ...body, totalRow]
      .map((row) => row.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `positions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
          <BarChart2 className="w-[18px] h-[18px] text-violet-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Positions</h1>
          <p className="text-xs text-[#7c82a0] mt-0.5">As of {asOf} · Prices as of {pricesAgo}</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={Wallet} label="Total Value" value={fmt$(totals.value)} rawValue={totals.value} format={(n) => '$' + Math.round(n).toLocaleString('en-US')} accentClass="border-t-violet-500/60" index={0} />
        <Stat icon={List} label="Positions" value={String(rows.length)} accentClass="border-t-violet-500/60" index={1} />
        <Stat icon={Hash} label="Unique Symbols" value={String(new Set(rows.map((r) => r.sym)).size)} accentClass="border-t-violet-500/60" index={2} />
        <Stat icon={Trophy} label="Top Position" value={top ? top.sym : '—'} sub={top ? fmt$(top.value) : undefined} accentClass="border-t-violet-500/60" index={3} />
      </div>

      <div className="flex items-center gap-2 text-xs">
        <label className="text-[#7c82a0]">Symbol:</label>
        <input
          value={symbolFilter}
          onChange={(e) => setSymbolFilter(e.target.value)}
          placeholder="Filter…"
          className="bg-[#12151f] border border-[#1f2334] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 w-32"
        />
        <span className="ml-auto text-[#4a5070]">{filtered.length} of {rows.length} shown</span>
      </div>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1a1e2e]">
                <SortTh id="sym"     label="Symbol"   first sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="qty"     label="Qty"      align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="price"   label="Price"    align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="day"     label="Day $"    align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="dayPct"  label="Day %"    align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="gain"    label="Gain $"   align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="gainPct" label="Gain %"   align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="ret"     label="Return $" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="retPct"  label="Return %" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="value"   label="Value"    align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="value"   label="Weight"   align="right" last sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[#1a1e2e] font-semibold text-white bg-[#161a28]/50">
                <td className="px-4 py-2.5">Portfolio Total</td>
                <td className="px-2 py-2.5" /><td className="px-2 py-2.5" />
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totals.day)}`}>{signed$(totals.day)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totals.day)}`}>{signedPct(totals.dayPct)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totals.gain)}`}>{signed$(totals.gain)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totals.gain)}`}>{signedPct(totals.gainPct)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totals.ret)}`}>{signed$(totals.ret)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totals.ret)}`}>{signedPct(totals.retPct)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{fmt$(totals.value)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[#7c82a0]">100.00%</td>
              </tr>
              {filtered.map((r) => {
                const w = totals.value > 0 ? (r.value / totals.value) * 100 : 0;
                return (
                  <tr key={r.sym} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <TickerAvatar symbol={r.sym} size="sm" />
                        <span className="font-mono font-semibold text-white">{r.sym}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{r.qty.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{fmt$(r.price)}</td>
                    <td className="px-2 py-2 text-right"><PlChip value={r.day} /></td>
                    <td className={`px-2 py-2 text-right tabular-nums ${r.day === 0 || r.dayPct == null ? 'text-[#4a5070]' : plColor(r.day)}`}>{r.day === 0 || r.dayPct == null ? '--' : signedPct(r.dayPct)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${plColor(r.gain)}`}>{signed$(r.gain)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${plColor(r.gain)}`}>{signedPct(r.gainPct)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${plColor(r.ret)}`}>{signed$(r.ret)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${plColor(r.ret)}`}>{signedPct(r.retPct)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-white">{fmt$(r.value)}</td>
                    <td className="px-4 py-2 text-right"><WeightBar pct={w} colorClass="bg-violet-500/70" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px] text-[#4a5070]">
        Return $ / % = unrealized gain + dividends received (trailing 12 months) + realized P/L from app-placed sales.
      </p>
    </div>
  );
}
