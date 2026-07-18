'use client';
import { useMemo, useState } from 'react';

export interface PositionRow {
  symbol: string;
  pillar: string;
  quantity: number;
  marketValue: number;
  dayPL?: number;
}

type SortKey = 'symbol' | 'pillar' | 'marketValue' | 'dayPL';

export function PositionsTable({ rows }: { rows: PositionRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('marketValue');
  const [asc, setAsc] = useState(false);
  const [filter, setFilter] = useState('');

  const sorted = useMemo(() => {
    const f = filter.toUpperCase();
    return rows
      .filter((r) => !f || r.symbol.includes(f) || r.pillar.toUpperCase().includes(f))
      .sort((a, b) => {
        const av = a[sortKey] ?? 0;
        const bv = b[sortKey] ?? 0;
        const cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : Number(av) - Number(bv);
        return asc ? cmp : -cmp;
      });
  }, [rows, sortKey, asc, filter]);

  const th = (key: SortKey, label: string) => (
    <th
      className="cursor-pointer px-3 py-2 text-left text-xs font-semibold uppercase opacity-70 hover:opacity-100"
      onClick={() => (sortKey === key ? setAsc(!asc) : setSortKey(key))}
    >
      {label} {sortKey === key ? (asc ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between p-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide opacity-70">Positions ({rows.length})</h3>
        <input
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
        />
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[var(--card)]">
            <tr>{th('symbol', 'Symbol')}{th('pillar', 'Pillar')}{th('marketValue', 'Value')}{th('dayPL', 'Day P/L')}</tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.symbol} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-1.5 font-mono font-semibold">{r.symbol}</td>
                <td className="px-3 py-1.5 capitalize">{r.pillar}</td>
                <td className="px-3 py-1.5 font-mono">${Math.round(r.marketValue).toLocaleString()}</td>
                <td className={`px-3 py-1.5 font-mono ${(r.dayPL ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {r.dayPL != null ? `$${Math.round(r.dayPL).toLocaleString()}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
