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
import { BarChart2, Hash, List, Trophy, Wallet } from 'lucide-react';
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

  const equities = useMemo(
    () => positions.filter((p) => !p.instrument.symbol.includes(' ')),
    [positions],
  );

  const rows = useMemo(() => {
    return equities
      .map((p) => {
        const sym  = p.instrument.symbol;
        const v    = p.currentValue ?? 0;
        const qty  = p.longQuantity ?? 0;
        const price = qty > 0 ? v / qty : 0;
        const day  = p.todayGainLoss ?? 0;
        const dayPct = v - day > 0 ? (day / (v - day)) * 100 : 0;
        const gain = p.gainLoss ?? 0;
        const cost = (p.averagePrice ?? 0) * qty;
        const divs = dividendsBySymbol[sym] ?? 0;
        const realized = realizedBySymbol[sym] ?? 0;
        const ret  = gain + divs + realized;
        const retPct = cost > 0 ? (ret / cost) * 100 : 0;
        return { sym, qty, price, day, dayPct, gain, gainPct: p.gainLossPercent ?? 0, ret, retPct, value: v };
      })
      .sort((a, b) => b.value - a.value);
  }, [equities, dividendsBySymbol, realizedBySymbol]);

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
      dayPct: (r) => r.dayPct,
      gain:   (r) => r.gain,
      gainPct:(r) => r.gainPct,
      ret:    (r) => r.ret,
      retPct: (r) => r.retPct,
      value:  (r) => r.value,
    });
  }, [rows, symbolFilter, sortRows]);

  const totals = useMemo(() => {
    let day = 0, gain = 0, ret = 0, value = 0;
    for (const r of rows) { day += r.day; gain += r.gain; ret += r.ret; value += r.value; }
    const dayPct  = value - day > 0 ? (day / (value - day)) * 100 : 0;
    const cost    = rows.reduce((s, r) => s + (r.gainPct !== 0 ? r.value - r.gain : r.value), 0);
    const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
    const retPct  = cost > 0 ? (ret / cost) * 100 : 0;
    return { day, dayPct, gain, gainPct, ret, retPct, value };
  }, [rows]);

  const top = rows[0];
  const asOf = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const pricesAgo = lastUpdated && Date.now() - lastUpdated.getTime() < 90_000 ? 'Just now'
    : lastUpdated ? `${Math.floor((Date.now() - lastUpdated.getTime()) / 60_000)}m ago` : '—';

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
                    <td className={`px-2 py-2 text-right tabular-nums ${r.day === 0 ? 'text-[#4a5070]' : plColor(r.day)}`}>{r.day === 0 ? '--' : signedPct(r.dayPct)}</td>
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
