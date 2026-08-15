'use client';

/**
 * ContributionTracker — every contribution, and whether you allocated it.
 *
 * Sits at the top of the Transactions tab. Deliberately a separate panel from
 * the transaction table rather than a status column on it: the table's rows
 * come from /api/transactions while contributions come from the cash-flow log,
 * and joining the two id spaces would be fragile in a way that fails silently.
 * A row that quietly stops matching would show a contribution as untracked,
 * which is the one outcome this feature exists to prevent.
 *
 * Open items sort to the top and stay there until they're dealt with. That
 * persistence is the whole point — an alert can be missed, a list that still
 * says "needs allocation" tomorrow cannot.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PiggyBank, Check, X, RotateCcw, ArrowRight, RefreshCw } from 'lucide-react';

export interface TrackedContribution {
  eventId: string;
  date: string;
  amount: number;
  description?: string;
  accountHash?: string;
  state: 'open' | 'allocated' | 'ignored';
  allocatedDollars?: number;
  remaining: number;
  note?: string;
  allocatedAt?: number;
}

export interface ContributionSummary {
  count: number;
  total: number;
  oldestDate: string | null;
}

const fmt$ = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/** Shared fetch so the tracker and the dashboard banner can't disagree. */
export async function fetchContributions(accountHash?: string): Promise<{
  contributions: TrackedContribution[];
  summary: ContributionSummary;
}> {
  const qs = accountHash && accountHash !== 'all' ? `?accountHash=${encodeURIComponent(accountHash)}` : '';
  const res = await fetch(`/api/contributions/status${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const STATE_CHIP: Record<TrackedContribution['state'], string> = {
  open:      'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  allocated: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
  ignored:   'bg-[#2d3248] text-[#7c82a0] border border-[#2d3248]',
};

const STATE_LABEL: Record<TrackedContribution['state'], string> = {
  open:      'Needs allocation',
  allocated: 'Allocated',
  ignored:   'Ignored',
};

export function ContributionTracker({
  accountHash,
  onAllocate,
}: {
  accountHash?: string;
  /** Opens the allocation tool pre-filled with this amount. */
  onAllocate?: (amount: number, eventId: string) => void;
}) {
  const [rows, setRows]       = useState<TrackedContribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchContributions(accountHash);
      setRows(d.contributions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [accountHash]);

  useEffect(() => { load(); }, [load]);

  async function mark(eventId: string, action: 'allocated' | 'ignored' | 'open', note?: string) {
    setBusy(eventId);
    try {
      const res = await fetch('/api/contributions/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, action, note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Open first, then newest. Anything needing action is always at the top,
  // regardless of when it landed — an old unallocated deposit shouldn't sink
  // below recent handled ones.
  const sorted = useMemo(() => {
    const rank = { open: 0, allocated: 1, ignored: 2 } as const;
    return [...rows].sort((a, b) =>
      rank[a.state] - rank[b.state] || b.date.localeCompare(a.date));
  }, [rows]);

  const open = sorted.filter((r) => r.state === 'open');
  const visible = showAll ? sorted : (open.length > 0 ? open : sorted.slice(0, 3));

  if (!loading && rows.length === 0) return null;

  return (
    <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <PiggyBank className="w-4 h-4 text-teal-400" />
          <span className="text-sm font-semibold text-white">Contributions</span>
          {open.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
              {open.length} need{open.length === 1 ? 's' : ''} allocation
            </span>
          )}
        </div>
        <button
          onClick={load}
          className="text-[#4a5070] hover:text-[#9aa2c0] transition-colors"
          aria-label="Refresh contributions"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

      {loading && rows.length === 0 && (
        <p className="text-xs text-[#4a5070] py-2">Loading contributions…</p>
      )}

      {!loading && open.length === 0 && rows.length > 0 && (
        <p className="text-xs text-emerald-400/80 mb-2">
          Every contribution is accounted for.
        </p>
      )}

      <div className="space-y-1.5">
        {visible.map((c) => (
          <div
            key={c.eventId}
            className="flex items-center gap-3 flex-wrap bg-[#0f1117] border border-[#1f2334] rounded-lg px-3 py-2"
          >
            <span className="text-[11px] text-[#7c82a0] tabular-nums w-20 flex-shrink-0">{c.date}</span>
            <span className="text-sm font-semibold text-white tabular-nums w-24 flex-shrink-0">
              {fmt$(c.amount)}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${STATE_CHIP[c.state]}`}>
              {STATE_LABEL[c.state]}
            </span>
            {/* Partial allocation: whole-share rounding leaves a residual, and
                the item stays open until it's small enough to not matter. */}
            {c.state === 'open' && c.allocatedDollars !== undefined && c.remaining > 0 && (
              <span className="text-[10px] text-[#7c82a0]">
                {money0(c.allocatedDollars)} deployed · {money0(c.remaining)} left
              </span>
            )}
            <span className="text-[11px] text-[#4a5070] truncate flex-1 min-w-[80px]">
              {c.note ?? c.description}
            </span>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              {c.state === 'open' && (
                <>
                  {onAllocate && (
                    <button
                      onClick={() => onAllocate(c.remaining > 0 ? c.remaining : c.amount, c.eventId)}
                      className="text-[11px] px-2 py-1 rounded bg-blue-600/90 hover:bg-blue-600 text-white transition-colors flex items-center gap-1"
                    >
                      Allocate <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    onClick={() => mark(c.eventId, 'allocated', 'Marked allocated manually')}
                    disabled={busy === c.eventId}
                    title="I already allocated this"
                    className="text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-emerald-300 hover:border-emerald-500/40 transition-colors disabled:opacity-40 flex items-center gap-1"
                  >
                    <Check className="w-3 h-3" /> Done
                  </button>
                  <button
                    onClick={() => mark(c.eventId, 'ignored', 'Dismissed manually')}
                    disabled={busy === c.eventId}
                    title="Not a contribution I need to allocate"
                    className="text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] transition-colors disabled:opacity-40 flex items-center gap-1"
                  >
                    <X className="w-3 h-3" /> Ignore
                  </button>
                </>
              )}
              {c.state !== 'open' && (
                <button
                  onClick={() => mark(c.eventId, 'open')}
                  disabled={busy === c.eventId}
                  title="Reopen — marked in error"
                  className="text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#4a5070] hover:text-[#9aa2c0] hover:border-[#3d4468] transition-colors disabled:opacity-40 flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" /> Reopen
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {rows.length > visible.length && (
        <button
          onClick={() => setShowAll(true)}
          className="text-[11px] text-blue-400 hover:text-blue-300 mt-2"
        >
          Show all {rows.length} contributions
        </button>
      )}
      {showAll && (
        <button
          onClick={() => setShowAll(false)}
          className="text-[11px] text-blue-400 hover:text-blue-300 mt-2"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}
