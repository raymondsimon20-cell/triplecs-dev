'use client';

/**
 * Shared column-sorting primitives for the P2P-style tables.
 *
 *   const { sortKey, sortDir, requestSort, sortRows } = useSort<Row>('value');
 *   ...sortRows(rows, { value: (r) => r.value, sym: (r) => r.sym })
 *   <SortTh id="value" label="Value" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
 *
 * First click on a column sorts descending (the common case for numbers);
 * clicking again flips to ascending.
 */

import React, { useCallback, useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

export function useSort<Row>(initialKey: string, initialDir: SortDir = 'desc') {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  const requestSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return prev;
      }
      setSortDir('desc');
      return key;
    });
  }, []);

  const sortRows = useCallback(
    (rows: Row[], accessors: Record<string, (r: Row) => string | number>) => {
      const acc = accessors[sortKey];
      if (!acc) return rows;
      const dir = sortDir === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        const va = acc(a), vb = acc(b);
        if (typeof va === 'string' || typeof vb === 'string') {
          return String(va).localeCompare(String(vb)) * dir;
        }
        return ((va as number) - (vb as number)) * dir;
      });
    },
    [sortKey, sortDir],
  );

  return { sortKey, sortDir, requestSort, sortRows };
}

export function SortTh({ id, label, align = 'left', first = false, last = false, sortKey, sortDir, onSort }: {
  id:      string;
  label:   string;
  align?:  'left' | 'right';
  first?:  boolean;
  last?:   boolean;
  sortKey: string;
  sortDir: SortDir;
  onSort:  (key: string) => void;
}) {
  const active = sortKey === id;
  return (
    <th className={`${first ? 'px-4' : last ? 'px-4' : 'px-2'} py-2.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={() => onSort(id)}
        className={`inline-flex items-center gap-1 transition-colors ${
          active ? 'text-white' : 'text-[#4a5070] hover:text-[#9aa2c0]'
        } ${align === 'right' ? 'flex-row-reverse' : ''}`}
        title={`Sort by ${label}`}
      >
        {label}
        <span className={`text-[9px] leading-none ${active ? 'text-blue-400' : 'text-transparent'}`}>
          {active && sortDir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}
