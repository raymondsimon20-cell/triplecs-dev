/**
 * 404 — Page not found.
 */

import { Home, ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#0f1117] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="space-y-2">
          <p className="text-7xl font-bold text-[#2d3248]">404</p>
          <h1 className="text-xl font-bold text-white">Page not found</h1>
          <p className="text-sm text-[#7c82a0]">
            This page doesn't exist. You might have followed a bad link or typed the URL wrong.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <a
            href="/dashboard"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Dashboard
          </a>
          <a
            href="/"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#22263a] border border-[#2d3248] hover:border-[#3d4268] text-[#7c82a0] hover:text-white text-sm font-medium transition-colors"
          >
            <Home className="w-4 h-4" />
            Home
          </a>
        </div>
      </div>
    </div>
  );
}
