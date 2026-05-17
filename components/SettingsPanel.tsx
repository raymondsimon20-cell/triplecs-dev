'use client';

/**
 * SettingsPanel — configurable strategy targets for the Triple C dashboard.
 *
 * Two-tier scope (2026-05):
 *   • "global" (default) — shared across all accounts. Mirrored to /api/strategy
 *     so the daily cron + signal engine see the same targets the UI uses.
 *   • per-account override — keyed by accountHash. UI-only: the cron engine
 *     has no notion of account-specific targets. When an override exists,
 *     useStrategyTargets(accountHash) returns it; otherwise falls back to
 *     global.
 *
 * Storage keys:
 *   • `triplec_strategy_targets`              — global
 *   • `triplec_strategy_targets:{accountKey}` — per-account override
 *
 * Public API:
 *   • useStrategyTargets(accountKey?)         — reactive read
 *   • updateStrategyTargets(t, accountKey?)   — programmatic write
 *   • <SettingsPanel accountKey accountLabel /> — UI; edits the scope of the
 *     currently-selected account, or global when accountKey is 'all'/undefined
 */

import { useState, useEffect, useCallback } from 'react';
import { Settings, RotateCcw, Check, Trash2 } from 'lucide-react';
import { DEFAULT_TARGETS, type StrategyTargets } from '@/lib/utils';
import { AutoConfigSection } from './AutoConfigSection';

// ─── Storage helpers ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'triplec_strategy_targets';

/** Normalise an accountKey into either undefined (global) or a real hash. */
function normaliseScope(accountKey?: string): string | undefined {
  if (!accountKey || accountKey === 'all' || accountKey === 'global') return undefined;
  return accountKey;
}

function storageKeyFor(scope: string | undefined): string {
  return scope ? `${STORAGE_KEY}:${scope}` : STORAGE_KEY;
}

function loadGlobal(): StrategyTargets {
  if (typeof window === 'undefined') return { ...DEFAULT_TARGETS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TARGETS };
    return { ...DEFAULT_TARGETS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_TARGETS };
  }
}

function loadOverride(scope: string): StrategyTargets | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKeyFor(scope));
    if (!raw) return null;
    return { ...DEFAULT_TARGETS, ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

function hasOverride(scope: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(storageKeyFor(scope)) != null;
  } catch {
    return false;
  }
}

/** Resolve effective targets for a given scope (override > global). */
function loadTargets(accountKey?: string): StrategyTargets {
  const scope = normaliseScope(accountKey);
  if (scope) {
    const override = loadOverride(scope);
    if (override) return override;
  }
  return loadGlobal();
}

function writeTargets(t: StrategyTargets, accountKey?: string) {
  const scope = normaliseScope(accountKey);
  try { localStorage.setItem(storageKeyFor(scope), JSON.stringify(t)); } catch { /* ignore */ }
}

function clearOverride(scope: string) {
  try { localStorage.removeItem(storageKeyFor(scope)); } catch { /* ignore */ }
}

/**
 * Mirror targets to the server-side blob via /api/strategy. Per-account
 * overrides land at `/api/strategy?accountHash=<hash>` so the engine's
 * per-account loop reads them on the next run. Global writes hit the
 * unscoped endpoint as before. Fire-and-forget.
 */
async function mirrorTargetsToServer(t: StrategyTargets, scope?: string): Promise<void> {
  try {
    const url = scope
      ? `/api/strategy?accountHash=${encodeURIComponent(scope)}`
      : '/api/strategy';
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(t),
      keepalive: true,
    });
  } catch (err) {
    console.warn('[SettingsPanel] mirror to /api/strategy failed:', err);
  }
}

/**
 * Clear a per-account override on the server so the engine falls back to
 * global next run. Fire-and-forget.
 */
async function clearOverrideOnServer(scope: string): Promise<void> {
  try {
    await fetch(`/api/strategy?accountHash=${encodeURIComponent(scope)}`, {
      method: 'DELETE',
      keepalive: true,
    });
  } catch (err) {
    console.warn('[SettingsPanel] clear override on server failed:', err);
  }
}

