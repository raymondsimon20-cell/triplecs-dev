/**
 * Rights Offering (RO) Status Tracker — CLM & CRF
 *
 * Stores the RO lifecycle stage, its dates, and your decision, per fund.
 *
 * GET  → { statuses, assessments } — assessments carry the derived urgency
 *        and days-remaining so the banner and the card can't disagree.
 * POST → { ticker, status?, notes?, recordDate?, opensAt?, expiresAt?,
 *          rightsPerShare?, decision? } — partial update, merged over stored.
 *
 * Types live in lib/ro-deadline.ts alongside the assessment logic; this route
 * only persists and merges.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getStore } from '@netlify/blobs';
import { assessRO, type ROStage, type ROStatus, type RODecision } from '@/lib/ro-deadline';

export const dynamic = 'force-dynamic';

export type { ROStage, ROStatus } from '@/lib/ro-deadline';

const TICKERS = ['CLM', 'CRF'];
const STAGES = new Set<ROStage>([
  'none', 'announced', 'subscription_open', 'subscription_closed', 'complete',
]);
const DECISIONS = new Set<RODecision>(['pending', 'subscribed', 'declined']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  // Assess server-side so every surface reads the same urgency — a banner and
  // a card computing "days left" separately is how they end up disagreeing.
  const assessments = Object.fromEntries(
    statuses.map((s) => [s.ticker, assessRO(s)]),
  );
  return NextResponse.json({ statuses, assessments });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const ticker = typeof body.ticker === 'string' ? body.ticker.toUpperCase() : '';
  if (!TICKERS.includes(ticker)) {
    return NextResponse.json({ error: `ticker must be one of ${TICKERS.join(', ')}` }, { status: 400 });
  }

  // Partial merge over what's stored. The original route replaced the whole
  // record, which meant setting a deadline would wipe the stage and vice
  // versa — fine when the only fields were status and notes, not now.
  const current = await getROStatus(ticker);
  const entry: ROStatus = { ...current, ticker, updatedAt: new Date().toISOString() };

  if (body.status !== undefined) {
    if (!STAGES.has(body.status as ROStage)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 });
    }
    entry.status = body.status as ROStage;
    // Rolling back to 'none' ends the offering — clear its dates and decision
    // so a future offering doesn't inherit stale ones and count down to a
    // deadline that already passed.
    if (entry.status === 'none') {
      delete entry.recordDate; delete entry.opensAt; delete entry.expiresAt;
      delete entry.rightsPerShare; delete entry.decision; delete entry.decidedAt;
    }
  }

  if (typeof body.notes === 'string') entry.notes = body.notes;

  for (const field of ['recordDate', 'opensAt', 'expiresAt'] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (v === null || v === '') { delete entry[field]; continue; }
    if (typeof v !== 'string' || !ISO_DATE.test(v)) {
      return NextResponse.json({ error: `${field} must be YYYY-MM-DD` }, { status: 400 });
    }
    entry[field] = v;
  }

  if (body.rightsPerShare !== undefined) {
    const n = Number(body.rightsPerShare);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: 'rightsPerShare must be a positive number' }, { status: 400 });
    }
    entry.rightsPerShare = n;
  }

  if (body.decision !== undefined) {
    if (!DECISIONS.has(body.decision as RODecision)) {
      return NextResponse.json({ error: 'invalid decision' }, { status: 400 });
    }
    entry.decision = body.decision as RODecision;
    entry.decidedAt = entry.decision === 'pending' ? undefined : new Date().toISOString();
  }

  await getStore('ro-status').setJSON(ticker, entry);
  return NextResponse.json({ ok: true, entry, assessment: assessRO(entry) });
}
