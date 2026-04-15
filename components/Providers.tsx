'use client';

/**
 * Client-side providers wrapper.
 * Wraps the app with ThemeProvider and ToastProvider.
 */

import { ThemeProvider } from './ThemeToggle';
import { ToastProvider } from './ToastProvider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        {children}
      </ToastProvider>
    </ThemeProvider>
  );
}
