// Vernostka service worker - offline-first app shell cache
//
// IMPORTANT: bump CACHE_VERSION whenever app files change. Each bump makes the browser
// treat this as a new service worker, which re-runs install() (refreshing every cached
// file) and activate() (deleting old cache versions). Forgetting to bump it can leave the
// app running on a stale mix of old/new files after a deploy.
const CACHE_VERSION = 'vernostka-v21';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/i18n.js',
  './js/db.js',
  './js/stores.js',
  './js/codegen.js',
  './js/scanner.js',
  './js/geo.js',
  './js/backup.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  // Third-party libs, cached on first successful fetch too, but pre-list core ones
  'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Same-origin app code (HTML/JS/CSS) that should always be fetched fresh from the network
// first when online, so a deploy is visible immediately instead of waiting on a background
// revalidation. Everything else (icons, manifest, pinned third-party libs) is effectively
// immutable/versioned, so cache-first is safe and faster for those.
function isAppCode(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            // Don't fail install if one optional (CDN) asset can't be fetched right now
            console.warn('SW cache miss for', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isAppCode(url)) {
    // Network-first: always get the latest app code when online. Offline (or if the
    // network request fails), fall back to the cache so the app still works.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => {
            if (cached) return cached;
            if (req.mode === 'navigate') return caches.match('./index.html');
            return new Response('', { status: 408, statusText: 'Offline' });
          })
        )
    );
    return;
  }

  // Icons, manifest, third-party libs: cache-first, refreshing the cache in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(req, res.clone()));
        }).catch(() => {});
        return cached;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => new Response('', { status: 408, statusText: 'Offline' }));
    })
  );
});
