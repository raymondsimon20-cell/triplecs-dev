'use client';

/**
 * SettingsPanel — configurable strategy targets for the Triple C dashboard.
 *
 * Persists to localStorage so settings survive page refreshes.
 * Export `useStrategyTargets()` from this file to read current settings
 * in any component.
 *
 * Settings exposed:
 *   • Pillar allocation targets (Triples %, Cornerstone %, Income %, Hedge %)
 *   • Margin warn / limit thresholds
 *   • Fund family concentration cap
 *   • FIRE monthly income target
 */

import { useState, useEffect, useCallback } from 'react';
import { Settings, RotateCcw, Check } from 'lucide-react';
import { DEFAULT_TARGETS, type StrategyTargets } from '@/lib/utils';

// ─── Storage helpers ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'triplec_strategy_targets';

function loadTargets(): StrategyTargets {
  if (typeof window === 'undefined') return { ...DEFAULT_TARGETS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TARGETS };
    return { ...DEFAULT_TARGETS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_TARGETS };
  }
}

function saveTargets(t: StrategyTargets) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

// ─── Public hook — read targets from anywhere ─────────────────────────────────

let _listeners: Array<(t: StrategyTargets) => void> = [];
let _current: StrategyTargets = DEFAULT_TARGETS;

export function useStrategyTargets(): StrategyTargets {
  const [targets, setTargets] = useState<StrategyTargets>(() => loadTargets());

  useEffect(() => {
    // Sync from localStorage on mount (handles SSR)
    setTargets(loadTargets());

    const handler = (t: StrategyTargets) => setTargets(t);
    _listeners.push(handler);
    return () => { _listeners = _listeners.filter((l) => l !== handler); };
  }, []);

  return targets;
}

function broadcast(t: StrategyTargets) {
  _current = t;
  saveTargets(t);
  _listeners.forEach((l) => l(t));
}

// ─── Slider row helper ────────────────────────────────────────────────────────

function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  suffix = '%',
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm text-white font-medium">{label}</span>
          <span className="ml-2 text-xs text-[#7c82a0]">{description}</span>
        </div>
        <span className="text-sm font-bold text-blue-400 tabular-nums w-16 text-right">
          {value}{suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 bg-[#2d3248] rounded-full appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5
          [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-blue-400 [&::-webkit-slider-thumb]:cursor-pointer
          [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-125"
      />
      <div className="flex justify-between text-[10px] text-[#4a5070]">
        <span>{min}{suffix}</span>
        <span>{max}{suffix}</span>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<StrategyTargets>(() => loadTargets());

  // Keep draft in sync with persisted values on mount
  useEffect(() => { setDraft(loadTargets()); }, []);

  const set = useCallback(<K extends keyof StrategyTargets>(key: K, value: StrategyTargets[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  /** Set a pillar % and auto-adjust the largest other pillar to keep sum ≤ 100 */
  const setPillar = useCallback((key: 'triplesPct' | 'cornerstonePct' | 'incomePct' | 'hedgePct', value: number) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      const pillars: typeof key[] = ['triplesPct', 'cornerstonePct', 'incomePct', 'hedgePct'];
      let sum = pillars.reduce((s, k) => s + next[k], 0);

      // If over 100, reduce the other pillars starting from the largest
      if (sum > 100) {
        const others = pillars.filter((k) => k !== key).sort((a, b) => next[b] - next[a]);
        for (const other of others) {
          const excess = sum - 100;
          const reduction = Math.min(next[other], excess);
          next[other] -= reduction;
          sum -= reduction;
          if (sum <= 100) break;
        }
      }
      return next;
    });
  }, []);

  function handleSave() {
    broadcast(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    setDraft({ ...DEFAULT_TARGETS });
    broadcast({ ...DEFAULT_TARGETS });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const allocationSum = draft.triplesPct + draft.cornerstonePct + draft.incomePct + draft.hedgePct;
  const sumOk = allocationSum === 100;

  return (
    <>
      {/* Gear icon button in the header */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors"
        title="Strategy Settings"
        aria-label="Open strategy settings"
      >
        <Settings className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Settings</span>
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-[#1a1d27] border border-[#2d3248] rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2d3248]">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-blue-400" />
                <span className="font-bold text-white">Strategy Settings</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-[#7c82a0] hover:text-white transition-colors text-xl leading-none"
              >
                ×
              </button>
            </div>

            <div className="px-6 py-5 space-y-7">
              {/* Pillar allocation targets */}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">
                    Pillar Allocation Targets
                  </h3>
                  <span className={`text-xs font-bold tabular-nums ${sumOk ? 'text-emerald-400' : 'text-red-400'}`}>
                    {allocationSum}% total {sumOk ? '✓' : '≠ 100%'}
                  </span>
                </div>
                <SliderRow
                  label="Triples"
                  description="3× leveraged ETFs (UPRO, TQQQ…)"
                  value={draft.triplesPct}
                  min={0} max={40}
                  onChange={(v) => setPillar('triplesPct', v)}
                />
                <SliderRow
                  label="Cornerstone"
                  description="CLM / CRF closed-end funds"
                  value={draft.cornerstonePct}
                  min={0} max={40}
                  onChange={(v) => setPillar('cornerstonePct', v)}
                />
                <SliderRow
                  label="Core / Income"
                  description="Yieldmax, Defiance, JEPI…"
                  value={draft.incomePct}
                  min={0} max={100}
                  onChange={(v) => setPillar('incomePct', v)}
                />
                <SliderRow
                  label="Hedge"
                  description="Inverse ETFs, put protection"
                  value={draft.hedgePct}
                  min={0} max={30}
                  onChange={(v) => setPillar('hedgePct', v)}
                />
              </section>

              {/* Margin thresholds */}
              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">
                  Margin Thresholds
                </h3>
                <SliderRow
                  label="Warn at"
                  description="Orange alert level"
                  value={draft.marginWarnPct}
                  min={10} max={40}
                  onChange={(v) => set('marginWarnPct', v)}
                />
                <SliderRow
                  label="Limit at"
                  description="Red / reduce-now level"
                  value={draft.marginLimitPct}
                  min={20} max={60}
                  onChange={(v) => set('marginLimitPct', v)}
                />
              </section>

              {/* Fund family cap */}
              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">
                  Concentration Limits
                </h3>
                <SliderRow
                  label="Fund family cap"
                  description="Max % in any single fund family"
                  value={draft.familyCapPct}
                  min={5} max={50}
                  onChange={(v) => set('familyCapPct', v)}
                />
              </section>

              {/* FIRE target */}
              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">
                  FIRE Target
                </h3>
                <SliderRow
                  label="Monthly income goal"
                  description="Your FIRE number"
                  value={draft.fireNumber}
                  min={1000} max={50000} step={500}
                  suffix=""
                  onChange={(v) => set('fireNumber', v)}
                />
                <div className="text-xs text-[#4a5070]">
                  Current target: ${draft.fireNumber.toLocaleString()}/mo · ${(draft.fireNumber * 12).toLocaleString()}/yr
                </div>
              </section>
            </div>

            {/* Footer actions */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-[#2d3248]">
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Reset to defaults
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
              >
                {saved ? <Check className="w-4 h-4" /> : null}
                {saved ? 'Saved!' : 'Save Settings'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
