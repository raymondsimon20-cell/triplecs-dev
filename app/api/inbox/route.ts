/**
 * Trade Inbox API.
 *
 *   GET    /api/inbox?status=pending&source=rebalance  → list staged items
 *   POST   /api/inbox                                  → manually stage items
 *   PATCH  /api/inbox  body: { id, status }            → update item status
 *   DELETE /api/inbox  body: { id } | { all: true }    → dismiss one or all pending
 *
 * Most staging happens server-side from the rebalance-plan and option-plan
 * endpoints; the POST here exists for ad-hoc additions and tests.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  appendInbox,
  dismissAllPending,
  dismissItem,
  listInbox,
  markExecuted,
  type AppendInput,
  type InboxSource,
  type InboxStatus,
} from '@/lib/inbox';

export const dynamic = 'force-dynamic';

const VALID_STATUSES: InboxStatus[] = ['pending', 'executed', 'dismissed', 'expired'];
const VALID_SOURCES:  InboxSource[] = ['rebalance', 'option', 'ai-rec'];

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get('status');
  const sourceParam = searchParams.get('source');

  const filter: { status?: InboxStatus | InboxStatus[]; source?: InboxSource } = {};
  if (statusParam) {
    const statuses = statusParam.split(',').filter((s): s is InboxStatus =>
      VALID_STATUSES.includes(s as InboxStatus),
    );
    if (statuses.length > 0) filter.status = statuses;
  }
  if (sourceParam && VALID_SOURCES.includes(sourceParam as InboxSource)) {
    filter.source = sourceParam as InboxSource;
  }

  const items = await listInbox(filter);
  const counts = {
    pending:   items.filter((it) => it.status === 'pending').length,
    blocked:   items.filter((it) => it.status === 'pending' && it.blocked).length,
    executed:  items.filter((it) => it.status === 'executed').length,
    dismissed: items.filter((it) => it.status === 'dismissed').length,
    expired:   items.filter((it) => it.status === 'expired').length,
  };
  return NextResponse.json({ items, counts });
}

// ─── POST ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  let body: { items?: AppendInput[] };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const inputs = Array.isArray(body.items) ? body.items : [];
  if (inputs.length === 0) {
    return NextResponse.json({ error: 'No items provided' }, { status: 400 });
  }

  const staged = await appendInbox(inputs);
  return NextResponse.json({ staged, count: staged.length });
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

export async function PATCH(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  let body: { id?: string; status?: InboxStatus; orderId?: string | null; message?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { id, status } = body;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  let updated;
  if (status === 'executed') {
    updated = await markExecuted(id, { orderId: body.orderId ?? null, message: body.message });
  } else if (status === 'dismissed') {
    updated = await dismissItem(id);
  } else {
    return NextResponse.json({ error: 'Only `executed` and `dismissed` are settable via PATCH' }, { status: 400 });
  }

  if (!updated) return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  return NextResponse.json({ item: updated });
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  let body: { id?: string; all?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  if (body.all === true) {
    const dismissed = await dismissAllPending();
    return NextResponse.json({ dismissed });
  }

  if (!body.id) return NextResponse.json({ error: 'Missing id or all flag' }, { status: 400 });
  const updated = await dismissItem(body.id);
  if (!updated) return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  return NextResponse.json({ item: updated });
}
