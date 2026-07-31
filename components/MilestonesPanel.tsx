'use client';

/**
 * MilestonesPanel — the phase ladder, paced by observed contributions.
 *
 * The value in this is not the progress bar; it is the pace. Trailing
 * contributions are read from the transaction ledger, so "how far to the next
 * threshold" is answered from what the account actually did rather than an
 * assumed savings rate. Where the rate is zero or negative the projection is
 * withheld instead of shown as an optimistic guess.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Flag, TrendingUp, CheckCircle2 } from 'lucide-react';
import {
  VALUE_MILESTONES, milestoneProgress, freedomProgress,
} from '@/lib/portfolio/milestones';
import type { NormalizedTransaction } from '@/components/TransactionsView';

const fmt$ = (n: number, dec = 0) =>
  '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

function describeMonths(m: number | null): string {
  if (m === null) return '—';
  if (m < 12) return `${m} mo`;
  const y = Math.floor(m / 12), rem = m % 12;
  return rem === 0 ? `${y}y` : `${y}y ${rem}m`;
}

interface Props {
  portfolioValue:  number;
  /** Projected monthly distribution income. */
  monthlyIncome:   number;
  /** Monthly income target from strategy settings. */
  monthlyTarget:   number;
  blendedYieldPct: number;
  transactions:    NormalizedTransaction[];
}

export function MilestonesPanel({
  portfolioValue, monthlyIncome, monthlyTarget, blendedYieldPct, transactions,
}: Props) {
  const [windowDays, setWindowDays] = useState(90);

  /**
   * Monthly accumulation = net contributions over the window, annualised to a
   * month. Distributions are excluded deliberately: they are already inside
   * portfolio value, so counting them here would double-count the compounding.
   */
  const pace = useMemo(() => {
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
    let contributions = 0, withdrawals = 0;
    for (const t of transactions) {
      if (t.date < cutoff) continue;
      if (t.category === 'Contribution') contributions += Math.abs(t.amount);
      else if (t.category === 'Withdrawal') withdrawals += Math.abs(t.amount);
    }
    const net = contributions - withdrawals;
    const months = windowDays / 30.44;
    return {
      contributions, withdrawals, net,
      perMonth: months > 0 ? net / months : 0,
    };
  }, [transactions, windowDays]);

  const prog    = useMemo(() => milestoneProgress(portfolioValue, pace.perMonth), [portfolioValue, pace.perMonth]);
  const freedom = useMemo(
    () => freedomProgress(monthlyIncome, monthlyTarget, blendedYieldPct),
    [monthlyIncome, monthlyTarget, blendedYieldPct],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Flag className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-semibold text-white">Milestones</span>
        <div className="ml-auto flex items-center gap-0.5">
          {[30, 90, 180].map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                windowDays === d
                  ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30'
                  : 'text-[#7c82a0] hover:text-white border border-transparent'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Value ladder */}
      <div className="space-y-2">
        {VALUE_MILESTONES.map((m) => {
          const reached = portfolioValue >= m.threshold;
          const isNext  = prog.next?.id === m.id;
          return (
            <div key={m.id} className={`rounded-lg border p-2.5 ${
              isNext ? 'bg-violet-500/5 border-violet-500/25' : 'bg-[#0f1117] border-[#1f2334]'
            }`}>
              <div className="flex items-center gap-2 text-[11px]">
                {reached
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  : <div className="w-3.5 h-3.5 rounded-full border border-[#2d3248] flex-shrink-0" />}
                <span className={reached ? 'text-[#9aa2c0]' : 'text-white font-medium'}>{m.label}</span>
                <span className="text-[#4a5070] tabular-nums">{fmt$(m.threshold)}</span>
                {isNext && (
                  <span className="ml-auto text-violet-300 tabular-nums">
                    {fmt$(prog.remaining)} to go
                    {prog.monthsAtCurrentPace !== null && ` · ~${describeMonths(prog.monthsAtCurrentPace)}`}
                  </span>
                )}
                {reached && <span className="ml-auto text-emerald-400/70 text-[10px]">reached</span>}
              </div>
              {isNext && (
                <>
                  <div className="w-full h-1.5 bg-[#1f2334] rounded-full overflow-hidden mt-2">
                    <div className="h-full rounded-full bg-violet-500/80" style={{ width: `${prog.progressPct}%` }} />
                  </div>
                  <p className="text-[10px] text-[#4a5070] mt-1.5">{m.meaning}</p>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Pace */}
      <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-2.5 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-[#7c82a0]">Contribution pace, trailing {windowDays}d</span>
          <span className={`tabular-nums font-semibold ${pace.perMonth > 0 ? 'text-emerald-400' : 'text-[#9aa2c0]'}`}>
            {pace.perMonth >= 0 ? '+' : '-'}{fmt$(pace.perMonth)}/mo
          </span>
        </div>
        <div className="text-[10px] text-[#4a5070] mt-1">
          {fmt$(pace.contributions)} in
          {pace.withdrawals > 0 && `, ${fmt$(pace.withdrawals)} out`}
          {' '}· distributions excluded, since they are already counted inside portfolio value
        </div>
        {pace.perMonth <= 0 && (
          <div className="text-[10px] text-yellow-200/80 mt-1">
            No net contributions in this window, so no pace estimate — the ladder is not being
            approached by deposits.
          </div>
        )}
      </div>

      {/* Freedom — a different unit entirely */}
      <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-[11px] font-semibold text-white">Freedom</span>
          <span className="ml-auto text-[11px] tabular-nums text-[#9aa2c0]">
            {fmt$(freedom.monthlyIncome)} of {fmt$(freedom.monthlyTarget)}/mo
          </span>
        </div>
        <div className="w-full h-1.5 bg-[#1f2334] rounded-full overflow-hidden">
          <div className="h-full rounded-full bg-emerald-500/80" style={{ width: `${Math.min(freedom.coveragePct, 100)}%` }} />
        </div>
        <div className="text-[10px] text-[#4a5070] mt-1.5">
          {freedom.coveragePct.toFixed(0)}% covered
          {freedom.gap > 0 && ` · ${fmt$(freedom.gap)}/mo short`}
          {freedom.impliedPortfolio !== null && (
            <> · target implies roughly {fmt$(freedom.impliedPortfolio)} invested at the current
              {' '}{blendedYieldPct.toFixed(1)}% blended yield</>
          )}
        </div>
        <p className="text-[10px] text-[#4a5070] mt-1.5">
          The last step changes units: the earlier thresholds are portfolio value, this one is
          monthly income against monthly cost. The implied portfolio figure holds the current yield
          constant, which the earlier panels give reason to treat carefully — a yield that includes
          return of capital will not sustain the same income indefinitely.
        </p>
      </div>
    </div>
  );
}
