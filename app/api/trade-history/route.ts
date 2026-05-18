/**
 * GET /api/trade-history[?accountHash=…]
 * Returns the trade history log stored in Netlify Blobs. With an accountHash
 * query parameter, filters to entries tagged for that Schwab account (plus
 * legacy untagged entries, which predate per-account tagging — they're
 * included so the user doesn't lose history on a scoped view).
 *
 * DELETE /api/trade-history
 * Clears all history (requires confirmation query param).
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import type { TradeHistoryEntry } from '../orders/route';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const store = getStore('trade-history');
    const log = await store.get('log', { type: 'json' }) as TradeHistoryEntry[] | null;
    const all = Array.isArray(log) ? log : [];

    const accountHashParam = new URL(req.url).searchParams.get('accountHash');
    const accountHash      = accountHashParam && accountHashParam !== 'all' && accountHashParam !== 'global'
      ? accountHashParam
      : undefined;
    const entries = accountHash
      ? all.filter((e) => !e.accountHash || e.accountHash === accountHash)
      : all;

    return NextResponse.json({ entries, scope: accountHash ?? 'all' });
  } catch (err) {
    console.error('Trade history GET error:', err);
    return NextResponse.json({ entries: [] });
  }
}
