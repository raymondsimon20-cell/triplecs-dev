'use client';

/**
 * LedgerView — complete transaction ledger (P2P-style redesign, page 7).
 * Inflow / expense / deployed stat cards over the full fetched window, then
 * the raw ledger table with date-range filter.
 */

import React, { useMemo, useState } from 'react';
import { type NormalizedTransaction, categoryChipClass, fmtDate } from '@/components/TransactionsView';
import { useSort, SortTh } from '@/components/sortable';

const fmt$ = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

const INFLOW_CATS  = new Set(['Dividend', 'Interest', 'Stock Sale', 'Contribution']);
const EXPENSE_CATS = new Set(['Withdrawal', 'Margin Interest']);
const DEPLOY_CATS  = new Set(['Stock Purchase', 'Option Trade']);

const inputCls = 'bg-[#12151f] border border-[#1f2334] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500';

interface Props {
  transactions: NormalizedTransaction[];
  loading:      boolean;
  accountLabel: string;
  windowDays:   number;
}

export function LedgerView({ transactions, loading, accountLabel, windowDays }: Props) {
  const [fromDate, setFromDate] = useState('');
  const [toDate,   setToDate]   = useState('');
  const [limit,    setLimit]    = useState(100);

  const { sortKey, sortDir, requestSort, sortRows } = useSort<NormalizedTransaction>('date');

  const filtered = useMemo(() => {
    const base = transactions.filter((t) => {
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
    });
  }, [transactions, fromDate, toDate, sortRows]);

  const stats = useMemo(() => {
    let inflows = 0, inflowN = 0, expenses = 0, expenseN = 0, deployed = 0, deployN = 0;
    for (const t of filtered) {
      if (INFLOW_CATS.has(t.category) && t.amount > 0) { inflows += t.amount; inflowN += 1; }
      else if (EXPENSE_CATS.has(t.category)) { expenses += -Math.abs(t.amount); expenseN += 1; }
      else if (DEPLOY_CATS.has(t.category) && t.amount < 0) { deployed += t.amount; deployN += 1; }
    }
    return { inflows, inflowN, expenses, expenseN, deployed, deployN, net: inflows + expenses + deployed };
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-white">Ledger</h1>
        <p className="text-xs text-[#7c82a0] mt-0.5">
          Complete transaction ledger · {accountLabel} · trailing {windowDays} days
        </p>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <label className="text-[#7c82a0]">Date:</label>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputCls} />
        <span className="text-[#4a5070]">–</span>
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputCls} />
        {(fromDate || toDate) && (
          <button onClick={() => { setFromDate(''); setToDate(''); }} className="text-blue-400 hover:text-blue-300 ml-1">Clear</button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3.5">
          <div className="text-[11px] text-[#7c82a0] mb-1">Total Inflows</div>
          <div className="text-lg font-bold tabular-nums text-emerald-400">{signed$(stats.inflows)}</div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">{stats.inflowN} transactions</div>
        </div>
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3.5">
          <div className="text-[11px] text-[#7c82a0] mb-1">Total Expenses</div>
          <div className="text-lg font-bold tabular-nums text-red-400">{signed$(stats.expenses)}</div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">{stats.expenseN} transactions</div>
        </div>
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3.5">
          <div className="text-[11px] text-[#7c82a0] mb-1">Capital Deployed</div>
          <div className="text-lg font-bold tabular-nums text-violet-300">{signed$(stats.deployed)}</div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">{stats.deployN} transactions</div>
        </div>
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3.5">
          <div className="text-[11px] text-[#7c82a0] mb-1">Net Cash Movement</div>
          <div className={`text-lg font-bold tabular-nums ${plColor(stats.net)}`}>{signed$(stats.net)}</div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">{filtered.length} transactions total</div>
        </div>
      </div>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1a1e2e]">
                <SortTh id="date"     label="Date"     first sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="category" label="Category" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="symbol"   label="Symbol"   sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <th className="text-left px-2 py-2.5 font-medium text-[#4a5070]">Description</th>
                <SortTh id="amount" label="Cash Impact" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="units"  label="Units"       align="right" last sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="px-4 py-6 text-[#4a5070]">Loading ledger…</td></tr>}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-[#4a5070]">No transactions in range.</td></tr>
              )}
              {filtered.slice(0, limit).map((t) => (
                <tr key={t.id} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                  <td className="px-4 py-2 text-[#9aa2c0] whitespace-nowrap">{fmtDate(t.date)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${categoryChipClass(t.category)}`}>{t.category}</span>
                  </td>
                  <td className="px-2 py-2 font-mono font-semibold text-white">{t.symbol || '-'}</td>
                  <td className="px-2 py-2 text-[#7c82a0] max-w-[300px] truncate">{t.description}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${plColor(t.amount)}`}>{signed$(t.amount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#7c82a0]">{t.units ? t.units.toFixed(4) : '0.0000'}</td>
                </tr>
              ))}
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
