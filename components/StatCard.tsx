'use client';

/**
 * StatCard — shared stat tile for the P2P-style pages, with an optional
 * corner icon. Keeps the label top-left, icon top-right in the page accent.
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';

export function StatCard({ label, value, sub, valueClass = 'text-white', icon: Icon, iconClass = 'text-[#4a5070]' }: {
  label:      string;
  value:      string;
  sub?:       string;
  valueClass?: string;
  icon?:      LucideIcon;
  iconClass?: string;
}) {
  return (
    <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3.5">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="text-[11px] text-[#7c82a0]">{label}</div>
        {Icon && <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${iconClass}`} />}
      </div>
      <div className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-[#4a5070] mt-0.5">{sub}</div>}
    </div>
  );
}
