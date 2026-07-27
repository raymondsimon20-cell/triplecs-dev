/**
 * Triple C Dashboard — Service Worker
 *
 * Strategy (v2 — fixes post-deploy version skew):
 *   - Navigations (HTML): network-first, cache only as offline fallback.
 *     Serving cached HTML cache-first caused stale pages to load old chunk
 *     manifests after deploys → mixed-version TypeErrors.
 *   - /_next/static/ chunks: cache-first (content-hashed, immutable).
 *   - API data: network-first with cache fallback (stale beats nothing).
 *   - Everything else: network-first with cache fallback.
 */

const CACHE_NAME = 'triplec-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME));
  self.skipWaiting();
});

// Activate — clean old caches (including v1's stale app shell)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    })
    .catch(() => caches.match(request).then((cached) => {
      if (cached) return cached;
      throw new Error('offline and not cached');
    }));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Immutable content-hashed build assets: cache-first is safe forever.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached ?? fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
      )
    );
    return;
  }

  // Navigations, API, and everything else: fresh network first, cache as
  // offline fallback only. Prevents stale HTML pointing at deleted chunks.
  event.respondWith(networkFirst(request));
});
