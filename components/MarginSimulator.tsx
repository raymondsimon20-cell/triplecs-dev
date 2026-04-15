'use client';

/**
 * "What If" Margin Simulator
 *
 * Lets you model adding or removing a position and instantly see:
 *   • New portfolio value, equity, and margin utilization
 *   • New pillar percentages
 *   • Whether any Triple C rules would be breached
 *
 * Looks up price from existing positions when the symbol is already held;
 * otherwise the user can enter a manual price.
 *
 * Triple C thresholds: WARN at 30% margin utilization, MAX at 50%.
 */

import { useState, useMemo } from 'react';
import { Gauge, Plus, Minus, ArrowRight, AlertTriangle, CheckCircle, ChevronDown, ChevronUp } from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import { fmt$, fmtPct as fmtPctUtil } from '@/lib/utils';

interface PillarSummary {
  pillar: PillarType;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
  dayGainLoss: number;
}

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
  equity: number;
  marginBalance: number;
  pillarSummary: PillarSummary[];
}

interface SimResult {
  newTotalValue:      number;
  newEquity:          number;
  newMarginBalance:   number;
  newMarginUtilPct:   number;
  marginStatus:       'safe' | 'warn' | 'danger';
  pillarDeltas:       { pillar: PillarType; label: string; before: number; after: number }[];
  alerts:             string[];
}

// Pillar classification for quick lookup
const PILLAR_MAP: Record<string, PillarType> = {
  UPRO: 'triples', TQQQ: 'triples', SPXL: 'triples', UDOW: 'triples', UMDD: 'triples', URTY: 'triples',
  CLM: 'cornerstone', CRF: 'cornerstone',
  SQQQ: 'hedge', SPXS: 'hedge', UVXY: 'hedge', VIX: 'hedge',
};

function getPillar(symbol: string, existingPositions: EnrichedPosition[]): PillarType {
  const upper = symbol.toUpperCase();
  if (PILLAR_MAP[upper]) return PILLAR_MAP[upper];
  const existing = existingPositions.find((p) => p.instrument?.symbol?.toUpperCase() === upper);
  if (existing) return existing.pillar;
  return 'income'; // default assumption for income ETFs
}

// Reg T initial margin: 50% for equities; maintenance: 25%
// Triple C uses 30% warn / 50% max (of total portfolio value)
const WARN_MARGIN_PCT = 30;
const MAX_MARGIN_PCT  = 50;

// fmtPct without sign prefix (used for % display only in this component)
function fmtPct(n: number) { return `${n.toFixed(1)}%`; }

const PILLAR_COLORS: Record<PillarType, string> = {
  triples:     'text-violet-400',
  cornerstone: 'text-amber-400',
  income:      'text-emerald-400',
  hedge:       'text-blue-400',
  other:       'text-[#7c82a0]',
};

