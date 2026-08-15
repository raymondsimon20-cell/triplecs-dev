'use client';

/**
 * ContributionBanner — "you have money sitting unallocated".
 *
 * Renders nothing at zero, which is the intended steady state. When it does
 * render it doesn't offer a dismiss: a banner you can dismiss is a
 * notification, and the point of this feature is that a contribution can't be
 * cleared from view without actually being dealt with. Marking it allocated or
 * ignored in the tracker is the only way to make this go away.
 */

import { useEffect, useState } from 'react';
import { PiggyBank, ArrowRight } from 'lucide-react';
import { fetchContributions, type ContributionSummary } from '@/components/ContributionTracker';

const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/** Days after which an unallocated contribution reads as overdue, not just new. */
const STALE_DAYS = 7;

export function ContributionBanner({
  accountHash,
  onReview,
}: {
  accountHash?: string;
  /** Opens the Transactions tab, where the tracker lives. */
  onReview: () => void;
}) {
  const [summary, setSummary] = useState<ContributionSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchContributions(accountHash)
      .then((d) => { if (!cancelled) setSummary(d.summary ?? null); })
      // Never break the dashboard over this panel — worst case it doesn't show.
      .catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
  }, [accountHash]);

  if (!summary || summary.count === 0) return null;

  const ageDays = summary.oldestDate
    ? Math.floor((Date.now() - Date.parse(summary.oldestDate)) / 86_400_000)
    : 0;
  const stale = ageDays >= STALE_DAYS;

  return (
    <button
      onClick={onReview}
      className={`w-full flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
        stale
          ? 'bg-amber-500/10 border-amber-500/40 hover:bg-amber-500/15'
          : 'bg-teal-500/10 border-teal-500/30 hover:bg-teal-500/15'
      }`}
    >
      <PiggyBank className={`w-4 h-4 flex-shrink-0 ${stale ? 'text-amber-400' : 'text-teal-400'}`} />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-white">
          {summary.count} contribution{summary.count === 1 ? '' : 's'} awaiting allocation
          {' · '}{money0(summary.total)}
        </span>
        <span className="block text-[11px] text-[#7c82a0] mt-0.5">
          {stale
            ? `Oldest landed ${ageDays} days ago — still sitting in cash`
            : 'Review and allocate in Transactions'}
        </span>
      </span>
      <ArrowRight className="w-4 h-4 text-[#7c82a0] flex-shrink-0" />
    </button>
  );
}
