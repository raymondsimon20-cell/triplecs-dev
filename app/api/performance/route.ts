/**
 * GET /api/performance
 *
 * Returns the consolidated performance dataset:
 *   - daily snapshots (real + synthetic — synthetic are returned for chart
 *     display only and excluded from all return calculations below)
 *   - cash-flow events
 *   - TWR / CAGR / period returns (real snapshots only)
 *   - pillar attribution (real snapshots only)
 *   - SPY alpha (real snapshots only)
 *   - 40% target progress
 *
 * Pure read endpoint — math is all pure functions, no Schwab calls. Backed
 * by the daily snapshot capture so it stays fast.
 *
 * Why synthetic snapshots are excluded from math: the backfill walks back
 * from current positions and prices them at historical closes, but it can't
 * reconstruct cash balance, margin, sold positions, or realized gains. The
 * resulting `equity` field is positions-only, which would silently mix with
 * real `equity` values (positions + cash) and corrupt TWR.
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
    // Math runs on real snapshots only — synthetic backfill has positions-only
    // equity and would skew TWR. Chart still gets the full series (faded).
    const realOnly = chronological.filter((s) => !s.synthetic);

    const twr         = computeTWR(realOnly, cashFlows);
    const attribution = computePillarAttribution(realOnly);
    const alpha       = computeAlphaVsSPY(realOnly, cashFlows);
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
        realCount: realOnly.length,
        syntheticCount: chronological.length - realOnly.length,
        cashFlowCount: cashFlows.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[performance] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
