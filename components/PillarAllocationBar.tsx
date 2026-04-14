'use client';

import type { PillarSummary } from '@/lib/classify';

const PILLAR_COLORS: Record<string, string> = {
  triples: '#f59e0b',
  cornerstone: '#3b82f6',
  income: '#10b981',
  hedge: '#8b5cf6',
  other: '#6b7280',
};

interface Props {
  summaries: PillarSummary[];
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

      {/* Legend */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {summaries.map((s) => (
          <div key={s.pillar} className="flex items-start gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full mt-0.5 flex-shrink-0"
              style={{ backgroundColor: PILLAR_COLORS[s.pillar] }}
            />
            <div className="min-w-0">
              <div className="text-xs text-[#7c82a0] truncate">{s.label}</div>
              <div className="text-sm font-semibold text-white">
                {s.portfolioPercent.toFixed(1)}%
              </div>
              <div className="text-xs text-[#7c82a0]">
                ${s.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
