/**
 * Contribution allocation tracking.
 *
 * The point of this module is that a contribution can't be quietly missed.
 * Every deposit is either allocated or it isn't, and the ones that aren't stay
 * visible until they are. That's a stronger guarantee than a notification,
 * which is a single moment in time — miss it and nothing remembers.
 *
 * Contributions themselves are NOT stored here. They're derived from the
 * existing cash-flow log (`getCashFlows`), so there's one source of truth for
 * "what money came in". This module stores only the *status* of each one,
 * keyed by `CashFlowEvent.id`, which means:
 *
 *   • a re-sync of cash flows never resets a status
 *   • the feature works retroactively — a deposit with no status record is
 *     `open` by definition, so history is covered without a migration
 *
 * `amount` and `date` are denormalized onto the status record even though they
 * duplicate the event. Event ids are Schwab's `activityId` where available and
 * a synthetic `hash-date-kind-amount-direction` string otherwise; if a
 * classifier is ever retuned, the synthetic form can change and orphan a
 * record. Keeping amount+date means an orphan can be re-matched rather than
 * silently lost — which would show up as a contribution reopening months later.
 */

import { getStore } from '@netlify/blobs';
import { getCashFlows, type CashFlowEvent } from '../storage';

const STORE = 'contribution-status';
const KEY   = 'log';

/** Deposits below this are noise (residual ACH, interest sweeps) — not tracked. */
export const MIN_TRACKED_AMOUNT = 250;

/**
 * Residual left after whole-share rounding that's too small to be worth
 * keeping an item open for.
 *
 * Set deliberately tight: at $10, anything that could still buy even a cheap
 * share keeps the contribution open. The tradeoff is more open items that need
 * an explicit "Done" — a $60 remainder stays on the list rather than closing
 * itself. That's the intended bias: leftover cash stays visible.
 *
 * SLATED FOR REMOVAL. The remainder-pool design (CONTRIBUTION_ALERT_PLAN.md
 * §3.6, locked) makes every residual flow into a shared pool, at which point a
 * contribution always closes when acted on and no close threshold is needed.
 * This constant becomes POOL_DISPLAY_FLOOR — the level below which the pool
 * row is hidden rather than nagging over $3. The pool ships with order
 * linkage, which is what produces partial allocations in the first place.
 *
 * Until then this threshold stands, because with nothing reporting partial
 * fills yet every allocation closes cleanly regardless.
 */
export const RESIDUAL_CLOSE_THRESHOLD = 10;

export type ContributionState = 'open' | 'allocated' | 'ignored';

export interface ContributionStatus {
  /** CashFlowEvent.id — the join key. */
  eventId: string;
  state: ContributionState;
  /** Denormalized for orphan recovery — see module header. */
  amount: number;
  date: string;
  accountHash?: string;
  allocatedAt?: number;
  /** TradeHistoryEntry ids placed against this contribution. */
  tradeIds?: string[];
  /** Dollars actually deployed. May be below `amount` after share rounding. */
  allocatedDollars?: number;
  /** Free text, e.g. "allocated manually at Schwab" or the internal-transfer reason. */
  note?: string;
  updatedAt: number;
}

