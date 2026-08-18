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
import { InfoBubble, BubbleRow, MetricHelpBody } from '@/components/InfoBubble';
import { ArrowRight, Banknote, Clock, CreditCard, Gauge, Landmark, Layers, List, Percent, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { type NormalizedTransaction, parseOptionSymbol } from '@/components/TransactionsView';

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const signed$ = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
// Whole-dollar, unsigned. Module scope so it's stable across renders and safe
// to reference from memoized card content without landing in a deps array.
const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
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
  /**
   * Schwab's "Total accounts value" (`liquidationValue`). Differs from
   * `equity` in a margin account holding shorts. Optional so callers that
   * haven't been updated fall back to `equity` rather than rendering NaN.
   */
  liquidationValue?: number;
  marginBalance:   number;
  availableCash:   number;
  positions:       EnrichedPosition[];
  lastUpdated:     Date | null;
  /** Trailing-12-month dividend total (fallback total-return card only). */
  dividends12mo:   number;
  /**
   * Time-weighted return from /api/performance. Preferred source for the
   * Total Return card — measures a defined window and nets out contributions.
   * Null when there aren't yet two real snapshots to chain.
   */
  twr?: {
    twrPct: number; cagrPct: number; daysCovered: number; hasGaps: boolean;
    /** Dollar P/L over the same window, net of contributions. Optional so a
     *  stale cached response without the field degrades to percent-only. */
    gainDollars?: number;
    /** Window summary for the "how this is calculated" bubble. All optional
     *  for the same reason — a response predating them just shows less. */
    startValue?: number;
    endValue?: number;
    netFlowTotal?: number;
    startDate?: string;
    endDate?: string;
    periods?: unknown[];
  } | null;
  /** Most recent normalized transactions (dividends, trades) for the table. */
  recentTransactions: NormalizedTransaction[];
  transactionsLoading?: boolean;
  onViewPositions:    () => void;
  onViewTransactions: () => void;
}

