/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pillar: {
          triples: '#8b5cf6',
          cornerstone: '#f59e0b',
          income: '#10b981',
          hedge: '#ef4444',
          cash: '#64748b',
        },
      },
    },
  },
  plugins: [],
};
