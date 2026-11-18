/* Service worker: lets the app OPEN when the internet is down (cloud use on a phone or till).
 *
 *  - Pages: network first (so a new version is picked up at once); if the network fails or is
 *    slower than 4 seconds, the last page shell is used.
 *  - /assets and /fonts (files named by their content hash) and icons: cache first.
 *  - The API is NEVER touched or stored here: sign-in, orders and money always go straight to the
 *    server, and nothing about a guest or a bill is kept in a cache.
 */
const SHELL = 'erp-shell-v1';
const FILES = 'erp-files-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL && key !== FILES) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), ms));

async function page(request) {
  const shell = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(request), timeout(4000)]);
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      await shell.put('/shell', res.clone());
    }
    return res;
  } catch {
    const cached = await shell.match('/shell');
    if (cached) return cached;
    throw new Error('offline and nothing cached yet');
  }
}

async function file(request) {
  const cache = await caches.open(FILES);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return; // never cached
  if (request.mode === 'navigate') {
    event.respondWith(page(request));
  } else if (/^\/(assets|fonts)\//.test(url.pathname) || /^\/icon-.*\.png$/.test(url.pathname)) {
    event.respondWith(file(request));
  }
});
