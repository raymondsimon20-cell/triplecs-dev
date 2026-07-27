'use client';

/**
 * DashboardOverview — "Portfolio Dashboard" landing page (P2P-style redesign).
 *
 * Layout mirrors the reference: stat card grid → performance cards (day /
 * total gain / total return) → account card → top positions summary → recent
 * transactions. Dark theme, matches existing surface palette.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { StatCard as Stat } from '@/components/StatCard';
import { TickerAvatar, PlChip, WeightBar, TableSkeleton } from '@/components/polish';
import { ArrowRight, Banknote, Clock, CreditCard, Gauge, Landmark, Layers, List, Percent, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { type NormalizedTransaction, parseOptionSymbol } from '@/components/TransactionsView';

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

function ago(d: Date | null): string {
  if (!d) return '—';
  const min = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)}d ago`;
}


interface Props {
  accountLabel:    string;
  accountNumber:   string;
  ownerName?:      string;
  totalValue:      number;
  equity:          number;
  marginBalance:   number;
  availableCash:   number;
  positions:       EnrichedPosition[];
  lastUpdated:     Date | null;
  /** Trailing-12-month dividend total (for the total-return card). */
  dividends12mo:   number;
  /** Most recent normalized transactions (dividends, trades) for the table. */
  recentTransactions: NormalizedTransaction[];
  transactionsLoading?: boolean;
  onViewPositions:    () => void;
  onViewTransactions: () => void;
}

