/**
 * /api/contributions/status — contribution allocation tracking.
 *
 * GET  → { contributions, summary }
 *          contributions: every trackable deposit joined to its allocation
 *          state. summary: count + dollar total still open, for the dashboard.
 *          ?accountHash=… scopes to one account. ?state=open filters.
 *
 * POST → mark one contribution
 *          { eventId, action: 'allocated' | 'ignored' | 'open',
 *            allocatedDollars?, tradeIds?, note? }
 *
 * PUT  → one-time backfill: close everything before ?before=YYYY-MM-DD so the
 *        count starts clean instead of surfacing months of history you've
 *        already dealt with. Defaults to the first of the current month, so
 *        this month's deposits stay open for review and everything older is
 *        marked as predating the feature.
 *
 * Read-only derivation: contributions come from the cash-flow log, never a
 * second copy. This route only reads and writes their status.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getCashFlows } from '@/lib/storage';
import {
  listContributions,
  openContributionSummary,
  markAllocated,
  markIgnored,
  markOpen,
  seedHistoricalAsIgnored,
  type ContributionState,
} from '@/lib/contributions/status';

export const dynamic = 'force-dynamic';

const ACTIONS = new Set<ContributionState>(['allocated', 'ignored', 'open']);

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHash = searchParams.get('accountHash') ?? undefined;
  const stateFilter = searchParams.get('state');

  try {
    const [all, summary] = await Promise.all([
      listContributions(accountHash),
      openContributionSummary(accountHash),
    ]);
    const contributions = stateFilter
      ? all.filter((c) => c.state === stateFilter)
      : all;
    return NextResponse.json({ contributions, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[contributions/status] GET failed:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const eventId = typeof body.eventId === 'string' ? body.eventId : '';
  const action  = body.action as ContributionState;
  if (!eventId) return NextResponse.json({ error: 'eventId required' }, { status: 400 });
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: `action must be one of ${[...ACTIONS].join(', ')}` }, { status: 400 });
  }

  try {
    // Amount and date come from the cash-flow log rather than the request, so
    // a caller can't write a status row that disagrees with the event it
    // describes. They're denormalized onto the status purely so an orphaned
    // row can be re-matched later — see lib/contributions/status.ts.
    const event = (await getCashFlows()).find((e) => e.id === eventId);
    if (!event) {
      return NextResponse.json({ error: `No cash-flow event ${eventId}` }, { status: 404 });
    }

    const base = { amount: event.amount, date: event.date, accountHash: event.accountHash };
    const note = typeof body.note === 'string' ? body.note : undefined;

    let result;
    if (action === 'allocated') {
      const raw = Number(body.allocatedDollars);
      result = await markAllocated(eventId, {
        ...base,
        allocatedDollars: Number.isFinite(raw) && raw > 0 ? raw : undefined,
        tradeIds: Array.isArray(body.tradeIds) ? (body.tradeIds as string[]) : undefined,
        note,
      });
    } else if (action === 'ignored') {
      result = await markIgnored(eventId, { ...base, note });
    } else {
      result = await markOpen(eventId, base);
    }

    return NextResponse.json({ status: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[contributions/status] POST failed:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Default: the first of the current month. Deposits from this month stay
  // open so you can review them; anything older is closed as pre-feature.
  const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
  const before = new URL(req.url).searchParams.get('before') ?? firstOfMonth;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    return NextResponse.json({ error: 'before must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const seeded = await seedHistoricalAsIgnored(before);
    return NextResponse.json({ seeded, before });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[contributions/status] PUT failed:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
