// Service worker del panel interno — solo lo mínimo para que sea instalable como app.
// A propósito NO cachea páginas ni datos en vivo (Redis) ni el JS de la app: acabamos de
// pasar por un problema real de JS viejo servido desde caché, así que aquí la estrategia es
// "red primero, caché solo como último recurso si no hay internet" — nunca al revés.
const CACHE_NAME = 'tugps24-interno-shell-v1';
const APP_SHELL = ['/img/icon-192.png', '/img/icon-512.png', '/favicon.svg'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
