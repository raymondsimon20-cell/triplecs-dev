'use client';

/**
 * StatCard — shared stat tile for the P2P-style pages.
 *
 * Polish pass (2026-07): bigger tabular hero number, optional animated
 * count-up (rawValue + format), optional 30-point sparkline, optional accent
 * top border carrying the page color, and a staggered entrance (index prop).
 */

import React from 'react';
import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { InfoBubble, MetricHelpBody } from '@/components/InfoBubble';
import { metricHelp } from '@/lib/metric-help';

export function Sparkline({ points, stroke = '#378ADD', height = 26 }: {
  points: number[];
  stroke?: string;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 160;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = height - 3 - ((v - min) / range) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${coords.join(' L')}`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="mt-1.5" aria-hidden="true">
      <path d={`${line} L${w},${height} L0,${height} Z`} fill={stroke} opacity="0.12" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

export function StatCard({
  label, value, sub, valueClass = 'text-white', icon: Icon, iconClass = 'text-[#4a5070]',
  accentClass, spark, sparkColor, rawValue, format, index = 0, helpDetail, noHelp = false,
}: {
  label:      string;
  value:      string;
  sub?:       string;
  valueClass?: string;
  icon?:      LucideIcon;
  iconClass?: string;
  /** Tailwind border-color class for the 2px accent top border, e.g. 'border-t-blue-500/60'. */
  accentClass?: string;
  /** 30-point series for the sparkline under the number. */
  spark?:     number[];
  sparkColor?: string;
  /** When provided with `format`, the number counts up on load/update. */
  rawValue?:  number;
  format?:    (n: number) => string;
  /** Position in the grid — staggers the entrance animation. */
  index?:     number;
  /**
   * Extra rows appended inside the info bubble, for live figures the registry
   * can't know (actual inputs, the current denominator, and so on).
   */
  helpDetail?: React.ReactNode;
  /** Set to suppress the info bubble even when the registry has an entry. */
  noHelp?:    boolean;
}) {
  // Help is looked up by label rather than passed in, so a card gets a bubble
  // the moment lib/metric-help.ts gains an entry — no call-site edit needed.
  // The tradeoff is that labels are the join key: renaming a label silently
  // drops its bubble. scripts/check-metric-help.ts catches that.
  const help = noHelp ? undefined : metricHelp(label);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.3), ease: 'easeOut' }}
      className={`bg-[#12151f] border border-[#1f2334] rounded-lg p-3.5 ${accentClass ? `border-t-2 ${accentClass}` : ''}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 text-[11px] text-[#7c82a0]">
          {label}
          {help && (
            <InfoBubble label={label}>
              <MetricHelpBody label={label} detail={helpDetail} />
            </InfoBubble>
          )}
        </div>
        {Icon && <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${iconClass}`} />}
      </div>
      <div className={`text-2xl font-bold tabular-nums leading-tight ${valueClass}`}>
        {rawValue !== undefined && format
          ? <AnimatedNumber value={rawValue} format={format} />
          : value}
      </div>
      {spark && spark.length > 1 && <Sparkline points={spark} stroke={sparkColor ?? '#378ADD'} />}
      {sub && <div className="text-[10px] text-[#4a5070] mt-0.5">{sub}</div>}
    </motion.div>
  );
}
