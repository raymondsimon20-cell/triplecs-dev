import { clsx } from 'clsx';
import type { PillarType } from '@/lib/schwab/types';
import { PILLAR_LABELS } from '@/lib/classify';

const PILLAR_STYLES: Record<PillarType, string> = {
  growth:      'bg-sky-500/15 text-sky-400 border-sky-500/25',
  cornerstone: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  income:      'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  triples:     'bg-amber-500/15 text-amber-400 border-amber-500/25',
  other:       'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const PILLAR_ABBR: Record<PillarType, string> = {
  growth: 'GRW', cornerstone: 'CEF', income: 'HY', triples: 'LEV', other: 'OTH',
};

export function PillarBadge({ pillar }: { pillar: PillarType }) {
  return (
    <span
      className={clsx(
        'inline-block text-xs font-medium px-2 py-0.5 rounded border',
        PILLAR_STYLES[pillar]
      )}
    >
      {PILLAR_ABBR[pillar]}
    </span>
  );
}
