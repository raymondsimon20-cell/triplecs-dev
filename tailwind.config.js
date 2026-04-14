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
    },
  },
  plugins: [],
};
