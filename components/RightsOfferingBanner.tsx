'use client';

/**
 * RightsOfferingBanner — a live rights offering you haven't decided on.
 *
 * Same principle as ContributionBanner: no dismiss button. The only ways to
 * clear it are to record that you subscribed, record that you declined, or
 * end the offering. That's deliberate — a rights offering has a hard expiry,
 * and "I saw the alert and forgot" is precisely how the rights lapse.
 *
 * Ranks above the contribution banner in urgency because a missed deadline is
 * unrecoverable, whereas unallocated cash is only idle.
 */

import { useCallback, useEffect, useState } from 'react';
import { Ticket, Check, X, CalendarClock } from 'lucide-react';
import type { ROStatus, ROAssessment } from '@/lib/ro-deadline';

const URGENCY_STYLE: Record<string, string> = {
  missed:   'bg-red-500/10 border-red-500/45 text-red-300',
  critical: 'bg-red-500/10 border-red-500/40 text-red-300',
  warn:     'bg-amber-500/10 border-amber-500/40 text-amber-300',
  info:     'bg-blue-500/10 border-blue-500/30 text-blue-300',
};

export function RightsOfferingBanner() {
  const [items, setItems] = useState<Array<{ ro: ROStatus; a: ROAssessment }>>([]);
  const [busy, setBusy]   = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ro-status');
      if (!res.ok) return;
      const d = await res.json();
      const statuses: ROStatus[] = d.statuses ?? [];
      const assessments: Record<string, ROAssessment> = d.assessments ?? {};
      setItems(
        statuses
          .map((ro) => ({ ro, a: assessments[ro.ticker] }))
          .filter((x) => x.a?.needsAction),
      );
    } catch {
      // Never break the dashboard over this panel.
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function patch(ticker: string, body: Record<string, unknown>) {
    setBusy(ticker);
    try {
      await fetch('/api/ro-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, ...body }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      {items.map(({ ro, a }) => (
        <div
          key={ro.ticker}
          className={`rounded-lg border px-4 py-3 ${URGENCY_STYLE[a.urgency] ?? URGENCY_STYLE.info}`}
        >
          <div className="flex items-start gap-3">
            <Ticket className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-white">{a.headline}</div>
              <div className="text-[11px] text-[#9aa2c0] mt-0.5">{a.detail}</div>

              {/* Deadline missing: the watcher can tell an offering exists from
                  the N-2 filing, but parsing the expiry out of a prospectus is
                  not reliable enough to trust. A wrong countdown is worse than
                  none, so it's asked for rather than guessed. */}
              {a.missingDeadline && (
                <div className="flex items-center gap-2 mt-2">
                  <CalendarClock className="w-3.5 h-3.5 text-[#7c82a0]" />
                  <input
                    type="date"
                    value={dateDraft[ro.ticker] ?? ''}
                    onChange={(e) => setDateDraft((d) => ({ ...d, [ro.ticker]: e.target.value }))}
                    className="bg-[#0f1117] border border-[#2d3248] rounded px-2 py-1 text-[11px] text-white"
                    aria-label={`${ro.ticker} subscription deadline`}
                  />
                  <button
                    disabled={!dateDraft[ro.ticker] || busy === ro.ticker}
                    onClick={() => patch(ro.ticker, { expiresAt: dateDraft[ro.ticker] })}
                    className="text-[11px] px-2 py-1 rounded bg-blue-600/90 hover:bg-blue-600 text-white disabled:opacity-40 transition-colors"
                  >
                    Set deadline
                  </button>
                </div>
              )}

              <div className="flex items-center gap-1.5 mt-2">
                <button
                  disabled={busy === ro.ticker}
                  onClick={() => patch(ro.ticker, { decision: 'subscribed' })}
                  className="text-[11px] px-2 py-1 rounded border border-[#2d3248] bg-[#0f1117] text-[#9aa2c0] hover:text-emerald-300 hover:border-emerald-500/40 transition-colors disabled:opacity-40 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" /> Subscribed
                </button>
                <button
                  disabled={busy === ro.ticker}
                  onClick={() => patch(ro.ticker, { decision: 'declined' })}
                  className="text-[11px] px-2 py-1 rounded border border-[#2d3248] bg-[#0f1117] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] transition-colors disabled:opacity-40 flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> Not subscribing
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
