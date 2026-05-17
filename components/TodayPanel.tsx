'use client';

/**
 * TodayPanel — the unified action queue for the redesigned dashboard.
 *
 * Wraps TradeInbox (which is the existing approval engine for auto-staged
 * rebalance + option + signal-engine + AI-rec trades) and presents it as the
 * single "what should I do right now" surface. Pre-redesign, this responsibility
 * was split across four panels (Daily Autopilot Plan, Trade Inbox, Rebalance
 * Workflow, Market Conditions Recommendations) — all of which proposed trades
 * with no clear ordering. They now feed into one queue.
 *
 * The panel itself is presentational — TradeInbox owns the data, polling,
 * approval flow, and source/severity badges. This wrapper just provides the
 * Today header chrome and frames the inbox in a clean card.
 */

import { Inbox, Sparkles } from 'lucide-react';
import { TradeInbox } from './TradeInbox';

interface Props {
  accountHash: string;
  /** Called after any execute or dismiss so the parent can refresh portfolio. */
  onChanged?: () => void;
}

export function TodayPanel({ accountHash, onChanged }: Props) {
  return (
    <div className="bg-[#12151f] border border-[#1f2334] border-l-2 border-l-blue-500/60 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1a1e2e]">
        <div className="flex items-center gap-2.5">
          <span className="p-1.5 rounded-md bg-blue-500/10 border border-blue-500/20">
            <Inbox className="w-4 h-4 text-blue-400" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-white tracking-tight">Today</div>
            <div className="text-[11px] text-[#7c82a0] mt-0.5">
              Rebalance, hedges, options, signal engine — one queue. Approve per row or in bulk.
            </div>
          </div>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] text-[#7c82a0] uppercase tracking-wider">
          <Sparkles className="w-3 h-3" />
          autopilot ready
        </span>
      </div>

      <div className="p-5">
        <TradeInbox accountHash={accountHash} onChanged={onChanged} />
      </div>
    </div>
  );
}
