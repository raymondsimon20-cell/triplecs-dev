'use client';

import type { PillarSummary } from '@/lib/classify';
import type { StrategyTargets } from '@/lib/utils';

const PILLAR_COLORS: Record<string, string> = {
  triples: '#f59e0b',
  cornerstone: '#3b82f6',
  income: '#10b981',
  hedge: '#8b5cf6',
  other: '#6b7280',
};

interface Props {
  summaries: PillarSummary[];
  targets?: StrategyTargets;
}

function getTargetLabel(pct: number, pillar: string, targets?: StrategyTargets): string {
  if (!targets) return '';

  const pillars: Record<string, keyof StrategyTargets> = {
    triples: 'triplesPct',
    cornerstone: 'cornerstonePct',
    income: 'incomePct',
    hedge: 'hedgePct',
  };

  const key = pillars[pillar];
  if (!key) return '';

  const targetPct = targets[key];
  // Allow ±5% variance
  const min = targetPct - 5;
  const max = targetPct + 5;
  return `${min}–${max}%`;
}

function statusColor(pct: number, pillar: string, targets?: StrategyTargets): string {
  if (!targets) return 'text-[#7c82a0]';

  const pillars: Record<string, keyof StrategyTargets> = {
    triples: 'triplesPct',
    cornerstone: 'cornerstonePct',
    income: 'incomePct',
    hedge: 'hedgePct',
  };

  const key = pillars[pillar];
  if (!key) return 'text-[#7c82a0]';

  const target = targets[key];
  const min = target - 5;
  const max = target + 5;

  if (pct < min) return 'text-amber-400';
  if (pct > max) return 'text-red-400';
  return 'text-emerald-400';
}

export function PillarAllocationBar({ summaries, targets }: Props) {
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
          const color = statusColor(s.portfolioPercent, s.pillar, targets);
          const targetLabel = getTargetLabel(s.portfolioPercent, s.pillar, targets);
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
                {targetLabel && (
                  <div className="text-xs text-[#4a5070] mt-0.5">
                    Target: {targetLabel}
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
