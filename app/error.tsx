'use client';

/**
 * Global error boundary — catches unhandled errors in any route segment.
 * Shows a friendly recovery UI instead of a blank white screen.
 */

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#0f1117] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#1a1d27] border border-[#2d3248] rounded-2xl p-8 text-center space-y-5">
        <div className="mx-auto w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center">
          <AlertTriangle className="w-7 h-7 text-red-400" />
        </div>

        <div className="space-y-2">
          <h1 className="text-xl font-bold text-white">Something went wrong</h1>
          <p className="text-sm text-[#7c82a0]">
            The dashboard hit an unexpected error. Your data is safe — try refreshing.
          </p>
        </div>

        {error.message && (
          <div className="bg-[#22263a] rounded-lg px-4 py-3 text-left">
            <p className="text-xs text-[#4a5070] mb-1">Error details:</p>
            <p className="text-xs text-red-400 font-mono break-all">{error.message}</p>
          </div>
        )}

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Try Again
          </button>
          <a
            href="/"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#22263a] border border-[#2d3248] hover:border-[#3d4268] text-[#7c82a0] hover:text-white text-sm font-medium transition-colors"
          >
            <Home className="w-4 h-4" />
            Home
          </a>
        </div>

        {error.digest && (
          <p className="text-[10px] text-[#4a5070]">Error ID: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
