import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Triple C',
  description: 'Leveraged-ETF + income-fund portfolio automation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
