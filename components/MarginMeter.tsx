'use client';

interface Props {
  equity: number;
  marginBalance: number;
}

export function MarginMeter({ equity, marginBalance }: Props) {
  const margin = Math.abs(marginBalance);
  const total = equity + margin;
  const pct = total > 0 ? (margin / total) * 100 : 0;

  const color =
    pct > 50 ? '#ef4444' :
    pct > 30 ? '#f97316' :
               '#22c55e';

  const label =
    pct > 50 ? 'DANGER — Reduce Now' :
    pct > 30 ? 'WARNING — Above Target' :
               'Safe';

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-sm text-[#7c82a0]">Margin Usage</span>
        <span className="text-sm font-bold" style={{ color }}>
          {pct.toFixed(1)}% — {label}
        </span>
      </div>
      <div className="h-2.5 bg-[#2d3248] rounded-full overflow-hidden">
        {/* Safe zone marker at 30% */}
        <div className="relative h-full">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }}
          />
          {/* 30% marker */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-amber-400/60"
            style={{ left: '30%' }}
            title="30% target limit"
          />
          {/* 50% marker */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500/60"
            style={{ left: '50%' }}
            title="50% hard max"
          />
        </div>
      </div>
      <div className="flex justify-between text-xs text-[#7c82a0]">
        <span>$0</span>
        <span>30% target</span>
        <span>50% max</span>
      </div>
    </div>
  );
}
