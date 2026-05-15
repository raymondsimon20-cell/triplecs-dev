'use client';

/**
 * Replay Panel — exposes /api/signals/replay in the dashboard.
 *
 * Lets you see what the engine WOULD have fired on each stored real snapshot.
 * The point is calibration: if MAINTENANCE_RANKED_TRIM has been firing daily
 * for two months, the threshold is too low. If PILLAR_FILL has fired zero
 * times, either the threshold is too high or you've been well-allocated.
 *
 * Output is a by-rule summary table + the most recent N days as a list. Not
 * trying to be a full backtester — see the API caveats for what replay does
 * and does not tell you.
 */

import { useState, useCallback, useEffect } from 'react';
import { History, RefreshCw, AlertTriangle } from 'lucide-react';

interface ReplayDay {
  date:                 string;
  totalValue:           number;
  marginUtilizationPct: number;
  signalsFired: Array<{
    rule:        string;
    direction:   string;
    ticker:      string;
    sizeDollars: number;
    priority:    string;
    reason:      string;
  }>;
}

interface ReplayResponse {
  days:    ReplayDay[];
  summary: {
    snapshotCount?: number;
    byRule:         Record<string, number>;
    totalFires:     number;
  };
  caveats?: string[];
  notice?:  string;
  error?:   string;
}

function fmt$(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  return n.toLocaleString('en-US', {
    style:                'currency',
    currency:             'USD',
    maximumFractionDigits: 0,
  });
}

export function ReplayPanel() {
  const [data,    setData]    = useState<ReplayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit,   setLimit]   = useState(60);
  const [ruleFilter, setRuleFilter] = useState<string>('');
  const [error,   setError]   = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (ruleFilter) qs.set('rule', ruleFilter);
      const r = await fetch(`/api/signals/replay?${qs.toString()}`);
      const d: ReplayResponse = await r.json();
      if (d.error) {
        setError(d.error);
        setData(null);
      } else {
        setData(d);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [limit, ruleFilter]);

  // Don't auto-fetch — replay is heavier than the daily plan, so make the
  // user opt in by clicking Run.
  useEffect(() => { /* explicit run only */ }, []);

  const byRuleEntries = data
    ? Object.entries(data.summary.byRule).sort((a, b) => b[1] - a[1])
    : [];
  const daysWithFires = data?.days.filter((d) => d.signalsFired.length > 0).slice(0, 30) ?? [];

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-[#7c82a0] flex items-center gap-1.5">
          Last
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-[#1a1d27] border border-[#2d3248] text-white text-xs rounded px-2 py-1"
          >
            <option value={30}>30</option>
            <option value={60}>60</option>
            <option value={90}>90</option>
            <option value={180}>180</option>
            <option value={365}>365</option>
          </select>
          snapshots
        </label>
        <label className="text-xs text-[#7c82a0] flex items-center gap-1.5">
          Rule filter
          <input
            type="text"
            value={ruleFilter}
            onChange={(e) => setRuleFilter(e.target.value.trim())}
            placeholder="all rules"
            className="bg-[#1a1d27] border border-[#2d3248] text-white text-xs rounded px-2 py-1 font-mono"
          />
        </label>
        <button
          onClick={run}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 hover:bg-purple-500/25 transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
          {loading ? 'Replaying…' : 'Run replay'}
        </button>
      </div>

      {/* States */}
      {error && (
        <div className="text-xs text-red-400 flex items-start gap-2 p-3 border border-red-500/30 bg-red-500/5 rounded">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!data && !loading && !error && (
        <div className="text-xs text-[#7c82a0] p-4 border border-dashed border-[#2d3248] rounded">
          Click <strong className="text-white">Run replay</strong> to backtest the current engine rules
          over your stored snapshots. Useful before flipping auto-execute to <code className="font-mono">auto</code>.
        </div>
      )}

      {data && (
        <>
          {data.notice && (
            <div className="text-xs text-amber-400 p-3 border border-amber-500/30 bg-amber-500/5 rounded">
              {data.notice}
            </div>
          )}
          {/* Summary by rule */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] mb-2">By-rule fire counts</div>
            {byRuleEntries.length === 0 ? (
              <div className="text-xs text-[#4a5070]">No signals fired across {data.summary.snapshotCount ?? 0} snapshots.</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {byRuleEntries.map(([rule, n]) => (
                  <div key={rule} className="bg-[#1a1d27] border border-[#2d3248] rounded p-2">
                    <div className="text-[10px] text-[#7c82a0] font-mono">{rule}</div>
                    <div className="text-lg font-bold text-white tabular-nums">{n}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent days with fires */}
          {daysWithFires.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] mb-2">Recent firing days</div>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {daysWithFires.map((d) => (
                  <div key={d.date} className="bg-[#1a1d27] border border-[#2d3248] rounded p-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-[#a0a4c0]">{d.date}</span>
                      <span className="text-[10px] text-[#4a5070]">
                        {fmt$(d.totalValue)} · margin {d.marginUtilizationPct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="space-y-1">
                      {d.signalsFired.map((s, i) => (
                        <div key={i} className="text-[11px] flex items-center gap-2">
                          <span className="font-mono text-emerald-300 w-12">{s.direction}</span>
                          <span className="font-mono font-semibold text-white w-16">{s.ticker}</span>
                          {s.sizeDollars > 0 && (
                            <span className="font-mono text-[#a0a4c0] w-20">{fmt$(s.sizeDollars)}</span>
                          )}
                          <span className="text-[#7c82a0] font-mono text-[10px]">{s.rule}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Caveats */}
          {data.caveats && data.caveats.length > 0 && (
            <details className="text-[10px] text-[#4a5070]">
              <summary className="cursor-pointer hover:text-[#7c82a0]">Replay caveats</summary>
              <ul className="mt-2 space-y-1 pl-4 list-disc">
                {data.caveats.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
