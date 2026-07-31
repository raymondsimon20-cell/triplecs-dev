'use client';

/**
 * MarginBridgePanel — is the bridge closing or widening?
 *
 * The cycle the strategy describes: the whole paycheck is deposited and
 * invested, expenses ride on margin, distributions pay the balance back down.
 * The bridge is supposed to be temporary. Whether it actually is comes down to
 * one monthly cash question with a direction attached.
 *
 * Distinct from the FIRE tab, which asks when distributions cover expenses —
 * the endpoint. This asks whether the balance is trending toward zero, which is
 * the part you can act on month to month.
 *
 * On the NAV-drag input: it is powerful and easy to misuse, so it defaults to
 * zero rather than to the observed yield/total-return gap. That gap is measured
 * over however much distribution history exists — often only a few months — and
 * compounding it for a decade produces nonsense. It is offered as a labelled
 * scenario, not as truth.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Waypoints, TrendingDown, TrendingUp, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { projectBridge, describeMonths, type BridgeInputs } from '@/lib/portfolio/bridge';

const fmt$ = (n: number, dec = 0) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

const STORE_KEY = 'triple-c-bridge-inputs';

interface Props {
  portfolioValue: number;
  marginBalance:  number;
  /** Blended distribution yield, percent. */
  yieldPct:       number;
  marginRatePct:  number;
  marginLimitPct: number;
  /** Observed total return, percent — used only to label the drag scenario. */
  totalReturnPct?: number;
}

