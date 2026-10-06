// Service worker de la demo 3D: lo mínimo para que se instale como app en Android. Igual que el del
// panel interno, va a la red primero (la demo debe verse siempre con su última versión) y usa la
// caché solo si no hay internet.
const CACHE_NAME = 'tugps24-demo3d-shell-v1';
const APP_SHELL = ['/img/icon-192.png', '/img/icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tugps24-demo3d') && k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
