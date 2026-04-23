'use client';

import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { motion } from 'framer-motion';

/**
 * Global "Pause Automation" kill switch. When on, all AI plan endpoints
 * (rebalance-plan, option-plan) short-circuit before calling Claude.
 */
export function AutomationToggle() {
  const [paused,  setPaused]  = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/automation-pause')
      .then((r) => r.json())
      .then((d) => setPaused(Boolean(d.paused)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function toggle() {
    const next = !paused;
    setPaused(next);   // optimistic
    try {
      const r = await fetch('/api/automation-pause', {
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

  return (
    <motion.button
      onClick={toggle}
      whileTap={{ scale: 0.94 }}
      className={[
        'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold',
        'border transition-colors',
        paused
          ? 'bg-red-500/15 border-red-500/40 text-red-300 hover:bg-red-500/25'
          : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20',
      ].join(' ')}
      title={paused ? 'AI plan endpoints are paused — click to resume' : 'Click to pause AI plan endpoints'}
      aria-pressed={paused}
    >
      {paused ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      <span>{paused ? 'Paused' : 'AI Live'}</span>
    </motion.button>
  );
}
