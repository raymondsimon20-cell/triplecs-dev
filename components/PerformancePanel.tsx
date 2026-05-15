'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import { Target, TrendingUp, TrendingDown, Database, RefreshCw, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';

interface SnapshotPoint {
  savedAt: number;
  totalValue: number;
  equity: number;
  spyClose?: number;
  synthetic?: boolean;
}

interface PerfPayload {
  snapshots: SnapshotPoint[];
  twr: { twrPct: number; cagrPct: number; daysCovered: number; hasGaps: boolean } | null;
  attribution: Array<{ pillar: string; contributionPp: number; returnPct: number; avgWeightPct: number }> | null;
  alpha: { portfolioReturnPct: number; spyReturnPct: number; alphaPp: number } | null;
  progress: { actualCAGR: number; targetCAGR: number; gapPp: number; paceLabel: 'ahead' | 'on-pace' | 'behind'; requiredForwardCAGR: number | null } | null;
  meta: { snapshotCount: number; realCount: number; syntheticCount: number; cashFlowCount: number };
}

interface ChartPoint {
  date: string;
  twrPct: number | null;
  spyPct: number | null;
  targetPct: number;
  synthetic: boolean;
}

const PILLAR_COLOR: Record<string, string> = {
  triples:     '#f59e0b',
  cornerstone: '#3b82f6',
  income:      '#10b981',
  hedge:       '#8b5cf6',
  other:       '#6b7280',
};

function pct(n: number, dp = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a1d27] border border-[#3d4468] rounded-lg p-3 text-xs shadow-xl">
      <div className="text-[#7c82a0] mb-1.5">{label}</div>
      {payload.filter((p: { value: number | null }) => p.value != null).map((p: { name: string; value: number; color: string }, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono font-semibold text-white">{pct(p.value, 2)}</span>
        </div>
      ))}
    </div>
  );
};

