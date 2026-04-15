'use client';

/**
 * Phase 5 — Options & Put Strategy Engine
 *
 * Rules source: Vol 5 (buying puts / boxing) + Vol 6 (selling puts for income)
 *
 * Section 1 — Put Protection Tracker (Vol 5)
 *   • Bought SPY/QQQ puts ~30 days out, strike ~10% below market
 *   • Roll signal: <14 days to expiry → Roll Now; 14-21 → Roll Soon
 *   • Cover when RSI oversold / VIX spikes
 *
 * Section 2 — Sell-Put Income Engine (Vol 6)
 *   • Sell LEAPs on indexed ETFs with LOW share price (UPRO, TQQQ, income ETFs)
 *   • Shows suggested strike (10% below), assignment risk, premium quality score
 *   • Avoid high share-price names (large assignment $ per contract)
 *   • Premiums lower cost basis & margin interest
 *
 * Section 3 — Boxing Tracker (Vol 5, Ch 4-5)
 *   • Short CLM/CRF when: equity low, premium > 20%, RO announced, black-swan recourse
 *   • Boxing raises equity immediately by lowering maintenance
 *   • Cover at lows, DCA long, ride back to top
 */

import { useState } from 'react';
import {
  Shield, DollarSign, Layers, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle, Clock, TrendingDown,
} from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { TRIPLES_SYMBOLS, INCOME_SYMBOLS, CORNERSTONE_SYMBOLS } from '@/lib/classify';

// ─── OCC Option Symbol Parser ─────────────────────────────────────────────────

interface ParsedOption {
  underlying: string;
  expiry: Date;
  type: 'P' | 'C';
  strike: number;
  daysToExpiry: number;
}

/**
 * Parses a Schwab OCC option symbol.
 * Standard format: RRRRRRYYMMDDTSSSSSSSS (21 chars)
 * e.g. "SPY   250117P00580000" → SPY, 2025-01-17, Put, $580.00
 * Falls back to description parsing if symbol doesn't match.
 */
function parseOptionSymbol(symbol: string, description?: string): ParsedOption | null {
  try {
    // OCC format: 6-char root + 6-char date (YYMMDD) + 1-char type + 8-char strike
    const cleaned = symbol.replace(/\s+/g, '');
    // Attempt regex match on cleaned symbol
    const occMatch = cleaned.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([PC])(\d{8})$/);
    if (occMatch) {
      const [, root, yy, mm, dd, typeChar, strikeRaw] = occMatch;
      const year = 2000 + parseInt(yy);
      const expiry = new Date(year, parseInt(mm) - 1, parseInt(dd));
      const strike = parseInt(strikeRaw) / 1000;
      const now = new Date();
      const daysToExpiry = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
      return {
        underlying: root,
        expiry,
        type: typeChar as 'P' | 'C',
        strike,
        daysToExpiry,
      };
    }

    // Fallback: parse description like "SPY Jan 17 2025 580 Put"
    if (description) {
      const descMatch = description.match(
        /^(\w+)\s+(\w+)\s+(\d+)\s+(\d{4})\s+([\d.]+)\s+(Put|Call)/i,
      );
      if (descMatch) {
        const [, root, month, day, year, strikeStr, typeStr] = descMatch;
        const months: Record<string, number> = {
          Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
          Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
        };
        const expiry = new Date(parseInt(year), months[month] ?? 0, parseInt(day));
        const now = new Date();
        const daysToExpiry = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
        return {
          underlying: root,
          expiry,
          type: typeStr.toLowerCase() === 'put' ? 'P' : 'C',
          strike: parseFloat(strikeStr),
          daysToExpiry,
        };
      }
    }
  } catch {
    // parsing failed
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number, dec = 0) {
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return n < 0 ? `-$${s}` : `$${s}`;
}

