'use client';

/**
 * AutoConfigSection — Autopilot mode, daily caps, and circuit-breaker for
 * the active scope (per-account or household). Rendered inside SettingsPanel.
 *
 * Wire-up:
 *   - GET /api/signals/auto-config?accountHash=<scope>  → load
 *   - PATCH /api/signals/auto-config?accountHash=<scope> body { mode, dailyCaps, circuitBreaker } → save
 *   - DELETE /api/signals/auto-config?accountHash=<scope> → clear override (per-account only)
 *
 * Per-account overrides land at `signal-engine-auto-config:account:<hash>`;
 * the engine's per-account auto-execute loop picks them up on the next run.
 * Household scope writes to the global default that any unscoped account
 * falls back to.
 */

import { useEffect, useState } from 'react';
import { Loader2, Check, Trash2 } from 'lucide-react';

type Mode = 'manual' | 'dry-run' | 'auto';

interface AutoConfig {
  mode:       Mode;
  dailyCaps:  {
    maxTrades:              number;
    maxDollarsPerTrade:     number;
    maxNetExposureShiftPct: number;
  };
  circuitBreaker: {
    dailyLossPct:    number;
    pausedUntilDate: string | null;
    pausedReason:    string;
  };
}

interface Props {
  /** Account scope. Omit / 'all' / 'global' edits the household default. */
  accountKey?: string;
  /** Human-readable label for the current scope. */
  accountLabel?: string;
}

const MODE_DESCRIPTIONS: Record<Mode, string> = {
  manual:    'No auto-execute. Engine stages into the inbox; you approve every trade.',
  'dry-run': 'Engine stages + would-have-executed paper trades. No Schwab calls. Safe to observe.',
  auto:     'Real Schwab orders for tier-1 items inside daily caps. Manual approval for tier-2.',
};

function normaliseScope(accountKey?: string): string | undefined {
  if (!accountKey || accountKey === 'all' || accountKey === 'global') return undefined;
  return accountKey;
}

