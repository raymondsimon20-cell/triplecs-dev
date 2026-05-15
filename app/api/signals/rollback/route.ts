/**
 * POST /api/signals/rollback
 *
 * Reverses a recent autopilot trade by placing the inverse order:
 *   - BUY  → SELL  the same ticker and quantity
 *   - SELL → BUY   the same ticker and quantity
 *
 * Hard constraints:
 *   - Only works on entries from the last 24 hours. Older trades have been
 *     digested by your portfolio; reversing them after that point is just
 *     trading, not rollback.
 *   - Only works on entries written by the signal-engine autopilot path
 *     (aiMode='signal_engine_auto'). Manual trades aren't autopilot's
 *     responsibility — use the regular order interface to reverse those.
 *   - Each entry can only be rolled back once. A `rolledBackBy` reference is
 *     written into the original entry so a second rollback request returns
 *     a clear error.
 *
 * Body: { id: string }   (the trade-history entry id to reverse)
 *
 * Returns:
 *   { success: true, orderId, message }                  on placed
 *   { success: false, reason }                           on rejection
 *
 * GET /api/signals/rollback                              lists recently-rolled
 *                                                        items + reversible
 *                                                        autopilot trades in
 *                                                        the 24h window.
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getAccountNumbers } from '@/lib/schwab/client';
import { placeOrders } from '@/lib/schwab/orders';
import type { TradeHistoryEntry } from '@/app/api/orders/route';

export const dynamic = 'force-dynamic';

const ROLLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

type ExtendedEntry = TradeHistoryEntry & {
  /** When this entry has been reversed by a later trade, points at the reversal's id. */
  rolledBackBy?: string;
  /** When this entry IS a rollback, points at the original. */
  rollbackOf?:   string;
};

async function loadTradeHistory(): Promise<ExtendedEntry[]> {
  try {
    const data = await getStore('trade-history').get('log', { type: 'json' });
    return Array.isArray(data) ? (data as ExtendedEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeTradeHistory(log: ExtendedEntry[]): Promise<void> {
  await getStore('trade-history').setJSON('log', log.slice(0, 500));
}

// ─── GET — list reversible items + recently rolled back ───────────────────────

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const log    = await loadTradeHistory();
  const cutoff = Date.now() - ROLLBACK_WINDOW_MS;

  const reversible: ExtendedEntry[] = [];
  const rolledBack: ExtendedEntry[] = [];

  for (const e of log) {
    if (e.aiMode !== 'signal_engine_auto') continue;
    if (e.status !== 'placed')             continue;
    if (e.rollbackOf)                       continue; // skip rollback entries themselves
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t < cutoff)  continue;
    if (e.rolledBackBy)                     rolledBack.push(e);
    else                                    reversible.push(e);
  }

  return NextResponse.json({
    windowHours: ROLLBACK_WINDOW_MS / (60 * 60 * 1000),
    reversible,
    rolledBack,
  });
}

// ─── POST — execute a rollback ────────────────────────────────────────────────

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { id?: string } = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = body.id?.trim();
  if (!id) return NextResponse.json({ error: 'Missing entry id' }, { status: 400 });

  const log = await loadTradeHistory();
  const idx = log.findIndex((e) => e.id === id);
  if (idx === -1)
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });

  const entry = log[idx];

  // ─── Validation ────────────────────────────────────────────────────────────
  if (entry.aiMode !== 'signal_engine_auto') {
    return NextResponse.json({
      error: 'Rollback only supports autopilot trades. Use the regular order interface to reverse manual trades.',
    }, { status: 400 });
  }
  if (entry.status !== 'placed') {
    return NextResponse.json({
      error: `Cannot reverse an entry with status '${entry.status}'.`,
    }, { status: 400 });
  }
  if (entry.rolledBackBy) {
    return NextResponse.json({
      error: `Entry already rolled back by ${entry.rolledBackBy}.`,
    }, { status: 409 });
  }
  if (entry.rollbackOf) {
    return NextResponse.json({
      error: 'This entry IS a rollback. Rolling back a rollback is not supported — place a manual order if you want to undo.',
    }, { status: 400 });
  }
  if (entry.instruction !== 'BUY' && entry.instruction !== 'SELL') {
    return NextResponse.json({
      error: `Only equity BUY/SELL trades are rollback-eligible (got ${entry.instruction}).`,
    }, { status: 400 });
  }
  const tradeTime = Date.parse(entry.timestamp);
  const ageMs = Date.now() - tradeTime;
  if (!Number.isFinite(tradeTime) || ageMs > ROLLBACK_WINDOW_MS) {
    return NextResponse.json({
      error: `Trade is outside the ${ROLLBACK_WINDOW_MS / (60 * 60 * 1000)}h rollback window (age: ${Math.round(ageMs / (60 * 60 * 1000))}h).`,
    }, { status: 400 });
  }

  // ─── Place the inverse order ──────────────────────────────────────────────
  const tokens = await getTokens();
  if (!tokens)
    return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });

  const accountNums = await getAccountNumbers(tokens);
  const accountHash = accountNums[0]?.hashValue;
  if (!accountHash)
    return NextResponse.json({ error: 'No Schwab account' }, { status: 500 });

  const inverse: 'BUY' | 'SELL' = entry.instruction === 'BUY' ? 'SELL' : 'BUY';
  const [result] = await placeOrders(tokens, accountHash, [{
    symbol:      entry.symbol,
    instruction: inverse,
    quantity:    entry.quantity,
    orderType:   'MARKET',
  }]);

  if (result.status !== 'placed') {
    return NextResponse.json({
      success: false,
      reason:  result.message ?? 'Schwab rejected the rollback order',
    }, { status: 502 });
  }

  // ─── Write rollback record + tag original ─────────────────────────────────
  const rollbackId = `${Date.now()}-rb-${entry.id}`;
  const rollbackEntry: ExtendedEntry = {
    id:          rollbackId,
    timestamp:   new Date().toISOString(),
    symbol:      entry.symbol,
    instruction: inverse,
    quantity:    entry.quantity,
    orderType:   'MARKET',
    price:       entry.price,
    orderId:     result.orderId,
    status:      result.status,
    message:     result.message,
    rationale:   `Rollback of ${entry.id} (${entry.instruction} ${entry.symbol} placed ${entry.timestamp})`,
    aiMode:      'signal_engine_rollback',
    rollbackOf:  entry.id,
  };

  log[idx] = { ...entry, rolledBackBy: rollbackId };
  await writeTradeHistory([rollbackEntry, ...log]);

  return NextResponse.json({
    success:   true,
    orderId:   result.orderId,
    message:   result.message,
    rollbackId,
    inverse,
    quantity:  entry.quantity,
    symbol:    entry.symbol,
  });
}
