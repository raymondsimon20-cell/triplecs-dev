'use client';

import type { PillarSummary } from '@/lib/classify';

const PILLAR_COLORS: Record<string, string> = {
  triples: '#f59e0b',
  cornerstone: '#3b82f6',
  income: '#10b981',
  hedge: '#8b5cf6',
  other: '#6b7280',
};

// Strategy targets from the e-guides
const PILLAR_TARGETS: Record<string, { min: number; max: number; label: string }> = {
  triples:     { min: 10, max: 30, label: '10–30%' },
  cornerstone: { min: 20, max: 30, label: '20–30%' },
  income:      { min: 30, max: 55, label: '30–55%' },
  hedge:       { min: 5,  max: 15, label: '5–15%'  },
};

interface Props {
  summaries: PillarSummary[];
}

function statusColor(pct: number, pillar: string): string {
  const target = PILLAR_TARGETS[pillar];
  if (!target) return 'text-[#7c82a0]';
  if (pct < target.min) return 'text-amber-400';
  if (pct > target.max) return 'text-red-400';
  return 'text-emerald-400';
}

export function PillarAllocationBar({ summaries }: Props) {
  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="h-3 rounded-full overflow-hidden flex w-full bg-[#2d3248]">
        {summaries.map((s) => (
          <div
            key={s.pillar}
            style={{
              width: `${s.portfolioPercent}%`,
              backgroundColor: PILLAR_COLORS[s.pillar],
            }}
            title={`${s.label}: ${s.portfolioPercent.toFixed(1)}%`}
          />
        ))}
      </div>

      {/* Legend with targets */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {summaries.map((s) => {
          const target = PILLAR_TARGETS[s.pillar];
          const color = statusColor(s.portfolioPercent, s.pillar);
          return (
            <div key={s.pillar} className="flex items-start gap-2">
              <div
                className="w-2.5 h-2.5 rounded-full mt-0.5 flex-shrink-0"
                style={{ backgroundColor: PILLAR_COLORS[s.pillar] }}
              />
              <div className="min-w-0">
                <div className="text-xs text-[#7c82a0] truncate">{s.label}</div>
                <div className={`text-sm font-semibold ${color}`}>
                  {s.portfolioPercent.toFixed(1)}%
                </div>
                <div className="text-xs text-[#7c82a0]">
                  ${s.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </div>
                {target && (
                  <div className="text-xs text-[#4a5070] mt-0.5">
                    Target: {target.label}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
