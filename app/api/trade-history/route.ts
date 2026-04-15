/**
 * GET /api/trade-history
 * Returns the trade history log stored in Netlify Blobs.
 *
 * DELETE /api/trade-history
 * Clears all history (requires confirmation query param).
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import type { TradeHistoryEntry } from '../orders/route';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const store = getStore('trade-history');
    const log = await store.get('log', { type: 'json' }) as TradeHistoryEntry[] | null;
    return NextResponse.json({ entries: Array.isArray(log) ? log : [] });
  } catch (err) {
    console.error('Trade history GET error:', err);
    return NextResponse.json({ entries: [] });
  }
}
