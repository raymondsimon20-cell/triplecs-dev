'use client';

/**
 * TradeInbox — unified one-click approval queue for all AI-staged trades.
 *
 * Items are auto-staged from /api/rebalance-plan and /api/option-plan in
 * addition to their existing inline UIs (additive — no existing flow breaks).
 * The user can approve in bulk via "Approve All Allowed", or per-item.
 * Approving routes through /api/orders, then PATCHes the inbox item to
 * `executed`. Items past the 24h TTL auto-expire on read.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Inbox, CheckCircle2, XCircle, AlertTriangle, RefreshCw,
  ShieldAlert, Layers, Zap, Loader2,
} from 'lucide-react';

interface GuardrailViolation {
  code:     string;
  message:  string;
  severity: 'block' | 'warn';
}

interface InboxItem {
  id:           string;
  createdAt:    number;
  expiresAt:    number;
  source:       'rebalance' | 'option' | 'ai-rec';
  status:       'pending' | 'executed' | 'dismissed' | 'expired';
  symbol:       string;
  instruction:  string;
  quantity:     number;
  orderType:    'MARKET' | 'LIMIT';
  price?:       number;
  occSymbol?:   string;
  limitPrice?:  number;
  pillar?:      string;
  rationale?:   string;
  aiMode?:      string;
  violations:   GuardrailViolation[];
  blocked:      boolean;
  resolvedAt?:  number;
  orderId?:     string | null;
  message?:     string;
}

interface InboxPayload {
  items: InboxItem[];
  counts: {
    pending: number; blocked: number;
    executed: number; dismissed: number; expired: number;
  };
}

interface Props {
  accountHash: string;
  /** Called after any execute or dismiss so the parent can refresh portfolio. */
  onChanged?: () => void;
}

const SOURCE_LABEL: Record<InboxItem['source'], string> = {
  rebalance: 'Rebalance',
  option:    'Option',
  'ai-rec':  'AI Rec',
};

const SOURCE_ICON: Record<InboxItem['source'], JSX.Element> = {
  rebalance: <Layers className="w-3 h-3" />,
  option:    <ShieldAlert className="w-3 h-3" />,
  'ai-rec':  <Zap className="w-3 h-3" />,
};

const SOURCE_TONE: Record<InboxItem['source'], string> = {
  rebalance: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300',
  option:    'bg-violet-500/10 border-violet-500/30 text-violet-300',
  'ai-rec':  'bg-amber-500/10 border-amber-500/30 text-amber-300',
};

function isOption(item: InboxItem): boolean {
  return item.source === 'option' || Boolean(item.occSymbol);
}

function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function notional(item: InboxItem): number {
  if (isOption(item)) {
    return (item.limitPrice ?? item.price ?? 0) * item.quantity * 100;
  }
  return (item.price ?? 0) * item.quantity;
}

