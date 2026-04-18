import type { Metadata } from 'next';
import { Providers } from '@/components/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Triple C Dashboard',
  description: 'Real-time portfolio management for the Triple C\'s strategy',
  manifest: '/manifest.json',
  themeColor: '#3b82f6',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Triple C',
  },
  icons: {
    icon: '/favicon.svg',
    apple: '/icon-192.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body className="min-h-screen bg-[#0f1117] text-[#e8eaf0] antialiased">
        <Providers>
          {children}
        </Providers>
        {/* Service worker registration */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js').then((reg) => {
                    // Pick up new SW versions on next navigation instead of
                    // serving stale HTML from a previous deploy.
                    reg.addEventListener('updatefound', () => {
                      const sw = reg.installing;
                      if (!sw) return;
                      sw.addEventListener('statechange', () => {
                        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                          reg.update().catch(() => {});
                        }
                      });
                    });
                    reg.update().catch(() => {});
                  }).catch(() => {});
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
