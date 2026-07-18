'use client';
import { motion } from 'framer-motion';

export function FireProgress({ equity, target }: { equity: number; target: number }) {
  const pct = target > 0 ? Math.min(1, equity / target) : 0;
  return (
    <div className="card p-4">
      <div className="mb-1 flex justify-between text-sm">
        <span className="font-semibold uppercase tracking-wide opacity-70">FIRE Progress</span>
        <span className="font-mono">
          ${Math.round(equity).toLocaleString()} / ${Math.round(target).toLocaleString()} ({(pct * 100).toFixed(1)}%)
        </span>
      </div>
      <div className="h-3 w-full rounded-full bg-slate-200 dark:bg-slate-800">
        <motion.div
          className="h-3 rounded-full bg-gradient-to-r from-amber-500 to-emerald-500"
          initial={{ width: 0 }}
          animate={{ width: `${pct * 100}%` }}
          transition={{ duration: 0.8 }}
        />
      </div>
    </div>
  );
}
