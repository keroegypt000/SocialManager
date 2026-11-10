// Service worker: shows a notification when a WhatsApp status is due.
// The push has no data; we ask the platform how many statuses are waiting.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let count = 0;
    try {
      const res = await fetch('/api/whatsapp/count', { credentials: 'same-origin' });
      if (res.ok) count = (await res.json()).count;
    } catch { /* offline or logged out: show the generic message */ }
    await self.registration.showNotification('📱 حالة واتساب جاهزة', {
      body: count > 1 ? `${count} حالات مستنياك تنشرهم` : 'دوس هنا وانشرها بلمسة واحدة',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'whatsapp-status',
      renotify: true,
      dir: 'rtl',
      lang: 'ar',
      data: { url: '/#/whatsapp' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#/whatsapp', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        return w.navigate(url);
      }
    }
    return self.clients.openWindow(url);
  })());
});
