/**
 * GET    /api/accounts/cleanup → dry-run report of stale per-account slots
 *                                across the per-account blob stores
 *                                (signal-engine-state, strategy-targets,
 *                                auto-config, cache, snapshots).
 * DELETE /api/accounts/cleanup → actually purges them.
 *
 * "Stale" = an accountHash that's no longer in the user's current Schwab
 * account list. After unlinking an account, its server-side state would
 * otherwise accumulate forever; this endpoint is the user's escape hatch
 * for tidying up.
 *
 * Nicknames are localStorage-only and out of scope.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { scanStaleAccounts, purgeStaleAccounts } from '@/lib/account-cleanup';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  try { await requireAuth(); } catch { return unauthorized(); }
  try {
    const report = await scanStaleAccounts();
    return NextResponse.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE() {
  try { await requireAuth(); } catch { return unauthorized(); }
  try {
    const result = await purgeStaleAccounts();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
