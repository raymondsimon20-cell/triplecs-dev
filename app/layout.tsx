import type { Metadata } from 'next';
import { Providers } from '@/components/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Triple C Dashboard',
  description: 'Real-time portfolio management for the Triple C\'s strategy',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0f1117] text-[#e8eaf0] antialiased">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
