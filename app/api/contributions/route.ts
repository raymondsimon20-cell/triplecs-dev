/**
 * /api/contributions — manually recorded cash flows.
 *
 * Deposits and withdrawals that never surface in the Schwab transaction feed
 * (outside transfers, cash moved between institutions, corrections) still belong
 * in the equity bridge — otherwise they land in "Market & Other" and make the
 * month look like it gained or lost money it never made.
 *
 * GET    → all manual events (optionally scoped by accountHash)
 * POST   → record one   { date, amount, direction?, kind?, description?, accountHash? }
 * DELETE → remove one   ?id=...
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  getCashFlows, addManualCashFlow, deleteManualCashFlow, type CashFlowEvent,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

const VALID_KINDS = new Set(['deposit', 'withdrawal', 'journal', 'other']);

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accountHash = new URL(req.url).searchParams.get('accountHash') ?? undefined;
  const all = await getCashFlows(accountHash);
  return NextResponse.json({ contributions: all.filter((e) => e.source === 'manual') });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const date = typeof body.date === 'string' ? body.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }

  const rawAmount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
  if (!Number.isFinite(rawAmount) || rawAmount === 0) {
    return NextResponse.json({ error: 'amount must be a non-zero number' }, { status: 400 });
  }
  // Amount is stored positive; direction carries the sign. Accept a negative
  // amount as shorthand for a withdrawal so the caller can be sloppy.
  const amount = Math.abs(rawAmount);
  const direction: 'in' | 'out' =
    body.direction === 'out' || body.direction === 'in'
      ? body.direction
      : rawAmount < 0 ? 'out' : 'in';

  const kindRaw = typeof body.kind === 'string' ? body.kind : '';
  const kind = (VALID_KINDS.has(kindRaw) ? kindRaw : direction === 'in' ? 'deposit' : 'withdrawal') as CashFlowEvent['kind'];

  const description = typeof body.description === 'string' && body.description.trim()
    ? body.description.trim().slice(0, 200)
    : direction === 'in' ? 'Manual contribution' : 'Manual withdrawal';

  const event: CashFlowEvent = {
    // Random suffix keeps two identical same-day entries distinct.
    id: `manual-${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    direction,
    amount,
    kind,
    description,
    source: 'manual',
    ...(typeof body.accountHash === 'string' && body.accountHash
      ? { accountHash: body.accountHash }
      : {}),
  };

  await addManualCashFlow(event);
  return NextResponse.json({ ok: true, contribution: event });
}

export async function DELETE(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const removed = await deleteManualCashFlow(id);
  if (!removed) {
    return NextResponse.json({ error: 'Not found, or not a manual entry' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
