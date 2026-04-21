'use client';

import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, BarChart2 } from 'lucide-react';

interface SnapshotPoint {
  savedAt: number;
  totalValue: number;
  equity: number;
  marginBalance: number;
  marginUtilizationPct: number;
}

interface ChartPoint {
  date: string;
  portfolioValue: number;
  equity: number;
  marginPct: number;
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

export function PortfolioChart() {
  const [data,    setData]    = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [view,    setView]    = useState<'value' | 'equity' | 'margin'>('value');

  useEffect(() => {
    fetch('/api/snapshots?limit=90')
      .then((r) => r.json())
      .then((d) => {
        const snapshots: SnapshotPoint[] = d.snapshots ?? [];
        const points: ChartPoint[] = snapshots
          .reverse() // oldest first for chart
          .map((s) => ({
            date:           new Date(s.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            portfolioValue: s.totalValue,
            equity:         s.equity,
            marginPct:      s.marginUtilizationPct,
          }));
        setData(points);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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

  const first = data[0];
  const last  = data[data.length - 1];

  const valueChange = last.portfolioValue - first.portfolioValue;
  const valuePct    = first.portfolioValue > 0 ? (valueChange / first.portfolioValue) * 100 : 0;
  const isUp        = valueChange >= 0;

  const VIEW_CONFIG = {
    value:  { key: 'portfolioValue', label: 'Portfolio Value', color: '#3b82f6', gradFrom: '#3b82f620', gradTo: '#3b82f605' },
    equity: { key: 'equity',         label: 'Equity',          color: '#10b981', gradFrom: '#10b98120', gradTo: '#10b98105' },
    margin: { key: 'marginPct',      label: 'Margin %',        color: '#f59e0b', gradFrom: '#f59e0b20', gradTo: '#f59e0b05' },
  };

  const cfg = VIEW_CONFIG[view];

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
            {isUp ? '+' : ''}{valuePct.toFixed(1)}%
          </span>
          <span className="text-xs text-[#7c82a0]">over {data.length}d</span>
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
              {v === 'value' ? 'Value' : v === 'equity' ? 'Equity' : 'Margin %'}
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
              activeDot={{ r: 3, fill: cfg.color }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