/**
 * Fetch the server-side strategy on mount. If the server copy is newer than
 * localStorage (different from defaults), use it as the source of truth for
 * GLOBAL targets so cross-device + cron-side state agree with the UI.
 */
async function fetchServerTargets(): Promise<StrategyTargets | null> {
  try {
    const r = await fetch('/api/strategy', { credentials: 'include' });
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.targets && typeof d.targets === 'object') {
      return { ...DEFAULT_TARGETS, ...d.targets };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Listener bus — broadcasts scope-specific changes ─────────────────────────

type Listener = (scope: string | undefined, t: StrategyTargets) => void;
let _listeners: Listener[] = [];

function broadcast(t: StrategyTargets, accountKey?: string, opts?: { skipServerMirror?: boolean }) {
  const scope = normaliseScope(accountKey);
  writeTargets(t, accountKey);
  if (!opts?.skipServerMirror) {
    // Mirror writes to the server-side blob so the cron + per-account engine
    // pick them up on the next run. Global writes hit the unscoped endpoint;
    // per-account overrides include ?accountHash=<scope>.
    void mirrorTargetsToServer(t, scope);
  }
  _listeners.forEach((l) => l(scope, t));
}

// ─── Public hook ──────────────────────────────────────────────────────────────

/**
 * Returns the strategy targets that apply to the given accountKey.
 *   - useStrategyTargets()           → global
 *   - useStrategyTargets('all')      → global (alias)
 *   - useStrategyTargets(<hash>)     → per-account override if present, else global
 */
export function useStrategyTargets(accountKey?: string): StrategyTargets {
  const scope = normaliseScope(accountKey);
  const [targets, setTargets] = useState<StrategyTargets>(() => loadTargets(accountKey));

  useEffect(() => {
    setTargets(loadTargets(accountKey));

    // Server reconciliation only applies to global — the engine doesn't know
    // about per-account overrides. If we're scoped to an account but no
    // override exists yet, we still want global to come in from the server.
    void (async () => {
      const server = await fetchServerTargets();
      if (!server) return;
      const localGlobal = loadGlobal();
      const differs = (Object.keys(server) as Array<keyof StrategyTargets>)
        .some((k) => server[k] !== localGlobal[k]);
      if (differs) {
        // Write server values into global (skip mirroring back to avoid loops).
        broadcast(server, undefined, { skipServerMirror: true });
      }
      // Re-resolve in case our scope falls back to global.
      setTargets(loadTargets(accountKey));
    })();

    const handler: Listener = (changedScope) => {
      // If a change touches our scope, or touches global while we have no
      // override of our own, refresh.
      const ourOverride = scope ? hasOverride(scope) : false;
      const isOurScope  = changedScope === scope;
      const isGlobalAffectsUs = !changedScope && (!scope || !ourOverride);
      if (isOurScope || isGlobalAffectsUs) {
        setTargets(loadTargets(accountKey));
      }
    };
    _listeners.push(handler);
    return () => { _listeners = _listeners.filter((l) => l !== handler); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  return targets;
}

/** Programmatic write. accountKey defaults to global. */
export function updateStrategyTargets(newTargets: StrategyTargets, accountKey?: string) {
  broadcast(newTargets, accountKey);
}

/**
 * Non-hook, synchronous resolver. Use when you need per-account targets in a
 * context that can't call hooks (loops, effects iterating multiple accounts,
 * one-off computations). Resolution order matches `useStrategyTargets`:
 * per-account override (if accountKey is a real hash) → global → defaults.
 */
export function loadStrategyTargetsFor(accountKey?: string): StrategyTargets {
  return loadTargets(accountKey);
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

interface SettingsPanelProps {
  /** Account scope to edit. 'all' / undefined edits the global default. */
  accountKey?: string;
  /** Human-readable label for the current scope (e.g. nickname or last4). */
  accountLabel?: string;
}

export function SettingsPanel({ accountKey, accountLabel }: SettingsPanelProps = {}) {
  const scope = normaliseScope(accountKey);
  const isGlobalScope = !scope;
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<StrategyTargets>(() => loadTargets(accountKey));
  const [overrideActive, setOverrideActive] = useState<boolean>(() => (scope ? hasOverride(scope) : false));

  // Re-sync draft when the active scope changes (account switch) or panel opens.
  useEffect(() => {
    setDraft(loadTargets(accountKey));
    setOverrideActive(scope ? hasOverride(scope) : false);
  }, [accountKey, scope, open]);

  const set = useCallback(<K extends keyof StrategyTargets>(key: K, value: StrategyTargets[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  type PillarKey = 'triplesPct' | 'cornerstonePct' | 'incomePct' | 'hedgePct';
  const PILLAR_KEYS: PillarKey[] = ['triplesPct', 'cornerstonePct', 'incomePct', 'hedgePct'];

  const setPillar = useCallback((key: PillarKey, value: number) => {
    setDraft((prev) => {
      const next: Record<string, number> = { ...prev, [key]: value };
      let sum = PILLAR_KEYS.reduce((s, k) => s + next[k], 0);
      if (sum > 100) {
        const others = PILLAR_KEYS.filter((k) => k !== key).sort((a, b) => next[b] - next[a]);
        for (const other of others) {
          const excess = sum - 100;
          const reduction = Math.min(next[other], excess);
          next[other] -= reduction;
          sum -= reduction;
          if (sum <= 100) break;
        }
      }
      return next as unknown as StrategyTargets;
    });
    // Editing implies opting into an override at this scope.
    if (scope && !overrideActive) setOverrideActive(true);
  }, [PILLAR_KEYS, scope, overrideActive]);

  function handleSave() {
    if (isGlobalScope) {
      broadcast(draft);  // global
    } else if (overrideActive) {
      broadcast(draft, scope);  // per-account override
    } else {
      // Toggle was off and user hit Save — treat as a "use global" intent.
      // Clear the override locally and on the server so the engine falls back
      // to global on next run, then refresh listeners.
      if (scope) {
        clearOverride(scope);
        void clearOverrideOnServer(scope);
      }
      const g = loadGlobal();
      _listeners.forEach((l) => l(scope, g));
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    if (isGlobalScope) {
      setDraft({ ...DEFAULT_TARGETS });
      broadcast({ ...DEFAULT_TARGETS });
    } else {
      // For a per-account scope, "Reset" clears the override locally AND on
      // the server so the engine's next run falls back to global.
      if (scope) {
        clearOverride(scope);
        void clearOverrideOnServer(scope);
      }
      setOverrideActive(false);
      const g = loadGlobal();
      setDraft(g);
      // Broadcast at our scope so listeners re-resolve to global. Skip the
      // server mirror — we just hit DELETE.
      _listeners.forEach((l) => l(scope, g));
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const allocationSum = draft.triplesPct + draft.cornerstonePct + draft.incomePct + draft.hedgePct;
  const sumOk = allocationSum === 100;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors"
        title="Strategy Settings"
        aria-label="Open strategy settings"
      >
        <Settings className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Settings</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-[#1a1d27] border border-[#2d3248] rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
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

            {/* Scope chip ───────────────────────────────────────────────── */}
            <div className="px-6 pt-4 pb-1">
              {isGlobalScope ? (
                <div className="text-[11px] text-[#9aa2c0] bg-[#22263a] border border-[#2d3248] rounded-md px-3 py-2 flex items-center gap-2">
                  <span className="font-semibold text-white">Global / All accounts</span>
                  <span className="text-[#7c82a0]">— changes affect every account that doesn't have its own override, and sync to the cron engine.</span>
                </div>
              ) : (
                <div className="text-[11px] text-[#9aa2c0] bg-[#22263a] border border-[#2d3248] rounded-md px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[#7c82a0]">Editing:</span>
                      <span className="font-semibold text-white truncate">{accountLabel ?? scope?.slice(0, 8) ?? 'this account'}</span>
                      {overrideActive
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">override</span>
                        : <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2d3248] text-[#9aa2c0]">using global</span>}
                    </div>
                    <label className="flex items-center gap-1.5 text-[10px] text-[#9aa2c0] cursor-pointer flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={overrideActive}
                        onChange={(e) => setOverrideActive(e.target.checked)}
                        className="accent-blue-500"
                      />
                      Override
                    </label>
                  </div>
                  {!overrideActive && (
                    <div className="text-[10px] text-[#7c82a0]">
                      This account currently uses the global defaults. Tick "Override" and save to give it its own targets.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-5 space-y-7">
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">
                    Pillar Allocation Targets
                  </h3>
                  <span className={`text-xs font-bold tabular-nums ${sumOk ? 'text-emerald-400' : 'text-red-400'}`}>
                    {allocationSum}% total {sumOk ? '✓' : '≠ 100%'}
                  </span>
                </div>
                <SliderRow label="Triples"     description="3× leveraged ETFs (UPRO, TQQQ…)" value={draft.triplesPct}     min={0} max={40}  onChange={(v) => setPillar('triplesPct', v)} />
                <SliderRow label="Cornerstone" description="CLM / CRF closed-end funds"      value={draft.cornerstonePct} min={0} max={40}  onChange={(v) => setPillar('cornerstonePct', v)} />
                <SliderRow label="Core / Income" description="Yieldmax, Defiance, JEPI…"     value={draft.incomePct}     min={0} max={100} onChange={(v) => setPillar('incomePct', v)} />
                <SliderRow label="Hedge"       description="Inverse ETFs, put protection"   value={draft.hedgePct}      min={0} max={30}  onChange={(v) => setPillar('hedgePct', v)} />
              </section>

              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">Margin Settings</h3>
                <div className="text-[10px] text-[#4a5070]">
                  Schwab caps utilization at 50% — values above 50 are clamped server-side.
                </div>
                <SliderRow label="Interest rate"      description="Your Schwab margin rate"                            value={draft.marginRatePct}          min={0}  max={15} step={0.25} suffix="%" onChange={(v) => set('marginRatePct', v)} />
                <SliderRow label="Warn at"            description="UI warning level (informational only)"               value={draft.marginWarnPct}          min={10} max={50}              onChange={(v) => set('marginWarnPct', v)} />
                <SliderRow label="Trim fires above"   description="MAINTENANCE_RANKED_TRIM fires past this"             value={draft.marginLimitPct}         min={20} max={50}              onChange={(v) => set('marginLimitPct', v)} />
                <SliderRow label="Trim target"        description="Trim aims to bring margin back here"                 value={draft.marginTrimTargetPct}    min={15} max={50}              onChange={(v) => set('marginTrimTargetPct', v)} />
                <SliderRow label="New-buy ceiling"    description="PILLAR_FILL stops proposing new positions above this" value={draft.marginNewBuyCeilingPct} min={20} max={50}              onChange={(v) => set('marginNewBuyCeilingPct', v)} />
              </section>

              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">Concentration Limits</h3>
                <SliderRow label="Fund family cap" description="Max % in any single fund family" value={draft.familyCapPct} min={5} max={50} onChange={(v) => set('familyCapPct', v)} />
              </section>

              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">FIRE Target</h3>
                <SliderRow label="Monthly income goal" description="Your FIRE number" value={draft.fireNumber} min={1000} max={50000} step={500} suffix="" onChange={(v) => set('fireNumber', v)} />
                <div className="text-xs text-[#4a5070]">
                  Current target: ${draft.fireNumber.toLocaleString()}/mo · ${(draft.fireNumber * 12).toLocaleString()}/yr
                </div>
              </section>

              {/* Per-account / household autopilot config — independent of the
                  strategy-targets draft above. Its own load + save lifecycle. */}
              <AutoConfigSection accountKey={accountKey} accountLabel={accountLabel} />
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-[#2d3248]">
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors"
                title={isGlobalScope ? 'Reset global to defaults' : 'Remove this account override (revert to global)'}
              >
                {isGlobalScope
                  ? <><RotateCcw className="w-3 h-3" /> Reset to defaults</>
                  : <><Trash2     className="w-3 h-3" /> Use global</>}
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
