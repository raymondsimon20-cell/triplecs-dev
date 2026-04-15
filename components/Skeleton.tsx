'use client';

/**
 * Skeleton — lightweight loading placeholder for dashboard panels.
 * Provides a shimmering skeleton animation that hints at content structure.
 */

interface SkeletonProps {
  /** Number of rows to render (default 3) */
  rows?: number;
  /** Layout variant */
  variant?: 'list' | 'card' | 'metric';
  /** Extra class names */
  className?: string;
}

function ShimBar({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-[#2d3248] rounded animate-pulse ${className}`} />
  );
}

export function Skeleton({ rows = 3, variant = 'list', className = '' }: SkeletonProps) {
  if (variant === 'metric') {
    return (
      <div className={`grid grid-cols-2 sm:grid-cols-3 gap-3 ${className}`}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-4 space-y-2">
            <ShimBar className="h-3 w-20" />
            <ShimBar className="h-6 w-28" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'card') {
    return (
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${className}`}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <ShimBar className="h-4 w-16" />
              <ShimBar className="h-4 w-24" />
            </div>
            <ShimBar className="h-3 w-full" />
            <ShimBar className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    );
  }

  // Default: list rows
  return (
    <div className={`space-y-3 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <ShimBar className="h-4 w-16" />
          <ShimBar className="h-4 flex-1" />
          <ShimBar className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Inline skeleton text — single line placeholder */
export function SkeletonText({ width = 'w-24' }: { width?: string }) {
  return <ShimBar className={`h-3 ${width} inline-block`} />;
}
