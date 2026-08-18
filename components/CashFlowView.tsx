'use client';

/**
 * CashFlowView — 30-day cash flow ledger (P2P-style redesign, page 4).
 * Income / expense / contribution aggregation, daily net-operating bar chart,
 * and a categorized transaction table. All derived from /api/transactions.
 *
 * Model (mirrors the reference):
 *   Income        = dividends + interest + positive option cash
 *   Expenses      = cash withdrawals + margin interest
 *   Contributions = transfers in
 *   Capital Deployed = stock/option purchases
 *   Net Operating = Income − Expenses
 * Stock-sale proceeds are disclosed separately because returning invested
 * principal is not income.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import { StatCard as Stat } from '@/components/StatCard';
import { TickerAvatar, TableSkeleton } from '@/components/polish';
import { Activity, Banknote, CreditCard, Download, PiggyBank, Plus, ShoppingCart, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { type NormalizedTransaction, categoryChipClass, fmtDate } from '@/components/TransactionsView';
import { reconcileInflows, unsweptIsSignificant } from '@/lib/portfolio/duplicate-inflows';
import { cashFlowDateKeys, localDateKey, summarizeCashFlow } from '@/lib/cash-flow';

const fmt$ = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

/** A manually recorded cash flow, from /api/contributions. */
interface ManualFlow {
  id:          string;
  date:        string;
  direction:   'in' | 'out';
  amount:      number;
  kind:        string;
  description?: string;
  accountHash?: string;
}

interface Props {
  transactions: NormalizedTransaction[];
  loading:      boolean;
  windowDays?:  number;
  accountHash?: string;
}

const WINDOW_CHOICES = [30, 60, 90, 180, 365];

const todayKey = () => localDateKey();

