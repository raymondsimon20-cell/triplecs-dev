'use client';

/**
 * ToastProvider — lightweight toast notification system.
 *
 * Usage:
 *   import { useToast } from '@/components/ToastProvider';
 *   const toast = useToast();
 *   toast.show('Order filled!', 'success');
 *   toast.show('Margin above 30%', 'danger');
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { CheckCircle, AlertTriangle, AlertCircle, Info, X, Bell } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

type ToastLevel = 'success' | 'danger' | 'warn' | 'info';

interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  createdAt: number;
  dismissing?: boolean;
}

interface ToastContextValue {
  show: (message: string, level?: ToastLevel, durationMs?: number) => void;
  toasts: Toast[];
}

const ToastContext = createContext<ToastContextValue>({
  show: () => {},
  toasts: [],
});

export const useToast = () => useContext(ToastContext);

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_DURATION = 5000;
const MAX_VISIBLE = 5;

const LEVEL_CONFIG: Record<ToastLevel, { icon: typeof CheckCircle; bg: string; border: string; text: string }> = {
  success: { icon: CheckCircle, bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', text: 'text-emerald-400' },
  danger:  { icon: AlertTriangle, bg: 'bg-red-500/15', border: 'border-red-500/30', text: 'text-red-400' },
  warn:    { icon: AlertCircle, bg: 'bg-orange-500/15', border: 'border-orange-500/30', text: 'text-orange-400' },
  info:    { icon: Info, bg: 'bg-blue-500/15', border: 'border-blue-500/30', text: 'text-blue-400' },
};

// ─── Provider ────────────────────────────────────────────────────────────────

let _nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    // Start dismiss animation
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, dismissing: true } : t));
    // Remove after animation
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const show = useCallback((message: string, level: ToastLevel = 'info', durationMs = DEFAULT_DURATION) => {
    const id = ++_nextId;
    const toast: Toast = { id, message, level, createdAt: Date.now() };
    setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), toast]);

    const timer = setTimeout(() => dismiss(id), durationMs);
    timers.current.set(id, timer);
  }, [dismiss]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { timers.current.forEach((t) => clearTimeout(t)); };
  }, []);

  return (
    <ToastContext.Provider value={{ show, toasts }}>
      {children}

      {/* Toast container — fixed bottom-right */}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 pointer-events-none"
        style={{ maxWidth: '24rem' }}
        aria-live="polite"
        role="log"
      >
        {toasts.map((toast) => {
          const cfg = LEVEL_CONFIG[toast.level];
          const Icon = cfg.icon;
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm
                ${cfg.bg} ${cfg.border}
                ${toast.dismissing
                  ? 'animate-[slideOut_0.3s_ease-in_forwards]'
                  : 'animate-[slideIn_0.3s_ease-out]'
                }`}
            >
              <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${cfg.text}`} />
              <span className={`text-sm font-medium flex-1 ${cfg.text}`}>
                {toast.message}
              </span>
              <button
                onClick={() => dismiss(toast.id)}
                className="flex-shrink-0 text-[#7c82a0] hover:text-white transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Keyframe animations injected via style tag */}
      <style jsx global>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(100%); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes slideOut {
          from { opacity: 1; transform: translateX(0); }
          to   { opacity: 0; transform: translateX(100%); }
        }
      `}</style>
    </ToastContext.Provider>
  );
}

// ─── AlertMonitor — watches portfolio data and fires toasts ─────────────────

interface AlertMonitorProps {
  marginPct: number;
  positions: { symbol: string; portfolioPercent: number }[];
  pendingOrderCount: number;
  marginWarnPct: number;
  marginLimitPct: number;
}

/**
 * Drop this inside the dashboard. It watches margin %, concentration, etc.
 * and fires toasts when thresholds are crossed.
 * Renders nothing visible — it's a side-effect component.
 */
export function AlertMonitor({
  marginPct,
  positions,
  pendingOrderCount,
  marginWarnPct,
  marginLimitPct,
}: AlertMonitorProps) {
  const toast = useToast();
  const prevMarginZone = useRef<string>('');
  const prevOverCap = useRef<Set<string>>(new Set());
  const prevOrderCount = useRef(pendingOrderCount);

  useEffect(() => {
    // ── Margin zone transitions ──
    const zone =
      marginPct > 50 ? 'emergency' :
      marginPct > marginLimitPct ? 'critical' :
      marginPct > marginWarnPct ? 'warn' : 'ok';

    if (prevMarginZone.current && zone !== prevMarginZone.current) {
      if (zone === 'emergency') {
        toast.show(`Margin at ${marginPct.toFixed(1)}% — EMERGENCY: reduce immediately!`, 'danger', 10000);
      } else if (zone === 'critical') {
        toast.show(`Margin at ${marginPct.toFixed(1)}% — above ${marginLimitPct}% limit. Reduce exposure.`, 'danger', 8000);
      } else if (zone === 'warn') {
        toast.show(`Margin at ${marginPct.toFixed(1)}% — approaching ${marginLimitPct}% limit.`, 'warn');
      } else if (prevMarginZone.current !== 'ok') {
        toast.show(`Margin back to ${marginPct.toFixed(1)}% — healthy range.`, 'success');
      }
    }
    prevMarginZone.current = zone;

    // ── Position concentration alerts ──
    const currentOverCap = new Set<string>();
    for (const pos of positions) {
      if (pos.portfolioPercent > 20) currentOverCap.add(pos.symbol);
    }
    // Only alert on newly over-cap symbols
    for (const sym of currentOverCap) {
      if (!prevOverCap.current.has(sym)) {
        const pct = positions.find((p) => p.symbol === sym)?.portfolioPercent ?? 0;
        toast.show(`${sym} is ${pct.toFixed(1)}% of portfolio — exceeds 20% cap. Trim needed.`, 'warn', 8000);
      }
    }
    prevOverCap.current = currentOverCap;

    // ── Order fill detection (count decreased = something filled/cancelled) ──
    if (prevOrderCount.current > 0 && pendingOrderCount < prevOrderCount.current) {
      const diff = prevOrderCount.current - pendingOrderCount;
      toast.show(`${diff} order${diff > 1 ? 's' : ''} filled or completed.`, 'success');
    }
    prevOrderCount.current = pendingOrderCount;
  }, [marginPct, positions, pendingOrderCount, marginWarnPct, marginLimitPct, toast]);

  return null; // Renders nothing — pure side-effect
}
