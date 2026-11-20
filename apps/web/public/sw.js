/* Service worker: lets the app OPEN and RUN when the internet is down (cloud use on a phone or till).
 *
 *  - On install the WHOLE app is cached: the page shell and every file of the build (the list comes from
 *    /asset-manifest.json, written at build time). So going offline at any moment is safe: a refresh opens the app,
 *    and a screen nobody visited yet still has its code.
 *  - Pages: network first (so a new version is picked up at once); if the network fails or is slower than 4 seconds,
 *    the cached shell is used.
 *  - /assets and /fonts (files named by their content hash) and icons: cache first.
 *  - The API is NEVER touched or stored here: sign-in, orders and money always go straight to the server, and nothing
 *    about a guest or a bill is kept in a cache.
 */
const SHELL = 'erp-shell-v2';
const FILES = 'erp-files-v2';

/** Fetches the shell and every build file now, so none of them has to be visited online first. */
async function precache() {
  const shell = await caches.open(SHELL);
  const files = await caches.open(FILES);
  try {
    const res = await fetch('/', { cache: 'reload' });
    if (res.ok) await shell.put('/shell', res);
  } catch {
    /* installed while offline: the next online page load stores it */
  }
  try {
    const manifest = await (await fetch('/asset-manifest.json', { cache: 'reload' })).json();
    // one by one: a single failed file must not stop the rest from being stored
    for (const url of manifest.files ?? []) {
      try {
        if (!(await files.match(url, { ignoreVary: true }))) {
          const res = await fetch(url);
          if (res.ok) await files.put(url, res);
        }
      } catch {
        /* fetched on first use instead */
      }
    }
  } catch {
    /* no manifest (a dev build): files are cached on first use */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});
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
  // ignoreVary: a precached copy was fetched without the Origin header a module script sends
  const hit = await cache.match(request, { ignoreVary: true });
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
