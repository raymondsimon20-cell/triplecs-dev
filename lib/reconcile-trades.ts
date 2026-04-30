/**
 * Reconcile Schwab fills into trade-history.
 *
 * The app records a trade-history entry only when an order is placed via
 * /api/orders. Fills executed directly in Schwab (or staged in the inbox
 * but executed outside the app) never land in trade-history, so the AI
 * Performance Review can't see them.
 *
 * This module pulls recent TRADE transactions from Schwab, parses each
 * fill, dedupes against the existing trade-history blob, tries to match
 * each fill to a still-pending inbox item to recover the AI mode + rationale,
 * and appends the result. Trades that can't be matched are stored with
 * aiMode='unknown' so they at least show up in the recap totals.
 */

import { getStore } from '@netlify/blobs';
import { createClient, getAccountNumbers } from './schwab/client';
import { getTokens } from './storage';
import { listInbox, markExecuted } from './inbox';
import type { SchwabTransaction } from './schwab/types';
import type { InboxItem } from './inbox';
import type { TradeHistoryEntry } from '@/app/api/orders/route';

const DEFAULT_LOOKBACK_DAYS = 14;
const INBOX_MATCH_WINDOW_MS = 7 * 86_400_000;
const HISTORY_CAP = 500;

interface ParsedFill {
  activityId:  string;
  timestamp:   string;             // ISO
  symbol:      string;
  instruction: TradeHistoryEntry['instruction'];
  quantity:    number;
  price:       number;
  isOption:    boolean;
}

interface ReconcileResult {
  scanned:    number;
  added:      number;          // new schwab-prefixed entries
  backfilled: number;          // existing entries that gained a fill price
  matched:    number;          // new entries back-filled with inbox aiMode
  unmatched:  number;          // new entries recorded as aiMode='unknown'
  skipped:    number;          // schwab activityId already present
}

/**
 * Schwab TRADE transactions split the trade across multiple `transferItems`:
 * the asset leg (EQUITY or OPTION) and one or more cash legs. The asset leg
 * carries the symbol, signed quantity (positive = received = BUY), and the
 * fill price. Cash legs are ignored here — fees/commissions are netted into
 * netAmount and don't affect mode classification.
 */
