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
 *
 * Positioning is done with a fixed-position portal to document.body, measured
 * and clamped to the viewport, rather than an absolutely-positioned child.
 * Two reasons the simpler approach didn't work:
 *
 *  1. StatCard is a framer-motion div with a transform. A transformed ancestor
 *     becomes the containing block for `position: fixed` descendants, so the
 *     bubble was trapped inside the card and clipped by the grid.
 *  2. A fixed-width popover anchored to a card edge runs off screen for cards
 *     in the last grid column, and off the bottom for cards low on the page.
 *
 * So: measure the trigger on open, place the bubble below it if there's room
 * and above it if there isn't, and clamp horizontally so it always stays
 * within the viewport with a small margin.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { metricHelp } from '@/lib/metric-help';

/** Popover width in px. Kept in JS because placement math needs it. */
const BUBBLE_W = 288; // matches w-72
/** Minimum gap between the bubble and the viewport edge. */
const MARGIN = 8;

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  /** True when the bubble hangs above the trigger and must grow upward. */
  above: boolean;
}

export function InfoBubble({
  label,
  children,
  align = 'right',
}: {
  /** Used for the accessible name, e.g. "How Total Return is calculated". */
  label: string;
  children: React.ReactNode;
  /**
   * Preferred horizontal anchor relative to the trigger. Only a preference —
   * the bubble is clamped to the viewport regardless, so a card in the last
   * column still renders fully on screen.
   */
  align?: 'left' | 'right';
}) {
  const [open, setOpen]     = useState(false);
  const [pinned, setPinned] = useState(false);
  const [place, setPlace]   = useState<Placement | null>(null);
  const wrapRef  = useRef<HTMLSpanElement>(null);
  const closeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Closing is deferred so the pointer can cross the gap between the trigger
  // and the portaled bubble without the bubble vanishing en route.
  const cancelClose = useCallback(() => {
    if (closeRef.current) { clearTimeout(closeRef.current); closeRef.current = null; }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeRef.current = setTimeout(() => setOpen(false), 120);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  /**
   * Work out where the bubble goes, from the trigger's position on screen.
   * Horizontal: start from the preferred edge, then clamp into the viewport.
   * Vertical: below if it fits, otherwise above; whichever side is chosen,
   * cap maxHeight to the space available so a tall bubble scrolls internally
   * instead of running off the bottom.
   */
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r  = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Shrink to fit rather than overflow on viewports narrower than the
    // bubble — clamping alone can't keep a 288px box inside a 280px screen.
    const width = Math.min(BUBBLE_W, vw - MARGIN * 2);
    const preferred = align === 'right' ? r.right - width : r.left;
    const left = Math.min(Math.max(preferred, MARGIN), Math.max(MARGIN, vw - width - MARGIN));

    const spaceBelow = vh - r.bottom - MARGIN * 2;
    const spaceAbove = r.top - MARGIN * 2;
    const below      = spaceBelow >= 160 || spaceBelow >= spaceAbove;

    setPlace({
      left,
      width,
      top: below ? r.bottom + 6 : r.top - 6,
      maxHeight: Math.max(120, below ? spaceBelow : spaceAbove),
      above: !below,
    });
  }, [align]);

  // Measure on open, and keep up with scroll/resize while it's showing.
  // `true` on the scroll listener catches scrolling inside any container, not
  // just the window — several panels live in their own scroll areas.
  useEffect(() => {
    if (!open) return;
    measure();
    const onMove = () => measure();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, measure]);

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

  // Portal to body so no transformed or overflow-hidden ancestor can clip or
  // reposition the bubble. Guarded on `place` so it never paints at 0,0 for a
  // frame before the measurement lands, and on `document` for SSR.
  const bubble = open && place && typeof document !== 'undefined'
    ? createPortal(
        <span
          role="tooltip"
          // The portal puts the bubble outside the trigger's DOM subtree, so
          // moving the pointer onto it would otherwise count as leaving the
          // trigger and close it mid-read. Track hover here too.
          onMouseEnter={cancelClose}
          onMouseLeave={() => { if (!pinned) scheduleClose(); }}
          style={{
            left: place.left,
            top: place.top,
            width: place.width,
            maxHeight: place.maxHeight,
            // Anchored by its bottom edge when above, so it grows upward away
            // from the trigger rather than covering it.
            transform: place.above ? 'translateY(-100%)' : undefined,
          }}
          className="fixed z-[100] block overflow-y-auto overscroll-contain rounded-lg border border-[#3d4468] bg-[#0f1117] p-3 text-[11px] font-normal normal-case leading-relaxed text-[#c8cde0] shadow-xl"
        >
          {children}
        </span>,
        document.body,
      )
    : null;

  return (
    <span className="relative inline-block" ref={wrapRef}>
      <button
        type="button"
        onMouseEnter={() => { cancelClose(); setOpen(true); }}
        onMouseLeave={() => { if (!pinned) scheduleClose(); }}
        onFocus={() => { cancelClose(); setOpen(true); }}
        onBlur={() => { if (!pinned) scheduleClose(); }}
        onClick={() => { cancelClose(); setPinned((v) => !v); setOpen((v) => !pinned || !v); }}
        className="text-[#4a5070] hover:text-[#7c82a0] transition-colors align-middle"
        aria-label={`How ${label} is calculated`}
        aria-expanded={open}
      >
        <Info className="w-3 h-3" />
      </button>
      {bubble}
    </span>
  );
}

/**
 * Renders a registry entry (what / how) plus any live detail rows. Shared by
 * StatCard and by hand-rolled cards so every bubble on the site reads the
 * same way. Returns null when no help is written for the label, letting
 * callers do `{help && <InfoBubble>…}` off the same lookup.
 */
export function MetricHelpBody({
  label, detail,
}: { label: string; detail?: React.ReactNode }) {
  const help = metricHelp(label);
  if (!help) return null;
  return (
    <span className="block space-y-2">
      <span className="block font-semibold text-white">{label}</span>
      <span className="block text-[#7c82a0]">{help.what}</span>
      {help.how && (
        <span className="block border-t border-[#252840] pt-2 text-[#7c82a0]">
          <span className="block text-[10px] uppercase tracking-wider text-[#4a5070] mb-1">
            How it&apos;s calculated
          </span>
          {help.how}
        </span>
      )}
      {detail && <span className="block space-y-1 border-t border-[#252840] pt-2">{detail}</span>}
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
