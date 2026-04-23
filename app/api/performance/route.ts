/**
 * GET /api/performance
 *
 * Returns the consolidated performance dataset:
 *   - daily snapshots (real + synthetic)
 *   - cash-flow events
 *   - TWR / CAGR / period returns
 *   - pillar attribution
 *   - SPY alpha
 *   - 40% target progress
 *
 * Pure read endpoint — math is all pure functions, no Schwab calls. Backed
 * by the daily snapshot capture so it stays fast.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getSnapshotHistory, getCashFlows } from '@/lib/storage';
import {
  computeTWR,
  computePillarAttribution,
  computeAlphaVsSPY,
  computeProgressVs40,
} from '@/lib/performance';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(365, Number(searchParams.get('limit') ?? 90)));

  try {
    const [snapshots, cashFlows] = await Promise.all([
      getSnapshotHistory(limit),
      getCashFlows(),
    ]);

    // Snapshots come back newest-first; performance functions expect chronological
    const chronological = [...snapshots].reverse();

    const twr         = computeTWR(chronological, cashFlows);
    const attribution = computePillarAttribution(chronological);
    const alpha       = computeAlphaVsSPY(chronological, cashFlows);
    const progress    = twr ? computeProgressVs40(twr.cagrPct, twr.daysCovered) : null;

    return NextResponse.json({
      snapshots: chronological,
      cashFlows,
      twr,
      attribution,
      alpha,
      progress,
      meta: {
        snapshotCount: chronological.length,
        syntheticCount: chronological.filter((s) => s.synthetic).length,
        cashFlowCount: cashFlows.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[performance] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
