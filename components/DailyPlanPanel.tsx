'use client';

/**
 * Daily Plan Panel — shows the structured "what autopilot would do today"
 * view from /api/signals/daily-plan. Tier 1 actions (auto-eligible), tier 2
 * (require approval), tier 3 (alerts-only) are rendered in separate sections.
 *
 * Approval clicks PATCH the inbox item to executed/dismissed via the existing
 * /api/inbox endpoint. The actual broker call happens in the daily auto-execute
 * pass when mode=auto; this panel just lets you approve queued items.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  ShieldAlert,
  RefreshCw,
  CircuitBoard,
} from 'lucide-react';
import { useAccountNicknames } from '@/components/AccountSwitcher';
import { ruleName, ruleDescription, consequenceOf } from '@/lib/friendly';

type Tier      = 'auto' | 'approval' | 'alert';
type Direction = 'BUY' | 'SELL' | 'REBALANCE' | 'ALERT' | 'INFO';
type Priority  = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

interface PlannedAction {
  signalId:            string;
  inboxItemId?:        string;
  rule:                string;
  ticker:              string;
  direction:           Direction;
  sizeDollars:         number;
  priority:            Priority;
  reason:              string;
  tier:                Tier;
  requiresApproval:    boolean;
  status?:             'pending' | 'executed' | 'dismissed' | 'expired';
  blockedByGuardrails: boolean;
  /** Schwab account hash from the matching inbox item; falls back to the
   *  panel's `accountHash` prop on submit. */
  accountHash?:        string;
  /** Order params copied from the inbox item — needed for /api/orders. */
  quantity?:           number;
  orderType?:          'MARKET' | 'LIMIT';
  price?:              number;
}

interface DailyPlan {
  generatedAt:          string;
  totalValue:           number;
  marginUtilizationPct: number;
  /** AFW (Available For Withdrawal) — Schwab margin headroom in USD. */
  afwDollars?:          number;
  inDefenseMode:        boolean;
  killSwitchActive:     boolean;
  autoExecuteMode:      'manual' | 'dry-run' | 'auto';
  actions: { auto: PlannedAction[]; approval: PlannedAction[]; alert: PlannedAction[] };
  counts:  { auto: number; approval: number; alert: number; total: number };
}

function fmt$(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('en-US', {
    style:                'currency',
    currency:             'USD',
    maximumFractionDigits: 0,
  });
}

function priorityColor(p: Priority): string {
  switch (p) {
    case 'CRITICAL': return 'text-red-400 border-red-500/40 bg-red-500/10';
    case 'HIGH':     return 'text-orange-400 border-orange-500/40 bg-orange-500/10';
    case 'MEDIUM':   return 'text-amber-400 border-amber-500/40 bg-amber-500/10';
    default:         return 'text-[#7c82a0] border-[#3d4468] bg-[#1a1d27]';
  }
}

