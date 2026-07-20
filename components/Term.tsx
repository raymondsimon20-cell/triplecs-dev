'use client';

/**
 * <Term k="AFW">AFW</Term> — dotted-underline word with a plain-English
 * tooltip from the shared glossary (lib/friendly.ts). Works on hover
 * (desktop) and tap (mobile, via focus).
 */

import { useState } from 'react';
import { GLOSSARY } from '@/lib/friendly';

export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const definition = GLOSSARY[k];
  if (!definition) return <>{children}</>;

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="cursor-help border-b border-dotted border-[#4a5070] text-inherit"
        aria-label={`What is ${k}?`}
      >
        {children}
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 z-40 mt-1.5 w-64 -translate-x-1/2 rounded-lg border border-[#3d4468] bg-[#0f1117] p-3 text-xs font-normal normal-case leading-relaxed text-[#c8cde0] shadow-xl"
        >
          {definition}
        </span>
      )}
    </span>
  );
}