export function CashFlowView({ transactions, loading, windowDays: initialWindow = 30, accountHash }: Props) {
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [windowDays, setWindowDays] = useState(initialWindow);

  // ── Manual contributions ────────────────────────────────────────────────────
  const [manual, setManual] = useState<ManualFlow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    date: todayKey(), amount: '', direction: 'in' as 'in' | 'out', description: '',
  });

  const loadManual = useCallback(async (signal?: AbortSignal) => {
    try {
      const qs = accountHash ? `?accountHash=${encodeURIComponent(accountHash)}` : '';
      const res = await fetch(`/api/contributions${qs}`, { signal });
      if (!res.ok) return;
      const json = await res.json();
      setManual(Array.isArray(json?.contributions) ? json.contributions : []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.warn('[CashFlowView] could not load manual contributions:', err);
    }
  }, [accountHash]);

  useEffect(() => {
    const controller = new AbortController();
    setManual([]);
    setCategoryFilter('all');
    void loadManual(controller.signal);
    return () => controller.abort();
  }, [loadManual]);

  const submitContribution = async () => {
    const amt = Number(form.amount);
    if (!Number.isFinite(amt) || amt === 0) { setFormError('Enter a non-zero amount.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) { setFormError('Enter a valid date.'); return; }

    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch('/api/contributions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: form.date,
          amount: Math.abs(amt),
          direction: form.direction,
          description: form.description || undefined,
          accountHash,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setFormError(j?.error ?? 'Could not save.');
        return;
      }
      await loadManual();
      setShowForm(false);
      setForm({ date: todayKey(), amount: '', direction: 'in', description: '' });
    } catch {
      setFormError('Could not save — check your connection.');
    } finally {
      setSaving(false);
    }
  };

  const removeContribution = async (id: string) => {
    // Optimistic: drop it locally, restore on failure.
    const prior = manual;
    setManual((m) => m.filter((x) => x.id !== id));
    try {
      const res = await fetch(`/api/contributions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) setManual(prior);
    } catch {
      setManual(prior);
    }
  };

  // Manual flows join the same pipeline as broker transactions so they land in
  // the aggregates, the chart, and the table without special-casing downstream.
  const manualAsTxns = useMemo<NormalizedTransaction[]>(
    () => manual.map((m) => ({
      id: m.id,
      date: m.date,
      category: m.direction === 'in' ? 'Contribution' : 'Withdrawal',
      symbol: '',
      description: m.description || (m.direction === 'in' ? 'Manual contribution' : 'Manual withdrawal'),
      amount: m.direction === 'in' ? Math.abs(m.amount) : -Math.abs(m.amount),
      units: 0,
      fee: 0,
      accountHash: m.accountHash ?? '',
    })),
    [manual],
  );

  const manualIds = useMemo(() => new Set(manual.map((m) => m.id)), [manual]);


  const dateKeys = useMemo(() => cashFlowDateKeys(windowDays), [windowDays]);
  const cutoff = dateKeys[0];

  const windowTxns = useMemo(
    () => [...transactions, ...manualAsTxns]
      .filter((t) => t.date >= cutoff)
      .sort((a, b) => b.date.localeCompare(a.date)),
    [transactions, manualAsTxns, cutoff],
  );

  // Split external money from internal register movement. Both post as
  // positive amounts; only the former is new capital. Shown rather than merely
  // applied, so the exclusion is auditable.
  const inflows = useMemo(
    () => reconcileInflows(windowTxns.map((t) => ({
      id: t.id, date: t.date, description: t.description, amount: t.amount, category: t.category,
    }))),
    [windowTxns],
  );

  const agg = useMemo(() => summarizeCashFlow(windowTxns), [windowTxns]);

  // Bar chart series (oldest → newest). Windows past 90 days bucket by week
  // so the bars stay readable instead of collapsing into 1px slivers.
  const weekly = windowDays > 90;
  const days = useMemo(() => {
    const out: { date: string; net: number }[] = [];
    if (!weekly) {
      for (const date of dateKeys) out.push({ date, net: agg.daily.get(date) ?? 0 });
      return out;
    }
    for (let i = 0; i < dateKeys.length; i += 7) {
      const bucket = dateKeys.slice(i, i + 7);
      const net = bucket.reduce((sum, date) => sum + (agg.daily.get(date) ?? 0), 0);
      out.push({ date: bucket[0], net });
    }
    return out;
  }, [agg.daily, dateKeys, weekly]);
  const maxAbs = Math.max(...days.map((d) => Math.abs(d.net)), 1);

  const categories = useMemo(
    () => Array.from(new Set(windowTxns.map((t) => t.category))).sort(),
    [windowTxns],
  );
  const tableTxns = categoryFilter === 'all'
    ? windowTxns
    : windowTxns.filter((t) => t.category === categoryFilter);

  const rangeLabel = `${new Date(cutoff + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  const exportCsv = () => {
    const header = ['Date', 'Description', 'Symbol', 'Category', 'Amount', 'Source'];
    const rows = tableTxns.map((t) => [
      t.date, t.description, t.symbol, t.category, t.amount.toFixed(2),
      manualIds.has(t.id) ? 'manual' : 'schwab',
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cash-flow-${windowDays}d-${todayKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const inputClass = 'w-full bg-[#0f1117] border border-[#2d3248] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#4a5070] focus:outline-none focus:border-emerald-500/50 transition-colors';

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
          <div className="w-px h-5 bg-[#2d3248] mx-1.5" />
          <button
            onClick={() => { setShowForm((v) => !v); setFormError(null); }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-emerald-500/30 bg-emerald-600/15 text-[11px] text-emerald-300 hover:bg-emerald-600/25 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add Contribution
          </button>
          <button
            onClick={exportCsv}
            disabled={tableTxns.length === 0}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#2d3248] text-[11px] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {/* Manual contribution entry */}
      {showForm && (
        <div className="bg-[#12151f] border border-emerald-500/25 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-white">Record a cash flow</span>
            <button onClick={() => setShowForm(false)} className="text-[#7c82a0] hover:text-white" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[10px] text-[#4a5070] mb-3">
            For deposits and withdrawals that never appear in the Schwab feed. Without them, outside
            transfers get absorbed into &quot;Market &amp; Other&quot; on the equity bridge and look like
            gains or losses you never made.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 items-end">
            <div>
              <label htmlFor="cf-date" className="block text-[10px] text-[#7c82a0] mb-1">Date</label>
              <input id="cf-date" type="date" value={form.date} max={todayKey()}
                     onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label htmlFor="cf-dir" className="block text-[10px] text-[#7c82a0] mb-1">Direction</label>
              <select id="cf-dir" value={form.direction}
                      onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value as 'in' | 'out' }))}
                      className={inputClass}>
                <option value="in">Contribution (in)</option>
                <option value="out">Withdrawal (out)</option>
              </select>
            </div>
            <div>
              <label htmlFor="cf-amt" className="block text-[10px] text-[#7c82a0] mb-1">Amount ($)</label>
              <input id="cf-amt" type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00"
                     value={form.amount}
                     onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className={inputClass} />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label htmlFor="cf-desc" className="block text-[10px] text-[#7c82a0] mb-1">Description (optional)</label>
              <input id="cf-desc" type="text" maxLength={200} placeholder="e.g. Paycheck transfer"
                     value={form.description}
                     onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className={inputClass} />
            </div>
            <button
              onClick={submitContribution}
              disabled={saving}
              className="px-3 py-1.5 rounded-md bg-emerald-600/80 hover:bg-emerald-600 text-xs text-white font-medium disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {formError && <p className="text-[11px] text-red-400 mt-2">{formError}</p>}

          {manual.length > 0 && (
            <div className="mt-4 border-t border-[#1f2334] pt-3">
              <div className="text-[10px] text-[#7c82a0] mb-1.5">
                {manual.length} manual entr{manual.length === 1 ? 'y' : 'ies'} on record
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {[...manual].sort((a, b) => b.date.localeCompare(a.date)).map((m) => (
                  <div key={m.id} className="flex items-center gap-2 text-[11px] py-1 border-b border-[#161a28] last:border-0">
                    <span className="text-[#9aa2c0] tabular-nums w-24">{fmtDate(m.date)}</span>
                    <span className={`tabular-nums w-24 ${m.direction === 'in' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {m.direction === 'in' ? '+' : '-'}{fmt$(m.amount)}
                    </span>
                    <span className="text-[#7c82a0] truncate flex-1">{m.description}</span>
                    <button onClick={() => removeContribution(m.id)}
                            className="text-[#4a5070] hover:text-red-400 transition-colors" aria-label="Delete entry">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={TrendingUp} label="Total Income" value={fmt$(agg.income)} sub="Distributions, interest & option cash in" valueClass="text-emerald-400" accentClass="border-t-emerald-500/60" index={0} />
        <Stat icon={TrendingUp} label="Option Cash In" value={fmt$(agg.optionIncome)} sub="Positive option trade cash" valueClass="text-emerald-300" accentClass="border-t-emerald-500/60" index={1} />
        <Stat icon={Banknote} label="Stock Sale Proceeds" value={fmt$(agg.stockSaleProceeds)} sub="Principal returned — excluded from income" accentClass="border-t-emerald-500/60" index={2} />
        <Stat icon={TrendingDown} label="Total Expenses" value={fmt$(agg.expenses)} valueClass="text-red-400" accentClass="border-t-emerald-500/60" index={3} />
        <Stat icon={CreditCard} label="Margin Cost" value={fmt$(agg.marginCost)} sub="Included in Total Expenses" valueClass="text-orange-300" accentClass="border-t-emerald-500/60" index={4} />
        <Stat icon={PiggyBank} label="Contributions" value={fmt$(agg.contributions)} accentClass="border-t-emerald-500/60" index={5} />
        <Stat icon={Banknote} label="Cash Withdrawals" value={fmt$(agg.withdrawals)} sub="Included in Total Expenses" accentClass="border-t-emerald-500/60" index={6} />
        <Stat icon={ShoppingCart} label="Capital Deployed" value={fmt$(agg.deployed)} accentClass="border-t-emerald-500/60" index={7} />
        <Stat icon={Activity} label="Net Operating" value={signed$(agg.netOperating)} valueClass={plColor(agg.netOperating)} accentClass="border-t-emerald-500/60" index={8} />
      </div>

      {/* Inflow reconciliation — external money vs internal register movement */}
      {(inflows.internal.length > 0 || inflows.unclassified.length > 0) && (
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3">
          <div className="text-xs font-semibold text-white mb-1">Inflow reconciliation</div>
          <p className="text-[10px] text-[#4a5070] mb-2.5">
            Money arriving and money moving between the account&apos;s cash and margin registers both
            post as positive amounts. Only the first is new capital. One deposit is often split
            across several register moves, so these totals will not line up one-to-one — the point
            is that the internal figure is excluded, not that it matches.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-[10px] text-[#7c82a0] mb-0.5">External money in</div>
              <div className="text-emerald-400 tabular-nums font-semibold">{fmt$(inflows.externalTotal)}</div>
              <div className="text-[10px] text-[#4a5070]">{inflows.external.length} counted as contributions</div>
            </div>
            <div>
              <div className="text-[10px] text-[#7c82a0] mb-0.5">Internal register moves</div>
              <div className="text-[#9aa2c0] tabular-nums font-semibold">{fmt$(inflows.internalTotal)}</div>
              <div className="text-[10px] text-[#4a5070]">{inflows.internal.length} excluded — not new money</div>
            </div>
            {inflows.unclassified.length > 0 && (
              <div>
                <div className="text-[10px] text-[#7c82a0] mb-0.5">Unrecognised inflows</div>
                <div className="text-yellow-300 tabular-nums font-semibold">{fmt$(inflows.unclassifiedTotal)}</div>
                <div className="text-[10px] text-[#4a5070]">{inflows.unclassified.length} neither — worth a look</div>
              </div>
            )}
          </div>

          {unsweptIsSignificant(inflows) && (
            <div className="mt-2.5 text-[11px] text-yellow-200/90 border-t border-[#1f2334] pt-2">
              {fmt$(inflows.unswept)} more moved between registers than was recorded as arriving.
              Register moves come from money that came in, so a gap this size suggests a deposit
              isn&apos;t being recognised as one — check the unrecognised list, or widen the window
              in case the deposit and its sweep fall either side of the boundary.
            </div>
          )}

          {inflows.unclassified.length > 0 && (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-[10px] text-[#7c82a0] hover:text-white">
                Show unrecognised inflows
              </summary>
              <div className="mt-1.5 space-y-1">
                {inflows.unclassified.map((t) => (
                  <div key={t.id} className="text-[11px] flex items-center gap-2">
                    <span className="text-[#9aa2c0] tabular-nums w-20">{fmtDate(t.date)}</span>
                    <span className="text-[#7c82a0] truncate flex-1">{t.description}</span>
                    <span className="tabular-nums text-yellow-300">{fmt$(t.amount)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[#4a5070] mt-1.5">
                These are positive amounts that are neither a known payer nor a recognised register
                move. If any is a real deposit, add its payer name to
                {' '}<code className="text-[#7c82a0]">lib/data/contribution-sources.ts</code> so it
                counts toward contributions rather than falling into the equity bridge residual.
              </p>
            </details>
          )}
        </div>
      )}

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
                    {manualIds.has(t.id) && (
                      <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-[#2d3248] text-[#7c82a0]" title="Manually recorded, not from the Schwab feed">
                        manual
                      </span>
                    )}
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
