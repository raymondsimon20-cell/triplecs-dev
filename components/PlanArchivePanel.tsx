'use client';

/**
 * Plan Archive Panel — browse historical daily plans saved by the engine.
 *
 * Renders the list of archived dates (newest first) from
 * /api/signals/daily-plan/archive. Clicking a date loads the full plan for
 * that day with the same tier breakdown as the live DailyPlan view.
 *
 * Retention is 90 days, set in lib/signals/plan-archive.ts.
 */

import { useState, useCallback, useEffect } from 'react';
import { History, RefreshCw, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';

interface PlannedAction {
  signalId:    string;
  rule:        string;
  ticker:      string;
  direction:   'BUY' | 'SELL' | 'REBALANCE' | 'ALERT' | 'INFO';
  sizeDollars: number;
  priority:    string;
  reason:      string;
  tier:        'auto' | 'approval' | 'alert';
  status?:     string;
}

interface DailyPlan {
  generatedAt:          string;
  totalValue:           number;
  marginUtilizationPct: number;
  /** AFW (Available For Withdrawal) — Schwab margin headroom in USD. */
  afwDollars?:          number;
  inDefenseMode:        boolean;
  killSwitchActive:     boolean;
  autoExecuteMode:      string;
  actions:  { auto: PlannedAction[]; approval: PlannedAction[]; alert: PlannedAction[] };
  counts:   { auto: number; approval: number; alert: number; total: number };
}

function fmt$(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  return n.toLocaleString('en-US', {
    style:                'currency',
    currency:             'USD',
    maximumFractionDigits: 0,
  });
}

function directionIcon(d: PlannedAction['direction']) {
  if (d === 'BUY')  return <TrendingUp   className="w-3 h-3 text-emerald-400" />;
  if (d === 'SELL') return <TrendingDown className="w-3 h-3 text-red-400" />;
  return <AlertTriangle className="w-3 h-3 text-amber-400" />;
}

export function PlanArchivePanel() {
  const [dates,        setDates]    = useState<string[] | null>(null);
  const [selectedDate, setSelected] = useState<string | null>(null);
  const [plan,         setPlan]     = useState<DailyPlan | null>(null);
  const [loadingList,  setLoadingList] = useState(false);
  const [loadingPlan,  setLoadingPlan] = useState(false);
  const [error,        setError]    = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const r = await fetch('/api/signals/daily-plan/archive');
      const d = await r.json();
      if (d.error) { setError(d.error); setDates([]); }
      else { setDates(d.dates ?? []); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadPlan = useCallback(async (date: string) => {
    setLoadingPlan(true);
    setSelected(date);
    setPlan(null);
    try {
      const r = await fetch(`/api/signals/daily-plan/archive?date=${encodeURIComponent(date)}`);
      const d = await r.json();
      if (d.error) { alert(`Failed to load ${date}: ${d.error}`); setPlan(null); }
      else        { setPlan(d.plan); }
    } catch (err) {
      alert(`Failed to load ${date}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingPlan(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-[#7c82a0]">
          {dates === null
            ? 'Loading archive…'
            : dates.length === 0
            ? 'No archived plans yet — they accumulate as the cron runs.'
            : `${dates.length} archived plan${dates.length === 1 ? '' : 's'} · 90-day retention`}
        </div>
        <button
          onClick={loadList}
          disabled={loadingList}
          className="text-xs px-2 py-1 rounded hover:bg-white/[0.04] transition-colors flex items-center gap-1.5 text-[#7c82a0] disabled:opacity-50"
        >
          {loadingList ? <RefreshCw className="w-3 h-3 animate-spin" /> : <History className="w-3 h-3" />} Refresh
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 flex items-start gap-2 p-2 border border-red-500/30 bg-red-500/5 rounded">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {dates && dates.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Date picker — left column */}
          <div className="md:col-span-1 space-y-1 max-h-96 overflow-y-auto pr-1">
            {dates.map((d) => (
              <button
                key={d}
                onClick={() => loadPlan(d)}
                className={
                  'w-full text-left text-xs px-2 py-1.5 rounded font-mono transition-colors ' +
                  (selectedDate === d
                    ? 'bg-purple-500/15 border border-purple-500/30 text-purple-300'
                    : 'border border-[#2d3248] text-[#a0a4c0] hover:bg-white/[0.04]')
                }
              >
                {d}
              </button>
            ))}
          </div>

          {/* Plan detail — right two columns */}
          <div className="md:col-span-2">
            {loadingPlan && (
              <div className="h-24 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}

            {!loadingPlan && !plan && (
              <div className="text-xs text-[#4a5070] p-4 border border-dashed border-[#2d3248] rounded">
                Select a date on the left to load that day's plan.
              </div>
            )}

            {!loadingPlan && plan && (
              <div className="space-y-3">
                <div className="text-xs text-[#7c82a0]">
                  <span className="text-white font-mono">{plan.generatedAt.slice(0, 19).replace('T', ' ')}</span>
                  {' · '}
                  Portfolio <strong className="text-white">{fmt$(plan.totalValue)}</strong>
                  {' · '}
                  Margin <strong className="text-white">{plan.marginUtilizationPct.toFixed(1)}%</strong>
                  {typeof plan.afwDollars === 'number' && (
                    <> · AFW <strong className="text-white">{fmt$(plan.afwDollars)}</strong></>
                  )}
                  {' · '}
                  Mode <code className="bg-[#0f1117] px-1 rounded">{plan.autoExecuteMode}</code>
                </div>
                {plan.inDefenseMode && (
                  <div className="text-xs text-red-400">⚠ Defense mode was active.</div>
                )}
                {plan.killSwitchActive && (
                  <div className="text-xs text-red-400">⚠ Kill switch was tripped.</div>
                )}

                {plan.counts.total === 0 && (
                  <div className="text-xs text-[#7c82a0] italic">Engine ran clean that day — no actions.</div>
                )}

                {(['auto', 'approval', 'alert'] as const).map((tier) => {
                  const items = plan.actions[tier];
                  if (items.length === 0) return null;
                  const accent =
                    tier === 'auto'     ? 'text-emerald-400' :
                    tier === 'approval' ? 'text-amber-400'   :
                                          'text-cyan-400';
                  const label =
                    tier === 'auto'     ? 'Tier 1 — Auto-eligible' :
                    tier === 'approval' ? 'Tier 2 — Required approval' :
                                          'Tier 3 — Alerts';
                  return (
                    <div key={tier} className="space-y-1.5">
                      <div className={`text-[10px] font-semibold uppercase tracking-wider ${accent}`}>{label}</div>
                      {items.map((a) => (
                        <div key={a.signalId} className="border border-[#2d3248] rounded p-2 text-xs">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            {directionIcon(a.direction)}
                            <span className="font-mono font-semibold text-white">{a.ticker}</span>
                            <span className="text-[#7c82a0]">{a.direction}</span>
                            {a.sizeDollars > 0 && (
                              <span className="font-mono text-[#a0a4c0]">{fmt$(a.sizeDollars)}</span>
                            )}
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[#0f1117] text-[#4a5070] font-mono">{a.rule}</span>
                            {a.status && a.status !== 'pending' && (
                              <span className="text-[10px] text-[#7c82a0] italic">→ {a.status}</span>
                            )}
                          </div>
                          <div className="text-[11px] text-[#a0a4c0]">{a.reason}</div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
