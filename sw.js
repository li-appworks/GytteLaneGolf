/* =====================================================================
   Gytte Lane Golf Society — service worker
   Lets the site open with no signal by keeping a copy of the page and
   its libraries on the device. Data comes from the site's own offline
   snapshot; live Supabase requests are never intercepted or cached.
   ===================================================================== */

const CACHE_NAME = 'glgs-v1';
const PRECACHE = ['/', '/index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept live data services — these must always hit the network
  if (url.hostname.endsWith('supabase.co')) return;
  if (url.hostname === 'api.postcodes.io') return;
  if (url.hostname.endsWith('tile.openstreetmap.org')) return;

  // Page loads: network first (so updates come through), cached copy if offline.
  // Cached under the request's own URL — was previously always cached (and
  // matched, on offline fallback) under the fixed key '/index.html'
  // regardless of which page was actually requested, so a navigation to
  // login.html would overwrite index.html's own cache entry, and either
  // page could serve the other's stale content the next time the network
  // fetch failed on a flaky connection.
  if (req.mode === 'navigate'){
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (fonts, Leaflet, Supabase JS library from CDNs):
  // cache first for speed and offline, fetch and store if not cached yet
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok){
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