export function DashboardOverview({
  accountLabel, accountNumber, ownerName = '', totalValue, equity, liquidationValue,
  marginBalance, availableCash, positions, lastUpdated, dividends12mo, twr = null,
  recentTransactions, transactionsLoading = false, onViewPositions, onViewTransactions,
}: Props) {
  const marginUsed = Math.abs(marginBalance);
  // Net worth of the account as Schwab states it. Falls back to `equity` when
  // the caller hasn't plumbed liquidationValue through.
  const netValue   = liquidationValue ?? equity;
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

  const { dayGL, totalGain, costBasis } = useMemo(() => {
    let dayGL = 0, totalGain = 0, costBasis = 0;
    for (const p of positions) {
      dayGL     += p.todayGainLoss ?? 0;
      totalGain += p.gainLoss ?? 0;
      // `p.costBasis` is signed and already dollar-denominated (option ×100
      // applied) — see enrichPositions. Summing the magnitude keeps short
      // credits from cancelling long capital in the return denominator.
      costBasis += Math.abs(p.costBasis ?? 0);
    }
    return { dayGL, totalGain, costBasis };
  }, [positions]);

  // Day % is the move relative to where the portfolio STARTED the day, not
  // where it ended it. Using the post-move value understates a gain and
  // overstates a loss.
  //
  // Denominator is prior NET account value, not gross. Verified against the
  // Schwab statement of 2026-08-03: -$2,732.49 on a $84,930.01 account is the
  // -3.12% Schwab printed, i.e. -2732.49 / (84930.01 + 2732.49). Dividing into
  // gross exposure instead credits the margin balance with absorbing part of
  // the move and makes every day look calmer than Schwab reports it.
  const priorNetValue = netValue - dayGL;
  const dayPct        = priorNetValue > 0 ? (dayGL / priorNetValue) * 100 : 0;
  const gainPct      = costBasis > 0 ? (totalGain / costBasis) * 100 : 0;
  // Realized P/L from app-placed sales (matched against captured cost basis).
  // Explicitly windowed to the trailing 365 days so this component agrees with
  // `dividends12mo` regardless of what window the caller happened to fetch —
  // previously it summed whatever transactions were loaded while the card
  // claimed "12mo".
  const realizedTotal = useMemo(() => {
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    return recentTransactions.reduce((s, t) => {
      if (typeof t.realizedPnl !== 'number') return s;
      const ts = Date.parse(t.date);
      if (Number.isFinite(ts) && ts < cutoff) return s;
      return s + t.realizedPnl;
    }, 0);
  }, [recentTransactions]);

  const totalReturn  = totalGain + dividends12mo + realizedTotal;
  const returnPct    = costBasis > 0 ? (totalReturn / costBasis) * 100 : 0;

  // ─── Total Return card ──────────────────────────────────────────────────
  // Prefer time-weighted return from lib/performance.ts. The hand-rolled
  // `totalReturn` above sums three different measurement windows — unrealized
  // is since-purchase (potentially years), dividends and realized are trailing
  // 12 months, and the denominator is original cost. That is not a return over
  // any period; on a three-year holding the price change gets three years of
  // runway while the income gets one.
  //
  // TWR fixes both problems: it measures a defined window, and it nets out
  // deposits and withdrawals so contributions don't read as performance —
  // which matters here because this account is actively funded.
  //
  // Falls back to the legacy figure when TWR is unavailable (needs ≥2 real,
  // non-synthetic snapshots), with a label that admits what it is.
  const returnCard = useMemo(() => {
    if (twr && twr.daysCovered > 0) {
      const pct = twr.twrPct * 100;
      const months = twr.daysCovered / 30.44;
      // Say what was actually measured rather than claiming "12mo" — snapshot
      // history may be shorter than a year, and gaps skip periods entirely.
      const window = months >= 11.5 ? '12mo'
        : months >= 1 ? `${Math.round(months)}mo`
        : `${Math.round(twr.daysCovered)}d`;
      // Show dollars AND percent, like the other two cards. The dollar figure
      // is computed over the identical period set as the percentage (see
      // computeTWR), so it's the same window with contributions removed — not
      // the fabricated "apply the rate to today's balance" number this card
      // used to avoid by rendering percent-only.
      //
      // `gainDollars` is optional: an older cached /api/performance response
      // won't carry it, so fall back to the percent-only presentation rather
      // than rendering $NaN.
      const hasDollars = typeof twr.gainDollars === 'number' && Number.isFinite(twr.gainDollars);
      return {
        label:    'Total Return',
        // Drives the trend arrow and accent colour. Both figures share a sign,
        // so either works; prefer dollars when present.
        v:        hasDollars ? (twr.gainDollars as number) : pct,
        pct,
        headline: hasDollars ? undefined : signedPct(pct),
        sub:      `time-weighted, ${window}, net of contributions${twr.hasGaps ? ' · gaps in history' : ''}`,
        info: (
          <span className="block space-y-2">
            <span className="block font-semibold text-white">Time-weighted return</span>
            <span className="block text-[#7c82a0]">
              Each period&apos;s return is <span className="text-[#c8cde0]">(end − contributions) ÷ start − 1</span>,
              chained together. Removing contributions is what stops a deposit
              from reading as performance.
            </span>
            <span className="block space-y-1 border-t border-[#252840] pt-2">
              {twr.startDate && twr.endDate && (
                <BubbleRow label="Window" value={`${twr.startDate} → ${twr.endDate}`} />
              )}
              <BubbleRow label="Days measured" value={`${Math.round(twr.daysCovered)}`} />
              {typeof twr.startValue === 'number' && (
                <BubbleRow label="Starting value" value={money0(twr.startValue)} />
              )}
              {typeof twr.endValue === 'number' && (
                <BubbleRow label="Ending value" value={money0(twr.endValue)} />
              )}
              {typeof twr.netFlowTotal === 'number' && (
                <BubbleRow label="Contributions removed" value={signed$(twr.netFlowTotal)} />
              )}
            </span>
            <span className="block space-y-1 border-t border-[#252840] pt-2">
              {hasDollars && (
                <BubbleRow label="Gain (dollars)" value={signed$(twr.gainDollars as number)} />
              )}
              <BubbleRow label="Return (percent)" value={signedPct(pct)} />
              {/* Annualizing a short window explodes: a 2-day +17% compounds
                  to ~1e14% a year. Only show CAGR once there's enough history
                  for the number to mean anything. */}
              {twr.daysCovered >= 60 && (
                <BubbleRow label="Annualized" value={signedPct(twr.cagrPct * 100)} muted />
              )}
            </span>
            <span className="block border-t border-[#252840] pt-2 text-[#4a5070]">
              Dollars are summed period by period; the percent is chained
              geometrically. Once contributions land mid-window the two
              won&apos;t divide into each other exactly — that&apos;s expected.
            </span>
            {twr.hasGaps && (
              <span className="block text-amber-400/80">
                Some periods had no usable snapshot and were skipped. Both
                figures cover only the periods that survived.
              </span>
            )}
          </span>
        ),
      };
    }
    return {
      label:    'Total Return',
      v:        totalReturn,
      pct:      returnPct,
      headline: undefined as string | undefined,
      sub:      'unrealized + 12mo dividends & realized · mixed windows',
      info: (
        <span className="block space-y-2">
          <span className="block font-semibold text-white">Fallback calculation</span>
          <span className="block text-[#7c82a0]">
            Not enough snapshot history for a time-weighted return yet (needs
            at least two real daily snapshots), so this is a simple sum.
          </span>
          <span className="block space-y-1 border-t border-[#252840] pt-2">
            <BubbleRow label="Unrealized gain" value={signed$(totalGain)} />
            <BubbleRow label="Dividends (12mo)" value={signed$(dividends12mo)} />
            <BubbleRow label="Realized (12mo)" value={signed$(realizedTotal)} />
            <BubbleRow label="Total" value={signed$(totalReturn)} />
          </span>
          <span className="block space-y-1 border-t border-[#252840] pt-2">
            <BubbleRow label="÷ Cost basis" value={money0(costBasis)} />
            <BubbleRow label="= Return" value={signedPct(returnPct)} />
          </span>
          <span className="block border-t border-[#252840] pt-2 text-amber-400/80">
            These are three different windows: the unrealized gain runs since
            purchase (possibly years), while dividends and realized P/L cover
            only the last 12 months. Treat it as a rough figure until enough
            snapshots accumulate.
          </span>
        </span>
      ),
    };
  }, [twr, totalReturn, returnPct, totalGain, dividends12mo, realizedTotal, costBasis]);

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
        <Stat icon={Wallet} label="Net Portfolio Value" value={fmt$(netValue)} rawValue={netValue} format={money0}
              accentClass="border-t-blue-500/60" spark={spark.net} sparkColor="#5DCAA5" index={1} />
        <Stat icon={CreditCard} label="Margin Used" value={fmt$(marginUsed)} rawValue={marginUsed} format={money0}
              valueClass={marginUsed > 0 ? 'text-orange-300' : 'text-white'} accentClass="border-t-blue-500/60" index={2} />
        <Stat icon={Percent} label="Equity %" value={`${equityPct.toFixed(1)}%`} accentClass="border-t-blue-500/60" index={3} />
        <Stat icon={List} label="Unique Positions" value={String(positions.length)} accentClass="border-t-blue-500/60" index={4} />
        <Stat icon={Banknote} label="Cash & Cash Investments" value={fmt$(availableCash)} rawValue={availableCash} format={money0}
              valueClass={availableCash < 0 ? 'text-orange-300' : 'text-white'}
              accentClass="border-t-blue-500/60" index={5} />
        <Stat icon={Clock} label="Last Sync" value={ago(lastUpdated)} accentClass="border-t-blue-500/60" index={6} />
        <div className="hidden md:block" />
      </div>

      {/* Performance cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {([
          // Deliberately NOT Schwab's headline "Total day change". Schwab's
          // figure is the change in ACCOUNT VALUE, which folds in the day's
          // movement of the cash/margin line — on 2026-08-03 that was
          // -$3,954.99 of margin drawn to buy securities, dwarfing the
          // +$1,174.93 the securities actually moved. Borrowing money is not
          // a loss, so this card reports market P/L on positions only.
          // `headline` is undefined on the dollar-denominated cards — only the
          // TWR card overrides it, since a rate has no dollar equivalent.
          // Day Change and Total Gain take their bubble text straight from the
          // registry; Total Return builds its own because the content depends
          // on which of the two calculations is in play.
          {
            label: 'Day Change', v: dayGL, pct: dayPct,
            sub: 'market moves only, excl. cash & margin',
            headline: undefined as string | undefined,
            info: (
              <MetricHelpBody label="Day Change" detail={
                <>
                  <BubbleRow label="Move on positions" value={signed$(dayGL)} />
                  <BubbleRow label="÷ Prior net value" value={money0(priorNetValue)} />
                  <BubbleRow label="= Day change" value={signedPct(dayPct)} />
                </>
              } />
            ) as React.ReactNode,
          },
          {
            label: 'Total Gain', v: totalGain, pct: gainPct,
            sub: 'unrealized, since purchase',
            headline: undefined as string | undefined,
            info: (
              <MetricHelpBody label="Total Gain" detail={
                <>
                  <BubbleRow label="Unrealized P/L" value={signed$(totalGain)} />
                  <BubbleRow label="÷ Cost basis" value={money0(costBasis)} />
                  <BubbleRow label="= Total gain" value={signedPct(gainPct)} />
                </>
              } />
            ) as React.ReactNode,
          },
          returnCard,
        ]).map(({ label, v, pct, sub, headline, info }, i) => {
          const Trend = v >= 0 ? TrendingUp : TrendingDown;
          const accent = v > 0 ? 'border-t-emerald-500/60' : v < 0 ? 'border-t-red-500/50' : 'border-t-[#2d3248]';
          return (
            <div key={label} className={`bg-[#12151f] border border-[#1f2334] border-t-2 ${accent} rounded-lg p-3.5`} style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-1.5 text-[11px] text-[#7c82a0]">
                  {label}
                  {info && <InfoBubble label={label}>{info}</InfoBubble>}
                </div>
                <Trend className={`w-3.5 h-3.5 flex-shrink-0 ${plColor(v)}`} />
              </div>
              <div className="flex items-baseline gap-2">
                {/* Cards normally render dollars large with a percent chip.
                    `headline` overrides that with a percentage when there is
                    no honest dollar figure — which now only happens if the
                    performance response predates `gainDollars`. */}
                <span className={`text-2xl font-bold tabular-nums leading-tight ${plColor(v)}`}>
                  {headline ?? signed$(v)}
                </span>
                {headline ? null : <PlChip value={pct} pct />}
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
                // Shared with PositionsView via enrichPositions — see
                // lib/classify.ts. null = no position at yesterday's close.
                const dayP = p.todayGainLossPercent;
                return (
                  <tr key={p.instrument.symbol} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <TickerAvatar symbol={p.instrument.symbol} size="sm" />
                        <span className="font-mono font-semibold text-white">{p.instrument.symbol}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right"><PlChip value={day} /></td>
                    <td className={`px-2 py-2 text-right tabular-nums ${day === 0 || dayP == null ? 'text-[#4a5070]' : plColor(day)}`}>
                      {day === 0 || dayP == null ? '--' : signedPct(dayP)}
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