export function PerformancePanel() {
  const [data, setData]       = useState<PerfPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/performance?limit=120');
      const d: PerfPayload | { error: string } = await r.json();
      if ('error' in d) setError(d.error); else { setData(d); setError(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runBackfill() {
    if (!confirm('Backfill the last 90 days of synthetic snapshots? This is approximate — see caveats.')) return;
    setBackfilling(true);
    try {
      const r = await fetch('/api/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 90 }),
      });
      const d = await r.json();
      if (d.error) alert(`Backfill failed: ${d.error}`);
      else alert(`Backfill done: ${d.written} synthetic days written, ${d.skipped} skipped.`);
      await load();
    } finally {
      setBackfilling(false);
    }
  }

  if (loading) {
    return (
      <div className="h-32 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-red-400 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" /> {error}
      </div>
    );
  }

  // Empty state — no snapshots yet
  if (!data || data.snapshots.length < 2) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-[#7c82a0] flex items-start gap-2">
          <Database className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            Performance series is empty. The daily Netlify function captures one
            snapshot per day. To get started immediately, you can backfill the
            last ~90 days from current positions + trade history (synthetic).
          </div>
        </div>
        <button
          onClick={runBackfill}
          disabled={backfilling}
          className="text-xs px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {backfilling ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
          {backfilling ? 'Backfilling…' : 'Backfill 90 days'}
        </button>
      </div>
    );
  }

  // Build the chart series. TWR/SPY are computed cumulatively from each snapshot.
  // (For a simple visualization we use snapshot-relative simple return — the
  // panel's pace gauge already shows the cash-flow-adjusted TWR for the headline.)
  //
  // We use `equity` (positions + cash − margin debt) so cash dividends and
  // interest are reflected. This matches the basis used by computeTWR.
  // Synthetic snapshots have equity == totalValue (positions only); they
  // remain on the chart faded but won't perfectly stitch with real points.
  const sorted = [...data.snapshots].sort((a, b) => a.savedAt - b.savedAt);
  const baseValue = sorted[0].equity;
  const baseSpy = sorted.find((s) => typeof s.spyClose === 'number' && s.spyClose! > 0)?.spyClose;
  const startTime = sorted[0].savedAt;

  const chartData: ChartPoint[] = sorted.map((s) => {
    const days = (s.savedAt - startTime) / (24 * 60 * 60 * 1000);
    const targetCum = (Math.pow(1.40, days / 365) - 1) * 100;
    return {
      date: new Date(s.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      twrPct: baseValue > 0 ? (s.equity / baseValue - 1) * 100 : 0,
      spyPct: baseSpy && s.spyClose ? (s.spyClose / baseSpy - 1) * 100 : null,
      targetPct: targetCum,
      synthetic: Boolean(s.synthetic),
    };
  });

  const progress      = data.progress;
  const alpha         = data.alpha;
  const attribution   = data.attribution ?? [];
  const syntheticDays = data.meta.syntheticCount;

  // Pace gauge color
  const paceColor =
    progress?.paceLabel === 'ahead'  ? 'text-emerald-400' :
    progress?.paceLabel === 'behind' ? 'text-red-400'    :
                                       'text-amber-400';
  const PaceIcon = progress && progress.gapPp >= 0 ? TrendingUp : TrendingDown;

  return (
    <div className="space-y-5">
      {/* ── Pace gauge ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <motion.div
          className="card-glass border border-[#252840] rounded-lg p-4"
          whileHover={{ y: -1 }}
        >
          <div className="flex items-center gap-2 mb-2">
            <Target className="w-4 h-4 text-emerald-400" />
            <div className="text-[11px] uppercase tracking-wider text-[#7c82a0]">Annualized vs 40% target</div>
          </div>
          {progress ? (
            <>
              <div className={`text-3xl font-extrabold tracking-tight ${paceColor} flex items-baseline gap-2`}>
                <PaceIcon className="w-5 h-5" />
                {pct(progress.actualCAGR * 100, 1)}
              </div>
              <div className="text-xs text-[#7c82a0] mt-1">
                {progress.paceLabel === 'on-pace'
                  ? 'On pace'
                  : `${progress.gapPp >= 0 ? 'Ahead by' : 'Behind by'} ${Math.abs(progress.gapPp).toFixed(1)}pp`}
                {alpha && (
                  <span className="ml-2 text-[#4a5070]">
                    · vs SPY: <span className={alpha.alphaPp >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {pct(alpha.alphaPp, 1)}
                    </span>
                  </span>
                )}
              </div>
              {progress.requiredForwardCAGR != null && (
                <div className="text-[10px] text-[#4a5070] mt-1.5">
                  Need {pct(progress.requiredForwardCAGR * 100, 1)} forward to hit 40% by year-end
                </div>
              )}
            </>
          ) : <div className="text-xs text-[#7c82a0]">Need more snapshots</div>}
        </motion.div>

        {data.twr && (
          <motion.div className="card-glass border border-[#252840] rounded-lg p-4" whileHover={{ y: -1 }}>
            <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] mb-2">Cumulative TWR ({data.twr.daysCovered.toFixed(0)}d)</div>
            <div className={`text-3xl font-extrabold tracking-tight ${data.twr.twrPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {pct(data.twr.twrPct * 100, 2)}
            </div>
            <div className="text-xs text-[#7c82a0] mt-1">Time-weighted, cash-flow adjusted</div>
          </motion.div>
        )}

        {alpha && (
          <motion.div className="card-glass border border-[#252840] rounded-lg p-4" whileHover={{ y: -1 }}>
            <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] mb-2">Alpha vs SPY</div>
            <div className={`text-3xl font-extrabold tracking-tight ${alpha.alphaPp >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {pct(alpha.alphaPp, 2)}
            </div>
            <div className="text-xs text-[#7c82a0] mt-1">
              You: {pct(alpha.portfolioReturnPct, 1)} · SPY: {pct(alpha.spyReturnPct, 1)}
            </div>
          </motion.div>
        )}
      </div>

      {/* ── TWR over time chart ─────────────────────────────────────────────── */}
      <div className="card-glass border border-[#252840] rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wider text-[#7c82a0]">Return path</div>
          {syntheticDays > 0 && (
            <div className="text-[10px] text-[#4a5070]" title="Synthetic days are reconstructed from current positions + trade history. Approximate.">
              {syntheticDays} synthetic day{syntheticDays === 1 ? '' : 's'} (faded)
            </div>
          )}
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3248" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#4a5070' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: '#4a5070' }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(0)}%`} width={42} />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={0} stroke="#3a3f5a" strokeDasharray="2 2" />
              <Legend wrapperStyle={{ fontSize: 10, color: '#7c82a0' }} iconSize={10} />
              <Line type="monotone" dataKey="targetPct" name="40% target" stroke="#10b98180" strokeWidth={1} strokeDasharray="4 3" dot={false} />
              <Line type="monotone" dataKey="spyPct" name="SPY" stroke="#7c82a0" strokeWidth={1.25} dot={false} connectNulls />
              <Line type="monotone" dataKey="twrPct" name="Portfolio" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Pillar attribution ──────────────────────────────────────────────── */}
      {attribution.length > 0 && (
        <div className="card-glass border border-[#252840] rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] mb-3">Pillar contribution to total return</div>
          <div className="space-y-2">
            {attribution.map((a) => {
              const color = PILLAR_COLOR[a.pillar] ?? '#6b7280';
              const max = Math.max(...attribution.map((x) => Math.abs(x.contributionPp)));
              const widthPct = max > 0 ? (Math.abs(a.contributionPp) / max) * 100 : 0;
              return (
                <div key={a.pillar} className="flex items-center gap-3 text-xs">
                  <div className="w-20 capitalize text-[#e8eaf0]">{a.pillar}</div>
                  <div className="flex-1 h-2 bg-[#1a1e2e] rounded overflow-hidden relative">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${widthPct}%` }}
                      transition={{ duration: 0.6, ease: 'easeOut' }}
                      className="h-full rounded"
                      style={{ backgroundColor: color, opacity: a.contributionPp >= 0 ? 0.85 : 0.45 }}
                    />
                  </div>
                  <div className="w-24 text-right font-mono">
                    <span className={a.contributionPp >= 0 ? 'text-emerald-400' : 'text-red-400'}>{pct(a.contributionPp, 2)}pp</span>
                  </div>
                  <div className="w-20 text-right text-[10px] text-[#4a5070]">
                    own: {pct(a.returnPct, 1)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Footer: backfill action + meta ─────────────────────────────────── */}
      <div className="flex items-center justify-between text-[10px] text-[#4a5070]">
        <div>
          {data.meta.snapshotCount} snapshots · {data.meta.cashFlowCount} cash-flow events
        </div>
        <button
          onClick={runBackfill}
          disabled={backfilling}
          className="px-2 py-1 rounded hover:bg-white/[0.04] transition-colors flex items-center gap-1.5 disabled:opacity-50"
          title="Re-run synthetic backfill — never overwrites real snapshots"
        >
          {backfilling ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />}
          {backfilling ? 'Backfilling…' : 'Backfill'}
        </button>
      </div>
    </div>
  );
}
