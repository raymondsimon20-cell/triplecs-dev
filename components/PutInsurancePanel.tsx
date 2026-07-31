'use client';

/**
 * PutInsurancePanel — protection as a standing obligation, not a trade.
 *
 * The P2P framing is that puts are insurance: bought monthly, rolled, and
 * expensed like any other operating cost. Their purpose is not to profit from a
 * decline but to keep a decline from pushing equity below the point where
 * positions are liquidated involuntarily.
 *
 * So the headline number here is drawdown headroom — how far the market can
 * fall before forced selling — and what the current protection does to it.
 * Everything else is in service of that.
 */

import React, { useMemo } from 'react';
import { Shield, ShieldAlert, ShieldCheck, Clock, TrendingDown } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { parseOcc, daysToExpiry } from '@/lib/options/occ';
import {
  computeDrawdownHeadroom, declineToCallWithPuts, PUT_RULE, type ProtectivePut,
} from '@/lib/portfolio/drawdown';

const fmt$ = (n: number, dec = 0) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const pct = (n: number, dec = 1) => `${n.toFixed(dec)}%`;

interface Props {
  positions:     EnrichedPosition[];
  totalValue:    number;
  marginBalance: number;
  marginLimitPct: number;
}

export function PutInsurancePanel({ positions, totalValue, marginBalance, marginLimitPct }: Props) {
  const analysis = useMemo(() => {
    const marginUsed = Math.abs(marginBalance);

    // Maintenance requirement across the book. Positions without an explicit
    // maintenance figure fall back to 50%, matching the pillar default rather
    // than assuming the best case.
    let maintenanceRequirement = 0;
    const underlyingPrices: Record<string, number> = {};
    for (const p of positions) {
      const value = Math.abs(p.marketValue ?? 0);
      if (p.instrument?.assetType !== 'OPTION') {
        const maint = typeof p.maintenancePct === 'number' ? p.maintenancePct : 50;
        maintenanceRequirement += value * (maint / 100);
        const sym = p.instrument?.symbol?.toUpperCase();
        const qty = p.longQuantity ?? 0;
        if (sym && qty > 0) underlyingPrices[sym] = value / qty;
      }
    }

    // Long puts only — a short put is an income position, not protection.
    const puts: ProtectivePut[] = [];
    for (const p of positions) {
      if (p.instrument?.assetType !== 'OPTION') continue;
      const contracts = p.longQuantity ?? 0;
      if (contracts <= 0) continue;
      const parsed = parseOcc(p.instrument?.symbol ?? '');
      if (!parsed || parsed.isCall) continue;

      const spot = underlyingPrices[parsed.underlying];
      puts.push({
        symbol: p.instrument.symbol,
        underlying: parsed.underlying,
        strike: parsed.strike,
        expiration: parsed.expiration,
        dte: daysToExpiry(parsed.expiration),
        contracts,
        notional: parsed.strike * 100 * contracts,
        otmPct: spot && spot > 0 ? ((spot - parsed.strike) / spot) * 100 : null,
      });
    }
    puts.sort((a, b) => a.dte - b.dte);

    const headroom = computeDrawdownHeadroom({
      totalValue, marginUsed, maintenanceRequirement, marginLimitPct,
    });
    const withPuts = declineToCallWithPuts(
      totalValue, marginUsed, maintenanceRequirement, puts, underlyingPrices,
    );

    const indexPuts = puts.filter((p) => (PUT_RULE.underlyings as readonly string[]).includes(p.underlying));
    const notional  = indexPuts.reduce((s, p) => s + p.notional, 0);
    const expiringSoon = puts.filter((p) => p.dte <= PUT_RULE.rollDte);

    return {
      marginUsed, maintenanceRequirement, puts, indexPuts, notional, expiringSoon,
      headroom, withPuts,
      coveragePct: totalValue > 0 ? (notional / totalValue) * 100 : 0,
      maintenancePctOfValue: totalValue > 0 ? (maintenanceRequirement / totalValue) * 100 : 0,
    };
  }, [positions, totalValue, marginBalance, marginLimitPct]);

  const a = analysis;
  const hasProtection = a.indexPuts.length > 0;
  const baseCall = a.headroom.toMaintenanceCall;
  const improvement = baseCall !== null && a.withPuts !== null ? a.withPuts - baseCall : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {hasProtection ? <ShieldCheck className="w-4 h-4 text-emerald-400" /> : <ShieldAlert className="w-4 h-4 text-orange-400" />}
        <span className="text-sm font-semibold text-white">Put insurance & drawdown headroom</span>
      </div>

      {/* Headroom — the number protection exists to move */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
          <div className="text-[10px] text-[#7c82a0] mb-1">Decline before forced selling</div>
          <div className={`text-lg font-bold tabular-nums ${
            baseCall === null ? 'text-[#9aa2c0]' : baseCall > 0.4 ? 'text-emerald-400' : baseCall > 0.2 ? 'text-yellow-300' : 'text-red-400'
          }`}>
            {baseCall === null ? '—' : pct(baseCall * 100)}
          </div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">
            broker maintenance call, no puts
          </div>
        </div>

        <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
          <div className="text-[10px] text-[#7c82a0] mb-1">With current puts</div>
          <div className="text-lg font-bold tabular-nums text-emerald-400">
            {a.withPuts === null ? '>95%' : pct(a.withPuts * 100)}
          </div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">
            {improvement !== null && improvement > 0.001
              ? `+${pct(improvement * 100)} of extra room`
              : hasProtection ? 'strikes too far out to move the line' : 'no protection held'}
          </div>
        </div>

        <div className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
          <div className="text-[10px] text-[#7c82a0] mb-1">Decline to your {marginLimitPct}% trim limit</div>
          <div className="text-lg font-bold tabular-nums text-[#9aa2c0]">
            {a.headroom.toAppLimit === null ? '—' : pct(a.headroom.toAppLimit * 100)}
          </div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">
            self-imposed, triggers trim not liquidation
          </div>
        </div>
      </div>

      <p className="text-[10px] text-[#4a5070]">
        Modelled as a uniform decline across all holdings, with margin fixed and the maintenance
        requirement ({pct(a.maintenancePctOfValue)} of value) scaling with prices. Put payoff counts
        intrinsic value only — no time value, and no volatility gain — so the protected figure
        understates a real hedge. A concentrated selloff in your largest holdings would bite sooner
        than a uniform one.
      </p>

      {/* Held protection */}
      {hasProtection ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-[#9aa2c0]">
              {a.indexPuts.length} index put{a.indexPuts.length === 1 ? '' : 's'} ·{' '}
              {fmt$(a.notional)} notional · {pct(a.coveragePct)} of portfolio
            </span>
          </div>
          {a.puts.map((p) => {
            const otmOk = p.otmPct !== null && p.otmPct >= PUT_RULE.minOtmPct && p.otmPct <= PUT_RULE.maxOtmPct;
            const dteOk = p.dte > PUT_RULE.rollDte;
            return (
              <div key={p.symbol} className="flex items-center gap-2 text-[11px] bg-[#0f1117] border border-[#1f2334] rounded px-2.5 py-1.5">
                <span className="font-mono text-white w-14">{p.underlying}</span>
                <span className="text-[#9aa2c0] tabular-nums">${p.strike} put ×{p.contracts}</span>
                <span className={`tabular-nums ${otmOk ? 'text-emerald-400' : 'text-[#7c82a0]'}`}>
                  {p.otmPct === null ? '—' : `${p.otmPct >= 0 ? '' : '+'}${pct(p.otmPct)} OTM`}
                </span>
                <span className={`ml-auto tabular-nums flex items-center gap-1 ${dteOk ? 'text-[#7c82a0]' : 'text-orange-300'}`}>
                  {!dteOk && <Clock className="w-3 h-3" />}
                  {p.dte}d
                </span>
                <span className="text-[#4a5070] tabular-nums w-20 text-right">{fmt$(p.notional)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex items-start gap-2 text-[11px] text-orange-200/90 bg-orange-500/5 border border-orange-500/20 rounded-lg p-2.5">
          <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-px" />
          <span>
            No long index puts held. The strategy treats monthly SPY/QQQ puts —{' '}
            {PUT_RULE.minOtmPct}–{PUT_RULE.maxOtmPct}% out of the money, around{' '}
            {PUT_RULE.targetDte} days out — as a recurring cost rather than an optional trade,
            because the leverage that makes the spread work also compounds a drawdown.
          </span>
        </div>
      )}

      {a.expiringSoon.length > 0 && (
        <div className="flex items-start gap-2 text-[11px] text-yellow-200/90">
          <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
          <span>
            {a.expiringSoon.length} contract{a.expiringSoon.length === 1 ? '' : 's'} within{' '}
            {PUT_RULE.rollDte} days of expiry — roll forward to keep cover continuous.
          </span>
        </div>
      )}

      {hasProtection && a.indexPuts.some((p) => p.otmPct !== null && p.otmPct > PUT_RULE.maxOtmPct) && (
        <div className="flex items-start gap-2 text-[11px] text-[#7c82a0]">
          <TrendingDown className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
          <span>
            Some strikes sit further than {PUT_RULE.maxOtmPct}% out of the money. Cheaper, but they
            only engage after a decline that has already done most of the damage — which is why the
            &ldquo;with current puts&rdquo; figure above may barely move.
          </span>
        </div>
      )}
    </div>
  );
}
