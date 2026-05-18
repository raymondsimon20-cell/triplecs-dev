'use client';

import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { motion } from 'framer-motion';

/**
 * "Pause Automation" kill switch.
 *
 * 2026-05 per-account autopilot:
 *   - When `accountHash` is provided AND not the aggregate sentinel, the
 *     toggle reads/writes that account's pause flag.
 *   - Otherwise the toggle controls the household master pause that
 *     overrides every account.
 *
 * The server-side gate logic (lib/guardrails.ts → getAutomationGate) checks
 * BOTH the account flag AND the household master, so a household pause
 * supersedes per-account state.
 */
interface AutomationToggleProps {
  /**
   * Schwab account hash to scope the toggle to. Omit (or pass 'all' / 'global')
   * for the household master pause.
   */
  accountHash?: string;
  /** Human-readable label used in tooltips / title text. */
  accountLabel?: string;
}

export function AutomationToggle({ accountHash, accountLabel }: AutomationToggleProps = {}) {
  const [paused,  setPaused]  = useState(false);
  const [householdPaused, setHouseholdPaused] = useState(false);
  const [loading, setLoading] = useState(true);

  const scope = !accountHash || accountHash === 'all' || accountHash === 'global'
    ? undefined
    : accountHash;
  const scopeLabel = scope ? (accountLabel ?? `···${scope.slice(0, 6)}`) : 'household';

  useEffect(() => {
    setLoading(true);
    const scopedUrl = scope
      ? `/api/automation-pause?accountHash=${encodeURIComponent(scope)}`
      : '/api/automation-pause';
    // Per-account view also reads the household master to surface the
    // "household pause overrides this account" hint. The scoped GET
    // already returns true when household is on (per isAutomationPaused
    // logic), but the household master flag distinct from the account's
    // OWN flag is useful UX.
    const work = scope
      ? Promise.all([
          fetch(scopedUrl).then((r) => r.json()).catch(() => ({ paused: false })),
          fetch('/api/automation-pause').then((r) => r.json()).catch(() => ({ paused: false })),
        ])
      : Promise.all([
          fetch(scopedUrl).then((r) => r.json()).catch(() => ({ paused: false })),
          Promise.resolve({ paused: false }),
        ]);
    work
      .then(([own, household]) => {
        setPaused(Boolean(own.paused));
        setHouseholdPaused(Boolean(household.paused));
      })
      .finally(() => setLoading(false));
  }, [scope]);

  async function toggle() {
    const next = !paused;
    setPaused(next);   // optimistic
    try {
      const url = scope
        ? `/api/automation-pause?accountHash=${encodeURIComponent(scope)}`
        : '/api/automation-pause';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: next }),
      });
      const d = await r.json();
      setPaused(Boolean(d.paused));
    } catch {
      setPaused(!next); // rollback
    }
  }

  if (loading) return null;

  // Per-account view: a household master pause overrides this account.
  // Surface a hint so the user can tell whether toggling the per-account
  // flag here will actually resume trading.
  const masterOverridesUs = Boolean(scope) && householdPaused && !paused;

  const titleBase = paused
    ? `AI paused for ${scopeLabel} — click to resume`
    : `Click to pause AI for ${scopeLabel}`;
  const title = masterOverridesUs
    ? `${titleBase}\n\nNote: the household master pause is also ON — this account stays paused regardless of its own flag until the master is cleared.`
    : titleBase;

  return (
    <motion.button
      onClick={toggle}
      whileTap={{ scale: 0.94 }}
      className={[
        'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold',
        'border transition-colors relative',
        paused || masterOverridesUs
          ? 'bg-red-500/15 border-red-500/40 text-red-300 hover:bg-red-500/25'
          : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20',
      ].join(' ')}
      title={title}
      aria-pressed={paused}
    >
      {paused || masterOverridesUs ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      <span>{paused ? 'Paused' : masterOverridesUs ? 'Paused (master)' : 'AI Live'}</span>
      {masterOverridesUs && (
        <span
          className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400 border border-amber-500/60"
          aria-hidden="true"
          title="Household master pause is on"
        />
      )}
    </motion.button>
  );
}
