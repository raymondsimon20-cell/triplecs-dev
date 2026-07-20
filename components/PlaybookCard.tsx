'use client';

/**
 * PlaybookCard — "if the market drops, here's the plan" — the Vol-7 downturn
 * playbook as an always-visible card, contextualized with the live SPY
 * drawdown so it reads as *your next move*, not a doc.
 */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, LifeBuoy } from 'lucide-react';

export function PlaybookCard({ spyDrawdownPct }: { spyDrawdownPct?: number }) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState(0);

  useEffect(() => {
    if (spyDrawdownPct != null) return;
    let cancelled = false;
    fetch('/api/market-correction')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.SPY?.correctionPct != null) setFetched(d.SPY.correctionPct);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [spyDrawdownPct]);

  const dd = Math.max(0, spyDrawdownPct ?? fetched);

  const steps: { at: string; plan: string; active: boolean }[] = [
    { at: 'Any dip',   plan: 'Dip ladder buys triples in 5% steps as they fall from highs.', active: dd > 0 },
    { at: '−10%',      plan: 'Buy $100K of triples. Sell Defiance/Roundhill first if raising cash — they fall least. 1/3 of every sale goes back into triples.', active: dd >= 10 },
    { at: '−20%',      plan: 'Second $100K into triples. Hedges scale to 5–10%. Deleverage — margin is the first thing to go in a real drawdown.', active: dd >= 20 },
    { at: '−30%',      plan: 'Third $100K (max $300K deployed). Harvest tax losses. Insurance puts ~10% below market, 0–15 days out.', active: dd >= 30 },
    { at: 'Recovery',  plan: 'At +10% off the lows: trim triples, shrink hedges back to $1.5–3K each, rotate gains into income funds.', active: false },
  ];

  return (
    <div className="rounded-xl border border-[#2d3248] bg-[#1a1d27] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-[#20243a] transition-colors"
      >
        <span className="flex items-center gap-2.5 text-sm font-semibold text-white">
          <LifeBuoy className="w-4 h-4 text-cyan-400" />
          If the market drops, the plan is…
          <span className="text-xs font-normal text-[#7c82a0]">
            {dd >= 1 ? `SPY is ${dd.toFixed(1)}% off its high` : 'SPY near its highs'}
          </span>
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-2 border-t border-[#2d3248] pt-3">
          {steps.map((s) => (
            <div key={s.at} className={`flex gap-3 text-xs rounded-lg px-3 py-2 ${s.active ? 'bg-cyan-500/10 border border-cyan-500/25' : ''}`}>
              <span className={`font-mono font-semibold w-16 shrink-0 ${s.active ? 'text-cyan-300' : 'text-[#7c82a0]'}`}>{s.at}</span>
              <span className={s.active ? 'text-[#c8cde0]' : 'text-[#7c82a0]'}>{s.plan}{s.active && ' ← you are here'}</span>
            </div>
          ))}
          <p className="text-[10px] text-[#4a5070]">
            From the Volume 7 playbook. The engine stages these moves automatically as each level hits — this card is so you know what to expect before it happens.
          </p>
        </div>
      )}
    </div>
  );
}
