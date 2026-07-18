'use client';
import { useState } from 'react';

/** Margin health meter with rule-threshold markers + what-if simulator. */
export function MarginMeter({
  equity,
  marginDebit,
  afw,
}: {
  equity: number;
  marginDebit: number;
  afw: number;
}) {
  const [simDraw, setSimDraw] = useState(0);
  const debit = marginDebit + simDraw;
  const gross = equity + debit;
  const util = gross > 0 ? debit / gross : 0;
  const tier =
    util >= 0.5 ? ['EMERGENCY', '#dc2626'] :
    util >= 0.3 ? ['CRITICAL', '#ea580c'] :
    util >= 0.2 ? ['WARNING', '#d97706'] :
    ['HEALTHY', '#16a34a'];

  return (
    <div className="card p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide opacity-70">Margin Health</h3>
        <span className="text-xs font-bold" style={{ color: tier[1] }}>{tier[0]}</span>
      </div>
      <div className="relative h-4 w-full rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className="h-4 rounded-full transition-all"
          style={{ width: `${Math.min(100, util * 100)}%`, backgroundColor: tier[1] }}
        />
        {/* Rule threshold markers: 20 / 30 / 50 (Schwab broker hard cap) */}
        {[0.2, 0.3, 0.5].map((t) => (
          <div
            key={t}
            className="absolute top-0 h-4 w-0.5 bg-slate-500"
            style={{ left: `${t * 100}%` }}
            title={`${t * 100}%${t === 0.5 ? ' — Schwab broker hard cap' : ''}`}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs opacity-70">
        <span>Utilization <b className="font-mono">{(util * 100).toFixed(1)}%</b></span>
        <span>AFW <b className="font-mono">${Math.round(afw - simDraw).toLocaleString()}</b></span>
        <span>Debit <b className="font-mono">${Math.round(debit).toLocaleString()}</b></span>
      </div>
      <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-700">
        <label className="text-xs opacity-70">
          Simulator — additional margin draw: <b className="font-mono">${simDraw.toLocaleString()}</b>
        </label>
        <input
          type="range"
          min={0}
          max={Math.max(10_000, Math.round(equity * 0.5))}
          step={1000}
          value={simDraw}
          onChange={(e) => setSimDraw(Number(e.target.value))}
          className="w-full"
        />
        {util > 0.5 && (
          <p className="text-xs font-semibold text-red-500">
            Above Schwab&apos;s 50% broker hard cap — this order would fail at the broker.
          </p>
        )}
      </div>
    </div>
  );
}
