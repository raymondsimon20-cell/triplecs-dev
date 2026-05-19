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
  TrendingUp,
  TrendingDown,
  CircuitBoard,
} from 'lucide-react';

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

function directionIcon(d: Direction) {
  if (d === 'BUY')  return <TrendingUp   className="w-3.5 h-3.5 text-emerald-400" />;
  if (d === 'SELL') return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
  return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
}

function ActionRow({
  action,
  onApprove,
  onDismiss,
  busy,
  readOnly = false,
}: {
  action:    PlannedAction;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  busy:      string | null;
  readOnly?: boolean;
}) {
  const isBusy = busy === action.signalId;
  const canAct =
    !readOnly &&
    action.requiresApproval &&
    action.inboxItemId &&
    action.status === 'pending' &&
    !action.blockedByGuardrails &&
    (action.direction === 'BUY' || action.direction === 'SELL');

  return (
    <div className="border border-[#2d3248] rounded-lg p-3 bg-[#1a1d27] hover:bg-[#1d2030] transition-colors">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {directionIcon(action.direction)}
          <span className="font-mono font-semibold text-white text-sm">{action.ticker}</span>
          <span className="text-xs text-[#7c82a0]">{action.direction}</span>
          {action.sizeDollars > 0 && (
            <span className="text-xs font-mono text-[#e8eaf0]">{fmt$(action.sizeDollars)}</span>
          )}
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${priorityColor(action.priority)}`}>
            {action.priority}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#0f1117] text-[#4a5070] border border-[#2d3248]">
            {action.rule}
          </span>
          {action.blockedByGuardrails && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30">
              guardrail
            </span>
          )}
          {action.status && action.status !== 'pending' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#0f1117] text-[#4a5070] border border-[#2d3248]">
              {action.status}
            </span>
          )}
        </div>
        {canAct && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => onApprove(action.signalId)}
              disabled={isBusy}
              className="text-xs px-2 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-50 flex items-center gap-1"
              title="Mark inbox item executed"
            >
              {isBusy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
              Approve
            </button>
            <button
              onClick={() => onDismiss(action.signalId)}
              disabled={isBusy}
              className="text-xs px-2 py-1 rounded bg-white/[0.04] border border-[#3d4468] text-[#7c82a0] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
              title="Dismiss this proposal"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      <div className="text-xs text-[#a0a4c0] leading-relaxed">{action.reason}</div>
    </div>
  );
}

interface Props {
  /**
   * Selected account hash from the dashboard. Used as a fallback when a
   * planned action's matching inbox item wasn't tagged with its own
   * accountHash (legacy items). Required for the bulk-approve flow which
   * has to send an accountHash to /api/orders.
   */
  accountHash?: string;
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

export function DailyPlanPanel({ accountHash, onChanged, readOnly = false }: Props = {}) {
  const [data,    setData]    = useState<DailyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [busy,    setBusy]    = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);

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
    if (!action.inboxItemId) return;
    setBusy(action.signalId);
    try {
      if (status === 'executed') {
        const ok = await executeAction(action);
        if (!ok) {
          // executeAction already logs to console; surface a top-level error
          // so the user sees that nothing was placed.
          setError(`Order placement failed for ${action.ticker} — see browser console.`);
        } else {
          onChanged?.();
        }
      } else {
        const r = await fetch('/api/inbox', {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ id: action.inboxItemId, status }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert(`Inbox update failed: ${d.error ?? r.statusText}`);
        }
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  /**
   * Submit one planned action to Schwab via /api/orders, then PATCH the
   * matching inbox item to executed with the resulting orderId. Mirrors the
   * single-row execute flow in TradeInbox so bulk approve behaves identically.
   *
   * Returns true on success, false on any failure (so bulk can keep going
   * across the rest of the tier instead of aborting on the first reject).
   */
  async function executeAction(action: PlannedAction): Promise<boolean> {
    if (!action.inboxItemId || !action.quantity || action.quantity <= 0) return false;
    const targetHash = action.accountHash || accountHash;
    if (!targetHash) {
      setError('No account selected — pick a single account before approving.');
      return false;
    }
    try {
      const r = await fetch('/api/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          accountHash: targetHash,
          orders: [{
            symbol:      action.ticker,
            instruction: action.direction,
            quantity:    action.quantity,
            orderType:   action.orderType ?? 'MARKET',
            price:       action.orderType === 'LIMIT' ? action.price : undefined,
            rationale:   `[${action.rule}] ${action.reason}`,
            aiMode:      'signal_engine',
          }],
        }),
      });
      const result = await r.json();
      if (!r.ok || result.error) {
        console.warn('[DailyPlanPanel] order failed for', action.ticker, result.error ?? r.statusText);
        return false;
      }
      const first = result.results?.[0];
      await fetch('/api/inbox', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          id:      action.inboxItemId,
          status:  'executed',
          orderId: first?.orderId ?? null,
          message: first?.message,
        }),
      });
      return true;
    } catch (err) {
      console.warn('[DailyPlanPanel] execute crashed for', action.ticker, err);
      return false;
    }
  }

  /**
   * Bulk-approve / bulk-dismiss every actionable item in a tier. Approve fires
   * the order through /api/orders and PATCHes the inbox to executed with the
   * resulting orderId; dismiss just PATCHes to dismissed. Both filter to
   * BUY/SELL items that are still pending, have a backing inbox item, and
   * aren't guardrail-blocked. Sequential to keep Schwab rate limits from
   * tripping and to keep error reporting per-item accurate.
   */
  async function bulkAct(tierActions: PlannedAction[], status: 'executed' | 'dismissed') {
    const verb = status === 'executed' ? 'approve' : 'dismiss';
    const acting = tierActions.filter(
      (a) =>
        a.inboxItemId &&
        a.status === 'pending' &&
        !a.blockedByGuardrails &&
        (a.direction === 'BUY' || a.direction === 'SELL'),
    );
    if (acting.length === 0) {
      setError(
        verb === 'approve'
          ? 'No actionable items in this tier — items without a backing inbox entry can\'t be approved.'
          : 'Nothing to dismiss in this tier.',
      );
      return;
    }
    const verbWord = verb === 'approve' ? 'Submit' : 'Dismiss';
    const tail = verb === 'approve' ? ' to Schwab? This is irreversible once placed.' : '?';
    if (!confirm(`${verbWord} ${acting.length} order${acting.length === 1 ? '' : 's'}${tail}`)) {
      return;
    }
    setBusy('__bulk__');
    setError(null);
    try {
      if (status === 'executed') {
        const placed: string[] = [];
        const failed: string[] = [];
        for (const action of acting) {
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
        for (const action of acting) {
          try {
            await fetch('/api/inbox', {
              method:  'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ id: action.inboxItemId, status }),
            });
          } catch (err) {
            console.warn('[DailyPlanPanel] bulk dismiss failed for', action.ticker, err);
          }
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

  if (error || !data) {
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
            Margin {data.marginUtilizationPct.toFixed(1)}%
            {typeof data.afwDollars === 'number' && ` · AFW ${fmt$(data.afwDollars)}`}
            {' · '}{data.counts.total} action{data.counts.total === 1 ? '' : 's'}
            {cachedAgo !== null && ` · cached ${cachedAgo}m ago`}
          </span>
        </div>
        <button
          onClick={load}
          className="text-xs px-2 py-1 rounded hover:bg-white/[0.04] transition-colors flex items-center gap-1.5 text-[#7c82a0]"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {readOnly && data.counts.total > 0 && (
        <div className="text-[11px] text-[#7c82a0] border border-dashed border-[#2d3248] rounded px-3 py-2">
          Read-only household summary — pick a single account to approve or dismiss items.
        </div>
      )}

      {/* Tier 1 — auto-eligible */}
      {data.actions.auto.length > 0 && (
        <Section
          title="Tier 1 — Auto-eligible"
          subtitle={
            data.autoExecuteMode === 'auto'
              ? 'These fire automatically on the next scheduled run unless dismissed.'
              : 'These would fire automatically if auto-execute mode were on. Currently requires approval.'
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
          title="Tier 2 — Requires approval"
          subtitle="New positions, large trades, or anything outside the auto whitelist. Review and approve each before it executes."
          color="amber"
          onBulkApprove={readOnly ? undefined : () => bulkAct(data.actions.approval, 'executed')}
          onBulkDismiss={readOnly ? undefined : () => bulkAct(data.actions.approval, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.approval.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
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
          title="Tier 3 — Alerts (no action)"
          subtitle="Informational signals that need your judgment, not a trade."
          color="cyan"
          onBulkApprove={undefined}
          onBulkDismiss={readOnly ? undefined : () => bulkAct(data.actions.alert, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.alert.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
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
