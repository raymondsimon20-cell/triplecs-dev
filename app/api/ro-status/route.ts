/**
 * Rights Offering (RO) Status Tracker — CLM & CRF
 *
 * Stores the current RO lifecycle stage per fund in Netlify Blobs.
 * GET  → returns { statuses: ROStatus[] }
 * POST → { ticker, status, notes? } → updates and returns the entry
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

export type ROStage =
  | 'none'               // No active RO
  | 'announced'          // RO announced — subscription not yet open
  | 'subscription_open'  // Subscription period active
  | 'subscription_closed'// Period ended — shares being issued
  | 'complete';          // RO complete — buy-back opportunity

export interface ROStatus {
  ticker: string;
  status: ROStage;
  notes: string;
  updatedAt: string;
}

const TICKERS = ['CLM', 'CRF'];

async function getROStatus(ticker: string): Promise<ROStatus> {
  try {
    const stored = (await getStore('ro-status').get(ticker, { type: 'json' })) as ROStatus | null;
    if (stored) return stored;
  } catch { /* fall through */ }
  return { ticker, status: 'none', notes: '', updatedAt: '' };
}

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const statuses = await Promise.all(TICKERS.map(getROStatus));
  return NextResponse.json({ statuses });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { ticker, status, notes = '' } = body as { ticker: string; status: ROStage; notes?: string };

  if (!ticker || !status) {
    return NextResponse.json({ error: 'ticker and status required' }, { status: 400 });
  }

  const entry: ROStatus = { ticker, status, notes, updatedAt: new Date().toISOString() };
  await getStore('ro-status').setJSON(ticker, entry);
  return NextResponse.json({ ok: true, entry });
}