function rollUrgency(daysToExpiry: number): { label: string; color: string; bg: string } {
  if (daysToExpiry <= 0)
    return { label: 'Expired', color: 'text-red-500', bg: 'bg-red-600/20 border-red-600/30' };
  if (daysToExpiry <= 14)
    return { label: 'Roll Now', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/25' };
  if (daysToExpiry <= 21)
    return { label: 'Roll Soon', color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/25' };
  return { label: 'Holding', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25' };
}

/** Premium quality score for sell-put candidates (0-100) */
function premiumQualityScore(pos: EnrichedPosition): number {
  let score = 0;
  const price = pos.quote?.lastPrice ?? pos.averagePrice;
  const symbol = pos.instrument.symbol;

  // Indexed → high preference
  if (TRIPLES_SYMBOLS.has(symbol)) score += 40;
  else if (INCOME_SYMBOLS.has(symbol)) score += 25;
  else score += 10;

  // Low share price → lower assignment risk
  if (price < 30) score += 30;
  else if (price < 60) score += 20;
  else if (price < 100) score += 10;
  else score -= 10; // high share price — avoid

  // High IV → fatter premiums
  const iv = pos.quote?.volatility ?? 0;
  if (iv > 50) score += 30;
  else if (iv > 30) score += 20;
  else if (iv > 15) score += 10;

  return Math.max(0, Math.min(100, score));
}

// ─── Section 1: Put Protection Tracker ───────────────────────────────────────

function PutProtectionSection({ positions }: { positions: EnrichedPosition[] }) {
  // Long option positions (bought puts/calls)
  const longOptions = positions.filter(
    (p) => p.instrument.assetType === 'OPTION' && p.longQuantity > 0,
  );
  const boughtPuts = longOptions.filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return parsed?.type === 'P';
  });

  return (
    <div className="space-y-4">
      <div className="text-xs text-[#7c82a0] space-y-1">
        <p>Vol 5 rules: SPY/QQQ puts ~30 days out, strike ~10% below market. Monthly roll strategy — cheapest insurance that moves most in a crash.</p>
        <p className="text-[10px] text-[#4a5070]">Buy when: RSI overbought or market melting. Cover when: RSI oversold, VIX spikes, or ~75% profit reached. Budget: $100-$300/mo.</p>
      </div>

      {boughtPuts.length === 0 ? (
        <div className="bg-[#22263a] rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-orange-400 text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-semibold">No put protection detected</span>
          </div>
          <p className="text-xs text-[#7c82a0]">
            Consider buying 1-2 SPY or QQQ put contracts ~30 days out, strike ~10% below current price.
            When VIX is low (below 15), premiums are cheapest — ideal time to buy insurance.
          </p>
          <div className="bg-[#1a1d27] rounded p-3 space-y-1 text-xs">
            <p className="text-white font-semibold">Quick sizing guide:</p>
            <p className="text-[#7c82a0]">SPY @ ~$500 → suggested strike ~$450 (10% OTM) • ~30 DTE</p>
            <p className="text-[#7c82a0]">QQQ @ ~$440 → suggested strike ~$396 (10% OTM) • ~30 DTE</p>
            <p className="text-[#4a5070]">Cost: typically $100-$300/contract/month depending on VIX</p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
                <th className="text-left px-3 py-2">Option</th>
                <th className="text-right px-3 py-2">Strike</th>
                <th className="text-right px-3 py-2">Expiry</th>
                <th className="text-right px-3 py-2">DTE</th>
                <th className="text-right px-3 py-2">Contracts</th>
                <th className="text-right px-3 py-2">Value</th>
                <th className="text-right px-3 py-2">G/L</th>
                <th className="text-right px-3 py-2">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2d3248]">
              {boughtPuts.map((pos) => {
                const parsed = parseOptionSymbol(pos.instrument.symbol, pos.instrument.description);
                if (!parsed) return null;
                const urgency = rollUrgency(parsed.daysToExpiry);
                const gl = pos.gainLoss;
                const contracts = pos.longQuantity;
                return (
                  <tr key={pos.instrument.symbol} className="hover:bg-[#22263a]/60">
                    <td className="px-3 py-2">
                      <div className="font-mono font-semibold text-white">{parsed.underlying} Put</div>
                      <div className="text-[10px] text-[#7c82a0]">{pos.instrument.description ?? pos.instrument.symbol}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-white">${parsed.strike.toFixed(0)}</td>
                    <td className="px-3 py-2 text-right text-[#7c82a0]">
                      {parsed.expiry.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${urgency.color}`}>
                      {parsed.daysToExpiry}d
                    </td>
                    <td className="px-3 py-2 text-right text-[#e8eaf0]">{contracts}</td>
                    <td className="px-3 py-2 text-right font-mono text-white">{fmt$(pos.marketValue)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmt$(gl)}
                      <div className="text-[10px] opacity-70">
                        {pos.gainLossPercent >= 0 ? '+' : ''}{pos.gainLossPercent.toFixed(0)}%
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${urgency.bg} ${urgency.color}`}>
                        {urgency.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Roll reminder */}
      {boughtPuts.some((p) => {
        const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
        return parsed && parsed.daysToExpiry <= 21;
      }) && (
        <div className="flex items-start gap-2 bg-orange-500/10 border border-orange-500/25 rounded-lg px-3 py-2 text-xs text-orange-300">
          <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>Roll approaching: sell the expiring put(s) to salvage remaining value, then buy new contracts ~30 DTE. Do this on a market down day (or when VIX is low) for cheaper replacement puts.</span>
        </div>
      )}
    </div>
  );
}

// ─── Section 2: Sell-Put Income Engine ───────────────────────────────────────

function SellPutIncomeSection({ positions, totalValue }: { positions: EnrichedPosition[]; totalValue: number }) {
  // Existing sold puts (short option positions)
  const soldPuts = positions.filter(
    (p) => p.instrument.assetType === 'OPTION' && p.shortQuantity > 0,
  ).filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return parsed?.type === 'P';
  });

  // Sell-put candidates: existing equity positions (not options), indexed/triples, lower share price
  const equityPositions = positions.filter(
    (p) => p.instrument.assetType === 'EQUITY' || p.instrument.assetType === 'MUTUAL_FUND',
  );

  const candidates = equityPositions
    .map((pos) => ({
      pos,
      score: premiumQualityScore(pos),
      price: pos.quote?.lastPrice ?? pos.averagePrice,
    }))
    .filter(({ score }) => score >= 30) // only show worthwhile candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 8); // top 8

  return (
    <div className="space-y-4">
      <div className="text-xs text-[#7c82a0]">
        Vol 6 rules: sell 1 LEAP put on indexed ETFs you WANT to own. Premium lowers cost basis and margin interest.
        Prefer LOW share price names to keep assignment risk manageable. Close when ~75% of premium recovered.
      </div>

      {/* Active sold puts */}
      {soldPuts.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-white">Active Sold Puts</h4>
          <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
                  <th className="text-left px-3 py-2">Option</th>
                  <th className="text-right px-3 py-2">Strike</th>
                  <th className="text-right px-3 py-2">DTE</th>
                  <th className="text-right px-3 py-2">Contracts</th>
                  <th className="text-right px-3 py-2">Assignment $</th>
                  <th className="text-right px-3 py-2">Premium P/L</th>
                  <th className="text-right px-3 py-2">Signal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2d3248]">
                {soldPuts.map((pos) => {
                  const parsed = parseOptionSymbol(pos.instrument.symbol, pos.instrument.description);
                  if (!parsed) return null;
                  const contracts = pos.shortQuantity;
                  const assignmentRisk = parsed.strike * 100 * contracts;
                  // Sold puts: gain when premium decays. Cost is what we received; current value is what we'd pay to close.
                  const gl = pos.gainLoss; // positive = winning (premium decaying)
                  const glPct = pos.gainLossPercent;
                  // Close signal: if we've made ~75% of the premium back
                  const closeSignal = glPct >= 75;
                  return (
                    <tr key={pos.instrument.symbol} className="hover:bg-[#22263a]/60">
                      <td className="px-3 py-2">
                        <div className="font-mono font-semibold text-white">{parsed.underlying} Put</div>
                        <div className="text-[10px] text-[#7c82a0]">Sold / Short</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-white">${parsed.strike.toFixed(0)}</td>
                      <td className="px-3 py-2 text-right font-mono text-[#7c82a0]">{parsed.daysToExpiry}d</td>
                      <td className="px-3 py-2 text-right text-[#e8eaf0]">{contracts}</td>
                      <td className="px-3 py-2 text-right font-mono text-orange-300">
                        {fmt$(assignmentRisk)}
                        <div className="text-[10px] opacity-70">if assigned</div>
                      </td>
                      <td className={`px-3 py-2 text-right font-mono font-semibold ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmt$(gl)}
                        <div className="text-[10px] opacity-70">{glPct.toFixed(0)}% recovered</div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {closeSignal ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-500/10 border-emerald-500/25 text-emerald-400">
                            Close (75%+)
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-[#22263a] border-[#3d4260] text-[#7c82a0]">
                            Hold
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sell-put candidates */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-white">
          Sell-Put Candidates
          <span className="ml-2 text-[#4a5070] font-normal">ranked by premium quality score</span>
        </h4>

        {candidates.length === 0 ? (
          <p className="text-xs text-[#4a5070] py-2">No suitable sell-put candidates in current positions.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-right px-3 py-2">Current</th>
                  <th className="text-right px-3 py-2">Strike (−10%)</th>
                  <th className="text-right px-3 py-2">Assignment Risk</th>
                  <th className="text-right px-3 py-2">IV</th>
                  <th className="text-right px-3 py-2">Score</th>
                  <th className="text-right px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2d3248]">
                {candidates.map(({ pos, score, price }) => {
                  const suggestedStrike = price * 0.90;
                  const assignmentRisk = suggestedStrike * 100; // 1 contract = 100 shares
                  const iv = pos.quote?.volatility ?? 0;
                  const symbol = pos.instrument.symbol;

                  const isTriple = TRIPLES_SYMBOLS.has(symbol);
                  const isIncome = INCOME_SYMBOLS.has(symbol);
                  const isHighPrice = price > 200;

                  const scoreColor = score >= 70
                    ? 'text-emerald-400'
                    : score >= 50
                    ? 'text-yellow-400'
                    : 'text-orange-400';

                  return (
                    <tr key={symbol} className="hover:bg-[#22263a]/60">
                      <td className="px-3 py-2">
                        <div className="font-mono font-semibold text-white">{symbol}</div>
                        <div className="text-[10px] text-[#7c82a0]">
                          {isTriple ? '3x Leveraged' : isIncome ? 'Income ETF' : 'Equity'}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-white">${price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono text-blue-400">
                        ${suggestedStrike.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${isHighPrice ? 'text-red-400' : 'text-[#7c82a0]'}`}>
                        {fmt$(assignmentRisk)}
                        <div className="text-[10px] opacity-70">per contract</div>
                      </td>
                      <td className="px-3 py-2 text-right text-[#7c82a0]">
                        {iv > 0 ? `${iv.toFixed(0)}%` : '—'}
                      </td>
                      <td className={`px-3 py-2 text-right font-bold ${scoreColor}`}>{score}</td>
                      <td className="px-3 py-2 text-right text-[10px] text-[#4a5070]">
                        {isHighPrice && <span className="text-red-400">⚠ High assign risk</span>}
                        {isTriple && !isHighPrice && <span className="text-emerald-400">✓ Preferred</span>}
                        {isIncome && !isTriple && <span className="text-blue-400">✓ Indexed</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="text-[10px] text-[#4a5070] space-y-0.5">
          <p>Score 70+: excellent candidate. 50-70: good. Below 50: caution.</p>
          <p>Sell 1 LEAP put (1-2 years out) on your highest-scored name. Premium received lowers cost basis and knockdowns margin interest.</p>
          <p>Vol 6: "I always sell puts on stocks I WANT to own anyway — assignment is the goal, not the risk."</p>
        </div>
      </div>
    </div>
  );
}

// ─── Section 3: Boxing Tracker ────────────────────────────────────────────────

function BoxingTrackerSection({
  positions,
  cornerstonePremiumPct,
}: {
  positions: EnrichedPosition[];
  cornerstonePremiumPct?: number; // CLM/CRF premium % above NAV, passed from parent
}) {
  // Short equity positions in CLM or CRF
  const boxedPositions = positions.filter(
    (p) => CORNERSTONE_SYMBOLS.has(p.instrument.symbol) && p.shortQuantity > 0,
  );

  // Boxing signal conditions (Vol 5, Ch 5)
  const premiumHigh = (cornerstonePremiumPct ?? 0) > 20;
  const hasNoBoxing = boxedPositions.length === 0;

  const boxSignals = [
    {
      label: 'Premium > 20% above NAV',
      active: premiumHigh,
      desc: 'Best arbitrage opportunity — short CLM/CRF, cover at NAV or lower',
    },
    {
      label: 'Equity too low / margin pressure',
      active: false, // would need equity% from account data; user assesses
      desc: 'Boxing immediately raises equity by lowering maintenance requirements',
    },
    {
      label: 'RO announced',
      active: false,
      desc: 'Box before RO subscription — cover at discount after rights offering closes',
    },
    {
      label: 'Black-swan / market overbought',
      active: false,
      desc: 'Broad market overbought: short Cornerstone as index proxy hedge',
    },
  ];

  const activeSignals = boxSignals.filter((s) => s.active);

  return (
    <div className="space-y-4">
      <div className="text-xs text-[#7c82a0]">
        Vol 5 Ch 4-5: Short-selling CLM/CRF ("boxing") protects the CEF side of your portfolio while raising equity through lower maintenance.
        Cornerstone IS the index — boxing it hedges your whole income portfolio.
      </div>

      {/* Signal checklist */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-white">Box Signals</p>
        {boxSignals.map((signal, i) => (
          <div
            key={i}
            className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
              signal.active
                ? 'bg-orange-500/10 border-orange-500/25'
                : 'bg-[#22263a] border-[#2d3248]'
            }`}
          >
            {signal.active ? (
              <AlertTriangle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0 mt-0.5" />
            ) : (
              <CheckCircle className="w-3.5 h-3.5 text-[#3d4260] flex-shrink-0 mt-0.5" />
            )}
            <div>
              <div className={`font-semibold ${signal.active ? 'text-orange-300' : 'text-[#4a5070]'}`}>
                {signal.label}
              </div>
              <div className={signal.active ? 'text-orange-400/70' : 'text-[#3d4260]'}>
                {signal.desc}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Active boxing positions */}
      {boxedPositions.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-white">Active Boxing Positions</p>
          <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-right px-3 py-2">Short Shares</th>
                  <th className="text-right px-3 py-2">Market Value</th>
                  <th className="text-right px-3 py-2">P/L</th>
                  <th className="text-right px-3 py-2">Today</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2d3248]">
                {boxedPositions.map((pos) => {
                  const gl = pos.gainLoss;
                  const today = pos.todayGainLoss ?? 0;
                  return (
                    <tr key={pos.instrument.symbol} className="hover:bg-[#22263a]/60">
                      <td className="px-3 py-2">
                        <div className="font-mono font-semibold text-white">{pos.instrument.symbol}</div>
                        <div className="text-[10px] text-red-400">Short / Boxed</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-red-400">
                        -{pos.shortQuantity.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-white">
                        {fmt$(pos.marketValue)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmt$(gl)}
                        <div className="opacity-70 text-[10px]">{pos.gainLossPercent.toFixed(1)}%</div>
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${today >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {today !== 0 ? fmt$(today) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className={`rounded-lg px-3 py-2.5 text-xs border ${
          activeSignals.length > 0
            ? 'bg-orange-500/10 border-orange-500/25 text-orange-300'
            : 'bg-[#22263a] border-[#2d3248] text-[#4a5070]'
        }`}>
          {activeSignals.length > 0 ? (
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                {activeSignals.length} box signal{activeSignals.length > 1 ? 's' : ''} active — consider shorting CLM/CRF.
                Use "Sell Short" (not "Sell") at market order. Cover at lows.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <CheckCircle className="w-3.5 h-3.5 text-[#3d4260]" />
              <span>No active boxing. No signals triggered — holding long only in Cornerstone is appropriate.</span>
            </div>
          )}
        </div>
      )}

      <div className="text-[10px] text-[#4a5070] space-y-0.5">
        <p>Boxing advantages: lowers maintenance → raises equity immediately • Less decay than put options • Short borrow rate often below margin rate • Protects entire CEF exposure since C's track the index.</p>
        <p>Cover strategy: buy to cover at lows, then DCA long Cornerstone and ride back to the top.</p>
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
  cornerstonePremiumPct?: number;
}

const SECTIONS = [
  { id: 'protection', label: 'Put Protection Tracker', icon: Shield },
  { id: 'income', label: 'Sell-Put Income Engine', icon: DollarSign },
  { id: 'boxing', label: 'Boxing Tracker (CLM/CRF Short)', icon: Layers },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function OptionsStrategyPanel({ positions, totalValue, cornerstonePremiumPct }: Props) {
  const [expanded, setExpanded] = useState<Set<SectionId>>(new Set(['protection', 'income']));

  const toggleSection = (id: SectionId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Count active sold puts + bought puts for header badge
  const optionPositions = positions.filter((p) => p.instrument.assetType === 'OPTION');
  const boughtPuts = optionPositions.filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return p.longQuantity > 0 && parsed?.type === 'P';
  });
  const soldPuts = optionPositions.filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return p.shortQuantity > 0 && parsed?.type === 'P';
  });
  const boxedPositions = positions.filter(
    (p) => CORNERSTONE_SYMBOLS.has(p.instrument.symbol) && p.shortQuantity > 0,
  );

  // Roll alert: any puts with < 14 DTE
  const rollAlert = boughtPuts.some((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return parsed && parsed.daysToExpiry <= 14;
  });

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-purple-400" />
          <h2 className="text-sm font-semibold text-white">Options & Put Strategy</h2>
          <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full border border-purple-500/30">
            Phase 5
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#4a5070]">
          {rollAlert && (
            <span className="flex items-center gap-1 text-red-400">
              <Clock className="w-3 h-3" />
              Roll alert
            </span>
          )}
          {boughtPuts.length > 0 && (
            <span>{boughtPuts.length} put{boughtPuts.length > 1 ? 's' : ''} owned</span>
          )}
          {soldPuts.length > 0 && (
            <span>{soldPuts.length} put{soldPuts.length > 1 ? 's' : ''} sold</span>
          )}
          {boxedPositions.length > 0 && (
            <span className="text-orange-400">{boxedPositions.length} boxed</span>
          )}
        </div>
      </div>

      {/* Accordion sections */}
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const isOpen = expanded.has(id);
        return (
          <div key={id} className="border border-[#2d3248] rounded-lg overflow-hidden">
            <button
              onClick={() => toggleSection(id)}
              className="w-full flex items-center justify-between px-4 py-3 bg-[#22263a] hover:bg-[#2a2f45] transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5 text-purple-400" />
                <span className="text-sm font-medium text-white">{label}</span>
                {id === 'protection' && rollAlert && (
                  <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/30">Roll!</span>
                )}
              </div>
              {isOpen ? (
                <ChevronUp className="w-4 h-4 text-[#7c82a0]" />
              ) : (
                <ChevronDown className="w-4 h-4 text-[#7c82a0]" />
              )}
            </button>

            {isOpen && (
              <div className="px-4 py-4">
                {id === 'protection' && (
                  <PutProtectionSection positions={positions} />
                )}
                {id === 'income' && (
                  <SellPutIncomeSection positions={positions} totalValue={totalValue} />
                )}
                {id === 'boxing' && (
                  <BoxingTrackerSection
                    positions={positions}
                    cornerstonePremiumPct={cornerstonePremiumPct}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Vol 5/6 strategy reminder */}
      <div className="text-[10px] text-[#4a5070] border-t border-[#2d3248] pt-3">
        Vol 5: Buy SPY/QQQ puts ~30 DTE, 10% OTM, roll monthly ($100-$300/mo insurance). Box CLM/CRF at premium highs or when equity low.
        Vol 6: Sell 1 LEAP put on indexed names you want to own — premium lowers cost basis and margin. Close at 75% profit.
      </div>
    </div>
  );
}
