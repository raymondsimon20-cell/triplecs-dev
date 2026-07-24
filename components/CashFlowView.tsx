'use client';

/**
 * CashFlowView — 30-day cash flow ledger (P2P-style redesign, page 4).
 * Income / expense / contribution aggregation, daily net-operating bar chart,
 * and a categorized transaction table. All derived from /api/transactions.
 *
 * Model (mirrors the reference):
 *   Income        = dividends + interest + stock-sale proceeds
 *   Expenses      = cash withdrawals + margin interest
 *   Contributions = transfers in
 *   Capital Deployed = stock/option purchases
 *   Net Operating = Income − Expenses
 */

import React, { useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { type NormalizedTransaction, categoryChipClass, fmtDate } from '@/components/TransactionsView';

const fmt$ = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

const INCOME_CATS   = new Set(['Dividend', 'Interest', 'Stock Sale']);
const EXPENSE_CATS  = new Set(['Withdrawal', 'Margin Interest']);
const DEPLOY_CATS   = new Set(['Stock Purchase', 'Option Trade']);

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

interface Props {
  transactions: NormalizedTransaction[];
  loading:      boolean;
  windowDays?:  number;
}

export function CashFlowView({ transactions, loading, windowDays = 30 }: Props) {
  const [categoryFilter, setCategoryFilter] = useState('all');

  const cutoff = useMemo(() => {
    const d = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    return d.toISOString().split('T')[0];
  }, [windowDays]);

  const windowTxns = useMemo(
    () => transactions.filter((t) => t.date >= cutoff),
    [transactions, cutoff],
  );

  const agg = useMemo(() => {
    let income = 0, marginCost = 0, contributions = 0, withdrawals = 0, deployed = 0;
    const daily = new Map<string, number>();
    for (const t of windowTxns) {
      if (INCOME_CATS.has(t.category)) {
        income += Math.abs(t.amount);
        daily.set(t.date, (daily.get(t.date) ?? 0) + Math.abs(t.amount));
      } else if (t.category === 'Margin Interest') {
        marginCost += Math.abs(t.amount);
        daily.set(t.date, (daily.get(t.date) ?? 0) - Math.abs(t.amount));
      } else if (t.category === 'Withdrawal') {
        withdrawals += Math.abs(t.amount);
        daily.set(t.date, (daily.get(t.date) ?? 0) - Math.abs(t.amount));
      } else if (t.category === 'Contribution') {
        contributions += Math.abs(t.amount);
      } else if (DEPLOY_CATS.has(t.category) && t.amount < 0) {
        deployed += Math.abs(t.amount);
      }
    }
    const expenses = withdrawals + marginCost;
    return { income, marginCost, contributions, withdrawals, deployed, expenses, netOperating: income - expenses, daily };
  }, [windowTxns]);

  // Daily bar chart series (oldest → newest).
  const days = useMemo(() => {
    const out: { date: string; net: number }[] = [];
    for (let i = windowDays; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      out.push({ date: d, net: agg.daily.get(d) ?? 0 });
    }
    return out;
  }, [agg.daily, windowDays]);
  const maxAbs = Math.max(...days.map((d) => Math.abs(d.net)), 1);

  const categories = useMemo(
    () => Array.from(new Set(windowTxns.map((t) => t.category))).sort(),
    [windowTxns],
  );
  const tableTxns = categoryFilter === 'all'
    ? windowTxns
    : windowTxns.filter((t) => t.category === categoryFilter);

  const rangeLabel = `${new Date(cutoff + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
          <Activity className="w-[18px] h-[18px] text-emerald-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">{windowDays}-Day Cash Flow</h1>
          <p className="text-xs text-[#7c82a0] mt-0.5">Ledger-style breakdown of income, expenses, and contributions</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total Income"     value={fmt$(agg.income)}        valueClass="text-emerald-400" />
        <Stat label="Total Expenses"   value={fmt$(agg.expenses)}      valueClass="text-red-400" />
        <Stat label="Margin Cost"      value={fmt$(agg.marginCost)}    sub="Included in Total Expenses" valueClass="text-orange-300" />
        <Stat label="Contributions"    value={fmt$(agg.contributions)} />
        <Stat label="Cash Withdrawals" value={fmt$(agg.withdrawals)}   sub="Included in Total Expenses" />
        <Stat label="Capital Deployed" value={fmt$(agg.deployed)} />
        <Stat label="Net Operating"    value={signed$(agg.netOperating)} valueClass={plColor(agg.netOperating)} />
      </div>

      {/* Daily net operating chart */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-white">Daily Net Operating ({windowDays}-Day View)</span>
          <span className="text-[10px] text-[#4a5070]">{rangeLabel} ({days.length} days)</span>
        </div>
        <div className="flex items-end gap-[2px] h-32">
          {days.map((d) => {
            const h = (Math.abs(d.net) / maxAbs) * 100;
            return (
              <div
                key={d.date}
                className="flex-1 flex flex-col justify-end h-full group relative"
                title={`${fmtDate(d.date)}: ${signed$(d.net)}`}
              >
                <div className="flex flex-col justify-center h-full">
                  <div className="h-1/2 flex flex-col justify-end">
                    {d.net > 0 && <div className="bg-emerald-500/80 rounded-t-sm" style={{ height: `${h / 2}%`, minHeight: '2px' }} />}
                  </div>
                  <div className="border-t border-[#2d3248]" />
                  <div className="h-1/2">
                    {d.net < 0 && <div className="bg-red-500/80 rounded-b-sm" style={{ height: `${h / 2}%`, minHeight: '2px' }} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-[10px] text-[#4a5070] mt-2">
          <span>{new Date(cutoff + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          <span>{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
        <div className="flex gap-4 mt-2 text-[10px] text-[#7c82a0]">
          <span>{days.filter((d) => d.net > 0).length} days positive</span>
          <span>{days.filter((d) => d.net < 0).length} days negative</span>
          <span className="ml-auto">Net: <span className={plColor(agg.netOperating)}>{signed$(agg.netOperating)}</span></span>
        </div>
      </div>

      {/* Transaction details */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f2334]">
          <span className="text-sm font-semibold text-white">Transaction Details</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="bg-[#0f1117] border border-[#1f2334] rounded-lg px-2 py-1 text-[11px] text-white focus:outline-none focus:border-blue-500"
          >
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#12151f]">
              <tr className="text-[#4a5070] border-b border-[#1a1e2e]">
                <th className="text-left px-4 py-2.5 font-medium">Date</th>
                <th className="text-left px-2 py-2.5 font-medium">Description</th>
                <th className="text-left px-2 py-2.5 font-medium">Symbol</th>
                <th className="text-left px-2 py-2.5 font-medium">Category</th>
                <th className="text-right px-4 py-2.5 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="px-4 py-6 text-[#4a5070]">Loading…</td></tr>}
              {!loading && tableTxns.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-[#4a5070]">No transactions in this window.</td></tr>
              )}
              {tableTxns.map((t) => (
                <tr key={t.id} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                  <td className="px-4 py-2 text-[#9aa2c0] whitespace-nowrap">{fmtDate(t.date)}</td>
                  <td className="px-2 py-2 text-[#7c82a0] max-w-[280px] truncate">{t.description}</td>
                  <td className="px-2 py-2 font-mono font-semibold text-white">{t.symbol || '-'}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${categoryChipClass(t.category)}`}>{t.category}</span>
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums ${plColor(t.amount)}`}>{signed$(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
