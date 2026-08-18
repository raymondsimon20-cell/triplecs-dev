'use client';

/**
 * TransactionsView — full transaction ledger (P2P-style redesign, page 3).
 * Filters: type, symbol, date range. Data comes from /api/transactions,
 * fetched once by the dashboard page and passed down.
 */

import React, { useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useSort, SortTh } from '@/components/sortable';
import { TickerAvatar, TableSkeleton } from '@/components/polish';
import { ContributionTracker } from '@/components/ContributionTracker';

export interface NormalizedTransaction {
  id:          string;
  date:        string;
  category:    string;
  symbol:      string;
  description: string;
  amount:      number;
  units:       number;
  fee:         number;
  accountHash: string;
  /** Realized P/L for sales matched against the app's trade-history cost basis. */
  realizedPnl?: number;
  expenseTagged?: boolean;
  expenseCategory?: string;
}

const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

export function categoryChipClass(category: string): string {
  if (category === 'Dividend' || category === 'Interest') return 'bg-emerald-500/15 text-emerald-300';
  if (category.includes('Sale'))     return 'bg-blue-500/15 text-blue-300';
  if (category.includes('Purchase')) return 'bg-violet-500/15 text-violet-300';
  if (category === 'Contribution')   return 'bg-teal-500/15 text-teal-300';
  if (category === 'Withdrawal' || category === 'Margin Interest') return 'bg-orange-500/15 text-orange-300';
  return 'bg-[#2d3248] text-[#9aa2c0]';
}

