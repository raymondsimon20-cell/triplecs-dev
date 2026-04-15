'use client';

/**
 * CollapsiblePanel — a reusable wrapper that wraps any dashboard section in
 * a titled card with expand/collapse behaviour.
 *
 * State is persisted in localStorage so panels remember their open/closed
 * state across page refreshes.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  /** Unique key used to persist open/closed state in localStorage */
  id: string;
  /** Section title shown in the header bar */
  title: string;
  /** Optional icon rendered before the title */
  icon?: ReactNode;
  /** Optional badge content rendered after the title (e.g. alert count) */
  badge?: ReactNode;
  /** Whether the panel starts open (default true) */
  defaultOpen?: boolean;
  children: ReactNode;
  /** Extra Tailwind classes applied to the outer wrapper */
  className?: string;
  /** Accent color for the left border — Tailwind border-color class e.g. "border-amber-500" */
  accentClass?: string;
}

const STORAGE_PREFIX = 'triplec_panel_';

export function CollapsiblePanel({
  id,
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
  className = '',
  accentClass,
}: Props) {
  const storageKey = `${STORAGE_PREFIX}${id}`;

  // Initialise from localStorage if available, otherwise use defaultOpen
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultOpen;
    const stored = localStorage.getItem(storageKey);
    return stored !== null ? stored === 'true' : defaultOpen;
  });

  // Re-sync on mount (handles SSR hydration mismatch)
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
    <div
      id={`panel-${id}`}
      className={`bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden scroll-mt-20 ${accentClass ? `border-l-2 ${accentClass}` : ''} ${className}`}
    >
      {/* Header bar */}
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/[0.02] transition-colors group"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {icon && (
            <span className="flex-shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
              {icon}
            </span>
          )}
          <span className="text-sm font-semibold text-white truncate">{title}</span>
          {badge && <span className="flex-shrink-0">{badge}</span>}
        </div>
        <span className="flex-shrink-0 ml-2 text-[#4a5070] group-hover:text-[#7c82a0] transition-colors">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {/* Content */}
      {open && (
        <div className="px-5 pb-5 pt-0 border-t border-[#2d3248]">
          {children}
        </div>
      )}
    </div>
  );
}
