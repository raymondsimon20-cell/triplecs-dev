/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Triple C brand colors
        triples: {
          DEFAULT: '#f59e0b',   // amber — leveraged growth
          light: '#fef3c7',
          dark: '#d97706',
        },
        cornerstone: {
          DEFAULT: '#3b82f6',   // blue — CLM/CRF cornerstone
          light: '#dbeafe',
          dark: '#1d4ed8',
        },
        income: {
          DEFAULT: '#10b981',   // emerald — income/dividends
          light: '#d1fae5',
          dark: '#059669',
        },
        hedge: {
          DEFAULT: '#8b5cf6',   // violet — shorts/puts
          light: '#ede9fe',
          dark: '#6d28d9',
        },
        danger: '#ef4444',
        warn: '#f97316',
        safe: '#22c55e',
      },
      boxShadow: {
        'glow-triples':     '0 0 20px rgba(245,158,11,0.12), 0 4px 24px rgba(0,0,0,0.4)',
        'glow-cornerstone': '0 0 20px rgba(59,130,246,0.12), 0 4px 24px rgba(0,0,0,0.4)',
        'glow-income':      '0 0 20px rgba(16,185,129,0.12), 0 4px 24px rgba(0,0,0,0.4)',
        'glow-hedge':       '0 0 20px rgba(139,92,246,0.12),  0 4px 24px rgba(0,0,0,0.4)',
        'glow-cyan':        '0 0 20px rgba(6,182,212,0.12),   0 4px 24px rgba(0,0,0,0.4)',
        'glow-orange':      '0 0 20px rgba(249,115,22,0.12),  0 4px 24px rgba(0,0,0,0.4)',
        'glow-red':         '0 0 20px rgba(239,68,68,0.15),   0 4px 24px rgba(0,0,0,0.4)',
        'glow-purple':      '0 0 20px rgba(168,85,247,0.12),  0 4px 24px rgba(0,0,0,0.4)',
        'card':             '0 4px 24px rgba(0,0,0,0.35)',
        'card-hover':       '0 8px 32px rgba(0,0,0,0.5)',
      },
      keyframes: {
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition:  '200% 0' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 4px 2px currentColor' },
          '50%':      { opacity: '0.5', boxShadow: '0 0 8px 4px currentColor' },
        },
        'dot-pulse': {
          '0%, 100%': { opacity: '1',   transform: 'scale(1)' },
          '50%':      { opacity: '0.4', transform: 'scale(0.75)' },
        },
      },
      animation: {
        shimmer:     'shimmer 2.4s linear infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'dot-pulse':  'dot-pulse 2s ease-in-out infinite',
      },
      fontFamily: {
        sans: ['var(--font-jakarta)', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