/** A contribution joined to its status, as the UI consumes it. */
export interface TrackedContribution {
  eventId: string;
  date: string;
  amount: number;
  description?: string;
  accountHash?: string;
  state: ContributionState;
  allocatedDollars?: number;
  /** Amount still to deploy. 0 unless partially allocated. */
  remaining: number;
  tradeIds?: string[];
  note?: string;
  allocatedAt?: number;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export async function getStatuses(): Promise<ContributionStatus[]> {
  const data = await getStore(STORE).get(KEY, { type: 'json' });
  return Array.isArray(data) ? (data as ContributionStatus[]) : [];
}

async function putStatuses(rows: ContributionStatus[]): Promise<void> {
  await getStore(STORE).setJSON(KEY, rows);
}

/**
 * Insert or update one status row. Read-modify-write, matching the pattern the
 * rest of the codebase uses against Netlify Blobs — see the note on
 * `appendCashFlows` for why the blob-lock approach was backed out.
 */
export async function setStatus(
  next: Omit<ContributionStatus, 'updatedAt'>,
): Promise<ContributionStatus> {
  const rows = await getStatuses();
  const row: ContributionStatus = { ...next, updatedAt: Date.now() };
  const i = rows.findIndex((r) => r.eventId === next.eventId);
  if (i >= 0) rows[i] = { ...rows[i], ...row };
  else rows.push(row);
  await putStatuses(rows);
  return row;
}

// ─── Internal-transfer detection ─────────────────────────────────────────────

/**
 * Is this deposit actually money moving between two of your own accounts?
 *
 * `classifyTransaction` maps `txType === 'JOURNAL'` to `kind: 'deposit'`, which
 * is correct for TWR — that return is computed per account, and a journal in
 * IS external from the receiving account's perspective. It is wrong here:
 * moving $5k from the Roth to the taxable produces a deposit on one side and a
 * withdrawal on the other, and no new money arrived. Counting it would have
 * you "allocating" dollars that are already invested, on margin.
 *
 * Detection is a paired-leg match: same date, same amount, opposite direction,
 * different account. Requires both accounts to be linked — with a single
 * linked account the other leg is invisible, so nothing matches and the
 * deposit is treated as genuine. That's the right default (a false open item
 * is visible and dismissible; a false negative is money left unallocated).
 */
export function findInternalTransferPair(
  deposit: CashFlowEvent,
  all: CashFlowEvent[],
): CashFlowEvent | null {
  if (deposit.direction !== 'in') return null;
  return all.find((e) =>
    e.id !== deposit.id &&
    e.direction === 'out' &&
    e.date === deposit.date &&
    Math.abs(e.amount - deposit.amount) < 0.01 &&
    // Both legs must be account-tagged and on *different* accounts. Untagged
    // legacy events can't be proven internal, so they don't match.
    Boolean(e.accountHash) &&
    Boolean(deposit.accountHash) &&
    e.accountHash !== deposit.accountHash,
  ) ?? null;
}

// ─── Derivation ──────────────────────────────────────────────────────────────

/** Cash-flow events that count as incoming contributions worth tracking. */
export function isTrackableContribution(e: CashFlowEvent): boolean {
  return e.direction === 'in'
    && (e.kind === 'deposit' || e.kind === 'journal')
    && e.amount >= MIN_TRACKED_AMOUNT;
}

/**
 * Join contributions to their status.
 *
 * Events with no stored status default to `open`, except internal transfers,
 * which default to `ignored` with a note. Both defaults are overridable by an
 * explicit stored status — marking an "internal" row as open sticks.
 */
export async function listContributions(accountHash?: string): Promise<TrackedContribution[]> {
  const [flows, statuses] = await Promise.all([getCashFlows(), getStatuses()]);
  const byId = new Map(statuses.map((s) => [s.eventId, s]));

  const scoped = accountHash
    ? flows.filter((e) => !e.accountHash || e.accountHash === accountHash)
    : flows;

  return scoped
    .filter(isTrackableContribution)
    .map((e) => {
      const stored = byId.get(e.id);
      const pair = stored ? null : findInternalTransferPair(e, flows);

      const state: ContributionState = stored?.state
        ?? (pair ? 'ignored' : 'open');
      const note = stored?.note
        ?? (pair ? `Internal transfer — paired with an outgoing ${pair.date} on another account` : undefined);

      const allocatedDollars = stored?.allocatedDollars;
      const remaining = state === 'allocated' || allocatedDollars === undefined
        ? 0
        : Math.max(0, e.amount - allocatedDollars);

      return {
        eventId: e.id,
        date: e.date,
        amount: e.amount,
        description: e.description,
        accountHash: e.accountHash,
        state,
        allocatedDollars,
        remaining,
        tradeIds: stored?.tradeIds,
        note,
        allocatedAt: stored?.allocatedAt,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Count and dollar total of contributions still awaiting allocation. */
export async function openContributionSummary(accountHash?: string): Promise<{
  count: number;
  total: number;
  oldestDate: string | null;
}> {
  const open = (await listContributions(accountHash)).filter((c) => c.state === 'open');
  return {
    count: open.length,
    total: open.reduce((s, c) => s + (c.remaining || c.amount), 0),
    oldestDate: open.length ? open[open.length - 1].date : null,
  };
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/**
 * Record that a contribution was allocated.
 *
 * When `allocatedDollars` falls short of the contribution — whole-share
 * rounding always leaves something — the item stays `open` with the residual
 * shown, rather than closing over money still sitting in cash. Only a residual
 * under RESIDUAL_CLOSE_THRESHOLD closes automatically, so in practice most
 * partial allocations wait for an explicit "Done".
 */
export async function markAllocated(
  eventId: string,
  opts: {
    amount: number;
    date: string;
    accountHash?: string;
    allocatedDollars?: number;
    tradeIds?: string[];
    note?: string;
  },
): Promise<ContributionStatus> {
  const deployed = opts.allocatedDollars ?? opts.amount;
  const residual = opts.amount - deployed;
  const fullyDone = residual < RESIDUAL_CLOSE_THRESHOLD;

  return setStatus({
    eventId,
    state: fullyDone ? 'allocated' : 'open',
    amount: opts.amount,
    date: opts.date,
    accountHash: opts.accountHash,
    allocatedAt: fullyDone ? Date.now() : undefined,
    allocatedDollars: deployed,
    tradeIds: opts.tradeIds,
    note: opts.note,
  });
}

export async function markIgnored(
  eventId: string,
  opts: { amount: number; date: string; accountHash?: string; note?: string },
): Promise<ContributionStatus> {
  return setStatus({ eventId, state: 'ignored', ...opts });
}

/** Reopen a contribution that was marked in error. */
export async function markOpen(
  eventId: string,
  opts: { amount: number; date: string; accountHash?: string },
): Promise<ContributionStatus> {
  return setStatus({
    eventId, state: 'open', ...opts,
    allocatedAt: undefined, allocatedDollars: undefined, tradeIds: undefined, note: undefined,
  });
}

/**
 * One-time backfill: close everything already in the log.
 *
 * Without this, switching the feature on surfaces every historical deposit as
 * unallocated — months of backlog you already dealt with. A count that opens
 * at 40 is a count you dismiss, and then it never works again. Starting at
 * zero is what makes the number trustworthy.
 *
 * Returns how many rows were seeded. Idempotent: only writes events that have
 * no status yet, so a second run does nothing.
 */
export async function seedHistoricalAsIgnored(before: string): Promise<number> {
  const [flows, statuses] = await Promise.all([getCashFlows(), getStatuses()]);
  const known = new Set(statuses.map((s) => s.eventId));

  const stale = flows.filter((e) =>
    isTrackableContribution(e) && e.date < before && !known.has(e.id));
  if (stale.length === 0) return 0;

  const now = Date.now();
  const rows: ContributionStatus[] = stale.map((e) => ({
    eventId: e.id,
    state: 'ignored' as const,
    amount: e.amount,
    date: e.date,
    accountHash: e.accountHash,
    note: 'Predates contribution tracking',
    updatedAt: now,
  }));

  await putStatuses([...statuses, ...rows]);
  return rows.length;
}
