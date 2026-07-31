'use client';

/**
 * MonthCloseView — monthly reconciliation.
 * Balance sheet, equity change bridge (waterfall), and net equity trend from
 * daily snapshots (/api/snapshots), for any month with snapshot history.
 *
 * Note on historical months: the `totalValue` / `equity` / `marginBalance` props
 * are *live* account values. They are only correct for the current month. When a
 * past month is selected we reconstruct the closing balance sheet from the last
 * real snapshot in that month instead, and fall back to an explicit "no data"
 * state rather than silently showing today's numbers under an old month's label.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { StatCard as Stat } from '@/components/StatCard';
import { Activity, CalendarCheck, ChevronLeft, ChevronRight, Percent, TrendingUp, Wallet } from 'lucide-react';
import type { NormalizedTransaction } from '@/components/TransactionsView';

const fmt$ = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

/** `savedAt` is epoch milliseconds from lib/portfolio/fetch.ts (Date.now()). */
interface SnapshotPoint { savedAt: number | string; totalValue: number; equity: number | null; synthetic?: boolean }

/** YYYY-MM-DD day key from either epoch ms or an ISO string. */
function dayKey(savedAt: number | string): string {
  const d = new Date(savedAt);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Last calendar day of a YYYY-MM month, as YYYY-MM-DD. */
function monthEndKey(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
}

function monthLabelOf(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** Step a YYYY-MM key by ±n months. */
function shiftMonth(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  return monthKeyOf(new Date(y, m - 1 + n, 1));
}

interface Props {
  totalValue:    number;
  equity:        number;
  marginBalance: number;
  transactions:  NormalizedTransaction[];
  accountHash?:  string;
}

export function MonthCloseView({ totalValue, equity, marginBalance, transactions, accountHash }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotPoint[]>([]);
  const currentMonth = monthKeyOf(new Date());
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);

  useEffect(() => {
    // 400 days rather than 180 — the month selector is only as deep as the
    // snapshot history behind it.
    const params = new URLSearchParams({ limit: '400' });
    if (accountHash) params.set('accountHash', accountHash);
    fetch(`/api/snapshots?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((d) => setSnapshots(Array.isArray(d?.snapshots) ? [...d.snapshots].reverse() : []))
      .catch(() => setSnapshots([]));
  }, [accountHash]);

  const isCurrent = selectedMonth === currentMonth;
  const monthStartKey = `${selectedMonth}-01`;
  const endKey = monthEndKey(selectedMonth);
  const monthLabel = monthLabelOf(selectedMonth);

  /** Months we can offer: every month with snapshot or transaction history, plus now. */
  const availableMonths = useMemo(() => {
    const keys = new Set<string>([currentMonth]);
    for (const s of snapshots) {
      const k = dayKey(s.savedAt);
      if (k) keys.add(k.slice(0, 7));
    }
    for (const t of transactions) {
      if (t.date) keys.add(t.date.slice(0, 7));
    }
    return Array.from(keys).sort().reverse();
  }, [snapshots, transactions, currentMonth]);

  const oldestMonth = availableMonths[availableMonths.length - 1] ?? currentMonth;
  const canGoBack = selectedMonth > oldestMonth;
  const canGoForward = selectedMonth < currentMonth;

  /** Real (non-synthetic) snapshots falling inside the selected month. */
  const monthSnaps = useMemo(
    () => snapshots.filter((s) => {
      const k = dayKey(s.savedAt);
      return k >= monthStartKey && k <= endKey && s.equity !== null && !s.synthetic;
    }),
    [snapshots, monthStartKey, endKey],
  );

  // Opening equity: the last real snapshot *before* this month is the truest
  // opening balance. Fall back to the first snapshot within the month when we
  // have no prior history (i.e. the first month tracked).
  const openingEquity = useMemo(() => {
    const prior = snapshots.filter((s) => dayKey(s.savedAt) < monthStartKey && s.equity !== null && !s.synthetic);
    if (prior.length > 0) return prior[prior.length - 1].equity as number;
    return monthSnaps.length > 0 ? (monthSnaps[0].equity as number) : null;
  }, [snapshots, monthStartKey, monthSnaps]);

  // Closing balance sheet. Live props for the current month; last in-month
  // snapshot for history. Null means we genuinely have no data for that month.
  const closing = useMemo(() => {
    if (isCurrent) return { equity, totalValue, hasData: true };
    const lastSnap = monthSnaps[monthSnaps.length - 1];
    if (!lastSnap) return { equity: 0, totalValue: 0, hasData: false };
    return { equity: lastSnap.equity as number, totalValue: lastSnap.totalValue, hasData: true };
  }, [isCurrent, equity, totalValue, monthSnaps]);

  // Selected month's flow components from transactions.
  const flows = useMemo(() => {
    let contributions = 0, income = 0, expenses = 0, realized = 0;
    for (const t of transactions) {
      if (t.date < monthStartKey || t.date > endKey) continue;
      if (t.category === 'Contribution') contributions += Math.abs(t.amount);
      else if (t.category === 'Dividend' || t.category === 'Interest') income += Math.abs(t.amount);
      else if (t.category === 'Withdrawal' || t.category === 'Margin Interest') expenses += Math.abs(t.amount);
      if (typeof t.realizedPnl === 'number') realized += t.realizedPnl;
    }
    return { contributions, netOperating: income - expenses, realized };
  }, [transactions, monthStartKey, endKey]);

  const closingEquity = closing.equity;
  const closingTotal  = closing.totalValue;
  // Margin is a live figure, so only trust the prop for the current month;
  // otherwise derive it from the snapshot's assets-minus-equity.
  const marginUsed  = isCurrent ? Math.abs(marginBalance) : Math.max(closingTotal - closingEquity, 0);
  const opening     = openingEquity ?? 0;
  const marketOther = closingEquity - opening - flows.contributions - flows.netOperating - flows.realized;
  const netChange   = closingEquity - opening;
  const equityPct   = closingTotal > 0 ? (closingEquity / closingTotal) * 100 : 0;

  // Waterfall bars: [label, value, running-start]
  const bridge = useMemo(() => {
    const steps = [
      { label: 'Opening',      value: opening,             kind: 'total' as const },
      { label: 'Contrib.',     value: flows.contributions, kind: 'delta' as const },
      { label: 'Net Oper.',    value: flows.netOperating,  kind: 'delta' as const },
      { label: 'Realized P/L', value: flows.realized,      kind: 'delta' as const },
      { label: 'Mkt & Other',  value: marketOther,         kind: 'delta' as const },
      { label: 'Closing',      value: closingEquity,       kind: 'total' as const },
    ];
    let running = 0;
    return steps.map((s) => {
      if (s.kind === 'total') { const start = 0; running = s.value; return { ...s, start, end: s.value }; }
      const start = running; running += s.value;
      return { ...s, start: Math.min(start, running), end: Math.max(start, running) };
    });
  }, [opening, flows, marketOther, closingEquity]);
  const bridgeMax = Math.max(...bridge.map((b) => b.end), 1);

  // Net equity trend from snapshots (all available real equity points).
  const trend = useMemo(
    () => snapshots
      .filter((s) => s.equity !== null && !s.synthetic)
      .map((s) => ({ date: dayKey(s.savedAt), equity: s.equity as number }))
      .filter((s) => s.date !== ''),
    [snapshots],
  );
  const trendMax = Math.max(...trend.map((t) => t.equity), closingEquity, 1);

  const navBtn = 'w-7 h-7 rounded-md border border-[#2d3248] flex items-center justify-center text-[#9aa2c0] hover:text-white hover:border-[#3d4468] disabled:opacity-30 disabled:cursor-not-allowed transition-colors';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
            <CalendarCheck className="w-[18px] h-[18px] text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Month Close</h1>
            <p className="text-xs text-[#7c82a0] mt-0.5">Did your equity grow? Monthly reconciliation and equity tracking</p>
          </div>
        </div>

        {/* Month selector */}
        <div className="flex items-center gap-1.5">
          <button
            className={navBtn}
            onClick={() => setSelectedMonth((m) => shiftMonth(m, -1))}
            disabled={!canGoBack}
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="bg-[#12151f] border border-[#2d3248] rounded-md px-3 py-1.5 text-xs text-white hover:border-[#3d4468] focus:outline-none focus:border-amber-500/50 transition-colors"
            aria-label="Select month"
          >
            {availableMonths.map((m) => (
              <option key={m} value={m}>
                {monthLabelOf(m)}{m === currentMonth ? ' (MTD)' : ''}
              </option>
            ))}
          </select>
          <button
            className={navBtn}
            onClick={() => setSelectedMonth((m) => shiftMonth(m, 1))}
            disabled={!canGoForward}
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!closing.hasData ? (
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-6">
          <p className="text-sm text-[#9aa2c0]">No snapshot history for {monthLabel}.</p>
          <p className="text-xs text-[#4a5070] mt-1.5">
            Month Close reconstructs closing balances from daily snapshots. Months before snapshot
            tracking began cannot be reconciled — pick a more recent month.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat icon={Wallet} label="Closing Equity" value={fmt$(closingEquity)}
                  sub={isCurrent ? 'Live — month in progress' : undefined}
                  accentClass="border-t-amber-500/60" index={0} />
            <Stat icon={TrendingUp} label="Net Change" value={openingEquity === null ? fmt$(closingEquity) : signed$(netChange)}
                  sub={openingEquity === null ? 'No opening balance' : undefined}
                  valueClass={openingEquity === null ? 'text-white' : plColor(netChange)} accentClass="border-t-amber-500/60" index={1} />
            <Stat icon={Percent} label="Equity %" value={`${equityPct.toFixed(1)}%`} accentClass="border-t-amber-500/60" index={2} />
            <Stat icon={Activity} label="Market & Other" value={signed$(marketOther)} valueClass={plColor(marketOther)} accentClass="border-t-amber-500/60" index={3} />
          </div>

          {/* Balance sheet */}
          <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-white">Balance Sheet</span>
              <span className="text-[10px] text-[#4a5070]">
                {isCurrent ? 'As of now' : `As of ${monthSnaps[monthSnaps.length - 1] ? dayKey(monthSnaps[monthSnaps.length - 1].savedAt) : endKey}`}
              </span>
            </div>
            <div className="space-y-2 text-xs max-w-md">
              <div className="flex justify-between"><span className="text-[#7c82a0]">Assets</span><span className="text-white tabular-nums">{fmt$(closingTotal)}</span></div>
              <div className="flex justify-between"><span className="text-[#7c82a0]">Liabilities (Margin)</span><span className="text-orange-300 tabular-nums">({fmt$(marginUsed)})</span></div>
              <div className="flex justify-between border-t border-[#1f2334] pt-2 font-semibold">
                <span className="text-white">Net Equity</span><span className="text-white tabular-nums">{fmt$(closingEquity)}</span>
              </div>
              <div className="flex justify-between"><span className="text-[#7c82a0]">Equity %</span><span className="text-[#9aa2c0] tabular-nums">{equityPct.toFixed(1)}%</span></div>
            </div>
          </div>

          {/* Equity change bridge */}
          <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-white">Equity Change Bridge</span>
              <span className="text-[10px] text-[#4a5070]">{monthLabel}{openingEquity === null ? ' · no opening balance available' : ''}</span>
            </div>
            <div className="flex items-end gap-3 h-40">
              {bridge.map((b) => {
                const hStart = (b.start / bridgeMax) * 100;
                const hEnd   = (b.end / bridgeMax) * 100;
                const isTotal = b.kind === 'total';
                const barColor = isTotal ? 'bg-blue-500/70'
                  : b.value >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70';
                return (
                  <div key={b.label} className="flex-1 flex flex-col justify-end h-full" title={`${b.label}: ${signed$(b.value)}`}>
                    <div className={`text-[10px] text-center mb-1 tabular-nums ${isTotal ? 'text-white' : plColor(b.value)}`}>
                      {signed$(b.value)}
                    </div>
                    <div className="relative flex-1">
                      <div
                        className={`absolute left-0 right-0 rounded-sm ${barColor}`}
                        style={{ bottom: `${hStart}%`, height: `${Math.max(hEnd - hStart, 1)}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-[#7c82a0] text-center mt-1.5">{b.label}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Net equity trend — full history, independent of the selected month */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-white">Net Equity Trend</span>
          <span className="text-[10px] text-[#4a5070]">{trend.length} daily snapshots</span>
        </div>
        {trend.length < 2 ? (
          <p className="text-xs text-[#4a5070] py-4">
            Not enough snapshot history yet — the trend fills in as daily snapshots accumulate.
          </p>
        ) : (
          <div>
            <div className="flex items-end gap-[1px] h-32">
              {trend.map((t) => {
                const inMonth = t.date >= monthStartKey && t.date <= endKey;
                return (
                  <div key={t.date} className="flex-1 flex flex-col justify-end h-full" title={`${t.date}: ${fmt$(t.equity)}`}>
                    <div
                      className={`rounded-t-sm ${inMonth ? 'bg-amber-400/80' : 'bg-blue-500/50'}`}
                      style={{ height: `${(t.equity / trendMax) * 100}%`, minHeight: '2px' }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-[#4a5070] mt-1.5">
              <span>{trend[0].date}</span>
              <span className="text-amber-400/70">{monthLabel} highlighted</span>
              <span>{trend[trend.length - 1].date}</span>
            </div>
          </div>
        )}
      </div>

      <p className="text-[10px] text-[#4a5070]">
        Bridge components: contributions, net operating cash, and realized P/L (from app-placed sales
        with captured cost basis) from the selected month&apos;s transactions; &quot;Market &amp; Other&quot; is the
        residual — price moves plus any sales placed outside the app. Closing balances for past months
        come from the last daily snapshot in that month, not live account values.
      </p>
    </div>
  );
}
