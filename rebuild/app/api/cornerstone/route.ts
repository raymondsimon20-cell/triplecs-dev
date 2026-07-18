/**
 * Cornerstone (CLM/CRF): NAV premium calculation + rights-offering status.
 * 30%+ premium-to-NAV = sell/box signal (RULES §4).
 */
import { NextResponse } from 'next/server';
import { getQuotes } from '@/lib/schwab/client';
import { CONFIG } from '@/lib/signals/engine';
import { storage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

interface RoStatus {
  symbol: string;
  active: boolean;
  ratio?: string;
  expires?: string;
  note?: string;
}

export async function GET() {
  try {
    const quotes = await getQuotes(['CLM', 'CRF', 'XCLMX', 'XCRFX']);
    // NAV tickers: XCLMX / XCRFX where available; fall back to stored manual NAV
    const manualNav = (await storage.get<Record<string, number>>('cornerstone-nav')) ?? {};
    const roStatus = (await storage.get<RoStatus[]>('ro-status')) ?? [];

    const result = ['CLM', 'CRF'].map((sym) => {
      const price = quotes[sym]?.last ?? 0;
      const nav = quotes[`X${sym}X`]?.last ?? manualNav[sym] ?? 0;
      const premium = nav > 0 ? price / nav - 1 : null;
      return {
        symbol: sym,
        price,
        nav,
        premiumPct: premium,
        sellBoxSignal:
          premium != null && premium >= CONFIG.CORNERSTONE_PREMIUM.sellBoxThresholdPct,
        rightsOffering: roStatus.find((r) => r.symbol === sym) ?? { symbol: sym, active: false },
      };
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
