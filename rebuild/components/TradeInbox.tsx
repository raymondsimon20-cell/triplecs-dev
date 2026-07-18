'use client';
import { useState } from 'react';

interface InboxSignal {
  id: string;
  rule: string;
  severity: string;
  title: string;
  rationale: string;
  trade?: { symbol: string; side: string; notional: number };
}

export function TradeInbox({
  trades,
  approvals,
  accountHash,
  onDecision,
}: {
  trades: InboxSignal[];
  approvals: Record<string, string>;
  accountHash: string;
  onDecision: (msg: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (signalId: string, decision: 'approved' | 'rejected') => {
    setBusy(signalId);
    try {
      const res = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signalId, decision, accountHash }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      onDecision(decision === 'approved' ? `Executed (${json.quantity ?? '?'} shares)` : 'Rejected');
    } catch (e) {
      onDecision(String(e), true);
    } finally {
      setBusy(null);
    }
  };

  if (trades.length === 0)
    return <div className="card p-4 text-sm opacity-60">No trades awaiting approval.</div>;

  return (
    <div className="card divide-y divide-slate-100 dark:divide-slate-800">
      <h3 className="p-3 text-sm font-semibold uppercase tracking-wide opacity-70">
        Trade Inbox ({trades.length})
      </h3>
      {trades.map((t) => {
        const status = approvals[t.id] ?? 'pending';
        return (
          <div key={t.id} className="flex items-start gap-3 p-3">
            <div className="flex-1">
              <div className="text-sm font-semibold">{t.title}</div>
              <div className="text-xs opacity-70">{t.rationale}</div>
              {t.trade && (
                <div className="mt-1 font-mono text-xs">
                  {t.trade.side} {t.trade.symbol} ~${Math.round(t.trade.notional).toLocaleString()}
                </div>
              )}
            </div>
            {status === 'pending' ? (
              <div className="flex gap-2">
                <button
                  disabled={busy === t.id}
                  onClick={() => decide(t.id, 'approved')}
                  className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  disabled={busy === t.id}
                  onClick={() => decide(t.id, 'rejected')}
                  className="rounded bg-slate-500 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            ) : (
              <span className="text-xs font-semibold capitalize opacity-60">{status}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
