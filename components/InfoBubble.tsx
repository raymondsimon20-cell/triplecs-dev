'use client';

/**
 * <InfoBubble label="Total Return"> — small ⓘ button that opens a popover
 * explaining how a figure was derived.
 *
 * Distinct from <Term>, which shows a fixed glossary definition for a word.
 * This one wraps arbitrary content, so callers can show the actual arithmetic
 * with the user's real numbers rather than a generic description.
 *
 * Opens on hover (desktop) and on click/focus (touch + keyboard). Click also
 * pins it open so the numbers can be read without holding the pointer still.
 */

import { useState, useRef, useEffect } from 'react';
import { Info } from 'lucide-react';

export function InfoBubble({
  label,
  children,
  align = 'right',
}: {
  /** Used for the accessible name, e.g. "How Total Return is calculated". */
  label: string;
  children: React.ReactNode;
  /** Which edge the popover hangs from. Cards near the viewport edge want 'right'. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen]     = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // A pinned bubble stays up until the user clicks elsewhere or hits Escape.
  useEffect(() => {
    if (!pinned) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) { setPinned(false); setOpen(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPinned(false); setOpen(false); }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  return (
    <span className="relative inline-block" ref={wrapRef}>
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => { if (!pinned) setOpen(false); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!pinned) setOpen(false); }}
        onClick={() => { setPinned((v) => !v); setOpen((v) => !pinned || !v); }}
        className="text-[#4a5070] hover:text-[#7c82a0] transition-colors align-middle"
        aria-label={`How ${label} is calculated`}
        aria-expanded={open}
      >
        <Info className="w-3 h-3" />
      </button>
      {open && (
        <span
          role="tooltip"
          className={`absolute z-50 mt-1.5 block w-72 rounded-lg border border-[#3d4468] bg-[#0f1117] p-3 text-[11px] font-normal normal-case leading-relaxed text-[#c8cde0] shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** One `label ...... value` row inside a bubble. */
export function BubbleRow({
  label, value, muted = false,
}: { label: string; value: string; muted?: boolean }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className={muted ? 'text-[#4a5070]' : 'text-[#7c82a0]'}>{label}</span>
      <span className={`tabular-nums font-medium ${muted ? 'text-[#7c82a0]' : 'text-white'}`}>{value}</span>
    </span>
  );
}
