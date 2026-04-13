const CACHE_NAME = 'printfarm-v2';
const SHELL_URLS = ['/', '/index.html', '/style.css', '/app.js', '/favicon.svg', '/manifest.json'];

// Cache app shell on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

// Clean old caches on activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for API, cache-first for static assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API requests: always network
  // Only handle http(s) requests — skip extensions, data URIs, etc.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') {
    return;
  }

  // Static assets: cache-first, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// Push notifications
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  const options = {
    body: data.body || '',
    icon: data.icon || '/favicon.svg',
    badge: data.badge || '/favicon.svg',
    tag: data.tag || 'printfarm',
    renotify: data.renotify !== false,
    requireInteraction: !!data.requireInteraction,
    silent: !!data.silent,
    data: { url: data.url || '/' },
  };
  if (data.image) options.image = data.image;
  if (Array.isArray(data.actions)) options.actions = data.actions;

  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'PrintFarm Planner', options);
    // Browsers won't let the SW play audio directly, but any open tab can.
    // Tell every client to play a bell so the notification is audible even
    // when the OS sound for web push is muted.
    if (data.playSound !== false) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) c.postMessage({ type: 'play-sound', kind: data.soundKind || 'bell' });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
