'use client';

/**
 * Options close-recommendations panel.
 *
 * Per-account UI for the /api/options/close-recs report. Tells the user
 * which open option positions to close (profits-first) to restore AFW
 * headroom above the safety floor.
 *
 * Read-only: surfaces the recommended set as a table; the user takes the
 * close actions in their broker or via the existing trade flow. No
 * auto-staging here (deliberate — see the conversation context: user asked
 * for "review now," not "stage automatically").
 *
 * Pairs with the post-trade AFW guardrail in lib/guardrails.ts. The
 * guardrail blocks NEW trades that would push AFW below the floor; this
 * panel helps unwind EXISTING positions that are already below it.
 */

import { useState } from 'react';
import { ShieldAlert, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';

// ─── Types — shape returned by /api/options/close-recs ────────────────────────

interface OptionPositionReport {
  symbol:           string;
  underlying:       string;
  description?:     string;
  side:             'long' | 'short';
  contracts:        number;
  marketValue:      number;
  marginLocked:     number;
  unrealizedPL:     number;
  closeInstruction: 'BUY_TO_CLOSE' | 'SELL_TO_CLOSE';
}

interface CloseRecsResponse {
  accountHash:        string;
  accountNumber:      string;
  afwBefore:          number;
  afwAfter:           number;
  floor:              number;
  alreadyHealthy:     boolean;
  recommendedCloses:  OptionPositionReport[];
  allOpenOptions:     OptionPositionReport[];
  generatedAt:        string;
  error?:             string;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmt$(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });
}

function fmtPL(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${fmt$(n)}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  accountHash:  string;
  /** Override the AFW floor (defaults to 10000 server-side). */
  floor?:       number;
}

export function OptionsCloseRecsPanel({ accountHash, floor }: Props) {
  const [data,    setData]    = useState<CloseRecsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ hash: accountHash });
      if (typeof floor === 'number') params.set('floor', String(floor));
      const res = await fetch(`/api/options/close-recs?${params}`);
      const json = await res.json() as CloseRecsResponse;
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // ── Empty state — pre-load CTA ──────────────────────────────────────────────
  if (!data && !loading && !error) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center">
        <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-400" />
        <p className="mb-1 text-sm font-medium text-zinc-200">
          Check open options against AFW floor
        </p>
        <p className="mb-4 text-xs text-zinc-400">
          Identifies open option positions whose margin lock is eating into AFW headroom.
          Recommends a profits-first close sequence to restore the {fmt$(floor ?? 10_000)} floor.
        </p>
        <button
          type="button"
          onClick={load}
          className="rounded-md bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-300 ring-1 ring-amber-500/30 hover:bg-amber-500/20"
        >
          Run check
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
        <RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin" />
        Fetching positions from Schwab…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
        <div className="mb-2 flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4" /> Couldn't load close-recs
        </div>
        <p className="mb-3 text-xs">{error}</p>
        <button
          type="button"
          onClick={load}
          className="rounded-md bg-red-500/10 px-3 py-1.5 text-xs ring-1 ring-red-500/30 hover:bg-red-500/20"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  // ── Healthy state — no closes needed ────────────────────────────────────────
  if (data.alreadyHealthy) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            AFW headroom is healthy
          </div>
          <p className="text-xs text-emerald-200/70">
            Current AFW {fmt$(data.afwBefore)} ≥ {fmt$(data.floor)} floor. No closes needed.
            {data.allOpenOptions.length > 0 && (
              <> {data.allOpenOptions.length} open option position{data.allOpenOptions.length === 1 ? '' : 's'} below — review optional.</>
            )}
          </p>
        </div>
        {data.allOpenOptions.length > 0 && renderTable(data.allOpenOptions, 'All open options')}
        {renderRefreshFooter(load, data.generatedAt)}
      </div>
    );
  }

  // ── Unhealthy state — show recommended closes ──────────────────────────────
  const deltaNeeded = data.floor - data.afwBefore;
  const reaches    = data.afwAfter >= data.floor;

  return (
    <div className="space-y-3">
      {/* Banner */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300">
          <ShieldAlert className="h-4 w-4" />
          AFW below floor — {fmt$(deltaNeeded)} short
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-zinc-400">Current AFW</div>
            <div className="font-mono text-zinc-100">{fmt$(data.afwBefore)}</div>
          </div>
          <div>
            <div className="text-zinc-400">Floor</div>
            <div className="font-mono text-zinc-100">{fmt$(data.floor)}</div>
          </div>
          <div>
            <div className="text-zinc-400">Projected after closes</div>
            <div className={`font-mono ${reaches ? 'text-emerald-300' : 'text-amber-300'}`}>
              {fmt$(data.afwAfter)}
            </div>
          </div>
        </div>
        {!reaches && (
          <p className="mt-2 text-xs text-amber-200/70">
            Even closing every recommended position doesn't fully restore the floor.
            You may need to close additional positions or wait for market movement.
          </p>
        )}
      </div>

      {/* Recommended set */}
      {data.recommendedCloses.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          No open option positions to close — AFW shortfall is driven by other factors.
        </p>
      ) : (
        renderTable(
          data.recommendedCloses,
          `Recommended closes (profits-first, minimum set)`,
        )
      )}

      {/* Full list toggle */}
      {data.allOpenOptions.length > data.recommendedCloses.length && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-zinc-400 underline hover:text-zinc-200"
        >
          {showAll ? 'Hide' : 'Show'} all {data.allOpenOptions.length} open option
          {data.allOpenOptions.length === 1 ? '' : 's'}
        </button>
      )}
      {showAll && renderTable(data.allOpenOptions, 'All open options (P&L ↓)')}

      {renderRefreshFooter(load, data.generatedAt)}
    </div>
  );
}

// ─── Sub-renders ─────────────────────────────────────────────────────────────

function renderTable(rows: OptionPositionReport[], title: string) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="border-b border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300">
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/60 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-normal">Underlying</th>
              <th className="px-3 py-2 text-left font-normal">Side</th>
              <th className="px-3 py-2 text-right font-normal">Contracts</th>
              <th className="px-3 py-2 text-right font-normal">Margin locked</th>
              <th className="px-3 py-2 text-right font-normal">P&amp;L</th>
              <th className="px-3 py-2 text-left font-normal">Action</th>
              <th className="px-3 py-2 text-left font-normal">Symbol</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map((r) => (
              <tr key={r.symbol} className="hover:bg-zinc-800/30">
                <td className="px-3 py-2 font-medium text-zinc-100">{r.underlying}</td>
                <td className="px-3 py-2">
                  <span className={r.side === 'short' ? 'text-orange-300' : 'text-blue-300'}>
                    {r.side}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-zinc-300">{r.contracts}</td>
                <td className="px-3 py-2 text-right font-mono text-zinc-300">{fmt$(r.marginLocked)}</td>
                <td className={`px-3 py-2 text-right font-mono ${r.unrealizedPL >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {fmtPL(r.unrealizedPL)}
                </td>
                <td className="px-3 py-2 text-zinc-300">{r.closeInstruction}</td>
                <td className="px-3 py-2 font-mono text-zinc-500 text-[10px]">{r.symbol}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderRefreshFooter(load: () => void, generatedAt: string) {
  return (
    <div className="flex items-center justify-between text-xs text-zinc-500">
      <span>Generated {new Date(generatedAt).toLocaleString()}</span>
      <button
        type="button"
        onClick={load}
        className="flex items-center gap-1 hover:text-zinc-300"
      >
        <RefreshCw className="h-3 w-3" /> Refresh
      </button>
    </div>
  );
}
