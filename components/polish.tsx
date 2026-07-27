'use client';

/**
 * Shared visual primitives from the 2026-07 polish pass.
 *
 *   TickerAvatar — rounded monogram square, color-hashed by fund family
 *                  (falls back to symbol hash) so families scan at a glance.
 *   PlChip       — tinted gain/loss pill; reads far stronger than bare
 *                  colored text inside dense tables.
 *   WeightBar    — thin proportional bar for portfolio-weight columns.
 *   TableSkeleton — shimmering placeholder rows for loading tables.
 */

import React from 'react';
import { getFundMetadata } from '@/lib/data/fund-metadata';

// Family → avatar palette (bg tint / text). Hand-picked for the major
// families; everything else hashes into the pool below.
const FAMILY_COLORS: Record<string, { bg: string; text: string }> = {
  Cornerstone: { bg: 'bg-violet-500/20',  text: 'text-violet-300'  },
  Roundhill:   { bg: 'bg-emerald-500/20', text: 'text-emerald-300' },
  YieldMax:    { bg: 'bg-amber-500/20',   text: 'text-amber-300'   },
  Defiance:    { bg: 'bg-cyan-500/20',    text: 'text-cyan-300'    },
  JPMorgan:    { bg: 'bg-blue-500/20',    text: 'text-blue-300'    },
  PIMCO:       { bg: 'bg-teal-500/20',    text: 'text-teal-300'    },
  RexShares:   { bg: 'bg-pink-500/20',    text: 'text-pink-300'    },
  Neos:        { bg: 'bg-indigo-500/20',  text: 'text-indigo-300'  },
  ProShares:   { bg: 'bg-orange-500/20',  text: 'text-orange-300'  },
  Direxion:    { bg: 'bg-orange-500/20',  text: 'text-orange-300'  },
};

const POOL: { bg: string; text: string }[] = [
  { bg: 'bg-blue-500/15',    text: 'text-blue-300'    },
  { bg: 'bg-emerald-500/15', text: 'text-emerald-300' },
  { bg: 'bg-violet-500/15',  text: 'text-violet-300'  },
  { bg: 'bg-amber-500/15',   text: 'text-amber-300'   },
  { bg: 'bg-pink-500/15',    text: 'text-pink-300'    },
  { bg: 'bg-teal-500/15',    text: 'text-teal-300'    },
  { bg: 'bg-cyan-500/15',    text: 'text-cyan-300'    },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function TickerAvatar({ symbol, size = 'md' }: { symbol: string; size?: 'sm' | 'md' }) {
  const family = getFundMetadata(symbol)?.family;
  const colors = (family && FAMILY_COLORS[family]) ?? POOL[hash(family ?? symbol) % POOL.length];
  const dims = size === 'sm' ? 'w-6 h-6 text-[9px]' : 'w-7 h-7 text-[10px]';
  return (
    <span
      className={`${dims} ${colors.bg} ${colors.text} rounded-lg inline-flex items-center justify-center font-semibold flex-shrink-0`}
      title={family}
      aria-hidden="true"
    >
      {symbol.slice(0, 2)}
    </span>
  );
}

export function PlChip({ value, pct = false, className = '' }: { value: number; pct?: boolean; className?: string }) {
  const pos = value > 0;
  const neg = value < 0;
  const text = pct
    ? `${pos ? '+' : ''}${value.toFixed(2)}%`
    : `${pos ? '+' : value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded-md tabular-nums whitespace-nowrap ${
      pos ? 'bg-emerald-500/12 text-emerald-300'
      : neg ? 'bg-red-500/12 text-red-300'
      : 'bg-[#2d3248] text-[#9aa2c0]'
    } ${className}`}>
      {value === 0 ? '--' : text}
    </span>
  );
}

export function WeightBar({ pct, max = 15, colorClass = 'bg-blue-500/70' }: { pct: number; max?: number; colorClass?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 justify-end w-full">
      <span className="w-12 h-1 bg-[#1f2334] rounded-full overflow-hidden hidden sm:inline-block">
        <span className={`block h-full rounded-full ${colorClass}`} style={{ width: `${Math.min((pct / max) * 100, 100)}%` }} />
      </span>
      <span className="tabular-nums text-[#7c82a0]">{pct.toFixed(2)}%</span>
    </span>
  );
}

export function TableSkeleton({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-[#1a1e2e]">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-3 py-2.5">
              <div
                className="h-3 bg-[#2d3248] rounded animate-pulse"
                style={{ width: c === 0 ? '60%' : '80%', animationDelay: `${(r * cols + c) * 40}ms` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