function ActionRow({
  action,
  accountChip,
  onApprove,
  onDismiss,
  busy,
  readOnly = false,
}: {
  action:    PlannedAction;
  /** Per-row account label + whether the action's accountHash was missing
   *  (fallback to the panel-selected account). Computed by the parent so we
   *  share the same resolver TradeInbox uses. */
  accountChip: { text: string; isFallback: boolean };
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  busy:      string | null;
  readOnly?: boolean;
}) {
  const isBusy = busy === action.signalId;
  // Now that bulk + per-row approve auto-stages on demand (see ensureStaged in
  // the parent), missing inboxItemId no longer disqualifies a row — only
  // status (already resolved) and guardrails do.
  const isUnstaged = !action.inboxItemId;
  const canAct =
    !readOnly &&
    action.requiresApproval &&
    (action.status === 'pending' || action.status === undefined) &&
    !action.blockedByGuardrails &&
    (action.direction === 'BUY' || action.direction === 'SELL');

  const chipStyle =
    action.direction === 'BUY'  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' :
    action.direction === 'SELL' ? 'bg-red-500/15 text-red-300 border-red-500/30' :
                                  'bg-amber-500/15 text-amber-300 border-amber-500/30';
  const chipLabel =
    action.direction === 'BUY' ? 'Buy' : action.direction === 'SELL' ? 'Sell' : 'Alert';
  const title =
    action.direction === 'BUY' || action.direction === 'SELL'
      ? action.sizeDollars > 0
        ? `${fmt$(action.sizeDollars)} of ${action.ticker}`
        : action.ticker
      : action.ticker;

  return (
    <div className="border border-[#2d3248] rounded-lg px-3.5 py-3 bg-[#1a1d27] hover:bg-[#1d2030] transition-colors">
      <div className="flex items-start gap-3">
        <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full border flex-shrink-0 mt-0.5 ${chipStyle}`}>
          {chipLabel}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white leading-snug">
            {title}
            <span className="font-normal text-[#4a5070] text-xs ml-2" title={ruleDescription(action.rule)}>· {ruleName(action.rule)}</span>
            {(action.priority === 'CRITICAL' || action.priority === 'HIGH') && (
              <span className={`text-[10px] font-normal px-1.5 py-0.5 rounded border ml-2 ${priorityColor(action.priority)}`}>
                {action.priority === 'CRITICAL' ? 'urgent' : 'high priority'}
              </span>
            )}
          </p>
          <p className="text-xs text-[#a0a4c0] leading-relaxed mt-1">{action.reason}</p>
          {canAct && (() => {
            const consequence = consequenceOf(action.rule, action.direction as 'BUY' | 'SELL' | 'ALERT');
            return consequence
              ? <p className="text-[11px] text-[#7c82a0] italic leading-relaxed mt-1">{consequence}</p>
              : null;
          })()}
          {(accountChip.text || action.blockedByGuardrails || (action.status && action.status !== 'pending')) && (
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {accountChip.text && (
                <span
                  className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
                    accountChip.isFallback
                      ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                      : 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                  }`}
                  title={
                    accountChip.isFallback
                      ? 'No account tagged on this signal — order will route to the currently selected account on approve.'
                      : 'Account this trade is suggested for'
                  }
                >
                  {accountChip.text}
                </span>
              )}
              {action.blockedByGuardrails && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30"
                  title="A safety check blocked this trade — it can't be approved.">
                  blocked by safety check
                </span>
              )}
              {action.status && action.status !== 'pending' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#0f1117] text-[#4a5070] border border-[#2d3248]">
                  {action.status}
                </span>
              )}
            </div>
          )}
        </div>
        {canAct && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => onApprove(action.signalId)}
              disabled={isBusy}
              className="text-xs px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-50 flex items-center gap-1"
              title={isUnstaged ? 'Stage in the inbox + submit to Schwab' : 'Submit this order to Schwab'}
            >
              {isBusy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
              Approve
            </button>
            <button
              onClick={() => onDismiss(action.signalId)}
              disabled={isBusy}
              className="text-xs px-2 py-1.5 rounded bg-white/[0.04] border border-[#3d4468] text-[#7c82a0] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
              title="Dismiss this proposal"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface AccountSummary {
  accountHash:   string;
  accountNumber: string;
}

/**
 * Per-symbol share count, scoped to an account. Used by ensureStaged to
 * enforce the keep-one-share rule on SELL signals before they're staged.
 */
interface PositionShareInfo {
  symbol:       string;
  shares:       number;
  accountHash?: string;
}

interface Props {
  /**
   * Selected account hash from the dashboard. Used as a fallback when a
   * planned action's matching inbox item wasn't tagged with its own
   * accountHash (legacy items). Required for the bulk-approve flow which
   * has to send an accountHash to /api/orders.
   */
  accountHash?: string;
  /**
   * Linked accounts — passed by the dashboard so each row can resolve its
   * targeted accountHash to a nickname / ···last4 label. When omitted, row
   * chips fall back to `···{hash prefix}` for tagged items and `→ selected`
   * for untagged ones (mirrors TradeInbox).
   */
  accounts?: AccountSummary[];
  /**
   * Current per-symbol share counts across the relevant accounts. Used by
   * ensureStaged to clamp on-demand SELL stagings so they never close a
   * position (mirrors lib/signals/run.ts:signalsToInbox). When omitted, the
   * keep-one-share rule is still enforced by the server-side guardrail at
   * /api/orders submission time, but the staged row will show the engine's
   * raw share count instead of the clamped value.
   */
  positions?: PositionShareInfo[];
  /** Called after any execute or dismiss so the parent can refresh portfolio. */
  onChanged?: () => void;
  /**
   * Render the plan as a household summary — tier counts and rows are still
   * shown but Approve / Dismiss buttons (per-row and bulk) are hidden so the
   * user has to pick a single account before firing orders. Mirrors the
   * TradeInbox `householdReadOnly` mode.
   */
  readOnly?: boolean;
}

export function DailyPlanPanel({ accountHash, accounts = [], positions = [], onChanged, readOnly = false }: Props = {}) {
  const [data,    setData]    = useState<DailyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [busy,    setBusy]    = useState<string | null>(null);
  const [notice,  setNotice]  = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const nicknames = useAccountNicknames();

  /**
   * Resolve an accountHash to a display label. Mirrors TradeInbox so plan
   * rows and inbox rows speak the same vocabulary.
   *   - Match in `accounts` → nickname (if set) or `···last4`
   *   - Hash present, no match → `···{hash prefix}` (account was disconnected)
   *   - No hash → empty string (callers handle "unknown")
   */
  const labelForHash = useCallback((hash: string | undefined): string => {
    if (!hash) return '';
    const match = accounts.find((a) => a.accountHash === hash);
    if (match) {
      const nick = nicknames[match.accountHash];
      return nick && nick.trim() ? nick.trim() : `···${match.accountNumber.slice(-4)}`;
    }
    return `···${hash.slice(0, 6)}`;
  }, [accounts, nicknames]);

  /**
   * Resolve a planned action's account chip — same routing rules as
   * TradeInbox.labelForItem so the user sees consistent labels across panels.
   */
  const labelForAction = useCallback((a: PlannedAction): { text: string; isFallback: boolean } => {
    if (a.accountHash) {
      return { text: labelForHash(a.accountHash) || '···unknown', isFallback: false };
    }
    const selected = labelForHash(accountHash);
    return {
      text: selected ? `→ ${selected}` : '→ selected',
      isFallback: true,
    };
  }, [labelForHash, accountHash]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/signals/daily-plan');
      if (r.status === 404) {
        setData(null);
        setError('No engine run cached yet. Trigger /api/signals to generate today\'s plan.');
        return;
      }
      const d = await r.json();
      if (d.error) {
        setError(d.error);
      } else {
        setData(d.plan);
        setCachedAt(d.cachedAt ?? null);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function patchInbox(action: PlannedAction, status: 'executed' | 'dismissed') {
    setBusy(action.signalId);
    try {
      if (status === 'executed') {
        // executeAction now auto-stages on demand, so we don't require an
        // existing inboxItemId here.
        const ok = await executeAction(action);
        if (!ok) {
          // executeAction sets a precise error itself; only fall back to a
          // generic message when it didn't.
          setError((prev) => prev ?? `Order placement failed for ${action.ticker} — see browser console.`);
        } else {
          // Plain-English confirmation: what just happened, in dollars.
          const verb = action.direction === 'BUY' ? 'Bought' : 'Sold';
          const qty  = action.quantity ? `${action.quantity.toLocaleString()} share${action.quantity === 1 ? '' : 's'} of ` : '';
          const amt  = action.sizeDollars > 0 ? ` for about ${fmt$(action.sizeDollars)}` : '';
          setNotice(`${verb} ${qty}${action.ticker}${amt}. The order is on its way to Schwab — it'll show under Pending orders until it fills.`);
          onChanged?.();
        }
      } else {
        // Dismiss path. If the row isn't staged yet, stage it first so the
        // dismissal sticks across runs (dedup will keep it out of next morning's
        // inbox). Cheap one-row stage; no broker call.
        let inboxItemId = action.inboxItemId;
        if (!inboxItemId) {
          const staged = await ensureStaged([action]);
          inboxItemId = staged[0]?.inboxItemId;
        }
        if (!inboxItemId) {
          setError(`Couldn't stage ${action.ticker} for dismissal — see browser console.`);
        } else {
          const r = await fetch('/api/inbox', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id: inboxItemId, status }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            alert(`Inbox update failed: ${d.error ?? r.statusText}`);
          }
        }
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  /**
   * Stage planned actions that don't yet have a backing inbox row. For each
   * unstaged action we:
   *
   *   1. Fetch a live quote via /api/quotes to learn the current price.
   *   2. Compute shares = floor(sizeDollars / price) — same arithmetic the
   *      engine's `signalsToInbox` uses, so the resulting inbox row is
   *      indistinguishable from one staged by the scheduled engine run.
   *   3. POST every staging input in one batch to /api/inbox.
   *   4. GET /api/inbox?status=pending to find the assigned inboxItemIds
   *      (covers dedup edge cases where appendInbox returns nothing because
   *      the item already exists from a prior source).
   *
   * Returns the input action list with `inboxItemId` / `quantity` /
   * `orderType` / `price` filled in for everything we could stage. Actions
   * we couldn't stage (no price, no accountHash, sub-tradeable size) are
   * returned unchanged so the caller can filter them.
   */
  async function ensureStaged(actions: PlannedAction[]): Promise<PlannedAction[]> {
    const needsStaging = actions.filter((a) => !a.inboxItemId);
    if (needsStaging.length === 0) return actions;

    // Drop anything we structurally can't stage (no target account,
    // non-BUY/SELL, zero size).
    const stagable = needsStaging.filter((a) => {
      const targetHash = a.accountHash || accountHash;
      return (
        targetHash &&
        (a.direction === 'BUY' || a.direction === 'SELL') &&
        a.sizeDollars > 0
      );
    });
    if (stagable.length === 0) return actions;

    // 1. Quotes — batch one POST for every unique symbol.
    const symbols = Array.from(new Set(stagable.map((a) => a.ticker)));
    let prices: Record<string, number> = {};
    try {
      const r = await fetch('/api/quotes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ symbols }),
      });
      const d = await r.json();
      prices = (d.prices ?? {}) as Record<string, number>;
    } catch (err) {
      console.warn('[DailyPlanPanel] quote fetch failed during staging:', err);
      return actions;
    }

    // Build a fast lookup for current share counts by (symbol, accountHash).
    // Sum across rows that match — covers fractional share splits across
    // sub-accounts under one hash, though that's rare. Falls back to a
    // symbol-only lookup when no accountHash on the position context.
    const sharesBy = new Map<string, number>();
    for (const p of positions) {
      const key = `${p.symbol}|${p.accountHash ?? ''}`;
      sharesBy.set(key, (sharesBy.get(key) ?? 0) + p.shares);
    }
    function currentSharesFor(symbol: string, hash: string): number {
      const scoped = sharesBy.get(`${symbol}|${hash}`);
      if (typeof scoped === 'number') return scoped;
      // Fall back to "any account" when share data isn't tagged with a hash.
      let total = 0;
      for (const [k, v] of sharesBy) {
        if (k.startsWith(`${symbol}|`)) total += v;
      }
      return total;
    }

    // 2. Build inputs. Mirror lib/signals/run.ts signalsToInbox shape so the
    // resulting inbox row is identical to a scheduled-engine stage. SELL
    // signals are clamped to currentShares - 1 (keep-one-share rule) and
    // dropped entirely when the position holds < 2 shares.
    const items = stagable
      .map((a) => {
        const price = prices[a.ticker];
        if (!price || price <= 0) return null;
        let quantity = Math.floor(a.sizeDollars / price);
        if (quantity <= 0) return null;
        const targetHash = a.accountHash || accountHash!;

        if (a.direction === 'SELL') {
          const currentShares = currentSharesFor(a.ticker, targetHash);
          if (currentShares > 0) {
            if (currentShares < 2) return null;
            if (quantity >= currentShares) quantity = currentShares - 1;
          }
          // If we have no position data at all (currentShares === 0), let
          // the server-side guardrail (lib/guardrails.ts:checkFullExit) do
          // the final check at /api/orders time. Better to stage and block
          // than to silently drop a legitimate signal.
        }

        return {
          source:      'signal-engine' as const,
          symbol:      a.ticker,
          instruction: a.direction as 'BUY' | 'SELL',
          quantity,
          orderType:   'MARKET' as const,
          price,
          rationale:   `[${a.rule}] ${a.reason}`,
          aiMode:      'signal_engine',
          violations:  [],
          tier:        a.tier,
          accountHash: targetHash,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (items.length === 0) return actions;

    // 3. POST /api/inbox with the whole batch.
    try {
      const r = await fetch('/api/inbox', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        console.warn('[DailyPlanPanel] stage POST failed:', d.error ?? r.statusText);
        return actions;
      }
    } catch (err) {
      console.warn('[DailyPlanPanel] stage POST crashed:', err);
      return actions;
    }

    // 4. GET the pending inbox to learn the assigned ids. Filter to
    // signal-engine entries that match (symbol, instruction, accountHash).
    let pending: Array<{
      id: string; source: string; symbol: string; instruction: string;
      quantity: number; price?: number; accountHash?: string; createdAt?: number;
    }> = [];
    try {
      const r = await fetch('/api/inbox?status=pending');
      const d = await r.json();
      pending = Array.isArray(d.items) ? d.items : [];
    } catch (err) {
      console.warn('[DailyPlanPanel] post-stage inbox read failed:', err);
      return actions;
    }

    // Most-recent match wins — when two pending rows exist for the same
    // (symbol, instruction, account) we want the one we just staged.
    function findMatch(a: PlannedAction) {
      const targetHash = a.accountHash || accountHash;
      return pending
        .filter(
          (it) =>
            it.source === 'signal-engine' &&
            it.symbol === a.ticker &&
            it.instruction === a.direction &&
            (!targetHash || !it.accountHash || it.accountHash === targetHash),
        )
        .sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))[0];
    }

    return actions.map((a) => {
      if (a.inboxItemId) return a;
      const match = findMatch(a);
      if (!match) return a;
      return {
        ...a,
        inboxItemId: match.id,
        quantity:    match.quantity,
        orderType:   'MARKET' as const,
        price:       match.price,
        accountHash: match.accountHash ?? a.accountHash,
      };
    });
  }

  /**
   * Submit one planned action to Schwab via /api/orders, then PATCH the
   * matching inbox item to executed with the resulting orderId. Mirrors the
   * single-row execute flow in TradeInbox so bulk approve behaves identically.
   *
   * If the action has no backing inbox row yet, it's auto-staged first via
   * `ensureStaged` — that's what makes Approve a one-click action even for
   * recommendations the scheduled engine run didn't stage (e.g. fresh signals
   * emitted after the morning stage pass).
   *
   * Returns true on success, false on any failure (so bulk can keep going
   * across the rest of the tier instead of aborting on the first reject).
   */
  async function executeAction(action: PlannedAction): Promise<boolean> {
    const targetHash = action.accountHash || accountHash;
    if (!targetHash) {
      setError('No account selected — pick a single account before approving.');
      return false;
    }

    // Auto-stage if needed so we have inboxItemId + quantity for the order.
    let staged = action;
    if (!staged.inboxItemId || !staged.quantity || staged.quantity <= 0) {
      const [resolved] = await ensureStaged([action]);
      staged = resolved ?? action;
      if (!staged.inboxItemId || !staged.quantity || staged.quantity <= 0) {
        setError(
          `Couldn't stage ${action.ticker} — no live quote, sub-tradeable size, ` +
          'or dedup rejected the row. Try refreshing the plan.',
        );
        return false;
      }
    }
    try {
      const r = await fetch('/api/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          accountHash: targetHash,
          orders: [{
            symbol:      staged.ticker,
            instruction: staged.direction,
            quantity:    staged.quantity,
            orderType:   staged.orderType ?? 'MARKET',
            price:       staged.orderType === 'LIMIT' ? staged.price : undefined,
            rationale:   `[${staged.rule}] ${staged.reason}`,
            aiMode:      'signal_engine',
          }],
        }),
      });
      const result = await r.json();
      if (!r.ok || result.error) {
        console.warn('[DailyPlanPanel] order failed for', staged.ticker, result.error ?? r.statusText);
        return false;
      }
      const first = result.results?.[0];
      await fetch('/api/inbox', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          id:      staged.inboxItemId,
          status:  'executed',
          orderId: first?.orderId ?? null,
          message: first?.message,
        }),
      });
      return true;
    } catch (err) {
      console.warn('[DailyPlanPanel] execute crashed for', staged.ticker, err);
      return false;
    }
  }

  /**
   * Bulk-approve / bulk-dismiss every actionable item in a tier.
   *
   * Approve flow:
   *   1. Filter to BUY/SELL rows that are still pending and not guardrail-blocked.
   *      Unstaged rows (no inboxItemId) are NOT filtered out — they get staged
   *      on the fly via ensureStaged before the order fires.
   *   2. Stage anything that needs staging (single batched /api/quotes +
   *      /api/inbox roundtrip; see ensureStaged).
   *   3. Sequentially submit each order via /api/orders and PATCH the inbox
   *      row to executed. Sequential keeps Schwab rate limits happy and lets
   *      us report per-item failures cleanly.
   *
   * Dismiss flow:
   *   1. Same filter.
   *   2. Stage any unstaged rows so the dedup window keeps them out of
   *      tomorrow morning's plan after they're dismissed today.
   *   3. PATCH every staged row to dismissed.
   */
  async function bulkAct(tierActions: PlannedAction[], status: 'executed' | 'dismissed') {
    const verb = status === 'executed' ? 'approve' : 'dismiss';
    const acting = tierActions.filter(
      (a) =>
        (a.status === 'pending' || a.status === undefined) &&
        !a.blockedByGuardrails &&
        (a.direction === 'BUY' || a.direction === 'SELL'),
    );
    if (acting.length === 0) {
      // Diagnose why so the user knows whether to re-run the engine, switch
      // accounts, or stop fighting an already-handled item.
      const reasons: string[] = [];
      const targets = tierActions.filter(
        (a) => a.direction === 'BUY' || a.direction === 'SELL',
      );
      const notPending = targets.filter((a) => a.status && a.status !== 'pending').length;
      const blocked    = targets.filter((a) => a.blockedByGuardrails).length;
      if (notPending > 0) reasons.push(`${notPending} already ${verb === 'approve' ? 'executed/dismissed' : 'resolved'}`);
      if (blocked    > 0) reasons.push(`${blocked} blocked by guardrails`);
      const detail = reasons.length > 0 ? ` — ${reasons.join('; ')}` : '';
      setError(
        verb === 'approve'
          ? `No actionable items in this tier${detail}.`
          : `Nothing to dismiss in this tier${detail}.`,
      );
      return;
    }
    // Mention staging in the confirm so the user understands what's about to
    // happen for the unstaged subset. Grouping by target account stays the
    // same as before so the dialog tells you where orders will route.
    const unstagedCount = acting.filter((a) => !a.inboxItemId).length;
    const stagingNote = unstagedCount > 0 && verb === 'approve'
      ? `\n\n${unstagedCount} of these aren't staged yet — they'll be staged in the inbox automatically before submission.`
      : '';
    const verbWord = verb === 'approve' ? 'Submit' : 'Dismiss';
    const tail = verb === 'approve' ? ' to Schwab? This is irreversible once placed.' : '?';
    if (!confirm(`${verbWord} ${acting.length} order${acting.length === 1 ? '' : 's'}${tail}${stagingNote}`)) {
      return;
    }
    setBusy('__bulk__');
    setError(null);
    try {
      // Stage anything missing an inbox row in one batched roundtrip (quotes
      // + POST /api/inbox + GET /api/inbox to learn ids). After this call,
      // `staged` carries inboxItemId + quantity for everything we could stage.
      const stagedActions = await ensureStaged(acting);
      const dropped       = stagedActions.filter((a) => !a.inboxItemId);
      const runnable      = stagedActions.filter((a) =>  a.inboxItemId);

      if (status === 'executed') {
        const placed: string[] = [];
        const failed: string[] = dropped.map((a) => `${a.ticker} (couldn't stage)`);
        for (const action of runnable) {
          const ok = await executeAction(action);
          if (ok) placed.push(action.ticker);
          else    failed.push(action.ticker);
        }
        if (failed.length > 0) {
          // Include each failed ticker so the user knows what to retry — the
          // previous "X placed, Y failed" message forced a console dive.
          const failList = failed.join(', ');
          const placedNote = placed.length > 0
            ? ` (${placed.length} placed: ${placed.join(', ')})`
            : '';
          setError(
            `Order placement failed for: ${failList}${placedNote}. ` +
            'Check the browser console for the underlying Schwab error, then retry from the row buttons or the Trade Inbox.',
          );
        }
        onChanged?.();
      } else {
        const dismissed: string[] = [];
        const failedToDismiss: string[] = dropped.map((a) => `${a.ticker} (couldn't stage)`);
        for (const action of runnable) {
          try {
            const r = await fetch('/api/inbox', {
              method:  'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ id: action.inboxItemId, status }),
            });
            if (r.ok) dismissed.push(action.ticker);
            else      failedToDismiss.push(action.ticker);
          } catch (err) {
            console.warn('[DailyPlanPanel] bulk dismiss failed for', action.ticker, err);
            failedToDismiss.push(action.ticker);
          }
        }
        if (failedToDismiss.length > 0) {
          setError(
            `Couldn't dismiss: ${failedToDismiss.join(', ')}` +
            (dismissed.length > 0 ? ` (dismissed ${dismissed.length}).` : '.'),
          );
        }
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="h-24 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Only fall back to the error-only view when we have no plan to show.
  // If `data` exists, mid-action errors (e.g. from bulkAct) are surfaced as a
  // dismissible banner above the panel content so the user doesn't lose sight
  // of the recommendations they were about to act on.
  if (!data) {
    return (
      <div className="text-xs text-[#7c82a0] flex items-start gap-2 p-3">
        <Clock className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>{error ?? 'No plan available.'}</span>
      </div>
    );
  }

  const modeBadgeColor =
    data.autoExecuteMode === 'auto'    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' :
    data.autoExecuteMode === 'dry-run' ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' :
                                          'bg-[#1a1d27] border-[#3d4468] text-[#7c82a0]';
  const cachedAgo = cachedAt ? Math.round((Date.now() - cachedAt) / 60_000) : null;

  return (
    <div className="space-y-4">
      {/* Transient error banner — set by bulkAct / executeAction / patchInbox.
          Shown above the panel content so users don't lose sight of the rows
          they were trying to act on. Dismissible. */}
      {notice && (
        <div className="flex items-start justify-between gap-3 text-xs p-2.5 rounded border bg-emerald-500/10 border-emerald-500/30 text-emerald-200">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{notice}</span>
          </div>
          <button
            onClick={() => setNotice(null)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/15 transition-colors shrink-0"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-start justify-between gap-3 text-xs p-2.5 rounded border bg-amber-500/10 border-amber-500/30 text-amber-200">
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-200 hover:bg-amber-500/15 transition-colors shrink-0"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {/* Header — mode + summary counts */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs px-2 py-1 rounded border ${modeBadgeColor} flex items-center gap-1.5`}>
            <CircuitBoard className="w-3 h-3" />
            Auto-execute: {data.autoExecuteMode}
          </span>
          {data.inDefenseMode && (
            <span className="text-xs px-2 py-1 rounded border bg-red-500/15 border-red-500/30 text-red-300 flex items-center gap-1.5">
              <ShieldAlert className="w-3 h-3" /> Defense mode
            </span>
          )}
          {data.killSwitchActive && (
            <span className="text-xs px-2 py-1 rounded border bg-red-500/15 border-red-500/30 text-red-300 flex items-center gap-1.5">
              <ShieldAlert className="w-3 h-3" /> Kill switch
              {!readOnly && (
                <button
                  onClick={async () => {
                    if (!confirm('Clear the margin kill switch? The engine will resume staging new purchases on the next run.')) return;
                    try {
                      const r = await fetch('/api/signals/state', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                          action: 'clear-kill-switch',
                          scope:  accountHash ? { accountHash } : undefined,
                        }),
                      });
                      if (!r.ok) {
                        const d = await r.json().catch(() => ({}));
                        setError(`Clear failed: ${d.error ?? r.statusText}`);
                        return;
                      }
                      await load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  className="ml-1 text-[10px] underline hover:no-underline"
                  title="Clear the kill switch via /api/signals/state"
                >
                  reset
                </button>
              )}
            </span>
          )}
          <span className="text-[10px] text-[#4a5070]">
            Borrowing {data.marginUtilizationPct.toFixed(1)}%
            {typeof data.afwDollars === 'number' && ` · cash cushion (AFW) ${fmt$(data.afwDollars)}`}
            {cachedAgo !== null && ` · updated ${cachedAgo}m ago`}
          </span>
        </div>
        <button
          onClick={load}
          className="text-xs px-2 py-1 rounded hover:bg-white/[0.04] transition-colors flex items-center gap-1.5 text-[#7c82a0]"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {/* At-a-glance counts */}
      {data.counts.total > 0 && (
        <div className="flex items-center gap-4 flex-wrap text-xs text-[#a0a4c0]">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            {data.counts.auto} {data.autoExecuteMode === 'auto' ? 'running automatically' : 'auto-eligible'}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-cyan-400" />
            {data.counts.approval} waiting for you
          </span>
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            {data.counts.alert} alert{data.counts.alert === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {readOnly && data.counts.total > 0 && (
        <div className="text-[11px] text-[#7c82a0] border border-dashed border-[#2d3248] rounded px-3 py-2">
          Read-only household summary — pick a single account to approve or dismiss items.
        </div>
      )}

      {/* Tier 1 — auto-eligible */}
      {data.actions.auto.length > 0 && (
        <Section
          title="Runs automatically"
          subtitle={
            data.autoExecuteMode === 'auto'
              ? 'These go through on the next scheduled run unless you dismiss them.'
              : 'These would run on their own if auto-execute were on. For now they wait for your approval.'
          }
          color="emerald"
          onBulkApprove={readOnly ? undefined : () => bulkAct(data.actions.auto, 'executed')}
          onBulkDismiss={readOnly ? undefined : () => bulkAct(data.actions.auto, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.auto.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
              accountChip={labelForAction(a)}
              onApprove={() => patchInbox(a, 'executed')}
              onDismiss={() => patchInbox(a, 'dismissed')}
              busy={busy}
              readOnly={readOnly}
            />
          ))}
        </Section>
      )}

      {/* Tier 2 — needs approval */}
      {data.actions.approval.length > 0 && (
        <Section
          title="Waiting for you"
          subtitle="New positions, larger trades, or anything outside the auto list. Nothing happens until you approve it."
          color="amber"
          onBulkApprove={readOnly ? undefined : () => bulkAct(data.actions.approval, 'executed')}
          onBulkDismiss={readOnly ? undefined : () => bulkAct(data.actions.approval, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.approval.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
              accountChip={labelForAction(a)}
              onApprove={() => patchInbox(a, 'executed')}
              onDismiss={() => patchInbox(a, 'dismissed')}
              busy={busy}
              readOnly={readOnly}
            />
          ))}
        </Section>
      )}

      {/* Tier 3 — alerts */}
      {data.actions.alert.length > 0 && (
        <Section
          title="Alerts — no trade needed"
          subtitle="Things worth knowing about that call for your judgment, not an order."
          color="cyan"
          onBulkApprove={undefined}
          onBulkDismiss={readOnly ? undefined : () => bulkAct(data.actions.alert, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.alert.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
              accountChip={labelForAction(a)}
              onApprove={() => patchInbox(a, 'executed')}
              onDismiss={() => patchInbox(a, 'dismissed')}
              busy={busy}
              readOnly={readOnly}
            />
          ))}
        </Section>
      )}

      {data.counts.total === 0 && (
        <div className="text-xs text-[#7c82a0] p-3 border border-dashed border-[#2d3248] rounded">
          Engine ran clean — no actions today.
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  color,
  onBulkApprove,
  onBulkDismiss,
  bulkBusy,
  children,
}: {
  title:         string;
  subtitle:      string;
  color:         'emerald' | 'amber' | 'cyan';
  onBulkApprove?: () => void;
  onBulkDismiss?: () => void;
  bulkBusy?:     boolean;
  children:      React.ReactNode;
}) {
  const accent =
    color === 'emerald' ? 'text-emerald-400' :
    color === 'amber'   ? 'text-amber-400'   :
                          'text-cyan-400';
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-xs font-semibold uppercase tracking-wider ${accent}`}>{title}</div>
          <div className="text-[10px] text-[#4a5070] mt-0.5">{subtitle}</div>
        </div>
        {(onBulkApprove || onBulkDismiss) && (
          <div className="flex items-center gap-1.5 shrink-0">
            {onBulkApprove && (
              <button
                onClick={onBulkApprove}
                disabled={bulkBusy}
                className="text-[10px] px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                title="Approve every actionable item in this tier"
              >
                Approve all
              </button>
            )}
            {onBulkDismiss && (
              <button
                onClick={onBulkDismiss}
                disabled={bulkBusy}
                className="text-[10px] px-2 py-1 rounded bg-white/[0.04] border border-[#3d4468] text-[#7c82a0] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
                title="Dismiss every item in this tier"
              >
                Dismiss all
              </button>
            )}
          </div>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
