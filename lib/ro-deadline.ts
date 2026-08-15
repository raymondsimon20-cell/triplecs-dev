/**
 * Rights-offering deadline logic — pure functions, no I/O.
 *
 * A rights offering is the sharper cousin of an unallocated contribution.
 * Both are "you need to act on this", but an RO has a hard expiry: miss the
 * subscription deadline and the rights lapse, and every stockholder who did
 * subscribe buys below NAV at your expense. There is no catching up later.
 *
 * Two things the original tracker couldn't express, both fixed here:
 *
 *  1. **No dates.** ROStatus was { ticker, status, notes, updatedAt }. The
 *     stage could say `subscription_open` without recording until when, so
 *     nothing could count down or escalate.
 *
 *  2. **No decision.** Advancing the stage recorded what the *fund* was doing,
 *     never what *you* had done about it. An offering you'd consciously skipped
 *     looked identical to one you hadn't noticed — so the tracker couldn't
 *     safely nag, and a silent tracker is the failure mode that loses money.
 *
 * On why deadlines are hand-entered: the EDGAR watcher detects that an N-2 was
 * filed, which is a reliable signal that an offering exists. Extracting the
 * expiration date from the prospectus text is not reliable, and a *wrong*
 * deadline is worse than none — it would count down confidently to the wrong
 * day. So detection is automatic, dates are confirmed by a human, and the UI
 * says plainly when a deadline is still missing.
 */

export type ROStage =
  | 'none'
  | 'announced'
  | 'subscription_open'
  | 'subscription_closed'
  | 'complete';

/** What *you* decided, as opposed to what stage the offering is at. */
export type RODecision = 'pending' | 'subscribed' | 'declined';

export interface ROStatus {
  ticker: string;
  status: ROStage;
  notes: string;
  updatedAt: string;
  /** Date you must own shares by to receive rights (YYYY-MM-DD). */
  recordDate?: string;
  /** Subscription period start (YYYY-MM-DD). */
  opensAt?: string;
  /** Subscription deadline (YYYY-MM-DD). The one that actually costs money. */
  expiresAt?: string;
  /** Rights needed per new share, e.g. 3 for a 1-for-3 offering. */
  rightsPerShare?: number;
  /** Your decision on this offering. Defaults to pending once announced. */
  decision?: RODecision;
  decidedAt?: string;
}

/** Days from `today` until `date`. Negative once past. */
export function daysUntil(date: string, today = new Date()): number {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return Number.NaN;
  const base = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((t - base) / 86_400_000);
}

export type ROUrgency = 'none' | 'info' | 'warn' | 'critical' | 'missed';

export interface ROAssessment {
  /** Is this offering live and undecided — i.e. does it need you? */
  needsAction: boolean;
  urgency: ROUrgency;
  daysLeft: number | null;
  /** Announced/open but no expiry recorded — can't count down. */
  missingDeadline: boolean;
  headline: string;
  detail: string;
}

/** Stages where the offering is live enough that a decision matters. */
const LIVE_STAGES = new Set<ROStage>(['announced', 'subscription_open']);

/**
 * Assess one offering.
 *
 * Escalation is by days remaining rather than by stage, because the stage is
 * hand-advanced and can sit stale — an offering left on `announced` while the
 * window quietly closes is exactly the case that must still scream.
 */
export function assessRO(ro: ROStatus, today = new Date()): ROAssessment {
  const decision = ro.decision ?? 'pending';

  // Decided, or not live — nothing to chase.
  if (!LIVE_STAGES.has(ro.status) || decision !== 'pending') {
    return {
      needsAction: false, urgency: 'none', daysLeft: null, missingDeadline: false,
      headline: '', detail: '',
    };
  }

  if (!ro.expiresAt) {
    return {
      needsAction: true,
      urgency: 'warn',
      daysLeft: null,
      missingDeadline: true,
      headline: `${ro.ticker} rights offering — deadline not recorded`,
      detail: 'An offering was detected but no subscription deadline is set. Add it so this can count down.',
    };
  }

  const daysLeft = daysUntil(ro.expiresAt, today);

  if (daysLeft < 0) {
    return {
      needsAction: true,
      urgency: 'missed',
      daysLeft,
      missingDeadline: false,
      headline: `${ro.ticker} rights offering expired ${Math.abs(daysLeft)}d ago`,
      detail: 'The subscription window closed with no decision recorded. Mark it subscribed or declined to clear.',
    };
  }

  const urgency: ROUrgency = daysLeft <= 3 ? 'critical' : daysLeft <= 10 ? 'warn' : 'info';
  return {
    needsAction: true,
    urgency,
    daysLeft,
    missingDeadline: false,
    headline: daysLeft === 0
      ? `${ro.ticker} rights offering expires today`
      : `${ro.ticker} rights offering — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`,
    detail: `Subscription closes ${ro.expiresAt}. Decide whether to subscribe.`,
  };
}

/** The offering most in need of attention, or null when none are. */
export function mostUrgent(statuses: ROStatus[], today = new Date()): {
  ro: ROStatus; assessment: ROAssessment;
} | null {
  const RANK: Record<ROUrgency, number> = {
    missed: 0, critical: 1, warn: 2, info: 3, none: 4,
  };
  const live = statuses
    .map((ro) => ({ ro, assessment: assessRO(ro, today) }))
    .filter((x) => x.assessment.needsAction)
    .sort((a, b) =>
      RANK[a.assessment.urgency] - RANK[b.assessment.urgency] ||
      (a.assessment.daysLeft ?? 999) - (b.assessment.daysLeft ?? 999));
  return live[0] ?? null;
}
