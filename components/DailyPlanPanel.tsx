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
}: {
  action:    PlannedAction;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  busy:      string | null;
}) {
  const isBusy = busy === action.signalId;
  const canAct =
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

export function DailyPlanPanel() {
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
      const r = await fetch('/api/inbox', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: action.inboxItemId, status }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(`Inbox update failed: ${d.error ?? r.statusText}`);
      } else {
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * Bulk-approve every actionable item in a tier. Filters to BUY/SELL items
   * that are still pending and not guardrail-blocked. PATCHes sequentially so
   * a Schwab rate limit on the downstream order endpoint doesn't backfire.
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
    if (acting.length === 0) return;
    if (!confirm(`${verb === 'approve' ? 'Approve' : 'Dismiss'} all ${acting.length} item(s) in this tier?`)) {
      return;
    }
    setBusy('__bulk__');
    try {
      for (const action of acting) {
        try {
          await fetch('/api/inbox', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id: action.inboxItemId, status }),
          });
        } catch (err) {
          console.warn('[DailyPlanPanel] bulk patch failed for', action.ticker, err);
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
          onBulkApprove={() => bulkAct(data.actions.auto, 'executed')}
          onBulkDismiss={() => bulkAct(data.actions.auto, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.auto.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
              onApprove={() => patchInbox(a, 'executed')}
              onDismiss={() => patchInbox(a, 'dismissed')}
              busy={busy}
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
          onBulkApprove={() => bulkAct(data.actions.approval, 'executed')}
          onBulkDismiss={() => bulkAct(data.actions.approval, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.approval.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
              onApprove={() => patchInbox(a, 'executed')}
              onDismiss={() => patchInbox(a, 'dismissed')}
              busy={busy}
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
          onBulkDismiss={() => bulkAct(data.actions.alert, 'dismissed')}
          bulkBusy={busy === '__bulk__'}
        >
          {data.actions.alert.map((a) => (
            <ActionRow
              key={a.signalId}
              action={a}
              onApprove={() => patchInbox(a, 'executed')}
              onDismiss={() => patchInbox(a, 'dismissed')}
              busy={busy}
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
