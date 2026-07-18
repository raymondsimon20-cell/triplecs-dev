/**
 * Option scan: put-selling candidates and close recommendations (RULES §9).
 * - Insurance puts: strikes ~10% OTM, 0–15 DTE
 * - Sell puts on long triples at lows (DCA via premium)
 * - Close recs: short puts that captured most of their premium
 */
import type { OptionChain, OptionContract } from '@/lib/schwab/types';

export const OPTION_CONFIG = {
  insuranceStrikeOtmPct: 0.10,
  maxDte: 15,
  /** Close a short put once this fraction of premium is captured. */
  closeAtPremiumCapturePct: 0.80,
  /** AFW-aware: skip scans entirely below this AFW cushion. */
  minAfwForNewShorts: 25_000,
} as const;

export interface PutCandidate {
  contract: OptionContract;
  kind: 'insurance' | 'income';
  reason: string;
}

export function scanPuts(chain: OptionChain): PutCandidate[] {
  const out: PutCandidate[] = [];
  const target = chain.underlyingPrice * (1 - OPTION_CONFIG.insuranceStrikeOtmPct);
  for (const strikes of Object.values(chain.putExpDateMap ?? {})) {
    for (const contracts of Object.values(strikes)) {
      for (const c of contracts) {
        if (c.daysToExpiration > OPTION_CONFIG.maxDte) continue;
        const distance = Math.abs(c.strikePrice - target) / chain.underlyingPrice;
        if (distance <= 0.02) {
          out.push({
            contract: c,
            kind: 'insurance',
            reason: `~10% OTM (${c.strikePrice}) at ${c.daysToExpiration} DTE — insurance-put profile (RULES §9).`,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.contract.daysToExpiration - b.contract.daysToExpiration);
}

export interface OpenShortPut {
  symbol: string;
  strike: number;
  premiumReceived: number; // per share
  currentPrice: number; // per share (mark)
  contracts: number;
  daysToExpiration: number;
}

export interface CloseRecommendation {
  position: OpenShortPut;
  capturedPct: number;
  reason: string;
}

export function closeRecommendations(openPuts: OpenShortPut[]): CloseRecommendation[] {
  const recs: CloseRecommendation[] = [];
  for (const p of openPuts) {
    if (p.premiumReceived <= 0) continue;
    const captured = 1 - p.currentPrice / p.premiumReceived;
    if (captured >= OPTION_CONFIG.closeAtPremiumCapturePct) {
      recs.push({
        position: p,
        capturedPct: captured,
        reason: `${(captured * 100).toFixed(0)}% of premium captured (≥ ${(OPTION_CONFIG.closeAtPremiumCapturePct * 100).toFixed(0)}%) — buy to close, redeploy collateral.`,
      });
    }
  }
  return recs;
}
