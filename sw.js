// Offline cache, so the app opens instantly on repeat visits and on a weak
// signal. Only this site's own files are kept: live data from other services
// (councils, OpenStreetMap's servers, map tiles) always comes from the network.

const CACHE = 'park-nearby';
const MAX_ENTRIES = 300;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  // The page: the network first, so a new version shows up; the saved copy when offline.
  if (request.mode === 'navigate') return event.respondWith(networkFirst(request));
  // Everything else answers from the saved copy at once and refreshes it in the
  // background. After a deploy their URLs carry a new version, so they're new files.
  event.respondWith(staleWhileRevalidate(event, request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    return (await cache.match(request)) ?? Promise.reject(err);
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) {
      await cache.put(request, response.clone());
      await trim(cache);
    }
    return response;
  });
  if (saved) {
    event.waitUntil(refresh.catch(() => {}));
    return saved;
  }
  return refresh;
}

/** Keeps the cache to the most recent entries, oldest first out. */
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(key);
}
