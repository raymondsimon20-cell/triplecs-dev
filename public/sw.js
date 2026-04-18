/**
 * Triple C Dashboard — Service Worker
 *
 * Strategy:
 *   - HTML navigation: network-first, no precache — pages are auth-dependent
 *     and must reflect the server's current redirect/session decision.
 *   - API data: network-first with cache fallback.
 *   - Static assets (icons, manifest, JS/CSS): cache-first with background update.
 *
 * Bump CACHE_NAME to invalidate prior service-worker caches on deploy.
 */

const CACHE_NAME = 'triplec-v3';

// Only precache truly static assets that do not depend on auth or server state.
// Do NOT precache "/" or "/dashboard" — those are redirects driven by session cookies.
const STATIC_ASSETS = [
  '/favicon.svg',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Best-effort: skip any asset that 404s instead of failing the whole install.
      Promise.all(
        STATIC_ASSETS.map((url) =>
          fetch(url)
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never intercept auth routes — redirects and Set-Cookie must flow through
  // untouched, or OAuth state cookies can be lost between login and callback.
  if (url.pathname.startsWith('/api/auth/')) return;

  // HTML navigation requests: always go to network so server-side redirects
  // based on session cookie are honored. Fall back to cache only if offline.
  const isNavigation =
    request.mode === 'navigate' ||
    (request.destination === '' && request.headers.get('accept')?.includes('text/html'));

  if (isNavigation) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request) || caches.match('/'))
    );
    return;
  }

  // Other API routes: network-first with cache fallback.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Static assets: cache-first with background update.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