function parseTrade(t: SchwabTransaction): ParsedFill | null {
  if (!t.activityId || !t.time) return null;
  const txType = (t.type ?? t.activityType ?? t.transactionType ?? '').toUpperCase();
  if (txType !== 'TRADE') return null;

  const items = t.transferItems ?? t.transactionItems ?? [];
  type ItemLike = (typeof items)[number] & {
    asset?: { symbol?: string; assetType?: string };
  };
  const assetLeg = (items as ItemLike[]).find((it) => {
    const at = (it.instrument?.assetType ?? it.asset?.assetType ?? '').toUpperCase();
    return at === 'EQUITY' || at === 'OPTION' || at === 'COLLECTIVE_INVESTMENT';
  });
  if (!assetLeg) return null;

  const symbol = assetLeg.instrument?.symbol ?? assetLeg.asset?.symbol;
  if (!symbol) return null;

  const rawAmount = assetLeg.amount ?? 0;
  const price     = assetLeg.price ?? 0;
  if (!rawAmount || !price || price <= 0) return null;

  const quantity = Math.abs(rawAmount);
  const isBuy    = rawAmount > 0;
  const isOption = (assetLeg.instrument?.assetType ?? assetLeg.asset?.assetType ?? '').toUpperCase() === 'OPTION';

  // For options, we can't distinguish open vs close from the transaction
  // alone — that requires reconciling against the prior position. Default
  // to OPEN; the recap's win/loss logic doesn't depend on this distinction.
  const instruction: TradeHistoryEntry['instruction'] = isOption
    ? (isBuy ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN')
    : (isBuy ? 'BUY' : 'SELL');

  return {
    activityId: String(t.activityId),
    timestamp:  t.time,
    symbol,
    instruction,
    quantity,
    price,
    isOption,
  };
}

function isBuySide(instruction: string): boolean {
  return instruction.startsWith('BUY');
}

/**
 * Find a still-actionable inbox item that plausibly produced this fill.
 * Match key: symbol + direction (buy/sell) + quantity, with the fill timestamp
 * landing in [createdAt, createdAt + 7d]. We don't match against `dismissed`
 * items (user said no — coincidental fill is just an unknown-mode trade).
 */
function matchInbox(parsed: ParsedFill, inbox: InboxItem[]): InboxItem | null {
  const fillMs = new Date(parsed.timestamp).getTime();
  if (!Number.isFinite(fillMs)) return null;
  const parsedIsBuy = isBuySide(parsed.instruction);

  // Prefer the most recent matching pending item; fall back to executed
  // (in case the inbox item was already manually marked executed but never
  // hit our /api/orders flow).
  const candidates = inbox
    .filter((it) => it.status === 'pending' || it.status === 'executed')
    .filter((it) => it.symbol === parsed.symbol)
    .filter((it) => it.quantity === parsed.quantity)
    .filter((it) => isBuySide(it.instruction) === parsedIsBuy)
    .filter((it) => fillMs >= it.createdAt && fillMs <= it.createdAt + INBOX_MATCH_WINDOW_MS);

  if (parsed.isOption) {
    // For options, also require occSymbol to match if the inbox item carries one.
    const tighter = candidates.filter((it) => !it.occSymbol || it.occSymbol === parsed.symbol);
    if (tighter.length > 0) candidates.length = 0, candidates.push(...tighter);
  }
  if (candidates.length === 0) return null;
  // Closest in time wins.
  candidates.sort((a, b) => Math.abs(fillMs - a.createdAt) - Math.abs(fillMs - b.createdAt));
  return candidates[0];
}

/**
 * Find an existing /api/orders trade-history entry that plausibly produced
 * this Schwab fill — match by symbol + direction + quantity, with the entry's
 * placed timestamp within ±24h of the Schwab fill time. Used both to dedupe
 * (don't re-add a fill the user already recorded) and to backfill a price
 * onto entries that came in without one (MARKET orders).
 *
 * Returns the index into `history`, or -1 if no match. Closest-in-time wins.
 * Skips schwab-prefixed entries (those are handled by activityId dedupe).
 */
function matchExistingEntry(parsed: ParsedFill, history: TradeHistoryEntry[]): number {
  const fillMs = new Date(parsed.timestamp).getTime();
  if (!Number.isFinite(fillMs)) return -1;
  const parsedIsBuy = isBuySide(parsed.instruction);
  const TOLERANCE_MS = 86_400_000;

  let bestIdx = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    if (e.id.startsWith('schwab-')) continue;
    if (e.status !== 'placed') continue;
    if (e.symbol !== parsed.symbol) continue;
    if (e.quantity !== parsed.quantity) continue;
    if (isBuySide(e.instruction) !== parsedIsBuy) continue;
    const eMs = new Date(e.timestamp).getTime();
    if (!Number.isFinite(eMs)) continue;
    const delta = Math.abs(fillMs - eMs);
    if (delta > TOLERANCE_MS) continue;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function loadTradeHistory(): Promise<TradeHistoryEntry[]> {
  const data = await getStore('trade-history').get('log', { type: 'json' });
  return Array.isArray(data) ? (data as TradeHistoryEntry[]) : [];
}

async function saveTradeHistory(entries: TradeHistoryEntry[]): Promise<void> {
  // Keep newest-first by timestamp, cap at HISTORY_CAP.
  const sorted = [...entries].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  await getStore('trade-history').setJSON('log', sorted.slice(0, HISTORY_CAP));
}

export async function reconcileSchwabTrades(opts?: { lookbackDays?: number; now?: number }): Promise<ReconcileResult> {
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const now          = opts?.now          ?? Date.now();
  const start = new Date(now - lookbackDays * 86_400_000).toISOString();
  const end   = new Date(now).toISOString();

  const result: ReconcileResult = { scanned: 0, added: 0, backfilled: 0, matched: 0, unmatched: 0, skipped: 0 };

  const tokens = await getTokens();
  if (!tokens) {
    console.warn('[reconcile-trades] no Schwab tokens — skipping');
    return result;
  }

  const accounts = await getAccountNumbers(tokens);
  if (accounts.length === 0) return result;

  const client = await createClient();
  const [history, inbox] = await Promise.all([loadTradeHistory(), listInbox()]);

  // Existing schwab-sourced entries are keyed by activityId — dedupe set.
  const existingActivityIds = new Set(
    history.filter((e) => e.id.startsWith('schwab-')).map((e) => e.id.slice('schwab-'.length)),
  );

  // Mutable working copy so we can backfill prices on existing entries
  // in place without producing duplicates.
  const updatedHistory: TradeHistoryEntry[] = [...history];
  const additions: TradeHistoryEntry[] = [];
  const inboxItemsToMark: { id: string; orderId: string | null; message: string }[] = [];

  for (const { hashValue } of accounts) {
    let txns: SchwabTransaction[];
    try {
      txns = await client.getTransactions(hashValue, start, end, 'TRADE');
    } catch (err) {
      console.warn(`[reconcile-trades] TRADE fetch failed for ${hashValue.slice(0, 6)}…:`, err);
      continue;
    }

    for (const t of txns) {
      const parsed = parseTrade(t);
      if (!parsed) continue;
      result.scanned++;

      if (existingActivityIds.has(parsed.activityId)) {
        result.skipped++;
        continue;
      }

      // First: see if an existing /api/orders entry matches this fill. If so,
      // backfill its price (when missing) and treat the Schwab activity as
      // accounted-for — don't add a duplicate schwab-prefixed entry.
      const existingIdx = matchExistingEntry(parsed, updatedHistory);
      if (existingIdx >= 0) {
        const existing = updatedHistory[existingIdx];
        const needsPrice = !existing.price || existing.price <= 0;
        if (needsPrice) {
          const note = `[price backfilled from Schwab activity ${parsed.activityId}]`;
          updatedHistory[existingIdx] = {
            ...existing,
            price: parsed.price,
            message: existing.message ? `${existing.message} ${note}` : note,
          };
          result.backfilled++;
        }
        continue;
      }

      // No existing match — record the Schwab fill as a new entry, attributing
      // it to a still-pending inbox item if one matches.
      const inboxMatch = matchInbox(parsed, inbox);
      const aiMode    = inboxMatch?.aiMode ?? 'unknown';
      const rationale = inboxMatch?.rationale;

      additions.push({
        id:          `schwab-${parsed.activityId}`,
        timestamp:   parsed.timestamp,
        symbol:      parsed.symbol,
        instruction: parsed.instruction,
        quantity:    parsed.quantity,
        orderType:   'MARKET',
        price:       parsed.price,
        orderId:     null,
        status:      'placed',
        message:     'Reconciled from Schwab',
        rationale,
        aiMode,
      });

      if (inboxMatch) {
        result.matched++;
        if (inboxMatch.status === 'pending') {
          inboxItemsToMark.push({
            id: inboxMatch.id,
            orderId: null,
            message: `Reconciled from Schwab activity ${parsed.activityId}`,
          });
        }
      } else {
        result.unmatched++;
      }
    }
  }

  if (additions.length > 0 || result.backfilled > 0) {
    await saveTradeHistory([...additions, ...updatedHistory]);
    result.added = additions.length;
  }

  // Mark matched pending inbox items as executed so they don't re-match next run.
  for (const m of inboxItemsToMark) {
    try {
      await markExecuted(m.id, { orderId: m.orderId, message: m.message });
    } catch (err) {
      console.warn(`[reconcile-trades] failed to mark inbox ${m.id} executed:`, err);
    }
  }

  console.log(`[reconcile-trades] scanned=${result.scanned} added=${result.added} backfilled=${result.backfilled} matched=${result.matched} unmatched=${result.unmatched} skipped=${result.skipped}`);
  return result;
}
