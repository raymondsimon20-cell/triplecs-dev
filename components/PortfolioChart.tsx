'use client';

import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, BarChart2 } from 'lucide-react';

interface SnapshotPoint {
  savedAt: number;
  totalValue: number;
  equity: number | null;
  marginBalance: number | null;
  marginUtilizationPct: number | null;
  /** True when reconstructed by backfill (gross value only — no cash/margin data). */
  synthetic?: boolean;
}

interface ChartPoint {
  date: string;
  portfolioValue: number;
  equity: number | null;
  marginPct: number | null;
  synthetic: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fmt$(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a1d27] border border-[#3d4468] rounded-lg p-3 text-xs shadow-xl">
      <div className="text-[#7c82a0] mb-1.5">{label}</div>
      {payload.map((p: { name: string; value: number; color: string }, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono font-semibold text-white">
            {p.name === 'Margin %' ? `${p.value.toFixed(1)}%` : fmt$(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

interface PortfolioChartProps {
  /** Account to scope the snapshot series to. Omit for household. */
  accountHash?: string;
}

export function PortfolioChart({ accountHash }: PortfolioChartProps = {}) {
  const [data,    setData]    = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [view,    setView]    = useState<'value' | 'equity' | 'margin'>('value');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: '90' });
    if (accountHash) params.set('accountHash', accountHash);
    fetch(`/api/snapshots?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        const snapshots: SnapshotPoint[] = d.snapshots ?? [];
        const points: ChartPoint[] = snapshots
          .reverse() // oldest first for chart
          .map((s) => ({
            date:           new Date(s.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            portfolioValue: s.totalValue,
            // Legacy synthetic snapshots (written before the null fix) faked
            // equity=totalValue and margin=0 — treat those as unknown too so
            // old backfilled data stops distorting the equity/margin lines.
            equity:         s.synthetic ? null : s.equity,
            marginPct:      s.synthetic ? null : s.marginUtilizationPct,
            synthetic:      !!s.synthetic,
          }));
        setData(points);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountHash]);

  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (data.length < 2) {
    return (
      <div className="h-32 flex items-center justify-center text-[#4a5070] text-sm">
        <div className="text-center">
          <BarChart2 className="w-6 h-6 mx-auto mb-2 opacity-40" />
          Chart will populate after 2+ days of portfolio snapshots
        </div>
      </div>
    );
  }

  const VIEW_CONFIG = {
    value:  { key: 'portfolioValue' as const, label: 'Portfolio Value', color: '#3b82f6' },
    equity: { key: 'equity'         as const, label: 'Equity',          color: '#10b981' },
    margin: { key: 'marginPct'      as const, label: 'Borrowing %',     color: '#f59e0b' },
  };
  const cfg = VIEW_CONFIG[view];

  // Header change stats follow the ACTIVE series (not always portfolio value),
  // computed between the first and last days that actually have data for it —
  // synthetic (reconstructed) days have no equity/margin numbers.
  const series     = data.filter((p) => p[cfg.key] != null);
  const first      = series[0];
  const last       = series[series.length - 1];
  const firstVal   = (first?.[cfg.key] ?? 0) as number;
  const lastVal    = (last?.[cfg.key] ?? 0) as number;
  const change     = lastVal - firstVal;
  const isUp       = view === 'margin' ? change <= 0 : change >= 0; // falling borrowing is good
  const headline   = view === 'margin'
    ? `${change >= 0 ? '+' : ''}${change.toFixed(1)}pp`
    : `${change >= 0 ? '+' : ''}${firstVal > 0 ? ((change / firstVal) * 100).toFixed(1) : '0.0'}%`;
  const syntheticCount = data.filter((p) => p.synthetic).length;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {isUp
            ? <TrendingUp   className="w-4 h-4 text-emerald-400" />
            : <TrendingDown className="w-4 h-4 text-red-400" />
          }
          <span className={`text-sm font-semibold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
            {headline}
          </span>
          <span className="text-xs text-[#7c82a0]">
            {cfg.label} over {series.length} day{series.length === 1 ? '' : 's'}
          </span>
        </div>
        {/* View toggle */}
        <div className="flex gap-1">
          {(['value', 'equity', 'margin'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                view === v
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-[#4a5070] hover:text-white border border-transparent'
              }`}
            >
              {v === 'value' ? 'Value' : v === 'equity' ? 'Equity' : 'Borrowing %'}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={cfg.color} stopOpacity={0.15} />
                <stop offset="95%" stopColor={cfg.color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2d3248" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: '#4a5070' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#4a5070' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => view === 'margin' ? `${v}%` : fmt$(v)}
              width={48}
            />
            <Tooltip content={<CustomTooltip />} />
            {view === 'margin' && (
              <>
                <ReferenceLine y={30} stroke="#ef444450" strokeDasharray="4 2" />
                <ReferenceLine y={20} stroke="#f59e0b40" strokeDasharray="4 2" />
              </>
            )}
            <Area
              type="monotone"
              dataKey={cfg.key}
              name={cfg.label}
              stroke={cfg.color}
              strokeWidth={1.5}
              fill="url(#chartGrad)"
              dot={false}
              connectNulls={false}
              activeDot={{ r: 3, fill: cfg.color }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Reconstructed-history footnote */}
      {syntheticCount > 0 && (
        <p className="text-[10px] text-[#4a5070] leading-relaxed">
          {view === 'value'
            ? `The first ${syntheticCount} day${syntheticCount === 1 ? '' : 's'} are reconstructed from your trade log and closing prices — position value only (options, cash, and borrowing aren't in the reconstruction).`
            : `Equity and borrowing aren't known for the ${syntheticCount} reconstructed day${syntheticCount === 1 ? '' : 's'} — those lines start where live tracking began.`}
        </p>
      )}
    </div>
  );
}
