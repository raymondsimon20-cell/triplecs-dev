/**
 * Cash-flow-oriented Schwab transactions fetcher.
 *
 * The existing `app/api/dividends/route.ts` extracts dividend/interest only
 * for the income hub. This module extracts *all* cash movements that affect
 * TWR — deposits, withdrawals, journals, dividend cash, margin interest, fees.
 *
 * Unlike the dividends route, we deliberately filter to the broad "RECEIVE_AND_DELIVER",
 * "TRADE", and "JOURNAL" buckets and let the classifier decide what counts as
 * a cash flow. Trades themselves don't appear as cash flows (they shift value
 * between cash and securities — net zero for portfolio value).
 */

import { createClient, getAccountNumbers } from './client';
import { getTokens } from '../storage';
import type { CashFlowEvent } from '../storage';
import type { SchwabTransaction } from './types';

/**
 * Schwab transaction type strings the API exposes. Not exhaustive — these
 * are the ones we currently classify.
 */
const CASH_FLOW_TYPES = [
  'DIVIDEND_OR_INTEREST',
  'RECEIVE_AND_DELIVER',
  'JOURNAL',
  'ELECTRONIC_FUND',
  'WIRE_IN',
  'WIRE_OUT',
  'CASH_RECEIPT',
  'CASH_DISBURSEMENT',
  'MARGIN_CALL',
  'MONEY_MARKET',
] as const;

interface ClassifiedFlow {
  direction: 'in' | 'out';
  kind: CashFlowEvent['kind'];
  amount: number;             // positive
}

/**
 * Decide whether a Schwab transaction represents a cash flow that should
 * affect TWR, and how to classify it. Returns `null` for trades and other
 * non-flow events.
 */
function classifyTransaction(t: SchwabTransaction): ClassifiedFlow | null {
  const txType = (t.type ?? t.activityType ?? t.transactionType ?? '').toUpperCase();
  const desc   = (t.description ?? t.transactionDescription ?? '').toLowerCase();

  // Settlement of a security trade — NOT a cash flow.
  if (txType === 'TRADE') return null;

  const rawAmount = t.netAmount ?? t.amount ?? t.totalAmount ?? 0;
  if (!rawAmount) return null;

  const amount    = Math.abs(rawAmount);
  const direction: 'in' | 'out' = rawAmount > 0 ? 'in' : 'out';

  // Deposits / withdrawals: ACH, wires, journals between accounts.
  if (
    txType === 'ELECTRONIC_FUND' ||
    txType === 'WIRE_IN' || txType === 'WIRE_OUT' ||
    txType === 'CASH_RECEIPT' || txType === 'CASH_DISBURSEMENT' ||
    txType === 'JOURNAL' ||
    /deposit|withdraw|ach|wire|transfer/.test(desc)
  ) {
    if (direction === 'in')  return { direction, kind: 'deposit', amount };
    return { direction, kind: 'withdrawal', amount };
  }

  // Margin interest charged to the account.
  if (/margin interest|interest charge/.test(desc)) {
    return { direction: 'out', kind: 'interest', amount };
  }

  // Fees & commissions surfacing as separate transactions (rare — usually netted).
  if (/fee|commission|sec fee|finra/.test(desc)) {
    return { direction: 'out', kind: 'fee', amount };
  }

  // Cash dividends and credit interest land here.
  if (txType === 'DIVIDEND_OR_INTEREST') {
    return { direction, kind: /interest/.test(desc) ? 'interest' : 'dividend', amount };
  }

  // RECEIVE_AND_DELIVER with non-zero netAmount can be DRIP cash legs;
  // treat as dividend-class cash flow.
  if (txType === 'RECEIVE_AND_DELIVER' && /dividend|distribution|reinvest/.test(desc)) {
    return { direction, kind: 'dividend', amount };
  }

  return null;
}

/**
 * Normalise a Schwab transaction date to YYYY-MM-DD.
 */
function normalizeDate(t: SchwabTransaction): string {
  const raw = t.time ?? t.transactionDate ?? t.tradeDate ?? t.settlementDate ?? '';
  return raw.split('T')[0] || new Date().toISOString().slice(0, 10);
}

/**
 * Fetch all cash-flow events across every linked account in [start, end].
 * `start` and `end` must be ISO datetimes (Schwab rejects bare dates).
 *
 * Returns deduplicated `CashFlowEvent[]` ready to pass to `appendCashFlows()`.
 */
export async function fetchCashFlows(start: string, end: string): Promise<CashFlowEvent[]> {
  const tokens = await getTokens();
  if (!tokens) throw new Error('NOT_AUTHENTICATED');

  const accounts = await getAccountNumbers(tokens);
  if (accounts.length === 0) return [];

  const client = await createClient();
  const seen   = new Set<string>();
  const events: CashFlowEvent[] = [];

  for (const { hashValue } of accounts) {
    const txnsByType = await Promise.all(
      CASH_FLOW_TYPES.map((type) =>
        client.getTransactions(hashValue, start, end, type).catch((err) => {
          console.warn(`[fetchCashFlows] ${type} fetch failed for ${hashValue.slice(0, 6)}…:`, err);
          return [] as SchwabTransaction[];
        }),
      ),
    );

    for (const txns of txnsByType) {
      for (const t of txns) {
        const classified = classifyTransaction(t);
        if (!classified) continue;

        const activityId = t.activityId !== undefined ? String(t.activityId) : undefined;
        const date = normalizeDate(t);
        const id = activityId ?? `${date}-${classified.kind}-${classified.amount}-${classified.direction}`;
        if (seen.has(id)) continue;
        seen.add(id);

        events.push({
          id,
          date,
          direction: classified.direction,
          amount: classified.amount,
          kind: classified.kind,
          description: t.description ?? t.transactionDescription,
          source: 'schwab',
          activityId,
        });
      }
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}
