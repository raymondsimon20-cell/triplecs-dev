'use client';

import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { PillarBadge } from './PillarBadge';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import { fmt$, gainLossColor } from '@/lib/utils';

type SortKey = 'symbol' | 'value' | 'gainLoss' | 'portfolioPct' | 'dayGL';

interface Props {
  positions: EnrichedPosition[];
}

const PILLAR_FILTER_OPTIONS: { value: PillarType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'triples', label: '3x Triples' },
  { value: 'cornerstone', label: 'Cornerstone' },
  { value: 'income', label: 'Core/Income' },
  { value: 'hedge', label: 'Hedges' },
  { value: 'other', label: 'Other' },
];

export function PositionsTable({ positions }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState<PillarType | 'all'>('all');

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(false); }
  };

  const filtered = positions.filter((p) => filter === 'all' || p.pillar === filter);

  const sorted = [...filtered].sort((a, b) => {
    let diff = 0;
    if (sortKey === 'symbol') diff = a.instrument.symbol.localeCompare(b.instrument.symbol);
    else if (sortKey === 'value') diff = a.marketValue - b.marketValue;
    else if (sortKey === 'gainLoss') diff = a.gainLoss - b.gainLoss;
    else if (sortKey === 'portfolioPct') diff = a.portfolioPercent - b.portfolioPercent;
    else if (sortKey === 'dayGL') diff = (a.todayGainLoss ?? 0) - (b.todayGainLoss ?? 0);
    return sortAsc ? diff : -diff;
  });

  const SortIcon = ({ col }: { col: SortKey }) =>
    sortKey === col
      ? sortAsc ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
      : <ChevronDown className="w-3 h-3 opacity-20" />;

  return (
    <div className="space-y-3">
      {/* Filter tabs */}
      <div className="flex gap-1 flex-wrap">
        {PILLAR_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value as PillarType | 'all')}
            aria-label={`Filter: ${opt.label}`}
            aria-pressed={filter === opt.value}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              filter === opt.value
                ? 'bg-[#3d4260] text-white'
                : 'text-[#7c82a0] hover:text-white hover:bg-[#2d3248]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Desktop table (hidden on mobile) ──────────────────────────────── */}
      <div className="hidden md:block overflow-x-auto rounded-lg border border-[#2d3248]">
        <table className="w-full text-sm" role="table" aria-label="Portfolio positions">
          <thead>
            <tr className="bg-[#22263a] text-[#7c82a0] text-xs uppercase tracking-wide">
              <th className="text-left px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('symbol')} aria-sort={sortKey === 'symbol' ? (sortAsc ? 'ascending' : 'descending') : 'none'}>
                <span className="flex items-center gap-1">Symbol <SortIcon col="symbol" /></span>
              </th>
              <th className="text-right px-4 py-3">Qty</th>
              <th className="text-right px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('value')} aria-sort={sortKey === 'value' ? (sortAsc ? 'ascending' : 'descending') : 'none'}>
                <span className="flex items-center gap-1 justify-end">Value <SortIcon col="value" /></span>
              </th>
              <th className="text-right px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('portfolioPct')} aria-sort={sortKey === 'portfolioPct' ? (sortAsc ? 'ascending' : 'descending') : 'none'}>
                <span className="flex items-center gap-1 justify-end">% Port <SortIcon col="portfolioPct" /></span>
              </th>
              <th className="text-right px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('gainLoss')} aria-sort={sortKey === 'gainLoss' ? (sortAsc ? 'ascending' : 'descending') : 'none'}>
                <span className="flex items-center gap-1 justify-end">Gain/Loss <SortIcon col="gainLoss" /></span>
              </th>
              <th className="text-right px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('dayGL')} aria-sort={sortKey === 'dayGL' ? (sortAsc ? 'ascending' : 'descending') : 'none'}>
                <span className="flex items-center gap-1 justify-end">Today <SortIcon col="dayGL" /></span>
              </th>
              <th className="text-right px-4 py-3">Avg Price</th>
              <th className="px-4 py-3">Pillar</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2d3248]">
            {sorted.map((pos) => {
              const gl = pos.gainLoss;
              const dgl = pos.todayGainLoss ?? 0;
              return (
                <tr
                  key={pos.instrument.symbol}
                  className="hover:bg-[#22263a]/60 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="font-mono font-semibold text-white">{pos.instrument.symbol}</div>
                    {pos.instrument.description && (
                      <div className="text-xs text-[#7c82a0] truncate max-w-[140px]">{pos.instrument.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[#e8eaf0]">
                    {pos.longQuantity > 0
                      ? pos.longQuantity.toLocaleString()
                      : pos.shortQuantity > 0
                      ? <span className="text-red-400">-{pos.shortQuantity}</span>
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-medium text-white">{fmt$(pos.marketValue)}</td>
                  <td className="px-4 py-3 text-right text-[#7c82a0]">{pos.portfolioPercent.toFixed(1)}%</td>
                  <td className={`px-4 py-3 text-right font-mono ${gainLossColor(gl)}`}>
                    {fmt$(gl)}
                    <div className="text-xs opacity-70">{pos.gainLossPercent >= 0 ? '+' : ''}{pos.gainLossPercent.toFixed(1)}%</div>
                  </td>
                  <td className={`px-4 py-3 text-right font-mono text-xs ${gainLossColor(dgl)}`}>
                    {dgl !== 0 ? fmt$(dgl) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[#7c82a0] text-xs">
                    {pos.averagePrice > 0 ? `$${pos.averagePrice.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-4 py-3"><PillarBadge pillar={pos.pillar} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="py-12 text-center text-[#7c82a0] text-sm">No positions in this category.</div>
        )}
      </div>

      {/* ── Mobile card view (hidden on desktop) ──────────────────────────── */}
      <div className="md:hidden space-y-2">
        {/* Sort controls for mobile */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-[#4a5070] uppercase tracking-wider">Sort by:</span>
          {(['value', 'gainLoss', 'dayGL', 'symbol'] as SortKey[]).map((key) => (
            <button
              key={key}
              onClick={() => handleSort(key)}
              aria-label={`Sort by ${key}`}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                sortKey === key
                  ? 'border-blue-500/40 text-blue-400 bg-blue-500/10'
                  : 'border-[#2d3248] text-[#7c82a0] hover:text-white'
              }`}
            >
              {key === 'value' ? 'Value' : key === 'gainLoss' ? 'G/L' : key === 'dayGL' ? 'Today' : 'Symbol'}
              {sortKey === key && (sortAsc ? ' ↑' : ' ↓')}
            </button>
          ))}
        </div>

        {sorted.map((pos) => {
          const gl = pos.gainLoss;
          const dgl = pos.todayGainLoss ?? 0;
          return (
            <div
              key={pos.instrument.symbol}
              className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2"
            >
              {/* Row 1: Symbol + Pillar + Value */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono font-semibold text-white text-sm">{pos.instrument.symbol}</span>
                  <PillarBadge pillar={pos.pillar} />
                </div>
                <span className="font-mono font-medium text-white text-sm tabular-nums">{fmt$(pos.marketValue)}</span>
              </div>

              {/* Row 2: Qty, %, Avg Price */}
              <div className="flex items-center justify-between text-xs text-[#7c82a0]">
                <span>
                  {pos.longQuantity > 0
                    ? `${pos.longQuantity.toLocaleString()} shares`
                    : pos.shortQuantity > 0
                    ? <span className="text-red-400">-{pos.shortQuantity} shares</span>
                    : '—'}
                </span>
                <span>{pos.portfolioPercent.toFixed(1)}% of portfolio</span>
              </div>

              {/* Row 3: Gain/Loss + Today */}
              <div className="flex items-center justify-between text-xs">
                <div className={`font-mono ${gainLossColor(gl)}`}>
                  G/L: {fmt$(gl)} ({pos.gainLossPercent >= 0 ? '+' : ''}{pos.gainLossPercent.toFixed(1)}%)
                </div>
                <div className={`font-mono ${gainLossColor(dgl)}`}>
                  Today: {dgl !== 0 ? fmt$(dgl) : '—'}
                </div>
              </div>
            </div>
          );
        })}

        {sorted.length === 0 && (
          <div className="py-12 text-center text-[#7c82a0] text-sm">No positions in this category.</div>
        )}
      </div>
    </div>
  );
}
