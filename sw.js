/* صح أو طيح! — Service Worker بسيط
   - اللعبة كلها تشتغل من السيرفر (الأسئلة والاتصال لحظي)، فما نخزن الصفحات.
   - إذا انقطع النت وفتحت التطبيق، تطلع صفحة «ما في إنترنت» بدل صفحة خطأ. */
const CACHE = 'sah-aw-teeh-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll([OFFLINE, '/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  // أيقونة صفحة «ما في إنترنت» من الذاكرة؛ باقي الطلبات (ومنها اتصال اللعبة) تروح للسيرفر عادي
  if (new URL(req.url).pathname === '/icon-192.png') {
    event.respondWith(fetch(req).catch(() => caches.match('/icon-192.png')));
  }
});
