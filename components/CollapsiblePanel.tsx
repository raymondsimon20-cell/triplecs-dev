'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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
  /** Tailwind border-color class for the left accent stripe, e.g. "border-amber-500/60" */
  accentClass?: string;
  /** Tailwind gradient tint applied to card bg, e.g. "from-amber-500/[0.04]" */
  tintClass?: string;
  /** Classes for the icon wrapper pill, e.g. "bg-amber-500/10 border border-amber-500/20" */
  iconContainerClass?: string;
  /** Brand color used for the intensified hover glow */
  glowColor?: GlowColor;
}

const STORAGE_PREFIX = 'triplec_panel_';

const GLOW_HOVER: Record<GlowColor, string> = {
  triples:     '0 0 32px rgba(245,158,11,0.22), 0 12px 36px rgba(0,0,0,0.5)',
  cornerstone: '0 0 32px rgba(59,130,246,0.22), 0 12px 36px rgba(0,0,0,0.5)',
  income:      '0 0 32px rgba(16,185,129,0.22), 0 12px 36px rgba(0,0,0,0.5)',
  hedge:       '0 0 32px rgba(139,92,246,0.22), 0 12px 36px rgba(0,0,0,0.5)',
  cyan:        '0 0 32px rgba(6,182,212,0.22),  0 12px 36px rgba(0,0,0,0.5)',
  orange:      '0 0 32px rgba(249,115,22,0.22), 0 12px 36px rgba(0,0,0,0.5)',
  red:         '0 0 32px rgba(239,68,68,0.28),  0 12px 36px rgba(0,0,0,0.5)',
  purple:      '0 0 32px rgba(168,85,247,0.22), 0 12px 36px rgba(0,0,0,0.5)',
};

export function CollapsiblePanel({
  id,
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
  className = '',
  accentClass,
  tintClass,
  iconContainerClass = 'bg-white/[0.06]',
  glowColor,
}: Props) {
  const storageKey = `${STORAGE_PREFIX}${id}`;
  const hoverShadow = glowColor ? GLOW_HOVER[glowColor] : '0 8px 32px rgba(0,0,0,0.5)';

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
        'card-glass border border-[#252840] rounded-xl overflow-hidden scroll-mt-20',
        'shadow-card transition-shadow duration-200',
        tintClass ? `bg-gradient-to-br ${tintClass} to-transparent` : '',
        accentClass ? `border-l-2 ${accentClass}` : '',
        className,
      ].join(' ')}
      whileHover={{ y: -2, boxShadow: hoverShadow }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
    >
      {/* Header bar */}
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03] transition-colors group"
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
            <div className="px-5 pb-5 pt-0 border-t border-[#252840]">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
