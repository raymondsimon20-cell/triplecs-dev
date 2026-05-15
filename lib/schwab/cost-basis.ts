/**
 * Cost-basis lookup helper.
 *
 * The trade-history record now persists `costBasisPerShare` for SELL trades so
 * downstream code (wash-sale detection, realized P&L attribution) can answer
 * "was this sell at a loss?" honestly instead of conservatively assuming yes.
 *
 * Schwab returns the avg cost basis on the position record as `averageLongPrice`.
 * This helper fetches the account, builds a symbol → cost-basis map, and is
 * called by the manual orders route and the autopilot execute path before
 * persisting trade-history entries.
 *
 * Best-effort: when the account can't be fetched (rate limit, token expiry),
 * we return an empty map rather than failing the order. The trade still gets
 * written; it just won't have cost basis attached.
 */

import { createClient } from './client';
import type { SchwabTokens } from './types';

export async function fetchCostBasisMap(
  tokens: SchwabTokens,
  accountHash: string,
): Promise<Record<string, number>> {
  try {
    const client = await createClient();
    const wrapper = await client.getAccount(accountHash);
    const positions = wrapper?.securitiesAccount?.positions ?? [];
    const map: Record<string, number> = {};
    for (const p of positions) {
      const symbol = p.instrument?.symbol?.toUpperCase();
      if (!symbol) continue;
      // Prefer the tax-lot-weighted avg; fall back to averageLongPrice.
      const basis = p.taxLotAverageLongPrice || p.averageLongPrice || p.averagePrice;
      if (basis && Number.isFinite(basis) && basis > 0) {
        map[symbol] = basis;
      }
    }
    return map;
  } catch (err) {
    console.warn('[cost-basis] fetch failed, returning empty map:', err);
    // Tokens param is unused on the happy path (we use the cached client) but
    // accepted to keep the contract consistent across callers that might want
    // a tokens-driven variant later.
    void tokens;
    return {};
  }
}

/**
 * Helper: pick cost basis for a SELL, undefined for BUY. Used inside trade-
 * history construction to keep call sites compact.
 */
export function costBasisFor(
  instruction: string,
  symbol: string,
  map: Record<string, number>,
): number | undefined {
  const sells = new Set(['SELL', 'SELL_TO_CLOSE', 'SELL_TO_OPEN']);
  if (!sells.has(instruction)) return undefined;
  return map[symbol.toUpperCase()];
}
