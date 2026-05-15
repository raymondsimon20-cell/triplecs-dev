/**
 * Options chain → best contract — shared, pure helpers.
 *
 * Previously inlined in app/api/option-plan/route.ts; extracted so both that
 * route AND the daily autopilot scanner (lib/signals/option-scan.ts) can pick
 * contracts from a chain without a Claude round-trip.
 *
 * Two operating modes:
 *   - 'sell_put' (Vol 6) — cash/margin-secured short puts for income
 *   - 'buy_put'  (Vol 5) — protective long puts for crash insurance
 *
 * The deterministic picker (`scoreFallback`) uses fixed scoring rules from
 * the Vol-5/6 strategy. It's not as nuanced as Claude can be but it's fast,
 * predictable, and good enough for autopilot's daily scan.
 */

export interface PutContract {
  symbol:           string;   // OCC symbol — verbatim from Schwab
  expiration:       string;
  dte:              number;
  strike:           number;
  bid:              number;
  ask:              number;
  mid:              number;
  iv:               number;
  delta:            number;
  openInterest:     number;
  otmPct:           number;
  breakeven:        number;
  closeTarget75:    number;
  annualisedReturn: number;
  inTheMoney:       boolean;
}

export type OptionMode = 'sell_put' | 'buy_put';

function safeDte(expDate: string): number {
  const today  = new Date();
  const target = new Date(expDate);
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/** Parse Schwab's raw chain into our PutContract[]. */
export function parseChain(
  raw: Record<string, unknown>,
  underlyingPrice: number,
): PutContract[] {
  const todayStr = new Date().toISOString().slice(0, 10);
  const putMap = (raw.putExpDateMap ?? {}) as Record<string, Record<string, unknown[]>>;
  const contracts: PutContract[] = [];

  for (const [expKey, strikeMap] of Object.entries(putMap)) {
    const expDate = expKey.split(':')[0];
    if (expDate < todayStr) continue;
    const dte = safeDte(expDate);
    if (dte <= 0) continue;

    for (const [strikeStr, legs] of Object.entries(strikeMap)) {
      const c = legs[0] as Record<string, unknown>;
      if (!c || c.nonStandard) continue;

      const strike = parseFloat(strikeStr);
      const bid    = (c.bid  as number) ?? 0;
      const ask    = (c.ask  as number) ?? 0;
      const mid    = +((bid + ask) / 2).toFixed(2);
      const iv     = +((c.volatility as number ?? 0)).toFixed(1);
      const delta  = +(c.delta as number ?? 0).toFixed(3);
      const itm    = (c.inTheMoney as boolean) ?? false;
      const otmPct = underlyingPrice > 0
        ? +((underlyingPrice - strike) / underlyingPrice * 100).toFixed(2)
        : 0;
      const breakeven        = +(strike - mid).toFixed(2);
      const closeTarget75    = +(mid * 0.25).toFixed(2);
      const annualisedReturn = strike > 0 && dte > 0
        ? +(mid / strike * (365 / dte) * 100).toFixed(2)
        : 0;

      contracts.push({
        symbol:           (c.symbol as string) ?? '',
        expiration:       expDate,
        dte,
        strike,
        bid,
        ask,
        mid,
        iv,
        delta,
        openInterest:     (c.openInterest  as number) ?? 0,
        otmPct,
        breakeven,
        closeTarget75,
        annualisedReturn,
        inTheMoney: itm,
      });
    }
  }

  return contracts.sort((a, b) => a.dte !== b.dte ? a.dte - b.dte : b.strike - a.strike);
}

/** Filter contracts to the Vol-5/6 sweet window for each mode. */
export function filterContracts(contracts: PutContract[], mode: OptionMode): PutContract[] {
  if (mode === 'sell_put') {
    // Vol 6: 45–150 DTE, 4–28% OTM, delta -0.13 to -0.45 (skip delta when 0 — missing after-hours)
    return contracts.filter(
      (c) => c.dte >= 45 && c.dte <= 150 &&
             c.otmPct >= 4 && c.otmPct <= 28 &&
             (c.delta === 0 || (Math.abs(c.delta) >= 0.13 && Math.abs(c.delta) <= 0.45)) &&
             !c.inTheMoney && c.mid > 0,
    );
  }
  // Vol 5: ~30 DTE, 5–20% OTM, protective put. Wide windows for high-priced ETFs.
  return contracts.filter(
    (c) => c.dte >= 7 && c.dte <= 90 &&
           c.otmPct >= 3 && c.otmPct <= 22 &&
           !c.inTheMoney && c.mid > 0,
  );
}

/**
 * Pick the best contract from a filtered set. Deterministic — no LLM call.
 * Used by the daily autopilot scanner and as the option-plan fallback.
 */
export function scoreFallback(contracts: PutContract[], mode: OptionMode): PutContract {
  if (mode === 'sell_put') {
    // Prefer delta ~-0.25, DTE 60-90, higher annualised return
    return contracts.reduce((best, c) => {
      const deltaC    = c.delta !== 0 ? Math.abs(c.delta) : Math.max(0.05, 0.5 - c.otmPct / 100 * 1.6);
      const deltaB    = best.delta !== 0 ? Math.abs(best.delta) : Math.max(0.05, 0.5 - best.otmPct / 100 * 1.6);
      const deltaDiff = Math.abs(deltaC - 0.25);
      const bestDelta = Math.abs(deltaB - 0.25);
      const dteScore  = c.dte >= 60 && c.dte <= 90 ? 0 : 1;
      const bestDte   = best.dte >= 60 && best.dte <= 90 ? 0 : 1;
      const score     = deltaDiff + dteScore * 0.5 - c.annualisedReturn * 0.01;
      const bestScore = bestDelta + bestDte * 0.5 - best.annualisedReturn * 0.01;
      return score < bestScore ? c : best;
    });
  }
  // Vol 5: prefer delta ~-0.20, DTE closest to 30
  return contracts.reduce((best, c) => {
    const dteDiff     = Math.abs(c.dte - 30);
    const bestDteDiff = Math.abs(best.dte - 30);
    return dteDiff < bestDteDiff ? c : best;
  });
}

/**
 * End-to-end picker for autopilot: parse chain, filter to mode window,
 * pick best. Returns null if no candidate fits the window.
 */
export function pickBestContract(
  rawChain:         Record<string, unknown>,
  underlyingPrice:  number,
  mode:             OptionMode,
): PutContract | null {
  const parsed   = parseChain(rawChain, underlyingPrice);
  const filtered = filterContracts(parsed, mode);
  if (filtered.length === 0) return null;
  return scoreFallback(filtered, mode);
}
