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
  ShieldAlert, Layers, Zap, Loader2, Activity, Wallet,
} from 'lucide-react';
import { useAccountNicknames } from './AccountSwitcher';

interface GuardrailViolation {
  code:     string;
  message:  string;
  severity: 'block' | 'warn';
}

interface InboxItem {
  id:           string;
  createdAt:    number;
  expiresAt:    number;
  source:       'rebalance' | 'option' | 'ai-rec' | 'signal-engine';
  status:       'pending' | 'executed' | 'dismissed' | 'expired' | 'failed';
  tier?:        'auto' | 'approval' | 'alert';
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
  /**
   * Schwab account hash this order targets. Set by the per-account engine
   * loop and per-account rebalance staging. When omitted (legacy items or
   * sources that don't tag accounts) the item falls through to the
   * currently-selected account on approve.
   */
  accountHash?: string;
}

interface InboxPayload {
  items: InboxItem[];
  counts: {
    pending: number; blocked: number;
    executed: number; dismissed: number; expired: number;
    failed?: number;
  };
}

interface AccountSummary {
  accountHash:   string;
  accountNumber: string;
}

interface Props {
  /** The account that owns the dashboard view. Items WITHOUT their own
   *  accountHash fall back to this hash on approve. */
  accountHash: string;
  /**
   * Linked accounts — passed by the dashboard so each row can show which
   * account it targets. When omitted the row chips collapse to just the
   * hash prefix.
   */
  accounts?:  AccountSummary[];
  /** Called after any execute or dismiss so the parent can refresh portfolio. */
  onChanged?: () => void;
}

const SOURCE_LABEL: Record<InboxItem['source'], string> = {
  rebalance:       'Rebalance',
  option:          'Option',
  'ai-rec':        'AI Rec',
  'signal-engine': 'Signals',
};

const SOURCE_ICON: Record<InboxItem['source'], JSX.Element> = {
  rebalance:       <Layers className="w-3 h-3" />,
  option:          <ShieldAlert className="w-3 h-3" />,
  'ai-rec':        <Zap className="w-3 h-3" />,
  'signal-engine': <Activity className="w-3 h-3" />,
};

