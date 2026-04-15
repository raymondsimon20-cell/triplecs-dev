import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

interface ATHConfig {
  SPY: number;
  QQQ: number;
  updatedAt: string;
}

// Fallback ATH values — user can override via POST
const DEFAULT_ATH: ATHConfig = {
  SPY: 613.0,
  QQQ: 540.0,
  updatedAt: new Date().toISOString(),
};

export async function GET() {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const client = await createClient();
    const quotes = await client.getQuotes(['SPY', 'QQQ']);

    // Load user-configured ATH
    const store = getStore('market-correction');
    const athRaw = await store.get('ath-config', { type: 'json' }).catch(() => null);
    const ath: ATHConfig = (athRaw as ATHConfig | null) ?? DEFAULT_ATH;

    const spyPrice = quotes['SPY']?.quote?.lastPrice ?? 0;
    const qqqPrice = quotes['QQQ']?.quote?.lastPrice ?? 0;
    const spyClose = quotes['SPY']?.quote?.closePrice ?? spyPrice;
    const qqqClose = quotes['QQQ']?.quote?.closePrice ?? qqqPrice;

    const spyCorrectionPct = ath.SPY > 0 ? ((ath.SPY - spyPrice) / ath.SPY) * 100 : 0;
    const qqqCorrectionPct = ath.QQQ > 0 ? ((ath.QQQ - qqqPrice) / ath.QQQ) * 100 : 0;

    // Primary signal: average of SPY and QQQ drawdowns
    const avgCorrectionPct = (spyCorrectionPct + qqqCorrectionPct) / 2;

    return NextResponse.json({
      SPY: {
        price: spyPrice,
        prevClose: spyClose,
        ath: ath.SPY,
        correctionPct: Math.max(0, spyCorrectionPct),
        dayChangePct: spyClose > 0 ? ((spyPrice - spyClose) / spyClose) * 100 : 0,
      },
      QQQ: {
        price: qqqPrice,
        prevClose: qqqClose,
        ath: ath.QQQ,
        correctionPct: Math.max(0, qqqCorrectionPct),
        dayChangePct: qqqClose > 0 ? ((qqqPrice - qqqClose) / qqqClose) * 100 : 0,
      },
      avgCorrectionPct: Math.max(0, avgCorrectionPct),
      athUpdatedAt: ath.updatedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const SPY = Number(body.SPY);
    const QQQ = Number(body.QQQ);

    if (isNaN(SPY) || isNaN(QQQ) || SPY <= 0 || QQQ <= 0) {
      return NextResponse.json({ error: 'Invalid ATH values' }, { status: 400 });
    }

    const store = getStore('market-correction');
    const config: ATHConfig = { SPY, QQQ, updatedAt: new Date().toISOString() };
    await store.set('ath-config', JSON.stringify(config));
    return NextResponse.json({ ok: true, ...config });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
