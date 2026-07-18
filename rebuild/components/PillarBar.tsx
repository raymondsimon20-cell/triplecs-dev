'use client';
import { motion } from 'framer-motion';

const COLORS: Record<string, string> = {
  triples: '#8b5cf6',
  cornerstone: '#f59e0b',
  income: '#10b981',
  hedge: '#ef4444',
  cash: '#64748b',
  unknown: '#94a3b8',
};

const TARGETS: Record<string, number> = { triples: 0.10, cornerstone: 0.20, income: 0.65, hedge: 0.05 };

export function PillarBar({ percents }: { percents: Record<string, number> }) {
  const entries = Object.entries(percents).filter(([, v]) => v > 0.001);
  return (
    <div className="card p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">Pillar Allocation</h3>
      <div className="flex h-6 w-full overflow-hidden rounded-full">
        {entries.map(([pillar, pct]) => (
          <motion.div
            key={pillar}
            initial={{ width: 0 }}
            animate={{ width: `${pct * 100}%` }}
            style={{ backgroundColor: COLORS[pillar] }}
            title={`${pillar}: ${(pct * 100).toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        {entries.map(([pillar, pct]) => (
          <span key={pillar} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[pillar] }} />
            <span className="capitalize">{pillar}</span>
            <span className="font-mono">{(pct * 100).toFixed(1)}%</span>
            {TARGETS[pillar] != null && (
              <span className="opacity-50">/ {(TARGETS[pillar] * 100).toFixed(0)}%</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
