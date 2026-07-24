'use client';

/**
 * MonthCloseView — monthly reconciliation (P2P-style redesign, page 6).
 * Balance sheet, equity change bridge (waterfall), and net equity trend from
 * daily snapshots (/api/snapshots).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
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
  totalValue:    number;
  equity:        number;
  marginBalance: number;
  transactions:  NormalizedTransaction[];
  accountHash?:  string;
}

export function MonthCloseView({ totalValue, equity, marginBalance, transactions, accountHash }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotPoint[]>([]);

  useEffect(() => {
    const params = new URLSearchParams({ limit: '180' });
    if (accountHash) params.set('accountHash', accountHash);
    fetch(`/api/snapshots?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((d) => setSnapshots((d.snapshots ?? []).reverse()))
      .catch(() => setSnapshots([]));
  }, [accountHash]);

  const monthStartKey = new Date().toISOString().slice(0, 7) + '-01';
  const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Opening equity = first real (non-synthetic) snapshot of this month.
  const openingEquity = useMemo(() => {
    const monthSnaps = snapshots.filter((s) => dayKey(s.savedAt) >= monthStartKey && s.equity !== null && !s.synthetic);
    return monthSnaps.length > 0 ? (monthSnaps[0].equity as number) : null;
  }, [snapshots, monthStartKey]);

  // This month's flow components from transactions.
  const flows = useMemo(() => {
    let contributions = 0, income = 0, expenses = 0;
    for (const t of transactions) {
      if (t.date < monthStartKey) continue;
      if (t.category === 'Contribution') contributions += Math.abs(t.amount);
      else if (t.category === 'Dividend' || t.category === 'Interest') income += Math.abs(t.amount);
      else if (t.category === 'Withdrawal' || t.category === 'Margin Interest') expenses += Math.abs(t.amount);
    }
    return { contributions, netOperating: income - expenses };
  }, [transactions, monthStartKey]);

  const marginUsed = Math.abs(marginBalance);
  const opening    = openingEquity ?? 0;
  const marketOther = equity - opening - flows.contributions - flows.netOperating;
  const netChange   = equity - opening;
  const equityPct   = totalValue > 0 ? (equity / totalValue) * 100 : 0;

  // Waterfall bars: [label, value, running-start]
  const bridge = useMemo(() => {
    const steps = [
      { label: 'Opening',      value: opening,            kind: 'total' as const },
      { label: 'Contrib.',     value: flows.contributions, kind: 'delta' as const },
      { label: 'Net Oper.',    value: flows.netOperating,  kind: 'delta' as const },
      { label: 'Mkt & Other',  value: marketOther,         kind: 'delta' as const },
      { label: 'Closing',      value: equity,              kind: 'total' as const },
    ];
    let running = 0;
    return steps.map((s) => {
      if (s.kind === 'total') { const start = 0; running = s.value; return { ...s, start, end: s.value }; }
      const start = running; running += s.value;
      return { ...s, start: Math.min(start, running), end: Math.max(start, running) };
    });
  }, [opening, flows, marketOther, equity]);
  const bridgeMax = Math.max(...bridge.map((b) => b.end), 1);

  // Net equity trend from snapshots (all available real equity points).
  const trend = useMemo(
    () => snapshots
      .filter((s) => s.equity !== null && !s.synthetic)
      .map((s) => ({ date: dayKey(s.savedAt), equity: s.equity as number }))
      .filter((s) => s.date !== ''),
    [snapshots],
  );
  const trendMax = Math.max(...trend.map((t) => t.equity), equity, 1);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
          <CalendarCheck className="w-[18px] h-[18px] text-amber-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Month Close</h1>
          <p className="text-xs text-[#7c82a0] mt-0.5">Did your equity grow? Monthly reconciliation and equity tracking</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Closing Equity" value={fmt$(equity)} />
        <Stat label="Net Change"     value={openingEquity === null ? fmt$(equity) : signed$(netChange)}
              sub={openingEquity === null ? 'First month — no opening balance' : undefined}
              valueClass={openingEquity === null ? 'text-white' : plColor(netChange)} />
        <Stat label="Equity %"       value={`${equityPct.toFixed(1)}%`} />
        <Stat label="Market & Other" value={signed$(marketOther)} valueClass={plColor(marketOther)} />
      </div>

      {/* Balance sheet */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="text-sm font-semibold text-white mb-3">Balance Sheet</div>
        <div className="space-y-2 text-xs max-w-md">
          <div className="flex justify-between"><span className="text-[#7c82a0]">Assets</span><span className="text-white tabular-nums">{fmt$(totalValue)}</span></div>
          <div className="flex justify-between"><span className="text-[#7c82a0]">Liabilities (Margin)</span><span className="text-orange-300 tabular-nums">({fmt$(marginUsed)})</span></div>
          <div className="flex justify-between border-t border-[#1f2334] pt-2 font-semibold">
            <span className="text-white">Net Equity</span><span className="text-white tabular-nums">{fmt$(equity)}</span>
          </div>
          <div className="flex justify-between"><span className="text-[#7c82a0]">Equity %</span><span className="text-[#9aa2c0] tabular-nums">{equityPct.toFixed(1)}%</span></div>
        </div>
      </div>

      {/* Equity change bridge */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-white">Equity Change Bridge</span>
          <span className="text-[10px] text-[#4a5070]">{monthLabel}{openingEquity === null ? ' · first month — no opening balance available' : ''}</span>
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

      {/* Net equity trend */}
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
              {trend.map((t) => (
                <div key={t.date} className="flex-1 flex flex-col justify-end h-full" title={`${t.date}: ${fmt$(t.equity)}`}>
                  <div className="bg-blue-500/50 rounded-t-sm" style={{ height: `${(t.equity / trendMax) * 100}%`, minHeight: '2px' }} />
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-[#4a5070] mt-1.5">
              <span>{trend[0].date}</span>
              <span>{trend[trend.length - 1].date}</span>
            </div>
          </div>
        )}
      </div>

      <p className="text-[10px] text-[#4a5070]">
        Bridge components: contributions and net operating cash from this month&apos;s transactions;
        &quot;Market &amp; Other&quot; is the residual (price moves, realized P/L, and anything uncategorized).
      </p>
    </div>
  );
}