export function TradeInbox({ accountHash, onChanged }: Props) {
  const [data, setData]         = useState<InboxPayload | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [busyIds, setBusyIds]   = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/inbox?status=pending');
      const d: InboxPayload | { error: string } = await r.json();
      if ('error' in d) setError(d.error);
      else { setData(d); setError(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const items = data?.items ?? [];
  const allowed = useMemo(() => items.filter((i) => !i.blocked), [items]);
  const blocked = useMemo(() => items.filter((i) =>  i.blocked), [items]);

  function markBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function execute(item: InboxItem) {
    if (!accountHash) { setError('No account selected'); return; }
    if (item.blocked) {
      const reasons = item.violations
        .filter((v) => v.severity === 'block')
        .map((v) => `• ${v.message}`)
        .join('\n');
      const ok = confirm(
        `OVERRIDE GUARDRAIL?\n\n${item.instruction} ${item.quantity} ${item.symbol}\n\nBlocked because:\n${reasons}\n\nClick OK to submit this order anyway.`,
      );
      if (!ok) return;
    }
    markBusy(item.id, true);
    try {
      const isOpt = isOption(item);
      const body = isOpt
        ? {
            accountHash,
            optionOrders: [{
              occSymbol:   item.occSymbol!,
              instruction: item.instruction,
              contracts:   item.quantity,
              limitPrice:  item.limitPrice ?? item.price ?? 0,
              rationale:   item.rationale,
              aiMode:      item.aiMode,
            }],
          }
        : {
            accountHash,
            orders: [{
              symbol:      item.symbol,
              instruction: item.instruction,
              quantity:    item.quantity,
              orderType:   item.orderType,
              price:       item.orderType === 'LIMIT' ? item.price : undefined,
              rationale:   item.rationale,
              aiMode:      item.aiMode,
            }],
          };

      const r = await fetch('/api/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const result = await r.json();
      if (!r.ok || result.error) {
        throw new Error(result.error || `HTTP ${r.status}`);
      }
      const first = result.results?.[0];
      await fetch('/api/inbox', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          id: item.id,
          status: 'executed',
          orderId: first?.orderId ?? null,
          message: first?.message,
        }),
      });
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      markBusy(item.id, false);
    }
  }

  async function dismiss(item: InboxItem) {
    markBusy(item.id, true);
    try {
      await fetch('/api/inbox', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: item.id }),
      });
      await load();
    } finally {
      markBusy(item.id, false);
    }
  }

  async function approveAllAllowed() {
    if (allowed.length === 0) return;
    if (!confirm(`Submit ${allowed.length} order${allowed.length === 1 ? '' : 's'} to Schwab? This is irreversible once placed.`)) return;
    setBulkBusy(true);
    try {
      // Sequential to keep error reporting accurate and avoid Schwab rate limits.
      for (const item of allowed) {
        // eslint-disable-next-line no-await-in-loop
        await execute(item);
      }
    } finally {
      setBulkBusy(false);
    }
  }

  async function dismissAll() {
    if (items.length === 0) return;
    if (!confirm(`Dismiss all ${items.length} pending items? They won't reappear.`)) return;
    setBulkBusy(true);
    try {
      await fetch('/api/inbox', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ all: true }),
      });
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="h-24 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── Header strip ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-[#7c82a0]">
          <Inbox className="w-4 h-4" />
          <span>
            {items.length === 0
              ? 'Inbox empty — propose trades from the panels below to stage them here.'
              : <>
                  <span className="text-white font-semibold">{allowed.length}</span> ready,{' '}
                  <span className="text-amber-400 font-semibold">{blocked.length}</span> blocked
                </>}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="text-[10px] px-2 py-1 rounded text-[#7c82a0] hover:text-white hover:bg-white/[0.04] transition-colors flex items-center gap-1"
            title="Refresh inbox"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
          {items.length > 0 && (
            <>
              <button
                onClick={dismissAll}
                disabled={bulkBusy}
                className="text-[10px] px-2 py-1 rounded text-[#7c82a0] border border-[#252840] hover:bg-white/[0.04] disabled:opacity-50 transition-colors"
              >
                Dismiss All
              </button>
              <button
                onClick={approveAllAllowed}
                disabled={bulkBusy || allowed.length === 0}
                className="text-[11px] px-3 py-1 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors flex items-center gap-1.5 font-semibold"
              >
                {bulkBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                Approve {allowed.length} Allowed
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-red-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {/* ── Item list ─────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {items.map((item) => {
            const busy = busyIds.has(item.id);
            const blockedItem = item.blocked;
            const warnings = item.violations.filter((v) => v.severity === 'warn');
            const blocks   = item.violations.filter((v) => v.severity === 'block');
            const ageMs = Date.now() - item.createdAt;
            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.15 }}
                className={[
                  'card-glass border rounded-lg p-3',
                  blockedItem ? 'border-red-500/40' : 'border-[#252840]',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Title row */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${SOURCE_TONE[item.source]}`}>
                        {SOURCE_ICON[item.source]} {SOURCE_LABEL[item.source]}
                      </span>
                      <span className="font-mono font-semibold text-white text-sm">
                        {item.instruction} {item.quantity} {isOption(item) ? item.occSymbol : item.symbol}
                      </span>
                      <span className="text-[10px] text-[#7c82a0]">
                        @ {item.orderType}{(item.price || item.limitPrice) ? ` $${(item.limitPrice ?? item.price)!.toFixed(2)}` : ''}
                      </span>
                      <span className="text-[10px] text-[#4a5070]">
                        ~${Math.round(notional(item)).toLocaleString()}
                      </span>
                      {item.pillar && (
                        <span className="text-[10px] text-[#4a5070] capitalize">· {item.pillar}</span>
                      )}
                      <span className="text-[10px] text-[#4a5070] ml-auto" title={new Date(item.createdAt).toLocaleString()}>
                        {fmtAge(ageMs)} ago
                      </span>
                    </div>

                    {/* Rationale */}
                    {item.rationale && (
                      <div className="text-[11px] text-[#a8aec8] mt-1.5 leading-snug">
                        {item.rationale}
                      </div>
                    )}

                    {/* Guardrails */}
                    {(blocks.length > 0 || warnings.length > 0) && (
                      <div className="mt-2 space-y-1">
                        {blocks.map((v, i) => (
                          <div key={`b-${i}`} className="text-[10px] flex items-start gap-1.5 text-red-300">
                            <ShieldAlert className="w-3 h-3 flex-shrink-0 mt-0.5" />
                            <span><span className="font-semibold">Blocked:</span> {v.message}</span>
                          </div>
                        ))}
                        {warnings.map((v, i) => (
                          <div key={`w-${i}`} className="text-[10px] flex items-start gap-1.5 text-amber-300">
                            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                            <span><span className="font-semibold">Warn:</span> {v.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => execute(item)}
                      disabled={busy}
                      className={[
                        'text-[11px] px-2.5 py-1 rounded border flex items-center gap-1 transition-colors font-semibold',
                        blockedItem
                          ? 'border-red-500/30 text-red-300 hover:bg-red-500/15'
                          : 'border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/15 bg-emerald-500/5',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                      ].join(' ')}
                      title={blockedItem ? 'Override required — click and confirm' : 'Submit this order to Schwab'}
                    >
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                      {blockedItem ? 'Override' : 'Approve'}
                    </button>
                    <button
                      onClick={() => dismiss(item)}
                      disabled={busy}
                      className="text-[11px] px-2.5 py-1 rounded border border-[#252840] text-[#7c82a0] hover:text-white hover:bg-white/[0.04] flex items-center gap-1 transition-colors disabled:opacity-50"
                    >
                      <XCircle className="w-3 h-3" /> Dismiss
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

