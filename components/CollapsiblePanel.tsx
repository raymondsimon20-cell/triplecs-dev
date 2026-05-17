'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Pillar tints + per-pillar hover glows were removed in the 2026-05 redesign.
 * The type stays for backwards compatibility (call sites pass it harmlessly);
 * the values are intentionally ignored so every panel renders with one neutral
 * card style. Pillar identity is carried only by the `accentClass` left-edge
 * stripe — that's the single channel for "what pillar is this about".
 */
type GlowColor =
  | 'triples'
  | 'cornerstone'
  | 'income'
  | 'hedge'
  | 'cyan'
  | 'orange'
  | 'red'
  | 'purple';

interface Props {
  id: string;
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  /** Tailwind border-color class for the left accent stripe, e.g. "border-amber-500/60" — the ONE place pillar color is carried */
  accentClass?: string;
  /** @deprecated — tinted gradient backgrounds were removed. Prop accepted but ignored. */
  tintClass?: string;
  /** Classes for the icon wrapper pill, e.g. "bg-amber-500/10 border border-amber-500/20" */
  iconContainerClass?: string;
  /** @deprecated — colored hover glows were removed. Prop accepted but ignored. */
  glowColor?: GlowColor;
}

const STORAGE_PREFIX = 'triplec_panel_';

// One neutral hover elevation, no color. Pre-redesign every panel had its own
// glow tint — the cumulative effect was a dashboard where everything competed
// for attention. Subtle lift only now; pillar identity travels via accentClass.
const HOVER_SHADOW = '0 6px 22px rgba(0,0,0,0.4)';

export function CollapsiblePanel({
  id,
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
  className = '',
  accentClass,
  iconContainerClass = 'bg-white/[0.06]',
}: Props) {
  const storageKey = `${STORAGE_PREFIX}${id}`;

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultOpen;
    const stored = localStorage.getItem(storageKey);
    return stored !== null ? stored === 'true' : defaultOpen;
  });

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) setOpen(stored === 'true');
  }, [storageKey]);

  function toggle() {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ }
  }

  return (
    <motion.div
      id={`panel-${id}`}
      className={[
        'bg-[#12151f] border border-[#1f2334] rounded-xl overflow-hidden scroll-mt-20',
        'transition-shadow duration-200',
        accentClass ? `border-l-2 ${accentClass}` : '',
        className,
      ].join(' ')}
      whileHover={{ y: -1, boxShadow: HOVER_SHADOW }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
    >
      {/* Header bar */}
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-white/[0.02] transition-colors group"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {icon && (
            <span className={`flex-shrink-0 p-1.5 rounded-md ${iconContainerClass} transition-opacity opacity-80 group-hover:opacity-100`}>
              {icon}
            </span>
          )}
          <span className="text-sm font-semibold text-white truncate tracking-tight">{title}</span>
          {badge && <span className="flex-shrink-0">{badge}</span>}
        </div>
        <span className="flex-shrink-0 ml-2 text-[#4a5070] group-hover:text-[#7c82a0] transition-colors">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {/* Content — animated open/close */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-5 pb-5 pt-0 border-t border-[#1f2334]">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