export function MarginSimulator({
  positions, totalValue, equity, marginBalance, pillarSummary,
}: Props) {
  const [open,       setOpen]       = useState(false);
  const [symbol,     setSymbol]     = useState('');
  const [action,     setAction]     = useState<'BUY' | 'SELL'>('BUY');
  const [sharesStr,  setSharesStr]  = useState('');
  const [manualPrice,setManualPrice]= useState('');

  // Look up current price for known symbols
  const knownPos = useMemo(
    () => positions.find((p) => p.instrument?.symbol?.toUpperCase() === symbol.toUpperCase()),
    [positions, symbol]
  );
  const knownPrice = knownPos ? (knownPos.marketValue / (knownPos.longQuantity || 1)) : null;
  const effectivePrice = manualPrice ? parseFloat(manualPrice) : (knownPrice ?? 0);
  const shares = parseInt(sharesStr) || 0;
  const tradeValue = effectivePrice * shares;

  const result = useMemo((): SimResult | null => {
    if (!symbol || shares <= 0 || effectivePrice <= 0) return null;

    const pillar = getPillar(symbol, positions);

    // For BUY on margin: totalValue increases by tradeValue, equity stays same,
    //   marginBalance increases by tradeValue (using margin for purchase)
    // For SELL: totalValue decreases, equity increases (cash received pays down margin),
    //   marginBalance decreases
    let newTotalValue    = totalValue;
    let newEquity        = equity;
    let newMarginBalance = Math.abs(marginBalance); // work in positive dollars

    if (action === 'BUY') {
      newTotalValue    += tradeValue;
      // Assume 50% margin (Reg T): half from equity, half from margin
      newMarginBalance += tradeValue * 0.5;
      newEquity        -= tradeValue * 0.5;
    } else {
      // Validate: can only sell up to what we hold
      const heldQty = knownPos?.longQuantity ?? 0;
      const actualShares = Math.min(shares, heldQty > 0 ? heldQty : shares);
      const actualValue  = effectivePrice * actualShares;
      newTotalValue    -= actualValue;
      // Proceeds pay down margin debt first
      const marginPaydown = Math.min(actualValue, newMarginBalance);
      newMarginBalance -= marginPaydown;
      newEquity        += actualValue - marginPaydown;
    }

    const newMarginUtilPct = newTotalValue > 0 ? (newMarginBalance / newTotalValue) * 100 : 0;
    const marginStatus: SimResult['marginStatus'] =
      newMarginUtilPct >= MAX_MARGIN_PCT  ? 'danger' :
      newMarginUtilPct >= WARN_MARGIN_PCT ? 'warn'   : 'safe';

    // Pillar deltas
    const pillarDeltas = pillarSummary.map((ps) => {
      let afterValue = ps.totalValue;
      if (ps.pillar === pillar) {
        afterValue += action === 'BUY' ? tradeValue : -Math.min(tradeValue, ps.totalValue);
      }
      return {
        pillar:  ps.pillar,
        label:   ps.label,
        before:  ps.portfolioPercent,
        after:   newTotalValue > 0 ? (afterValue / newTotalValue) * 100 : 0,
      };
    });

    // Rule checks
    const alerts: string[] = [];
    if (marginStatus === 'danger')
      alerts.push(`Margin would hit ${fmtPct(newMarginUtilPct)} — exceeds 50% hard cap.`);
    else if (marginStatus === 'warn')
      alerts.push(`Margin would reach ${fmtPct(newMarginUtilPct)} — in warning zone (30–50%).`);

    const triplesDelta = pillarDeltas.find((p) => p.pillar === 'triples');
    if (triplesDelta && triplesDelta.after > 45)
      alerts.push(`Triples would be ${fmtPct(triplesDelta.after)} — very high concentration, check leverage exposure.`);

    if (action === 'BUY' && pillar === 'income') {
      const incomeAfter = pillarDeltas.find((p) => p.pillar === 'income')?.after ?? 0;
      if (incomeAfter > 70)
        alerts.push(`Income pillar would reach ${fmtPct(incomeAfter)} — consider whether 1/3 rule applies first.`);
    }

    return { newTotalValue, newEquity, newMarginBalance, newMarginUtilPct, marginStatus, pillarDeltas, alerts };
  }, [symbol, action, shares, effectivePrice, positions, totalValue, equity, marginBalance, pillarSummary, tradeValue, knownPos]);

  const currentMarginPct = totalValue > 0 ? (Math.abs(marginBalance) / totalValue) * 100 : 0;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Gauge className="w-5 h-5 text-blue-400" />
          <span className="font-semibold text-white text-sm">"What If" Margin Simulator</span>
          <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">
            margin: {fmtPct(currentMarginPct)}
          </span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-5">

          {/* Inputs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Action */}
            <div className="space-y-1">
              <label className="text-xs text-[#7c82a0]">Action</label>
              <div className="flex gap-1">
                {(['BUY', 'SELL'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAction(a)}
                    className={`flex-1 flex items-center justify-center gap-1 text-xs py-2 rounded transition-colors ${
                      action === a
                        ? a === 'BUY' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                        : 'bg-[#0f1117] border border-[#2d3248] text-[#7c82a0]'
                    }`}
                  >
                    {a === 'BUY' ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                    {a}
                  </button>
                ))}
              </div>
            </div>

            {/* Symbol */}
            <div className="space-y-1">
              <label className="text-xs text-[#7c82a0]">Symbol</label>
              <input
                type="text"
                value={symbol}
                onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setManualPrice(''); }}
                placeholder="TQQQ"
                className="w-full bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-blue-500/50 uppercase"
              />
              {knownPrice && (
                <p className="text-[10px] text-emerald-400">Current: ${knownPrice.toFixed(2)}</p>
              )}
            </div>

            {/* Shares */}
            <div className="space-y-1">
              <label className="text-xs text-[#7c82a0]">Shares</label>
              <input
                type="number"
                min={1}
                value={sharesStr}
                onChange={(e) => setSharesStr(e.target.value)}
                placeholder="100"
                className="w-full bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-blue-500/50"
              />
            </div>

            {/* Price (manual override) */}
            <div className="space-y-1">
              <label className="text-xs text-[#7c82a0]">
                Price {knownPrice ? '(override)' : '(required)'}
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={manualPrice}
                onChange={(e) => setManualPrice(e.target.value)}
                placeholder={knownPrice ? knownPrice.toFixed(2) : '0.00'}
                className="w-full bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2 text-sm text-white placeholder-[#3d4260] focus:outline-none focus:border-blue-500/50"
              />
            </div>
          </div>

          {/* Trade summary pill */}
          {shares > 0 && effectivePrice > 0 && (
            <div className="text-xs text-[#7c82a0] bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2">
              {action} <span className="text-white font-semibold">{shares} × {symbol}</span>
              {' '}@ ${effectivePrice.toFixed(2)} = <span className="text-white font-semibold">{fmt$(tradeValue)}</span>
              {' '}in <span className={PILLAR_COLORS[getPillar(symbol, positions)]}>
                {getPillar(symbol, positions)}
              </span> pillar
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="space-y-4">
              {/* Margin comparison */}
              <div className="grid grid-cols-2 gap-3">
                {/* Before */}
                <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2">
                  <p className="text-[10px] text-[#4a5070] font-semibold uppercase">Before</p>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-[#7c82a0]">Portfolio</span><span className="text-white">{fmt$(totalValue)}</span></div>
                    <div className="flex justify-between"><span className="text-[#7c82a0]">Equity</span><span className="text-white">{fmt$(equity)}</span></div>
                    <div className="flex justify-between"><span className="text-[#7c82a0]">Margin used</span><span className={currentMarginPct >= MAX_MARGIN_PCT ? 'text-red-400' : currentMarginPct >= WARN_MARGIN_PCT ? 'text-orange-400' : 'text-emerald-400'}>{fmtPct(currentMarginPct)}</span></div>
                  </div>
                </div>

                {/* After */}
                <div className={`rounded-lg p-3 space-y-2 border ${
                  result.marginStatus === 'danger' ? 'bg-red-500/5 border-red-500/25' :
                  result.marginStatus === 'warn'   ? 'bg-orange-500/5 border-orange-500/25' :
                                                     'bg-emerald-500/5 border-emerald-500/25'
                }`}>
                  <p className="text-[10px] text-[#4a5070] font-semibold uppercase">After</p>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-[#7c82a0]">Portfolio</span><span className="text-white">{fmt$(result.newTotalValue)}</span></div>
                    <div className="flex justify-between"><span className="text-[#7c82a0]">Equity</span><span className="text-white">{fmt$(result.newEquity)}</span></div>
                    <div className="flex justify-between">
                      <span className="text-[#7c82a0]">Margin used</span>
                      <span className={
                        result.marginStatus === 'danger' ? 'text-red-400 font-bold' :
                        result.marginStatus === 'warn'   ? 'text-orange-400 font-bold' :
                                                           'text-emerald-400'
                      }>{fmtPct(result.newMarginUtilPct)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Pillar impact */}
              <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2">
                <p className="text-[10px] text-[#4a5070] font-semibold uppercase">Pillar Impact</p>
                {result.pillarDeltas.filter((p) => p.before !== p.after || p.pillar !== 'other').map((pd) => {
                  const delta = pd.after - pd.before;
                  const changed = Math.abs(delta) > 0.05;
                  return (
                    <div key={pd.pillar} className="flex items-center gap-2 text-xs">
                      <span className={`w-24 capitalize ${PILLAR_COLORS[pd.pillar]}`}>{pd.label}</span>
                      <span className="text-[#7c82a0]">{fmtPct(pd.before)}</span>
                      <ArrowRight className="w-3 h-3 text-[#4a5070]" />
                      <span className={changed
                        ? delta > 0 ? 'text-emerald-400 font-semibold' : 'text-orange-400 font-semibold'
                        : 'text-[#7c82a0]'
                      }>{fmtPct(pd.after)}</span>
                      {changed && (
                        <span className={`text-[10px] ${delta > 0 ? 'text-emerald-400' : 'text-orange-400'}`}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(1)}pp
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Alerts */}
              {result.alerts.length > 0 && (
                <div className="space-y-2">
                  {result.alerts.map((a, i) => (
                    <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                      result.marginStatus === 'danger'
                        ? 'bg-red-500/10 border border-red-500/25 text-red-300'
                        : 'bg-orange-500/10 border border-orange-500/25 text-orange-300'
                    }`}>
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      {a}
                    </div>
                  ))}
                </div>
              )}

              {result.alerts.length === 0 && (
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 text-xs text-emerald-300">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Trade looks safe — no rule violations projected.
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] text-[#4a5070]">
            BUY assumes 50% Reg T margin financing. SELL assumes proceeds pay down margin debt first.
            Margin thresholds: warn 30%, hard cap 50% per Triple C rules.
          </p>
        </div>
      )}
    </div>
  );
}
