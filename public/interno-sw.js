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

// ---------- Push notifications reales ----------
self.addEventListener('push', (event) => {
  let data = { title: 'TuGPS24 Interno', body: 'Tienes una notificación nueva.', link: '/interno' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // si no viene como JSON, se queda con el texto por defecto
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/img/icon-192.png',
      badge: '/img/icon-192.png',
      data: { link: data.link || '/interno' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/interno';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(link) && 'focus' in client) return client.focus();
      }
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(link);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(link);
    })
  );
});