export function MarginBridgePanel({
  portfolioValue, marginBalance, yieldPct, marginRatePct, marginLimitPct, totalReturnPct,
}: Props) {
  const [monthlyIncome, setMonthlyIncome]     = useState('');
  const [monthlyExpenses, setMonthlyExpenses] = useState('');
  const [navDragPct, setNavDragPct]           = useState(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const j = JSON.parse(raw) as { income?: string; expenses?: string; drag?: number };
      if (j.income)   setMonthlyIncome(j.income);
      if (j.expenses) setMonthlyExpenses(j.expenses);
      if (typeof j.drag === 'number') setNavDragPct(j.drag);
    } catch { /* ignore */ }
  }, []);

  const persist = (income: string, expenses: string, drag: number) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ income, expenses, drag })); } catch { /* ignore */ }
  };

  const income   = Number(monthlyIncome) || 0;
  const expenses = Number(monthlyExpenses) || 0;
  const ready    = expenses > 0;

  const inputs: BridgeInputs = useMemo(() => ({
    monthlyIncome: income,
    monthlyExpenses: expenses,
    portfolioValue,
    marginBalance: Math.abs(marginBalance),
    yieldPct,
    marginRatePct,
    navDragPct,
    marginLimitPct,
  }), [income, expenses, portfolioValue, marginBalance, yieldPct, marginRatePct, navDragPct, marginLimitPct]);

  const proj = useMemo(() => (ready ? projectBridge(inputs) : null), [inputs, ready]);

  /** The observed gap, offered as a scenario rather than a default. */
  const observedGap = totalReturnPct !== undefined ? totalReturnPct - yieldPct : null;

  const inputClass = 'w-28 bg-[#0f1117] border border-[#2d3248] rounded-md px-2.5 py-1.5 text-xs text-white placeholder-[#4a5070] focus:outline-none focus:border-blue-500/50 tabular-nums';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Waypoints className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-semibold text-white">Margin bridge</span>
      </div>
      <p className="text-[10px] text-[#4a5070]">
        Paycheck in, expenses on margin, distributions paying it back down. This projects whether the
        balance trends to zero or compounds against you — the journey, where the FIRE tab covers the
        destination.
      </p>

      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label htmlFor="br-inc" className="block text-[10px] text-[#7c82a0] mb-1">Monthly income deposited</label>
          <input id="br-inc" type="number" min="0" placeholder="0" value={monthlyIncome} className={inputClass}
                 onChange={(e) => { setMonthlyIncome(e.target.value); persist(e.target.value, monthlyExpenses, navDragPct); }} />
        </div>
        <div>
          <label htmlFor="br-exp" className="block text-[10px] text-[#7c82a0] mb-1">Monthly expenses</label>
          <input id="br-exp" type="number" min="0" placeholder="3500" value={monthlyExpenses} className={inputClass}
                 onChange={(e) => { setMonthlyExpenses(e.target.value); persist(monthlyIncome, e.target.value, navDragPct); }} />
        </div>
        <div className="flex-1 min-w-[220px]">
          <label htmlFor="br-drag" className="block text-[10px] text-[#7c82a0] mb-1">
            Annual price movement: <span className={navDragPct < 0 ? 'text-orange-300' : navDragPct > 0 ? 'text-emerald-400' : 'text-[#9aa2c0]'}>
              {navDragPct > 0 ? '+' : ''}{navDragPct}%
            </span>
          </label>
          <input id="br-drag" type="range" min={-25} max={10} step={1} value={navDragPct}
                 onChange={(e) => { const v = Number(e.target.value); setNavDragPct(v); persist(monthlyIncome, monthlyExpenses, v); }}
                 className="w-full accent-blue-500" />
        </div>
      </div>

      {observedGap !== null && (
        <p className="text-[10px] text-[#4a5070]">
          Your distribution yield exceeds total return by {Math.abs(observedGap).toFixed(1)}pp.
          Setting the slider to that figure models the gap continuing indefinitely —
          <span className="text-yellow-200/80"> treat that as a stress test, not a forecast</span>:
          it is measured over however much distribution history exists, and compounding a short
          window for ten years produces results that say more about the assumption than the account.
          Zero assumes price movement nets out.
        </p>
      )}

      {!ready && (
        <p className="text-xs text-[#4a5070]">Enter your monthly expenses to project the bridge.</p>
      )}

      {proj && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
              <div className="text-[10px] text-[#7c82a0] mb-1">Net cash, month 1</div>
              <div className={`text-lg font-bold tabular-nums ${proj.firstMonthNetCash >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {proj.firstMonthNetCash >= 0 ? '+' : ''}{fmt$(proj.firstMonthNetCash)}
              </div>
              <div className="text-[10px] text-[#4a5070] mt-0.5">after expenses & interest</div>
            </div>
            <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
              <div className="text-[10px] text-[#7c82a0] mb-1">Bridge direction</div>
              <div className={`text-lg font-bold flex items-center gap-1.5 ${
                proj.direction === 'shrinking' ? 'text-emerald-400' : proj.direction === 'growing' ? 'text-red-400' : 'text-[#9aa2c0]'
              }`}>
                {proj.direction === 'shrinking' ? <TrendingDown className="w-4 h-4" /> : proj.direction === 'growing' ? <TrendingUp className="w-4 h-4" /> : null}
                <span className="capitalize">{proj.direction}</span>
              </div>
              <div className="text-[10px] text-[#4a5070] mt-0.5">over 10 years</div>
            </div>
            <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
              <div className="text-[10px] text-[#7c82a0] mb-1">Bridge cleared</div>
              <div className="text-lg font-bold tabular-nums text-[#9aa2c0]">
                {describeMonths(proj.bridgeClearedAt)}
              </div>
              <div className="text-[10px] text-[#4a5070] mt-0.5">margin back to zero</div>
            </div>
            <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
              <div className="text-[10px] text-[#7c82a0] mb-1">Self-sustaining</div>
              <div className="text-lg font-bold tabular-nums text-[#9aa2c0]">
                {describeMonths(proj.selfSustainingAt)}
              </div>
              <div className="text-[10px] text-[#4a5070] mt-0.5">distributions cover expenses + interest</div>
            </div>
          </div>

          {proj.limitBreachedAt !== null && (
            <div className="flex items-start gap-2 text-[11px] text-red-300/90 bg-red-500/5 border border-red-500/25 rounded-lg p-2.5">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" />
              <span>
                On these assumptions margin utilisation passes your {marginLimitPct}% limit in{' '}
                {describeMonths(proj.limitBreachedAt)}. The bridge is not self-liquidating here —
                it is being funded by more borrowing.
              </span>
            </div>
          )}

          {proj.direction === 'shrinking' && proj.limitBreachedAt === null && (
            <div className="flex items-start gap-2 text-[11px] text-emerald-200/90">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-px" />
              <span>
                Bridge is closing on these assumptions — income and distributions together exceed
                expenses and carrying cost.
              </span>
            </div>
          )}

          {/* Trajectory sparkline — margin balance over the horizon */}
          <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-[#9aa2c0]">Margin balance, 10-year projection</span>
              <span className="text-[10px] text-[#4a5070] tabular-nums">
                now {fmt$(Math.abs(marginBalance))} → {fmt$(proj.months[proj.months.length - 1].marginBalance)}
              </span>
            </div>
            <div className="flex items-end gap-px h-16">
              {proj.months.filter((_, idx) => idx % 2 === 0).map((m) => {
                const peak = Math.max(...proj.months.map((x) => x.marginBalance), 1);
                return (
                  <div
                    key={m.month}
                    className={`flex-1 rounded-t-sm ${m.utilisationPct > marginLimitPct ? 'bg-red-500/70' : 'bg-blue-500/50'}`}
                    style={{ height: `${Math.max((m.marginBalance / peak) * 100, 1)}%` }}
                    title={`Month ${m.month}: ${fmt$(m.marginBalance)} (${m.utilisationPct.toFixed(1)}% utilisation)`}
                  />
                );
              })}
            </div>
          </div>

          <p className="text-[10px] text-[#4a5070]">
            Assumes income, expenses, yield and price movement all hold flat for ten years, and that
            surplus cash pays margin down before being invested. None of those hold in reality — the
            value is in the direction and rough timescale, not the precise month.
          </p>
        </>
      )}
    </div>
  );
}
