/**
 * GET /api/options-chain?symbol=TQQQ&contractType=PUT&strikeCount=15
 *
 * Fetches the live options chain from Schwab and returns a simplified,
 * put-selling-focused view with pre-calculated metrics per contract:
 *   - premium, bid, ask, IV, delta, DTE
 *   - breakeven price
 *   - 75% close target (Vol 6 rule: close when 75% of premium is captured)
 *   - annualised return on capital
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getOptionsChain } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export interface PutContract {
  symbol:           string;    // OCC option symbol
  expiration:       string;    // YYYY-MM-DD
  dte:              number;    // days to expiration
  strike:           number;
  bid:              number;
  ask:              number;
  mid:              number;    // (bid + ask) / 2
  last:             number;
  iv:               number;    // implied volatility as decimal (0.45 = 45%)
  delta:            number;    // negative for puts
  openInterest:     number;
  volume:           number;
  inTheMoney:       boolean;
  otmPct:           number;    // how far OTM as % of underlying price (positive = OTM)
  breakeven:        number;    // strike - mid premium
  closeTarget75:    number;    // close when premium falls to this (25% remaining = 75% captured)
  annualisedReturn: number;    // (mid / strike) * (365 / dte) — return on capital if assigned
}

export interface OptionsChainResponse {
  symbol:          string;
  underlyingPrice: number;
  puts:            PutContract[];
  fetchedAt:       string;
}

function safeDte(expirationDate: string): number {
  const exp = new Date(expirationDate + 'T16:00:00');  // market close
  const now = new Date();
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / 86_400_000));
}

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const symbol       = searchParams.get('symbol')?.toUpperCase();
  const strikeCount  = parseInt(searchParams.get('strikeCount') ?? '15');
  const contractType = (searchParams.get('contractType') ?? 'PUT') as 'PUT' | 'CALL' | 'ALL';

  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
  }

  const tokens = await getTokens();
  if (!tokens) {
    return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });
  }

  try {
    // Pass fromDate = today so Schwab never returns already-expired chains
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const raw = await getOptionsChain(tokens, symbol, { contractType, strikeCount, fromDate: todayStr });

    const underlyingPrice: number =
      (raw.underlyingPrice as number) ??
      ((raw.underlying as Record<string, unknown>)?.last as number) ?? 0;

    // Parse putExpDateMap  — shape: { "2025-04-18:1": { "120.0": [contractObj] } }
    const putExpDateMap = (raw.putExpDateMap ?? {}) as Record<string, Record<string, unknown[]>>;

    const puts: PutContract[] = [];

    for (const [expKey, strikeMap] of Object.entries(putExpDateMap)) {
      // expKey format: "2025-04-18:1"  (date:dteFromSchwab)
      const expDate = expKey.split(':')[0];
      const dte = safeDte(expDate);

      for (const [strikeStr, contracts] of Object.entries(strikeMap)) {
        const c = contracts[0] as Record<string, unknown>;
        if (!c || c.nonStandard) continue;

        if (dte <= 0) continue; // safety net: skip anything expiring today or already expired

        const strike = parseFloat(strikeStr);
        const bid    = (c.bid as number)  ?? 0;
        const ask    = (c.ask as number)  ?? 0;
        const mid    = +(((bid + ask) / 2).toFixed(2));
        const last   = (c.last as number) ?? mid;
        const iv     = (c.volatility as number) ?? 0;
        const delta  = (c.delta as number) ?? 0;
        const oi     = (c.openInterest as number) ?? 0;
        const vol    = (c.totalVolume as number) ?? 0;
        const itm    = (c.inTheMoney as boolean) ?? false;
        const otmPct = underlyingPrice > 0
          ? +((( underlyingPrice - strike) / underlyingPrice) * 100).toFixed(2)
          : 0;

        const breakeven         = +(( strike - mid).toFixed(2));
        const closeTarget75     = +(( mid * 0.25).toFixed(2));           // 75% profit = 25% remains
        const annualisedReturn  = strike > 0 && dte > 0
          ? +((mid / strike) * (365 / dte) * 100).toFixed(2)             // as %
          : 0;

        puts.push({
          symbol:           (c.symbol as string) ?? '',
          expiration:       expDate,
          dte,
          strike,
          bid,
          ask,
          mid,
          last,
          iv:               +(iv * 100).toFixed(1),  // convert to %
          delta:            +(delta).toFixed(3),
          openInterest:     oi,
          volume:           vol,
          inTheMoney:       itm,
          otmPct,
          breakeven,
          closeTarget75,
          annualisedReturn,
        });
      }
    }

    // Sort: nearest expiry first, then by strike descending (highest strike = closest to ATM)
    puts.sort((a, b) => {
      if (a.dte !== b.dte) return a.dte - b.dte;
      return b.strike - a.strike;
    });

    const response: OptionsChainResponse = {
      symbol,
      underlyingPrice,
      puts,
      fetchedAt: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Options chain error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
