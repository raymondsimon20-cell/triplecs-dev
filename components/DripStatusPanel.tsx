'use client';

/**
 * DripStatusPanel — is the compounding engine actually switched on?
 *
 * The CEF bucket's whole rationale is DRIP at NAV: reinvested distributions buy
 * CLM/CRF shares at net asset value while the market prices them at a premium,
 * so each reinvestment lands below what the shares are worth. If DRIP is off at
 * the broker, that bucket is just a high-yield holding paying cash — and until
 * now nothing in the app could tell you which situation you were in.
 *
 * Status is inferred from the transaction stream rather than a setting: a
 * reinvested distribution arrives as a delivery of shares, a cash one as a
 * credit. What the account actually did beats a checkbox.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Repeat, TrendingUp, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  summariseDrip, estimateNavCapture, NAV_DRIP_SYMBOLS, DRIP_STATUS_LABEL,
  type DripStatus, type DripCounts,
} from '@/lib/portfolio/drip';

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

const STATUS_CLASS: Record<DripStatus, string> = {
  on:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  off:     'bg-red-500/15 text-red-300 border-red-500/30',
  partial: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
  unknown: 'bg-[#2d3248] text-[#9aa2c0] border-transparent',
};

interface Props {
  accountHash?: string;
}

export function DripStatusPanel({ accountHash }: Props) {
  const [dripBySymbol, setDripBySymbol] = useState<Record<string, DripCounts>>({});
  const [navBySymbol, setNavBySymbol]   = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const qs = accountHash ? `?accountHash=${encodeURIComponent(accountHash)}` : '';
        const [divRes, navRes] = await Promise.all([
          fetch(`/api/dividends${qs}`),
          fetch('/api/cornerstone').catch(() => null),
        ]);
        if (cancelled) return;

        if (divRes.ok) {
          const j = await divRes.json();
          setDripBySymbol(j?.dripBySymbol ?? {});
        }
        if (navRes?.ok) {
          const j = await navRes.json();
          const m: Record<string, number> = {};
          for (const f of j?.funds ?? []) {
            if (f?.ticker && typeof f.premiumDiscount === 'number') m[String(f.ticker).toUpperCase()] = f.premiumDiscount;
          }
          if (!cancelled) setNavBySymbol(m);
        }
      } catch (err) {
        console.warn('[DripStatusPanel] load failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountHash]);

  // The NAV-DRIP funds get their own treatment; everything else is a plain
  // reinvest-or-cash question with no NAV edge attached.
  const navFunds = useMemo(
    () => [...NAV_DRIP_SYMBOLS]
      .map((sym) => {
        const counts = dripBySymbol[sym];
        if (!counts) return null;
        const summary = summariseDrip(sym, counts);
        const premium = navBySymbol[sym] ?? null;
        return { summary, premium, capture: estimateNavCapture(summary.reinvested, premium) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    [dripBySymbol, navBySymbol],
  );

  const others = useMemo(
    () => Object.entries(dripBySymbol)
      .filter(([sym]) => !NAV_DRIP_SYMBOLS.has(sym))
      .map(([sym, c]) => summariseDrip(sym, c))
      .filter((s) => s.status !== 'unknown')
      .sort((a, b) => b.reinvested - a.reinvested),
    [dripBySymbol],
  );

  const totalEdge = navFunds.reduce((s, f) => s + (f.capture?.estimatedEdge ?? 0), 0);
  const anyOff = navFunds.some((f) => f.summary.status === 'off' || f.summary.status === 'partial');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Repeat className="w-4 h-4 text-amber-400" />
        <span className="text-sm font-semibold text-white">DRIP at NAV — the compounding engine</span>
        {loading && <RefreshCw className="w-3 h-3 text-[#4a5070] animate-spin" />}
      </div>

      <p className="text-[10px] text-[#4a5070]">
        Status is inferred from your transaction history, not a broker setting: reinvested
        distributions arrive as share deliveries, cash ones as credits. If a fund shows
        &ldquo;Paying cash&rdquo; and you expected reinvestment, DRIP is off at the broker.
      </p>

      {/* NAV-DRIP funds */}
      <div className="space-y-2">
        {navFunds.length === 0 && !loading && (
          <p className="text-xs text-[#4a5070]">
            No distribution history yet for CLM or CRF in the fetched window.
          </p>
        )}
        {navFunds.map(({ summary, premium, capture }) => (
          <div key={summary.symbol} className="bg-[#0f1117] border border-[#1f2334] rounded-lg p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono font-semibold text-white text-sm">{summary.symbol}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_CLASS[summary.status]}`}>
                {DRIP_STATUS_LABEL[summary.status]}
              </span>
              <span className="text-[10px] text-[#7c82a0] tabular-nums">
                {summary.reinvestedPct.toFixed(0)}% of {fmt$(summary.reinvested + summary.cash, 0)} reinvested
                {' · '}{summary.reinvestedPayments}/{summary.payments} payments
              </span>
              {premium !== null && (
                <span className={`ml-auto text-[10px] tabular-nums ${premium > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
                  {premium > 0 ? '+' : ''}{premium.toFixed(1)}% to NAV
                </span>
              )}
            </div>

            {capture ? (
              <div className="mt-2 text-[11px] text-[#9aa2c0] flex items-start gap-1.5">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-px" />
                <span>
                  {fmt$(capture.reinvested, 0)} reinvested at NAV while the fund traded{' '}
                  {capture.premiumPct.toFixed(1)}% above it — roughly{' '}
                  <span className="text-emerald-400 font-semibold">{fmt$(capture.estimatedEdge)}</span>{' '}
                  of shares acquired below market value.
                </span>
              </div>
            ) : premium !== null && premium <= 0 ? (
              <div className="mt-2 text-[11px] text-[#7c82a0]">
                Trading at or below NAV, so there is no premium advantage to report. Worth knowing:
                at a discount, buying at NAV acquires fewer shares than buying at market — whether
                that applies depends on the fund&apos;s plan terms, which this app does not read.
              </div>
            ) : null}

            {summary.status === 'off' && (
              <div className="mt-2 text-[11px] text-red-300/90 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                <span>
                  Distributions are arriving as cash. The NAV reinvestment advantage is not being
                  captured — this is a broker-side setting, so it has to be switched on there.
                </span>
              </div>
            )}
            {summary.status === 'partial' && (
              <div className="mt-2 text-[11px] text-yellow-200/90">
                Mixed history — DRIP may have been enabled partway through the window, or some
                distributions were paid in cash.
              </div>
            )}
          </div>
        ))}
      </div>

      {navFunds.length > 0 && totalEdge > 0 && (
        <div className="flex items-center gap-2 text-xs bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span className="text-[#9aa2c0]">
            Estimated NAV advantage captured over the fetched window:{' '}
            <span className="text-emerald-400 font-semibold tabular-nums">{fmt$(totalEdge)}</span>
          </span>
        </div>
      )}

      {anyOff && (
        <p className="text-[11px] text-yellow-200/80">
          The CEF bucket is sized on the assumption that reinvestment compounds at NAV. With DRIP
          off, those holdings behave as ordinary high-yield positions and the bucket target is
          arguably too high for what it is doing.
        </p>
      )}

      {/* Everything else — plain reinvest vs cash */}
      {others.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[#7c82a0] hover:text-white text-[11px]">
            Reinvestment status for {others.length} other holdings
          </summary>
          <div className="mt-2 max-h-56 overflow-y-auto space-y-1">
            {others.map((s) => (
              <div key={s.symbol} className="flex items-center gap-2 text-[11px] py-0.5">
                <span className="font-mono text-white w-16">{s.symbol}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_CLASS[s.status]}`}>
                  {DRIP_STATUS_LABEL[s.status]}
                </span>
                <span className="ml-auto text-[#7c82a0] tabular-nums">
                  {fmt$(s.reinvested + s.cash, 0)} · {s.reinvestedPct.toFixed(0)}% reinvested
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[#4a5070] mt-2">
            Only CLM and CRF reinvest at NAV. For everything else, DRIP buys at market price — it
            still compounds, but carries no discount advantage.
          </p>
        </details>
      )}
    </div>
  );
}
