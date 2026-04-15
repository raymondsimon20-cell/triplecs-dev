/**
 * Dashboard loading skeleton — shown while the page JS bundle loads.
 * Mimics the real dashboard layout so there's no layout shift.
 */

function ShimBar({ className = '' }: { className?: string }) {
  return <div className={`bg-[#2d3248] rounded animate-pulse ${className}`} />;
}

function MetricSkeleton() {
  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-4 space-y-2">
      <ShimBar className="h-3 w-20" />
      <ShimBar className="h-6 w-28" />
      <ShimBar className="h-3 w-16" />
    </div>
  );
}

function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <ShimBar className="h-4 w-36" />
        <ShimBar className="h-4 w-16" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between">
          <ShimBar className="h-3 w-24" />
          <ShimBar className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-[#0f1117]">
      {/* Header skeleton */}
      <header className="bg-[#0f1117] border-b border-[#2d3248] sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShimBar className="h-5 w-5 rounded-full" />
            <ShimBar className="h-5 w-32" />
          </div>
          <div className="flex items-center gap-3">
            <ShimBar className="h-7 w-28 rounded-lg" />
            <ShimBar className="h-7 w-7 rounded-lg" />
            <ShimBar className="h-7 w-7 rounded-lg" />
            <ShimBar className="h-7 w-7 rounded-lg" />
          </div>
        </div>
      </header>

      {/* Nav skeleton */}
      <nav className="border-b border-[#2d3248] bg-[#0f1117] sticky top-[57px] z-30">
        <div className="max-w-7xl mx-auto px-4 flex gap-1.5 py-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <ShimBar key={i} className="h-7 w-20 rounded-lg" />
          ))}
        </div>
      </nav>

      {/* Content skeleton */}
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* Metric cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricSkeleton />
          <MetricSkeleton />
          <MetricSkeleton />
          <MetricSkeleton />
        </div>

        {/* Allocation bar */}
        <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-3">
          <ShimBar className="h-4 w-40" />
          <ShimBar className="h-6 w-full rounded-full" />
          <div className="flex gap-4">
            <ShimBar className="h-3 w-20" />
            <ShimBar className="h-3 w-20" />
            <ShimBar className="h-3 w-20" />
            <ShimBar className="h-3 w-20" />
          </div>
        </div>

        {/* Panels */}
        <PanelSkeleton rows={5} />
        <PanelSkeleton rows={3} />
        <PanelSkeleton rows={6} />
      </main>
    </div>
  );
}
