// Сервис-воркер: держит оболочку приложения в кеше и показывает пуш-уведомления.
const CACHE = 'apelsin-v2';
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'config.js', 'vendor/supabase.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/badge.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// Сначала сеть (чтобы обновления приходили сразу), кеш только когда сети нет.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (error) { /* пустой пуш */ }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const looking = windows.some((client) => client.focused && client.visibilityState === 'visible');
    // iOS отзывает разрешение, если пуш пришёл, а уведомление не показано, поэтому там показываем всегда.
    const isApple = /iPhone|iPad|iPod|Macintosh.*Safari/.test(self.navigator.userAgent) && !/Chrome/.test(self.navigator.userAgent);
    if (looking && !isApple) return;

    await self.registration.showNotification(data.title || 'Апельсин', {
      body: data.body || 'Новое сообщение',
      tag: data.chat_id || 'message',
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge.png',
      data: { chat_id: data.chat_id || null },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data && event.notification.data.chat_id;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length) {
      const client = windows[0];
      await client.focus();
      client.postMessage({ type: 'open-chat', chat_id: chatId });
      return;
    }
    await self.clients.openWindow(chatId ? './?chat=' + chatId : './');
  })());
});
