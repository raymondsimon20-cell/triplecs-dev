'use client';

/**
 * PillarTour — first-run explainer: the four pillars in one sentence each.
 * Shows once (dismissal persisted in localStorage); reopenable from the
 * "What's the strategy?" link it leaves behind.
 */

import { useEffect, useState } from 'react';
import { X, HelpCircle } from 'lucide-react';

const KEY = 'triple-c-pillar-tour-dismissed';

const PILLARS = [
  { name: 'Triples',     color: 'text-violet-300 border-violet-500/30 bg-violet-500/10',
    text: '3× leveraged index ETFs (UPRO, TQQQ). The growth engine — bought on dips, trimmed after runs. ~10% of the portfolio.' },
  { name: 'Cornerstone', color: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
    text: 'CLM and CRF funds paying ~21% yearly, reinvested at a built-in discount. The compounding core. ~20%.' },
  { name: 'Core/Income', color: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
    text: 'Dividend funds across many families — your monthly paycheck. The biggest slice at ~65%.' },
  { name: 'Hedges',      color: 'text-red-300 border-red-500/30 bg-red-500/10',
    text: 'Inverse ETFs and put options that profit when markets fall. Insurance — always at least 1%.' },
];

export function PillarTour() {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try { setDismissed(localStorage.getItem(KEY) === '1'); } catch { /* ignore */ }
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
  };
  const reopen = () => {
    setDismissed(false);
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  };

  if (dismissed) {
    return (
      <button
        onClick={reopen}
        className="flex items-center gap-1.5 text-[11px] text-[#4a5070] hover:text-[#7c82a0] transition-colors"
      >
        <HelpCircle className="w-3.5 h-3.5" /> What&apos;s the strategy?
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-[#2d3248] bg-[#1a1d27] p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">How this portfolio works</h3>
          <p className="text-xs text-[#7c82a0] mt-0.5">
            Four jobs, four pillars. Everything the app suggests is about keeping each one at its target size.
          </p>
        </div>
        <button onClick={dismiss} className="text-[#4a5070] hover:text-white transition-colors" aria-label="Dismiss">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {PILLARS.map((p) => (
          <div key={p.name} className={`rounded-lg border px-3 py-2.5 ${p.color}`}>
            <div className="text-xs font-semibold mb-1">{p.name}</div>
            <div className="text-[11px] leading-relaxed opacity-90">{p.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
