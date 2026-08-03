'use client';

/**
 * BusinessSpreadPanel — the arbitrage at the centre of the strategy.
 *
 * Borrow at the margin rate, hold assets distributing more than that, and the
 * difference is the engine. The app has always known both numbers and never
 * compared them.
 *
 * Two deliberate design decisions:
 *
 * 1. Yields come from observed payment history (lib/portfolio/dividend-cadence)
 *    where a cadence can be measured, falling back to quoted yields otherwise.
 *    A spread built on the old static table would have been wrong by ~4x on the
 *    weekly payers.
 *
 * 2. Distribution yield is shown next to total return, never alone. A portfolio
 *    can distribute 25% while its NAV erodes, because part of the distribution
 *    is return of capital — you are being paid with your own money. A spread
 *    panel that reports only yield-minus-margin would present that as a healthy
 *    business. Showing both side by side is the entire point of the panel.
 */

import React, { useMemo } from 'react';
import { Scale, TrendingUp, TrendingDown, Percent, Landmark } from 'lucide-react';
import { StatCard as Stat } from '@/components/StatCard';
import type { EnrichedPosition } from '@/lib/schwab/types';
import type { DividendRecord } from '@/components/DividendsView';
import { PILLAR_LABELS } from '@/lib/classify';
import { deriveCadence, annualiseFromHistory } from '@/lib/portfolio/dividend-cadence';
import { estimateAnnualDividend } from '@/components/IncomeHub';
import { MarginBridgePanel } from '@/components/MarginBridgePanel';

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const signed$ = (n: number, dec = 0) =>
  (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

/** Same guard as the allocation tool — a distorted denominator can blow this up. */
const MAX_DERIVED_YIELD_PCT = 150;

/** Pay periods per year. P2P frames the target as dollars per paycheck. */
const PAYCHECKS_PER_YEAR = 26;

interface Props {
  positions:     EnrichedPosition[];
  dividends:     DividendRecord[];
  totalValue:    number;
  equity:        number;
  marginBalance: number;
  marginRatePct: number;
  /** Utilisation limit, passed through to the bridge projection. */
  marginLimitPct: number;
  /** Realized P/L by symbol, for the total-return comparison. */
  realizedBySymbol?: Record<string, number>;
  /** Trailing-12M dividends actually received, by symbol. */
  dividendsBySymbol?: Record<string, number>;
}

export function BusinessSpreadPanel({
  positions, dividends, totalValue, equity, marginBalance, marginRatePct, marginLimitPct,
  realizedBySymbol = {}, dividendsBySymbol = {},
}: Props) {
  const analysis = useMemo(() => {
    // Payment history per symbol → derived annual income.
    const bySymbol = new Map<string, { date: string; amount: number }[]>();
    for (const d of dividends) {
      const list = bySymbol.get(d.symbol) ?? [];
      list.push({ date: d.date, amount: d.amount });
      bySymbol.set(d.symbol, list);
    }

    let annualIncome = 0;
    let derivedCount = 0;
    let coveredValue = 0;
    const byPillar = new Map<string, { value: number; income: number }>();

    for (const p of positions) {
      if (p.instrument?.assetType === 'OPTION' || p.instrument.symbol.includes(' ')) continue;
      const sym = p.instrument.symbol;
      const value = Math.abs(p.marketValue ?? 0);
      if (value <= 0) continue;

      const history = bySymbol.get(sym);
      let annual = 0;

      if (history && history.length >= 2) {
        const cadence = deriveCadence(history.map((h) => h.date));
        if (cadence.derived) {
          const fromHistory = annualiseFromHistory(history, cadence);
          const pct = (fromHistory / value) * 100;
          if (fromHistory > 0 && Number.isFinite(pct) && pct > 0 && pct <= MAX_DERIVED_YIELD_PCT) {
            annual = fromHistory;
            derivedCount += 1;
            coveredValue += value;
          }
        }
      }
      if (annual === 0) annual = estimateAnnualDividend(p);

      annualIncome += annual;
      const cur = byPillar.get(p.pillar) ?? { value: 0, income: 0 };
      cur.value += value;
      cur.income += annual;
      byPillar.set(p.pillar, cur);
    }

    const marginUsed  = Math.abs(marginBalance);
    const annualCost  = marginUsed * (marginRatePct / 100);
    const blendedYield = totalValue > 0 ? (annualIncome / totalValue) * 100 : 0;
    const spreadPp    = blendedYield - marginRatePct;

    // Income attributable to borrowed dollars specifically.
    const marginIncome = marginUsed * (blendedYield / 100);
    const marginNet    = marginIncome - annualCost;

    const netAnnual    = annualIncome - annualCost;
    const perPaycheck  = netAnnual / PAYCHECKS_PER_YEAR;

    // ── Total return, for the honesty comparison ────────────────────────────
    let unrealized = 0, costBasis = 0;
    for (const p of positions) {
      if (p.instrument?.assetType === 'OPTION' || p.instrument.symbol.includes(' ')) continue;
      unrealized += p.gainLoss ?? 0;
      // Single source of truth — see enrichPositions. Signed and already
      // dollar-denominated; take the magnitude for a return denominator.
      costBasis  += Math.abs(p.costBasis ?? 0);
    }
    const dividendsReceived = Object.values(dividendsBySymbol).reduce((s, v) => s + v, 0);
    const realized = Object.values(realizedBySymbol).reduce((s, v) => s + v, 0);
    const totalReturn = unrealized + dividendsReceived + realized;
    const totalReturnPct = costBasis > 0 ? (totalReturn / costBasis) * 100 : 0;

    // The gap between what the book distributes and what it actually returned.
    // Positive distributions with a negative total return is the signature of
    // return-of-capital: the yield is real cash, but it is partly your own.
    const erosionPp = blendedYield - totalReturnPct;

    return {
      annualIncome, annualCost, netAnnual, perPaycheck,
      blendedYield, spreadPp, marginUsed, marginIncome, marginNet,
      derivedCount, coveredPct: totalValue > 0 ? (coveredValue / totalValue) * 100 : 0,
      byPillar,
      unrealized, dividendsReceived, realized, totalReturn, totalReturnPct, erosionPp,
      equityPct: totalValue > 0 ? (equity / totalValue) * 100 : 0,
    };
  }, [positions, dividends, totalValue, equity, marginBalance, marginRatePct, realizedBySymbol, dividendsBySymbol]);

  const a = analysis;
  const spreadHealthy = a.spreadPp > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
          <Scale className="w-[18px] h-[18px] text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Business Spread</h1>
          <p className="text-xs text-[#7c82a0] mt-0.5">What the portfolio distributes, against what the margin costs</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={Percent} label="Blended Yield" value={`${a.blendedYield.toFixed(2)}%`}
              sub={`${a.derivedCount} symbols from payment history`} valueClass="text-emerald-400"
              accentClass="border-t-blue-500/60" index={0} />
        <Stat icon={Landmark} label="Margin Rate" value={`${marginRatePct.toFixed(2)}%`}
              sub={`on ${fmt$(a.marginUsed, 0)} borrowed`} accentClass="border-t-blue-500/60" index={1} />
        <Stat icon={a.spreadPp >= 0 ? TrendingUp : TrendingDown} label="Spread"
              value={`${a.spreadPp >= 0 ? '+' : ''}${a.spreadPp.toFixed(2)}pp`}
              sub="distribution yield less margin rate"
              valueClass={plColor(a.spreadPp)} accentClass="border-t-blue-500/60" index={2} />
        <Stat icon={TrendingUp} label="Net / Paycheck" value={signed$(a.perPaycheck)}
              sub={`${PAYCHECKS_PER_YEAR} periods · P2P target ~$600`}
              valueClass={plColor(a.perPaycheck)} accentClass="border-t-blue-500/60" index={3} />
      </div>

      {/* The honest comparison */}
      <div className={`rounded-lg p-4 border ${
        a.erosionPp > 10 ? 'bg-yellow-500/5 border-yellow-500/25' : 'bg-[#12151f] border-[#1f2334]'
      }`}>
        <div className="text-sm font-semibold text-white mb-1">Distributions vs. Total Return</div>
        <p className="text-[10px] text-[#4a5070] mb-3">
          Distribution yield is cash paid out. Total return is what the portfolio actually earned
          after price movement. When yield runs far ahead of total return, part of the distribution
          is return of capital — real cash, but partly your own principal coming back.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-[#7c82a0] mb-0.5">Distribution yield</div>
            <div className="text-emerald-400 tabular-nums font-semibold">{a.blendedYield.toFixed(2)}%</div>
            <div className="text-[10px] text-[#4a5070]">{fmt$(a.annualIncome, 0)}/yr projected</div>
          </div>
          <div>
            <div className="text-[#7c82a0] mb-0.5">Total return</div>
            <div className={`tabular-nums font-semibold ${plColor(a.totalReturnPct)}`}>
              {a.totalReturnPct >= 0 ? '+' : ''}{a.totalReturnPct.toFixed(2)}%
            </div>
            <div className="text-[10px] text-[#4a5070]">{signed$(a.totalReturn)} on cost</div>
          </div>
          <div>
            <div className="text-[#7c82a0] mb-0.5">Gap</div>
            <div className={`tabular-nums font-semibold ${a.erosionPp > 10 ? 'text-yellow-300' : 'text-[#9aa2c0]'}`}>
              {a.erosionPp >= 0 ? '' : '+'}{(-a.erosionPp).toFixed(2)}pp
            </div>
            <div className="text-[10px] text-[#4a5070]">total return less yield</div>
          </div>
          <div>
            <div className="text-[#7c82a0] mb-0.5">Made of</div>
            <div className="text-[10px] text-[#9aa2c0] leading-relaxed tabular-nums">
              {signed$(a.unrealized)} unrealized<br />
              {signed$(a.dividendsReceived)} received<br />
              {signed$(a.realized)} realized
            </div>
          </div>
        </div>

        {a.erosionPp > 10 && (
          <p className="text-[11px] text-yellow-200/90 mt-3 border-t border-yellow-500/15 pt-2">
            Yield exceeds total return by {a.erosionPp.toFixed(1)}pp. The spread above is computed on
            distributions, so it reads healthier than the portfolio has actually performed. Both
            numbers are correct — they measure different things, and the difference is what NAV
            erosion looks like in practice.
          </p>
        )}
      </div>

      {/* Margin arithmetic */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="text-sm font-semibold text-white mb-3">On the Borrowed Capital</div>
        <div className="space-y-2 text-xs max-w-lg">
          <div className="flex justify-between">
            <span className="text-[#7c82a0]">Margin balance</span>
            <span className="text-white tabular-nums">{fmt$(a.marginUsed)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#7c82a0]">Distributions on that capital (at {a.blendedYield.toFixed(2)}%)</span>
            <span className="text-emerald-400 tabular-nums">{signed$(a.marginIncome, 2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#7c82a0]">Interest cost (at {marginRatePct.toFixed(2)}%)</span>
            <span className="text-red-400 tabular-nums">{signed$(-a.annualCost, 2)}</span>
          </div>
          <div className="flex justify-between border-t border-[#1f2334] pt-2 font-semibold">
            <span className="text-white">Net on borrowed capital</span>
            <span className={`tabular-nums ${plColor(a.marginNet)}`}>{signed$(a.marginNet, 2)}</span>
          </div>
          <div className="flex justify-between text-[#4a5070]">
            <span>Equity %</span>
            <span className="tabular-nums">{a.equityPct.toFixed(1)}%</span>
          </div>
        </div>
        {!spreadHealthy && a.marginUsed > 0 && (
          <p className="text-[11px] text-red-300/90 mt-3">
            Distribution yield is below the margin rate — borrowed dollars are currently costing more
            than they distribute.
          </p>
        )}
      </div>

      {/* Per-bucket contribution */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="text-sm font-semibold text-white mb-1">Where the Income Comes From</div>
        <p className="text-[10px] text-[#4a5070] mb-3">
          Each bucket&apos;s share of projected annual distributions. Growth is expected to sit near
          zero — it is there to appreciate and hold up margin equity, not to pay.
        </p>
        <div className="space-y-2">
          {[...a.byPillar.entries()]
            .sort((x, y) => y[1].income - x[1].income)
            .map(([pillar, v]) => {
              const share = a.annualIncome > 0 ? (v.income / a.annualIncome) * 100 : 0;
              const y = v.value > 0 ? (v.income / v.value) * 100 : 0;
              return (
                <div key={pillar} className="space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-[#9aa2c0]">
                      {PILLAR_LABELS[pillar as keyof typeof PILLAR_LABELS] ?? pillar}
                      <span className="ml-1.5 text-[10px] text-emerald-400/80 tabular-nums">{y.toFixed(1)}% yld</span>
                    </span>
                    <span className="tabular-nums text-[#7c82a0]">
                      {fmt$(v.income, 0)}/yr · {share.toFixed(1)}% of income
                    </span>
                  </div>
                  <div className="w-full h-2 bg-[#1f2334] rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${Math.min(share, 100)}%` }} />
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* The bridge is the other half of the spread: the spread says whether
          borrowed dollars earn their keep, the bridge says whether the balance
          is actually being paid down. */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <MarginBridgePanel
          portfolioValue={totalValue}
          marginBalance={marginBalance}
          yieldPct={a.blendedYield}
          marginRatePct={marginRatePct}
          marginLimitPct={marginLimitPct}
          totalReturnPct={a.totalReturnPct}
        />
      </div>

      <p className="text-[10px] text-[#4a5070]">
        Projected annual income annualises observed distributions where a payment cadence can be
        measured ({a.coveredPct.toFixed(0)}% of portfolio value), and falls back to quoted yields
        otherwise. Distributions are not guaranteed and past payments do not predict future ones.
        This is a description of the account as it stands, not advice.
      </p>
    </div>
  );
}
