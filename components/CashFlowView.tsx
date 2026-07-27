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
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import { StatCard as Stat } from '@/components/StatCard';
import { TickerAvatar, TableSkeleton } from '@/components/polish';
import { Activity, Banknote, CreditCard, PiggyBank, ShoppingCart, TrendingDown, TrendingUp } from 'lucide-react';
import { type NormalizedTransaction, categoryChipClass, fmtDate } from '@/components/TransactionsView';

const fmt$ = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

const INCOME_CATS   = new Set(['Dividend', 'Interest', 'Stock Sale']);
const EXPENSE_CATS  = new Set(['Withdrawal', 'Margin Interest']);
const DEPLOY_CATS   = new Set(['Stock Purchase', 'Option Trade']);


interface Props {
  transactions: NormalizedTransaction[];
  loading:      boolean;
  windowDays?:  number;
}

const WINDOW_CHOICES = [30, 60, 90, 180, 365];

export function CashFlowView({ transactions, loading, windowDays: initialWindow = 30 }: Props) {
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [windowDays, setWindowDays] = useState(initialWindow);

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

  // Bar chart series (oldest → newest). Windows past 90 days bucket by week
  // so the bars stay readable instead of collapsing into 1px slivers.
  const weekly = windowDays > 90;
  const days = useMemo(() => {
    const out: { date: string; net: number }[] = [];
    if (!weekly) {
      for (let i = windowDays; i >= 0; i -= 1) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        out.push({ date: d, net: agg.daily.get(d) ?? 0 });
      }
      return out;
    }
    const weeks = Math.ceil(windowDays / 7);
    for (let w = weeks - 1; w >= 0; w -= 1) {
      const start = new Date(Date.now() - (w * 7 + 6) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      let net = 0;
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(Date.now() - (w * 7 + i) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        net += agg.daily.get(d) ?? 0;
      }
      out.push({ date: start, net });
    }
    return out;
  }, [agg.daily, windowDays, weekly]);
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
        <div className="ml-auto flex items-center gap-1">
          {WINDOW_CHOICES.map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                windowDays === d ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30' : 'text-[#7c82a0] hover:text-white border border-transparent'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={TrendingUp} label="Total Income" value={fmt$(agg.income)} valueClass="text-emerald-400" accentClass="border-t-emerald-500/60" index={0} />
        <Stat icon={TrendingDown} label="Total Expenses" value={fmt$(agg.expenses)} valueClass="text-red-400" accentClass="border-t-emerald-500/60" index={1} />
        <Stat icon={CreditCard} label="Margin Cost" value={fmt$(agg.marginCost)} sub="Included in Total Expenses" valueClass="text-orange-300" accentClass="border-t-emerald-500/60" index={2} />
        <Stat icon={PiggyBank} label="Contributions" value={fmt$(agg.contributions)} accentClass="border-t-emerald-500/60" index={3} />
        <Stat icon={Banknote} label="Cash Withdrawals" value={fmt$(agg.withdrawals)} sub="Included in Total Expenses" accentClass="border-t-emerald-500/60" index={4} />
        <Stat icon={ShoppingCart} label="Capital Deployed" value={fmt$(agg.deployed)} accentClass="border-t-emerald-500/60" index={5} />
        <Stat icon={Activity} label="Net Operating" value={signed$(agg.netOperating)} valueClass={plColor(agg.netOperating)} accentClass="border-t-emerald-500/60" index={6} />
      </div>

      {/* Daily net operating chart */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-white">
            {weekly ? 'Weekly' : 'Daily'} Net Operating ({windowDays}-Day View)
          </span>
          <span className="text-[10px] text-[#4a5070]">{rangeLabel} ({days.length} {weekly ? 'weeks' : 'days'})</span>
        </div>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={days} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <XAxis
                dataKey="date"
                tick={{ fill: '#4a5070', fontSize: 10 }}
                tickFormatter={(d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                interval="preserveStartEnd"
                minTickGap={40}
                axisLine={{ stroke: '#1f2334' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#4a5070', fontSize: 10 }}
                tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v}`)}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                contentStyle={{ background: '#1a1d27', border: '1px solid #3d4468', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#7c82a0' }}
                labelFormatter={(d) => fmtDate(String(d))}
                formatter={(v) => [signed$(Number(v)), 'Net']}
              />
              <ReferenceLine y={0} stroke="#2d3248" />
              <Bar dataKey="net" radius={[2, 2, 0, 0]} maxBarSize={18}>
                {days.map((d) => (
                  <Cell key={d.date} fill={d.net >= 0 ? '#10b981' : '#ef4444'} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex gap-4 mt-2 text-[10px] text-[#7c82a0]">
          <span>{days.filter((d) => d.net > 0).length} {weekly ? 'weeks' : 'days'} positive</span>
          <span>{days.filter((d) => d.net < 0).length} {weekly ? 'weeks' : 'days'} negative</span>
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
              {loading && <TableSkeleton cols={5} rows={6} />}
              {!loading && tableTxns.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-[#4a5070]">No transactions in this window.</td></tr>
              )}
              {tableTxns.map((t) => (
                <tr key={t.id} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                  <td className="px-4 py-2 text-[#9aa2c0] whitespace-nowrap">{fmtDate(t.date)}</td>
                  <td className="px-2 py-2 text-[#7c82a0] max-w-[280px] truncate">{t.description}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {t.symbol ? (
                      <span className="inline-flex items-center gap-1.5">
                        <TickerAvatar symbol={t.symbol} size="sm" />
                        <span className="font-mono font-semibold text-white">{t.symbol}</span>
                      </span>
                    ) : <span className="text-[#4a5070]">-</span>}
                  </td>
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
