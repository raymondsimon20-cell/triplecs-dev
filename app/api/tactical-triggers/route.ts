/**
 * GET  /api/tactical-triggers — evaluate Vol 7 daily tactical triggers.
 *   Query params:
 *     triples_value   : current total $ in triple-long ETFs
 *     afw             : current Available-For-Withdrawal $ (equity – margin used)
 *     spy_day_pct     : optional override for SPY day change %
 *     spy_price       : optional override for SPY last price
 *
 * POST /api/tactical-triggers — update stored baselines.
 *   Body: { triples_baseline?, afw_baseline?, correction_low_spy? }
 *
 * Triggers (Vol 7 Ch. 8):
 *   1) +$5K rule      — triples value drifted ≥ +$5K from baseline   → TRIM
 *   2) 1% up day      — SPY up ≥ +1.0% today                         → TRIM + rotate
 *   3) 10% SPY bounce — SPY ≥ 10% above stored correction low        → REBALANCE SHORTS
 *   4) AFW governor   — AFW dropped ≥ 10% from baseline               → BUY ladder
 *   5) AFW governor   — AFW rose    ≥ 10% from baseline               → TRIM
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

interface TacticalBaselines {
  triples_baseline: number;          // $ value Triples pillar was last rebalanced to
  afw_baseline: number;              // $ AFW snapshot at last rebalance
  correction_low_spy: number | null; // stored SPY low during last correction for the 10% bounce rule
  updatedAt: string;
}

const DEFAULT_BASELINES: TacticalBaselines = {
  triples_baseline: 0,
  afw_baseline: 0,
  correction_low_spy: null,
  updatedAt: new Date().toISOString(),
};

interface FiredTrigger {
  rule: string;                    // "+$5K rule", "1% up day", etc.
  action: 'TRIM' | 'BUY' | 'HOLD' | 'REBALANCE';
  detail: string;                  // human-readable reason w/ numbers
  inputs: Record<string, number>;  // raw inputs so the AI can cite them
}

async function loadBaselines(): Promise<TacticalBaselines> {
  const store = getStore('tactical-triggers');
  const raw = await store.get('baselines', { type: 'json' }).catch(() => null);
  return (raw as TacticalBaselines | null) ?? DEFAULT_BASELINES;
}

export async function GET(req: NextRequest) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const params = req.nextUrl.searchParams;
    const triplesValue = Number(params.get('triples_value') ?? 0);
    const afw = Number(params.get('afw') ?? 0);

    let spyDayPct = Number(params.get('spy_day_pct'));
    let spyPrice  = Number(params.get('spy_price'));

    // Fetch live SPY if not overridden — tactical triggers need today's % change
    if (!Number.isFinite(spyDayPct) || !Number.isFinite(spyPrice) || spyPrice <= 0) {
      try {
        const client = await createClient();
        const quotes = await client.getQuotes(['SPY']);
        const q = quotes['SPY']?.quote;
        if (q) {
          spyPrice = q.lastPrice ?? spyPrice;
          const close = q.closePrice ?? 0;
          spyDayPct = close > 0 ? ((spyPrice - close) / close) * 100 : 0;
        }
      } catch {
        // non-fatal — continue with whatever inputs we have
      }
    }

    const baselines = await loadBaselines();
    const fired: FiredTrigger[] = [];

    // Rule 1 — +$5K rule on triples collective value
    if (baselines.triples_baseline > 0) {
      const drift = triplesValue - baselines.triples_baseline;
      if (drift >= 5000) {
        fired.push({
          rule: '+$5K rule (triples drift)',
          action: 'TRIM',
          detail: `Triples at $${Math.round(triplesValue).toLocaleString()} — $${Math.round(drift).toLocaleString()} above baseline $${Math.round(baselines.triples_baseline).toLocaleString()}. Trim $5K from today's biggest gainer.`,
          inputs: { triples_value: triplesValue, baseline: baselines.triples_baseline, drift },
        });
      }
    }

    // Rule 2 — 1% up day on SPY
    if (Number.isFinite(spyDayPct) && spyDayPct >= 1.0) {
      fired.push({
        rule: '1% up day rule',
        action: 'TRIM',
        detail: `SPY up ${spyDayPct.toFixed(2)}% today — trim triples back to baseline; rotate into Cornerstone, Roundhill/Rex/Yieldmax (RDTE, QDTE, YMAX, YMAG, AIPI, FEPI, ULTY).`,
        inputs: { spy_day_pct: spyDayPct },
      });
    }

    // Rule 3 — 10% bounce off correction low
    if (baselines.correction_low_spy && baselines.correction_low_spy > 0 && Number.isFinite(spyPrice)) {
      const bouncePct = ((spyPrice - baselines.correction_low_spy) / baselines.correction_low_spy) * 100;
      if (bouncePct >= 10) {
        fired.push({
          rule: '10% SPY bounce — rebalance shorts',
          action: 'REBALANCE',
          detail: `SPY ${bouncePct.toFixed(1)}% above stored low ($${baselines.correction_low_spy.toFixed(2)} → $${spyPrice.toFixed(2)}). Use triple-long trim proceeds to rebalance SPXU/SQQQ/SDOW/SOXS to $1.5K–$3K each.`,
          inputs: { spy_price: spyPrice, correction_low: baselines.correction_low_spy, bounce_pct: bouncePct },
        });
      }
    }

    // Rule 4 — AFW governor (both directions)
    if (baselines.afw_baseline > 0 && afw > 0) {
      const afwDriftPct = ((afw - baselines.afw_baseline) / baselines.afw_baseline) * 100;
      if (afwDriftPct <= -10) {
        fired.push({
          rule: 'AFW governor (drawdown)',
          action: 'BUY',
          detail: `AFW down ${afwDriftPct.toFixed(1)}% from baseline ($${Math.round(baselines.afw_baseline).toLocaleString()} → $${Math.round(afw).toLocaleString()}). Deploy next triples-ladder tranche.`,
          inputs: { afw, baseline: baselines.afw_baseline, drift_pct: afwDriftPct },
        });
      } else if (afwDriftPct >= 10) {
        fired.push({
          rule: 'AFW governor (runup)',
          action: 'TRIM',
          detail: `AFW up ${afwDriftPct.toFixed(1)}% from baseline — trim triples back, rotate into income per 1/3 rule.`,
          inputs: { afw, baseline: baselines.afw_baseline, drift_pct: afwDriftPct },
        });
      }
    }

    return NextResponse.json({
      fired,
      baselines,
      inputs: {
        triples_value: triplesValue,
        afw,
        spy_day_pct: Number.isFinite(spyDayPct) ? spyDayPct : null,
        spy_price: Number.isFinite(spyPrice) ? spyPrice : null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const current = await loadBaselines();

    const next: TacticalBaselines = {
      triples_baseline:
        typeof body.triples_baseline === 'number' && body.triples_baseline >= 0
          ? body.triples_baseline
          : current.triples_baseline,
      afw_baseline:
        typeof body.afw_baseline === 'number' && body.afw_baseline >= 0
          ? body.afw_baseline
          : current.afw_baseline,
      correction_low_spy:
        body.correction_low_spy === null || body.correction_low_spy === undefined
          ? current.correction_low_spy
          : typeof body.correction_low_spy === 'number' && body.correction_low_spy > 0
          ? body.correction_low_spy
          : current.correction_low_spy,
      updatedAt: new Date().toISOString(),
    };

    const store = getStore('tactical-triggers');
    await store.set('baselines', JSON.stringify(next));
    return NextResponse.json({ ok: true, baselines: next });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
