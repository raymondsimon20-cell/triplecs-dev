/**
 * Shared portfolio-fetch helper.
 *
 * Extracted from app/api/accounts/route.ts so the daily Netlify function and
 * the API route can both build a `PortfolioSnapshot` without duplicating the
 * auth + classify + summarise pipeline.
 *
 * Returns the raw building blocks needed for both the API response and the
 * persisted snapshot — callers compose what they need.
 */

import { createClient } from '../schwab/client';
import { enrichPositions, summarizeByPillar } from '../classify';
import type { PortfolioSnapshot } from '../storage';
import type { EnrichedPosition } from '../schwab/types';

export interface FetchedAccountState {
  accountNumber: string;
  totalValue: number;
  equity: number;
  marginBalance: number;       // absolute value (positive number)
  marginUtilizationPct: number;
  pillarSummary: ReturnType<typeof summarizeByPillar>;
  positions: EnrichedPosition[];
}

/**
 * Fetch + classify a single account, returning the data needed to build a
 * snapshot. Does NOT persist — caller decides what to do with the result.
 */
export async function fetchAccountState(accountHash: string): Promise<FetchedAccountState> {
  const client  = await createClient();
  const wrapper = await client.getAccount(accountHash);
  const acct    = wrapper.securitiesAccount;
  const positions = acct.positions ?? [];

  const symbols = positions
    .map((p) => p.instrument.symbol)
    .filter((s) => !s.includes(' ')); // skip option symbols

  const quotes = symbols.length > 0 ? await client.getQuotes(symbols) : {};

  // Gross market value (longs + shorts) — see accounts route for rationale
  const totalValue =
    (acct.currentBalances.longMarketValue ?? 0) +
    Math.abs(acct.currentBalances.shortMarketValue ?? 0);

  const enriched      = enrichPositions(positions, quotes, totalValue);
  const pillarSummary = summarizeByPillar(enriched, totalValue);
  const equity        = acct.currentBalances.equity;
  const marginBalance = Math.abs(acct.currentBalances.marginBalance ?? 0);

  return {
    accountNumber: acct.accountNumber,
    totalValue,
    equity,
    marginBalance,
    marginUtilizationPct: totalValue > 0 ? (marginBalance / totalValue) * 100 : 0,
    pillarSummary,
    positions: enriched,
  };
}

/**
 * Convert a fetched account state into the `PortfolioSnapshot` schema used
 * by the snapshots blob. Aggregates a list of accounts into a single snapshot
 * (the user's current setup is single-account, but this future-proofs it).
 *
 * `extras` lets callers attach the SPY benchmark close for the day or mark
 * the snapshot as synthetic (used by backfill).
 */
export function buildSnapshot(
  states: FetchedAccountState[],
  extras: { spyClose?: number; synthetic?: boolean } = {},
): PortfolioSnapshot {
  const totalValue    = states.reduce((s, x) => s + x.totalValue, 0);
  const equity        = states.reduce((s, x) => s + x.equity, 0);
  const marginBalance = states.reduce((s, x) => s + x.marginBalance, 0);

  // Aggregate pillar summaries by absolute dollars, then re-derive percentages
  const pillarMap = new Map<string, number>();
  for (const s of states) {
    for (const p of s.pillarSummary) {
      pillarMap.set(p.pillar, (pillarMap.get(p.pillar) ?? 0) + p.totalValue);
    }
  }
  const pillarSummary = Array.from(pillarMap.entries()).map(([pillar, value]) => ({
    pillar,
    totalValue: value,
    portfolioPercent: totalValue > 0 ? (value / totalValue) * 100 : 0,
  }));

  const positions = states.flatMap((s) =>
    s.positions.map((p) => ({
      symbol: p.instrument.symbol,
      pillar: p.pillar,
      marketValue: p.marketValue,
      shares: p.longQuantity,
      unrealizedGL: p.longOpenProfitLoss ?? 0,
    })),
  );

  return {
    savedAt: Date.now(),
    totalValue,
    equity,
    marginBalance,
    marginUtilizationPct: totalValue > 0 ? (marginBalance / totalValue) * 100 : 0,
    pillarSummary,
    positions,
    ...(extras.spyClose !== undefined ? { spyClose: extras.spyClose } : {}),
    ...(extras.synthetic ? { synthetic: true } : {}),
  };
}
