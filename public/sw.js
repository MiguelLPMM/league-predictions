const CACHE_VERSION = 'v6';
const SHELL_CACHE = `predictions-shell-${CACHE_VERSION}`;
const API_CACHE = `predictions-api-${CACHE_VERSION}`;

const SHELL_FILES = [
  '/',
  '/predictions',
  '/leaderboard',
  '/admin',
  '/style.css',
  '/js/main.js',
  '/js/shell.js',
  '/js/auth.js',
  '/js/notify.js',
  '/js/leaderboard.js',
  '/js/scoring.js',
  '/js/admin.js',
  '/js/adminConfig.js',
  '/js/teamMatch.js',
  '/js/leagues.js',
  '/js/guestClaimPrompt.js',
  '/js/api/guestClaims.js',
  '/js/api/leaderboard.js',
  '/js/supabaseClient.js',
  '/vendor/supabase.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  // Pages are the same shell whatever the ?league= query, so match navigations without it
  const cached = await cache.match(request, request.mode === 'navigate' ? { ignoreSearch: true } : undefined);
  const fetchPromise = fetch(request)
    .then((response) => {
      cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}