export function DashboardOverview({
  accountLabel, accountNumber, ownerName = '', totalValue, equity, marginBalance,
  availableCash, positions, lastUpdated, dividends12mo, recentTransactions,
  transactionsLoading = false, onViewPositions, onViewTransactions,
}: Props) {
  const marginUsed = Math.abs(marginBalance);
  const equityPct  = totalValue > 0 ? (equity / totalValue) * 100 : 0;

  // 30-day snapshot series for the hero sparklines.
  const [spark, setSpark] = useState<{ gross: number[]; net: number[] }>({ gross: [], net: [] });
  useEffect(() => {
    fetch('/api/snapshots?limit=30')
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((d) => {
        const snaps = Array.isArray(d?.snapshots) ? [...d.snapshots].reverse() : [];
        setSpark({
          gross: snaps.map((s: { totalValue?: number }) => s.totalValue ?? 0).filter((v: number) => v > 0),
          net:   snaps.filter((s: { synthetic?: boolean; equity?: number | null }) => !s.synthetic && typeof s.equity === 'number')
                      .map((s: { equity?: number | null }) => s.equity as number),
        });
      })
      .catch(() => { /* sparkline is decoration — never break the page */ });
  }, []);

  const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

  const { dayGL, totalGain, costBasis } = useMemo(() => {
    let dayGL = 0, totalGain = 0, costBasis = 0;
    for (const p of positions) {
      dayGL     += p.todayGainLoss ?? 0;
      totalGain += p.gainLoss ?? 0;
      const qty = p.longQuantity ?? 0;
      costBasis += (p.averagePrice ?? 0) * qty;
    }
    return { dayGL, totalGain, costBasis };
  }, [positions]);

  const dayPct       = totalValue > 0 ? (dayGL / totalValue) * 100 : 0;
  const gainPct      = costBasis > 0 ? (totalGain / costBasis) * 100 : 0;
  // Realized P/L from app-placed sales (matched against captured cost basis).
  const realizedTotal = useMemo(
    () => recentTransactions.reduce((s, t) => s + (typeof t.realizedPnl === 'number' ? t.realizedPnl : 0), 0),
    [recentTransactions],
  );
  const totalReturn  = totalGain + dividends12mo + realizedTotal;
  const returnPct    = costBasis > 0 ? (totalReturn / costBasis) * 100 : 0;

  const topPositions = useMemo(
    () => [...positions]
      .filter((p) => !p.instrument.symbol.includes(' '))
      .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0))
      .slice(0, 9),
    [positions],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
          <Gauge className="w-[18px] h-[18px] text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Portfolio Dashboard</h1>
          <p className="text-xs text-[#7c82a0] mt-0.5">Overview of your investment accounts</p>
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={Layers} label="Gross Portfolio Value" value={fmt$(totalValue)} rawValue={totalValue} format={money0}
              accentClass="border-t-blue-500/60" spark={spark.gross} index={0} />
        <Stat icon={Wallet} label="Net Portfolio Value" value={fmt$(equity)} rawValue={equity} format={money0}
              accentClass="border-t-blue-500/60" spark={spark.net} sparkColor="#5DCAA5" index={1} />
        <Stat icon={CreditCard} label="Margin Used" value={fmt$(marginUsed)} rawValue={marginUsed} format={money0}
              valueClass={marginUsed > 0 ? 'text-orange-300' : 'text-white'} accentClass="border-t-blue-500/60" index={2} />
        <Stat icon={Percent} label="Equity %" value={`${equityPct.toFixed(1)}%`} accentClass="border-t-blue-500/60" index={3} />
        <Stat icon={List} label="Unique Positions" value={String(positions.length)} accentClass="border-t-blue-500/60" index={4} />
        <Stat icon={Banknote} label="Available Cash (incl. unsettled)" value={fmt$(availableCash)} rawValue={availableCash} format={money0}
              accentClass="border-t-blue-500/60" index={5} />
        <Stat icon={Clock} label="Last Sync" value={ago(lastUpdated)} accentClass="border-t-blue-500/60" index={6} />
        <div className="hidden md:block" />
      </div>

      {/* Performance cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {([
          { label: 'Day Change',   v: dayGL,       pct: dayPct,    sub: undefined },
          { label: 'Total Gain',   v: totalGain,   pct: gainPct,   sub: undefined },
          { label: 'Total Return', v: totalReturn, pct: returnPct, sub: 'incl. dividends & realized (12mo)' },
        ]).map(({ label, v, pct, sub }, i) => {
          const Trend = v >= 0 ? TrendingUp : TrendingDown;
          const accent = v > 0 ? 'border-t-emerald-500/60' : v < 0 ? 'border-t-red-500/50' : 'border-t-[#2d3248]';
          return (
            <div key={label} className={`bg-[#12151f] border border-[#1f2334] border-t-2 ${accent} rounded-lg p-3.5`} style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="text-[11px] text-[#7c82a0]">{label}</div>
                <Trend className={`w-3.5 h-3.5 flex-shrink-0 ${plColor(v)}`} />
              </div>
              <div className="flex items-baseline gap-2">
                <span className={`text-2xl font-bold tabular-nums leading-tight ${plColor(v)}`}>{signed$(v)}</span>
                <PlChip value={pct} pct />
              </div>
              {sub && <div className="text-[10px] text-[#4a5070] mt-0.5">{sub}</div>}
            </div>
          );
        })}
      </div>

      {/* Account card */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-blue-600/15 border border-blue-500/25 flex items-center justify-center">
            <Landmark className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            {ownerName && <div className="text-sm font-semibold text-white">{ownerName}</div>}
            <div className="text-xs text-[#7c82a0]">
              Schwab (···{accountNumber.slice(-3)})
            </div>
          </div>
        </div>
        <button onClick={onViewPositions} className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors">
          View full account details <ArrowRight className="w-3 h-3" />
        </button>
      </div>

      {/* Positions summary */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f2334]">
          <span className="text-sm font-semibold text-white">Positions</span>
          <span className="text-[10px] text-[#4a5070]">Prices as of {ago(lastUpdated)}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[#4a5070] border-b border-[#1a1e2e]">
                <th className="text-left px-4 py-2 font-medium">Symbol</th>
                <th className="text-right px-2 py-2 font-medium">Day $</th>
                <th className="text-right px-2 py-2 font-medium">Day %</th>
                <th className="text-right px-2 py-2 font-medium">Gain $</th>
                <th className="text-right px-2 py-2 font-medium">Gain %</th>
                <th className="text-right px-2 py-2 font-medium">Value</th>
                <th className="text-right px-4 py-2 font-medium">Weight</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[#1a1e2e] font-semibold text-white">
                <td className="px-4 py-2.5">Portfolio Total</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(dayGL)}`}>{signed$(dayGL)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(dayGL)}`}>{signedPct(dayPct)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totalGain)}`}>{signed$(totalGain)}</td>
                <td className={`px-2 py-2.5 text-right tabular-nums ${plColor(totalGain)}`}>{signedPct(gainPct)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{fmt$(totalValue)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[#7c82a0]">100.00%</td>
              </tr>
              {topPositions.map((p) => {
                const v = p.currentValue ?? 0;
                const w = totalValue > 0 ? (v / totalValue) * 100 : 0;
                const day = p.todayGainLoss ?? 0;
                const dayP = v - day > 0 ? (day / (v - day)) * 100 : 0;
                return (
                  <tr key={p.instrument.symbol} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <TickerAvatar symbol={p.instrument.symbol} size="sm" />
                        <span className="font-mono font-semibold text-white">{p.instrument.symbol}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right"><PlChip value={day} /></td>
                    <td className={`px-2 py-2 text-right tabular-nums ${day === 0 ? 'text-[#4a5070]' : plColor(day)}`}>
                      {day === 0 ? '--' : signedPct(dayP)}
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${plColor(p.gainLoss)}`}>{signed$(p.gainLoss)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${plColor(p.gainLoss)}`}>{signedPct(p.gainLossPercent)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-white">{fmt$(v)}</td>
                    <td className="px-4 py-2 text-right"><WeightBar pct={w} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button onClick={onViewPositions} className="w-full px-4 py-2.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-[#161a28] transition-colors text-left flex items-center gap-1">
          View all positions <ArrowRight className="w-3 h-3" />
        </button>
      </div>

      {/* Recent transactions */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f2334]">
          <span className="text-sm font-semibold text-white">Recent Transactions</span>
          <button onClick={onViewTransactions} className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors">
            View all <ArrowRight className="w-3 h-3" />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[#4a5070] border-b border-[#1a1e2e]">
                <th className="text-left px-4 py-2 font-medium">Date</th>
                <th className="text-left px-2 py-2 font-medium">Type</th>
                <th className="text-left px-2 py-2 font-medium">Symbol</th>
                <th className="text-right px-2 py-2 font-medium">Strike</th>
                <th className="text-right px-2 py-2 font-medium">Exp</th>
                <th className="text-left px-2 py-2 font-medium">Description</th>
                <th className="text-right px-2 py-2 font-medium">Amount</th>
                <th className="text-right px-2 py-2 font-medium">Units</th>
                <th className="text-right px-2 py-2 font-medium">Fee</th>
                <th className="text-right px-4 py-2 font-medium">P/L</th>
              </tr>
            </thead>
            <tbody>
              {transactionsLoading && <TableSkeleton cols={10} rows={5} />}
              {!transactionsLoading && recentTransactions.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-4 text-[#4a5070]">No recent transactions.</td></tr>
              )}
              {recentTransactions.slice(0, 10).map((t) => {
                const opt = t.symbol ? parseOptionSymbol(t.symbol) : null;
                return (
                <tr key={t.id} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                  <td className="px-4 py-2 text-[#9aa2c0] whitespace-nowrap">
                    {new Date(t.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      t.category === 'Dividend' ? 'bg-emerald-500/15 text-emerald-300'
                      : t.category.includes('Sale') ? 'bg-blue-500/15 text-blue-300'
                      : t.category.includes('Purchase') ? 'bg-violet-500/15 text-violet-300'
                      : 'bg-[#2d3248] text-[#9aa2c0]'
                    }`}>{t.category}</span>
                  </td>
                  <td className="px-2 py-2 font-mono font-semibold text-white">{opt ? `${opt.underlying} ${opt.kind}` : (t.symbol || '-')}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0]">{opt ? fmt$(opt.strike) : '-'}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#9aa2c0] whitespace-nowrap">{opt ? opt.exp : '-'}</td>
                  <td className="px-2 py-2 text-[#7c82a0] max-w-[240px] truncate">{t.description}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${plColor(t.amount)}`}>{signed$(t.amount)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[#7c82a0]">{t.units ? t.units.toFixed(4) : '0.0000'}</td>
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
      </div>
    </div>
  );
}