export function fmtDate(d: string): string {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Parse a Schwab OCC-style option symbol ("XYZ   260718C00150000") into
 * strike / expiry / type. Returns null for plain equity symbols.
 */
export function parseOptionSymbol(symbol: string): { underlying: string; exp: string; strike: number; kind: 'C' | 'P' } | null {
  const m = symbol.match(/^(\S+)\s+(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, underlying, ymd, kind, strikeRaw] = m;
  const exp = `${ymd.slice(2, 4)}/${ymd.slice(4, 6)}/${ymd.slice(0, 2)}`;
  return { underlying, exp, strike: Number(strikeRaw) / 1000, kind: kind as 'C' | 'P' };
}

const inputCls = 'bg-[#12151f] border border-[#1f2334] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500';

interface Props {
  transactions: NormalizedTransaction[];
  loading:      boolean;
  /** Scopes the contribution tracker. Omit for the household view. */
  accountHash?: string;
  /** Opens the allocation tool pre-filled. Omit to hide the Allocate button. */
  onAllocate?:  (amount: number, eventId: string) => void;
}

export function TransactionsView({ transactions, loading, accountHash, onAllocate }: Props) {
  const [typeFilter,   setTypeFilter]   = useState('all');
  const [symbolFilter, setSymbolFilter] = useState('');
  const [fromDate,     setFromDate]     = useState('');
  const [toDate,       setToDate]       = useState('');
  const [limit,        setLimit]        = useState(100);

  const categories = useMemo(
    () => Array.from(new Set(transactions.map((t) => t.category))).sort(),
    [transactions],
  );

  const { sortKey, sortDir, requestSort, sortRows } = useSort<NormalizedTransaction>('date');

  const filtered = useMemo(() => {
    const base = transactions.filter((t) => {
      if (typeFilter !== 'all' && t.category !== typeFilter) return false;
      if (symbolFilter && !t.symbol.toUpperCase().includes(symbolFilter.toUpperCase())) return false;
      if (fromDate && t.date < fromDate) return false;
      if (toDate && t.date > toDate) return false;
      return true;
    });
    return sortRows(base, {
      date:     (t) => t.date,
      category: (t) => t.category,
      symbol:   (t) => t.symbol,
      amount:   (t) => t.amount,
      units:    (t) => t.units,
      fee:      (t) => t.fee,
      pnl:      (t) => t.realizedPnl ?? Number.NEGATIVE_INFINITY,
    });
  }, [transactions, typeFilter, symbolFilter, fromDate, toDate, sortRows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center flex-shrink-0">
          <ArrowLeftRight className="w-[18px] h-[18px] text-cyan-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Transactions</h1>
          <p className="text-xs text-[#7c82a0] mt-0.5">All transactions across your accounts</p>
        </div>
      </div>

      {/* Contribution tracking — above the table on purpose. This is the
          "did I allocate that deposit?" question, and it should be the first
          thing visible on the tab, not something you scroll to find. */}
      <ContributionTracker accountHash={accountHash} onAllocate={onAllocate} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="text-[#7c82a0]">Type:</label>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={inputCls}>
          <option value="all">All</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="text-[#7c82a0] ml-2">Symbol:</label>
        <input value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)} placeholder="e.g. XDTE" className={`${inputCls} w-24`} />
        <label className="text-[#7c82a0] ml-2">Date:</label>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputCls} />
        <span className="text-[#4a5070]">–</span>
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputCls} />
        {(typeFilter !== 'all' || symbolFilter || fromDate || toDate) && (
          <button
            onClick={() => { setTypeFilter('all'); setSymbolFilter(''); setFromDate(''); setToDate(''); }}
            className="text-blue-400 hover:text-blue-300 ml-1"
          >
            Clear
          </button>
        )}
        <span className="ml-auto text-[#4a5070]">{filtered.length} transactions</span>
      </div>

      {/* Table */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1a1e2e]">
                <SortTh id="date"     label="Date"   first sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="category" label="Type"   sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="symbol"   label="Symbol" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <th className="text-right px-2 py-2.5 font-medium text-[#4a5070]">Strike</th>
                <th className="text-right px-2 py-2.5 font-medium text-[#4a5070]">Exp</th>
                <th className="text-left px-2 py-2.5 font-medium text-[#4a5070]">Description</th>
                <SortTh id="amount" label="Amount" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="units"  label="Units"  align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="fee"    label="Fee"    align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="pnl"    label="P/L"    align="right" last sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
              </tr>
            </thead>
            <tbody>
              {loading && <TableSkeleton cols={10} rows={8} />}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-6 text-[#4a5070]">No transactions match the filters.</td></tr>
              )}
              {filtered.slice(0, limit).map((t) => {
                const opt = t.symbol ? parseOptionSymbol(t.symbol) : null;
                return (
                <tr key={t.id} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                  <td className="px-4 py-2 text-[#9aa2c0] whitespace-nowrap">{fmtDate(t.date)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${categoryChipClass(t.category)}`}>{t.category}</span>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {t.symbol && !opt ? (
                      <span className="inline-flex items-center gap-1.5">
                        <TickerAvatar symbol={t.symbol} size="sm" />
                        <span className="font-mono font-semibold text-white">{t.symbol}</span>
                      </span>
                    ) : (
                      <span className="font-mono font-semibold text-white">{opt ? `${opt.underlying} ${opt.kind}` : '-'}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{opt ? `$${opt.strike.toFixed(2)}` : '-'}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0] whitespace-nowrap">{opt ? opt.exp : '-'}</td>
                  <td className="px-2 py-2 text-[#7c82a0] max-w-[300px] truncate">{t.description}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${plColor(t.amount)}`}>{signed$(t.amount)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#7c82a0]">{t.units ? t.units.toFixed(4) : '-'}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#7c82a0]">{t.fee > 0 ? `$${t.fee.toFixed(2)}` : '-'}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${t.realizedPnl !== undefined ? plColor(t.realizedPnl) : 'text-[#4a5070]'}`}>
                    {t.realizedPnl !== undefined ? signed$(t.realizedPnl) : '-'}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > limit && (
          <button
            onClick={() => setLimit((n) => n + 100)}
            className="w-full px-4 py-2.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-[#161a28] transition-colors"
          >
            Show more ({filtered.length - limit} remaining)
          </button>
        )}
      </div>
    </div>
  );
}
