/* Beesline Field Cup — service worker (docs/14-PWA.md, FR-61/62/65)
   App shell = cache-first, versioned. Supabase = network-only, never cached.
   Bump CACHE_VERSION on every deploy that changes index.html or the libs. */
'use strict';

const CACHE_VERSION = 'fc-v1.1.1';
const SHELL_CACHE   = CACHE_VERSION + '-shell';
const FONT_CACHE    = CACHE_VERSION + '-fonts';

// Same-origin app shell — install fails loudly if any of these is missing.
// The shell is cached under the SCOPE ROOT ('./'), not './index.html': static hosts such as Cloudflare Pages 308-redirect
// /index.html → /, and a cached response with redirected=true is rejected by the browser for navigation requests.
const SHELL = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon-180.png'
];

// Pinned CDN libs, byte-for-byte as referenced by index.html <script src>.
// Precached best-effort (one CDN hiccup must not block installation).
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

const CDN_HOSTS  = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
const SHELL_URL  = new URL('./', self.location).href;             // cache key of the app shell (scope root)
const INDEX_URL  = new URL('./index.html', self.location).href;   // same document, explicit file name
const SCOPE_PATH = new URL('./', self.location).pathname;

// Copy a response without its `redirected` flag (and without the network Response's internal state) so it is safe to serve for navigations.
async function plainCopy(res) {
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function isSupabase(url) {
  return url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(async (u) => {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (!res.ok) throw new Error('shell fetch failed: ' + u + ' ' + res.status);
      await cache.put(u, await plainCopy(res));
    }));
    await Promise.allSettled(LIBS.map((u) => cache.add(new Request(u, { mode: 'cors' }))));
    // No automatic skipWaiting: the page asks via {type:'SKIP_WAITING'} after the user taps Reload (FR-65).
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('fc-') && k !== SHELL_CACHE && k !== FONT_CACHE)   // only our own old versions (CacheStorage is per-origin)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function offlineResponse() {
  return new Response('Offline', { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } });
}

// Network-first; refresh the cached shell copy when the shell itself was fetched, fall back to it offline.
function isShellNavigation(request) {
  const u = new URL(request.url);
  return u.origin === self.location.origin && (u.pathname === SCOPE_PATH || u.origin + u.pathname === INDEX_URL);
}
async function navigationHandler(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && isShellNavigation(request)) {
      const cache = await caches.open(SHELL_CACHE);
      plainCopy(fresh.clone()).then((copy) => cache.put(SHELL_URL, copy)).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(SHELL_URL);
    return cached || offlineResponse();
  }
}

// Cache-first with network fill (same-origin static + CDN libs).
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && (fresh.ok || fresh.type === 'opaque')) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    return offlineResponse();
  }
}

// Stale-while-revalidate (Google Fonts CSS + woff2).
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((fresh) => {
    if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  }).catch(() => null);
  event.waitUntil(network);
  if (cached) return cached;
  const fresh = await network;
  return fresh || offlineResponse();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;                         // never cache POST / non-GET
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (isSupabase(url)) return;                                    // network-only: REST, Realtime, Storage

  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }
  if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, request));
    return;
  }
  // everything else: pass-through (browser default)
});