export function AutoConfigSection({ accountKey, accountLabel }: Props = {}) {
  const scope = normaliseScope(accountKey);
  const isGlobalScope = !scope;
  const [config, setConfig]       = useState<AutoConfig | null>(null);
  const [hasOverride, setHasOverride] = useState(false);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Load on mount + when scope changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    const url = scope
      ? `/api/signals/auto-config?accountHash=${encodeURIComponent(scope)}`
      : '/api/signals/auto-config';
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setConfig(d.config);
        setHasOverride(Boolean(d.hasOverride));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [scope]);

  function patch(updater: (c: AutoConfig) => AutoConfig) {
    setConfig((prev) => (prev ? updater(prev) : prev));
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const url = scope
        ? `/api/signals/auto-config?accountHash=${encodeURIComponent(scope)}`
        : '/api/signals/auto-config';
      const r = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode:           config.mode,
          dailyCaps:      config.dailyCaps,
          circuitBreaker: { dailyLossPct: config.circuitBreaker.dailyLossPct },
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setConfig(d.config);
      setHasOverride(!isGlobalScope);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /** Per-account scope only — clear the override so the engine falls back
   *  to household. */
  async function useGlobal() {
    if (!scope) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/signals/auto-config?accountHash=${encodeURIComponent(scope)}`, {
        method: 'DELETE',
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setConfig(d.config);
      setHasOverride(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function clearBreaker() {
    if (!config) return;
    setSaving(true);
    try {
      const url = scope
        ? `/api/signals/auto-config?accountHash=${encodeURIComponent(scope)}`
        : '/api/signals/auto-config';
      const r = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuitBreaker: { clearPause: true } }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setConfig(d.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">Autopilot</h3>
        <div className="h-16 flex items-center text-xs text-[#7c82a0]">
          <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> Loading auto-config…
        </div>
      </section>
    );
  }
  if (!config) {
    return (
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">Autopilot</h3>
        <div className="text-xs text-red-300">Failed to load auto-config{error ? `: ${error}` : ''}.</div>
      </section>
    );
  }

  const breakerActive = config.circuitBreaker.pausedUntilDate != null;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wider">Autopilot</h3>
        {scope ? (
          hasOverride
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">override · {accountLabel}</span>
            : <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2d3248] text-[#9aa2c0]">using household</span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">household default</span>
        )}
      </div>

      {/* Mode selector */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-[#9aa2c0]">Mode</div>
        <div className="grid grid-cols-3 gap-2">
          {(['manual', 'dry-run', 'auto'] as const).map((m) => (
            <button
              key={m}
              onClick={() => patch((c) => ({ ...c, mode: m }))}
              className={`px-2 py-1.5 rounded text-xs font-semibold border transition-colors ${
                config.mode === m
                  ? m === 'auto'    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' :
                    m === 'dry-run' ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'      :
                                       'bg-[#2d3248] border-[#3d4260] text-white'
                  : 'bg-transparent border-[#2d3248] text-[#7c82a0] hover:text-white hover:border-[#3d4260]'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-[#7c82a0] leading-relaxed">{MODE_DESCRIPTIONS[config.mode]}</div>
      </div>

      {/* Daily caps */}
      <div className="space-y-3">
        <div className="text-[11px] text-[#9aa2c0]">Daily caps</div>
        <NumberRow
          label="Max trades / day"
          value={config.dailyCaps.maxTrades}
          min={0} max={50} step={1}
          onChange={(v) => patch((c) => ({ ...c, dailyCaps: { ...c.dailyCaps, maxTrades: v } }))}
        />
        <NumberRow
          label="Max $ / trade"
          value={config.dailyCaps.maxDollarsPerTrade}
          min={0} max={50000} step={250}
          prefix="$"
          onChange={(v) => patch((c) => ({ ...c, dailyCaps: { ...c.dailyCaps, maxDollarsPerTrade: v } }))}
        />
        <NumberRow
          label="Max % portfolio shift / day"
          value={config.dailyCaps.maxNetExposureShiftPct}
          min={0} max={100} step={1}
          suffix="%"
          onChange={(v) => patch((c) => ({ ...c, dailyCaps: { ...c.dailyCaps, maxNetExposureShiftPct: v } }))}
        />
      </div>

      {/* Circuit breaker */}
      <div className="space-y-2">
        <div className="text-[11px] text-[#9aa2c0]">Circuit breaker</div>
        <NumberRow
          label="Trip if intraday loss ≤"
          value={config.circuitBreaker.dailyLossPct}
          min={-50} max={0} step={0.5}
          suffix="%"
          onChange={(v) => patch((c) => ({ ...c, circuitBreaker: { ...c.circuitBreaker, dailyLossPct: v } }))}
        />
        {breakerActive && (
          <div className="flex items-center justify-between bg-red-500/10 border border-red-500/30 rounded px-2.5 py-1.5">
            <span className="text-[10px] text-red-300">
              Tripped until {config.circuitBreaker.pausedUntilDate}: {config.circuitBreaker.pausedReason || 'no reason given'}
            </span>
            <button
              onClick={clearBreaker}
              className="text-[10px] text-red-200 underline hover:text-white"
            >
              Force-clear
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
          {error}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between pt-1">
        {scope && hasOverride ? (
          <button
            onClick={useGlobal}
            disabled={saving}
            className="flex items-center gap-1.5 text-[11px] text-[#7c82a0] hover:text-white disabled:opacity-50"
            title="Remove this account's autopilot override and fall back to the household defaults"
          >
            <Trash2 className="w-3 h-3" /> Use household
          </button>
        ) : <span />}
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold"
        >
          {saving
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : saved ? <Check className="w-3.5 h-3.5" /> : null}
          {saved ? 'Saved!' : scope && !hasOverride ? 'Save as override' : 'Save'}
        </button>
      </div>
    </section>
  );
}

// ─── Number input row ─────────────────────────────────────────────────────────

function NumberRow({
  label, value, min, max, step, prefix, suffix, onChange,
}: {
  label:    string;
  value:    number;
  min:      number;
  max:      number;
  step:     number;
  prefix?:  string;
  suffix?:  string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-white">{label}</span>
      <div className="flex items-center gap-1.5">
        {prefix && <span className="text-xs text-[#7c82a0]">{prefix}</span>}
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
          }}
          className="w-20 bg-[#12151f] border border-[#2d3248] rounded px-2 py-1 text-xs text-white text-right focus:outline-none focus:border-blue-500 tabular-nums"
        />
        {suffix && <span className="text-xs text-[#7c82a0]">{suffix}</span>}
      </div>
    </div>
  );
}
