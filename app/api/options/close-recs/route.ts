/**
 * GET /api/options/close-recs?hash=<accountHash>&floor=<dollars>
 *
 * Returns a one-shot report identifying which open option positions to
 * close to restore AFW headroom above the safety floor. Built to address
 * the situation where existing positions (opened before the post-trade AFW
 * guardrail) are eating into AFW below the $10K floor.
 *
 * Prioritization: profits-first. The recommendation set is a greedy
 * minimum walk down P&L-descending order, stopping once projected AFW
 * clears the floor. See lib/options/afw-close-recs.ts for the algorithm.
 *
 * Query params:
 *   hash:  Schwab accountHash to report on. Required.
 *   floor: Override the AFW floor in USD. Defaults to 10000 (matches
 *          DEFAULT_LIMITS.minAfwHeadroomAfterTrade and the signal-engine
 *          AFW_MIN_HEADROOM constant).
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { buildAfwCloseRecs } from '@/lib/options/afw-close-recs';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHash = searchParams.get('hash');
  if (!accountHash) {
    return NextResponse.json(
      { error: 'hash query param is required (Schwab accountHash)' },
      { status: 400 },
    );
  }

  const floorRaw = searchParams.get('floor');
  const floor = floorRaw ? Number(floorRaw) : 10_000;
  if (!Number.isFinite(floor) || floor < 0) {
    return NextResponse.json(
      { error: 'floor must be a non-negative number (USD)' },
      { status: 400 },
    );
  }

  try {
    const client  = await createClient();
    const wrapper = await client.getAccount(accountHash);
    const acct    = wrapper.securitiesAccount;
    const afw     = acct.currentBalances.availableFunds ?? 0;
    const positions = acct.positions ?? [];

    const report = buildAfwCloseRecs(positions, afw, floor);

    return NextResponse.json({
      accountHash,
      accountNumber: acct.accountNumber,
      ...report,
      generatedAt:   new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