const SOURCE_TONE: Record<InboxItem['source'], string> = {
  rebalance:       'bg-cyan-500/10 border-cyan-500/30 text-cyan-300',
  option:          'bg-violet-500/10 border-violet-500/30 text-violet-300',
  'ai-rec':        'bg-amber-500/10 border-amber-500/30 text-amber-300',
  'signal-engine': 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
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

export function TradeInbox({ accountHash, accounts = [], onChanged }: Props) {
  const [data, setData]         = useState<InboxPayload | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [busyIds, setBusyIds]   = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const nicknames = useAccountNicknames();

  /**
   * Resolve any accountHash to a display label.
   *   - Match in `accounts` → nickname (if set) or `···last4`
   *   - Hash present but no match → `···{hash prefix}` (account was disconnected)
   *   - No hash → empty string (callers handle "unknown" themselves).
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
   * Resolve an inbox item's chip label and routing intent.
   *   - Item tagged with accountHash → that account's nickname / last4.
   *   - Untagged (legacy items or sources that don't tag) → fall back to the
   *     currently-selected account's label, prefixed with "→" so the user
   *     can see the order will route there on approve.
   */
  const labelForItem = useCallback((item: InboxItem): { text: string; isFallback: boolean } => {
    if (item.accountHash) {
      return { text: labelForHash(item.accountHash) || '···unknown', isFallback: false };
    }
    const selected = labelForHash(accountHash);
    return {
      text: selected ? `→ ${selected}` : '→ selected',
      isFallback: true,
    };
  }, [labelForHash, accountHash]);

  const load = useCallback(async () => {
    try {
      // Pull pending + failed so the user can see autopilot rejects and retry.
      // Scope to the selected account on the server: only items targeted at
      // this account (plus untagged-fallback items) come back, so the queue
      // never shows trades destined for another account by mistake.
      const params = new URLSearchParams({ status: 'pending,failed' });
      if (accountHash) params.set('accountHash', accountHash);
      const r = await fetch(`/api/inbox?${params.toString()}`);
      const d: InboxPayload | { error: string } = await r.json();
      if ('error' in d) setError(d.error);
      else { setData(d); setError(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accountHash]);

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
    // Route to the item's own accountHash when one was stored at stage time
    // (per-account engine, drift auto-rebalance, etc.); fall back to the
    // header-selected account for legacy items that weren't tagged.
    const targetHash = item.accountHash || accountHash;
    if (!targetHash) { setError('No account selected'); return; }
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
            accountHash: targetHash,
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
            accountHash: targetHash,
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
    // Group by target account so the user knows whether bulk-approve fires
    // orders into one account or spans the household. Each item carries its
    // own accountHash now; untagged ones fall back to the header-selected
    // account (already reflected in the label resolver).
    const grouped = new Map<string, number>();
    for (const it of allowed) {
      const targetHash = it.accountHash || accountHash;
      grouped.set(targetHash, (grouped.get(targetHash) ?? 0) + 1);
    }
    const accountLines = Array.from(grouped.entries())
      .map(([hash, n]) => `  • ${labelForHash(hash) || `···${hash.slice(0, 6)}`} — ${n} order${n === 1 ? '' : 's'}`)
      .join('\n');
    const spanLabel = grouped.size > 1
      ? `\n\nThis spans ${grouped.size} accounts:\n${accountLines}`
      : '';
    if (!confirm(
      `Submit ${allowed.length} order${allowed.length === 1 ? '' : 's'} to Schwab? ` +
      `This is irreversible once placed.${spanLabel}`,
    )) return;
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

  /**
   * Clean up legacy items: pending items without an accountHash. These show
   * up in every per-account view because the filter treats them as "belongs
   * to the active account on approve". One-shot dismissal.
   */
  async function cleanupLegacyUntagged() {
    const untagged = items.filter((it) => !it.accountHash);
    if (untagged.length === 0) return;
    if (!confirm(
      `Dismiss ${untagged.length} untagged legacy item${untagged.length === 1 ? '' : 's'}? ` +
      `These are pending items staged before per-account tagging. They appear in every account's queue today.`,
    )) return;
    setBulkBusy(true);
    try {
      await fetch('/api/inbox', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cleanup: 'untagged' }),
      });
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  /** Bulk-tag every untagged pending item with the currently-selected
   *  account hash so they stop bleeding across views. */
  async function cleanupTagLegacy() {
    const untagged = items.filter((it) => !it.accountHash);
    if (untagged.length === 0 || !accountHash) return;
    const accountLabel = labelForHash(accountHash) || `···${accountHash.slice(0, 6)}`;
    if (!confirm(
      `Tag ${untagged.length} untagged legacy item${untagged.length === 1 ? '' : 's'} with ${accountLabel}? ` +
      `They'll then route to this account only and disappear from other accounts' queues.`,
    )) return;
    setBulkBusy(true);
    try {
      await fetch('/api/inbox', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cleanup: 'tag-untagged', accountHash }),
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
              {items.some((it) => !it.accountHash) && (
                <>
                  <button
                    onClick={cleanupTagLegacy}
                    disabled={bulkBusy}
                    className="text-[10px] px-2 py-1 rounded text-blue-300 border border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/15 disabled:opacity-50 transition-colors"
                    title="Tag legacy untagged items with the currently-selected account"
                  >
                    Tag legacy → this account
                  </button>
                  <button
                    onClick={cleanupLegacyUntagged}
                    disabled={bulkBusy}
                    className="text-[10px] px-2 py-1 rounded text-amber-300 border border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/15 disabled:opacity-50 transition-colors"
                    title="Dismiss legacy untagged items"
                  >
                    Dismiss legacy
                  </button>
                </>
              )}
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
            const failedItem = item.status === 'failed';
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
                  failedItem ? 'border-red-500/60 bg-red-500/[0.03]' :
                  blockedItem ? 'border-red-500/40' :
                  'border-[#252840]',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Title row */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${SOURCE_TONE[item.source]}`}>
                        {SOURCE_ICON[item.source]} {SOURCE_LABEL[item.source]}
                      </span>
                      {/* Account chip — tells the user which account this row
                          will hit on approve. Items without an explicit
                          accountHash get a "→ selected" fallback so the
                          routing intent is never invisible. */}
                      {(() => {
                        const { text, isFallback } = labelForItem(item);
                        return (
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
                              isFallback
                                ? 'bg-white/[0.03] border-[#252840] text-[#7c82a0]'
                                : 'bg-[#1a1e2e] border-[#2d3248] text-[#9aa2c0]'
                            }`}
                            title={item.accountHash
                              ? `Routes to ${text}`
                              : 'No account tagged — will route to the currently selected account on approve'}
                          >
                            <Wallet className="w-3 h-3" />
                            {text}
                          </span>
                        );
                      })()}
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

                    {/* Failed-status banner — surfaces Schwab's error message
                        for autopilot-rejected orders. Loud by design: a failed
                        item won't auto-retry on the next cron. */}
                    {failedItem && (
                      <div className="mt-1.5 flex items-start gap-1.5 text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
                        <XCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <span className="font-semibold">Schwab rejected:</span>{' '}
                          {item.message ?? 'unknown error'}
                        </div>
                      </div>
                    )}

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
                    {failedItem ? (
                      // For failed items, "Retry" flips the inbox status back
                      // to 'pending' (the next manual approve/auto cycle picks
                      // it up). User can still dismiss to drop it permanently.
                      <button
                        onClick={async () => {
                          markBusy(item.id, true);
                          try {
                            await fetch('/api/inbox', {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ id: item.id, status: 'pending' }),
                            });
                            await load();
                          } finally {
                            markBusy(item.id, false);
                          }
                        }}
                        disabled={busy}
                        className="text-[11px] px-2.5 py-1 rounded border border-amber-500/30 text-amber-300 hover:bg-amber-500/15 bg-amber-500/5 flex items-center gap-1 transition-colors font-semibold disabled:opacity-50"
                        title="Re-mark this item as pending — it will be eligible for the next approval / auto-execute pass"
                      >
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        Retry
                      </button>
                    ) : (
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
                    )}
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

