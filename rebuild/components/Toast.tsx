'use client';
import { AnimatePresence, motion } from 'framer-motion';

export interface ToastMsg {
  id: number;
  text: string;
  error?: boolean;
}

export function Toasts({ toasts }: { toasts: ToastMsg[] }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white shadow-lg ${
              t.error ? 'bg-red-600' : 'bg-emerald-600'
            }`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
