// PunchClock Pro — Service Worker
// Enables PWA installation (desktop/home screen shortcut).
// Keeps a minimal cache so the app shell loads instantly even on slow connections.

const CACHE_NAME = 'punchclock-v81';

// Only cache the app shell — never cache API/database calls
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: pre-cache the app shell ──────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ─────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first strategy ─────────────────────────────────────────
// Always try the network first so data is always fresh.
// Fall back to cache only for the app shell (navigation requests).
self.addEventListener('fetch', event => {
  const req = event.request;

  // Pass through all API / Supabase / Stripe calls without caching
  if (
    req.url.includes('supabase.co') ||
    req.url.includes('stripe.com') ||
    req.url.includes('fonts.googleapis.com') ||
    req.url.includes('cdnjs.cloudflare.com') ||
    req.url.includes('qrserver.com') ||
    req.method !== 'GET'
  ) {
    return; // let the browser handle it normally
  }

  // For navigation (page loads) — network first, cache fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          // Update cache with fresh response
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return response;
        })
        .catch(() => caches.match('/index.html')) // offline fallback
    );
    return;
  }

  // For other GET requests — network first, cache fallback
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
