/**
 * Guardrails — SEPARATE, independent validation layer.
 *
 * EVERY proposed trade (AI-generated, engine-fired, or user one-click) must
 * pass validateTrade() before execution. This layer deliberately does NOT
 * import the signals engine: hard limits are enforced here even if the
 * engine (or the AI) is wrong. Never trust the signal generator alone.
 */
import { classify, pillarBreakdown } from '@/lib/classify';
import { PILLAR_TARGETS, type Pillar } from '@/lib/data/fund-metadata';
import type { ProposedTrade, EnginePosition, EngineBalances } from '@/lib/signals/types';

export const GUARDRAIL_CONFIG = {
  /** Max single order as % of portfolio equity. */
  maxOrderPctOfPortfolio: 0.10,
  /** Max single-position concentration after the trade (RULES §7 hard cap). */
  maxConcentrationAfterTrade: 0.20,
  /** Max pillar overdrift above target after the trade. */
  maxPillarOverdrift: 0.10,
  /**
   * AFW floor — block any trade whose projected post-trade
   * AFW (Available For Withdrawal) would fall below this dollar floor.
   * Enforced independently for ALL trades, including automated ones.
   */
  afwFloorDollars: 10_000,
  /** Schwab broker-level margin utilization hard cap. */
  brokerMarginHardCap: 0.50,
} as const;

export interface GuardrailResult {
  allowed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

/**
 * Project the margin draw of a trade, including options:
 * - long equity buy: notional minus available cash draws margin
 * - long options (puts/calls): full premium, cash-only (no margin loan on long options)
 * - cash-secured put: strike × 100 × contracts held aside
 * - naked put: Schwab-style ~20% underlying requirement approximation
 * - covered call: no additional draw (shares already held)
 * - sells: negative draw (adds AFW)
 */
export function projectMarginDraw(trade: ProposedTrade): number {
  if (trade.side === 'SELL' && !trade.optionKind) return -trade.notional;
  switch (trade.optionKind) {
    case 'covered-call':
      return 0;
    case 'cash-secured-put': {
      const contracts = trade.contracts ?? 1;
      const strike = trade.strike ?? 0;
      return strike * 100 * contracts;
    }
    case 'naked-put': {
      // Approximation of Schwab naked-put requirement: 20% of underlying
      // (strike used as proxy) × 100 × contracts.
      const contracts = trade.contracts ?? 1;
      const strike = trade.strike ?? 0;
      return 0.2 * strike * 100 * contracts;
    }
    case 'long-put':
    case 'long-call':
      return trade.notional; // premium paid in full
    default:
      return trade.notional; // equity buy
  }
}

export function validateTrade(
  trade: ProposedTrade,
  positions: EnginePosition[],
  balances: EngineBalances
): GuardrailResult {
  const checks: GuardrailResult['checks'] = [];
  const total = balances.equity;
  const G = GUARDRAIL_CONFIG;

  // 1. Max order size
  const orderPct = trade.notional / Math.max(1, total);
  checks.push({
    name: 'max-order-size',
    passed: orderPct <= G.maxOrderPctOfPortfolio,
    detail: `Order is ${(orderPct * 100).toFixed(1)}% of portfolio (max ${(G.maxOrderPctOfPortfolio * 100).toFixed(0)}%).`,
  });

  // 2. Post-trade concentration
  const existing = positions.find((p) => p.symbol === trade.symbol)?.marketValue ?? 0;
  const postValue = trade.side === 'BUY' ? existing + trade.notional : Math.max(0, existing - trade.notional);
  const postConc = postValue / Math.max(1, total);
  checks.push({
    name: 'max-concentration',
    passed: postConc <= G.maxConcentrationAfterTrade,
    detail: `${trade.symbol} would be ${(postConc * 100).toFixed(1)}% after trade (hard cap ${(G.maxConcentrationAfterTrade * 100).toFixed(0)}%).`,
  });

  // 3. Pillar overdrift
  const breakdown = pillarBreakdown(
    positions.map((p) => ({ symbol: p.symbol, marketValue: p.marketValue, putCall: p.putCall })),
    balances.cash
  );
  const pillar: Pillar = trade.pillar ?? classify(trade.symbol);
  const target = (PILLAR_TARGETS as Record<string, number>)[pillar];
  if (target != null && trade.side === 'BUY') {
    const postPillarPct = ((breakdown.values[pillar] ?? 0) + trade.notional) / Math.max(1, total);
    const overdrift = postPillarPct - target;
    checks.push({
      name: 'max-pillar-overdrift',
      passed: overdrift <= G.maxPillarOverdrift,
      detail: `${pillar} would be ${(postPillarPct * 100).toFixed(1)}% vs ${(target * 100).toFixed(0)}% target (overdrift ${(overdrift * 100).toFixed(1)}%, max ${(G.maxPillarOverdrift * 100).toFixed(0)}%).`,
    });
  }

  // 4. AFW floor — projected post-trade AFW (Available For Withdrawal)
  const draw = projectMarginDraw(trade);
  const projectedAfw = balances.afw - draw;
  checks.push({
    name: 'afw-floor',
    passed: projectedAfw >= G.afwFloorDollars,
    detail: `Projected post-trade AFW $${Math.round(projectedAfw).toLocaleString()} (floor $${G.afwFloorDollars.toLocaleString()}).`,
  });

  // 5. Broker margin hard cap (Schwab fails orders above 50% utilization)
  if (trade.side === 'BUY') {
    const cashAvail = Math.max(0, balances.cash);
    const marginDraw = Math.max(0, draw - cashAvail);
    const projDebit = balances.marginDebit + marginDraw;
    const projGross = balances.equity + projDebit;
    const projUtil = projGross > 0 ? projDebit / projGross : 1;
    checks.push({
      name: 'broker-margin-cap',
      passed: projUtil <= G.brokerMarginHardCap,
      detail: `Projected margin utilization ${(projUtil * 100).toFixed(1)}% (Schwab broker hard cap ${(G.brokerMarginHardCap * 100).toFixed(0)}% — orders above fail at the broker).`,
    });
  }

  return { allowed: checks.every((c) => c.passed), checks };
}

/** Validate a batch; returns only the trades that pass, plus full results. */
export function validateBatch(
  trades: ProposedTrade[],
  positions: EnginePosition[],
  balances: EngineBalances
): { approved: ProposedTrade[]; results: { trade: ProposedTrade; result: GuardrailResult }[] } {
  const results = trades.map((trade) => ({
    trade,
    result: validateTrade(trade, positions, balances),
  }));
  return { approved: results.filter((r) => r.result.allowed).map((r) => r.trade), results };
}
