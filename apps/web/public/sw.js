/* Dashboard service worker: shows live chat push notifications and opens the conversation. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

/* Every push must show a notification: browsers penalise silent pushes, and Safari revokes the
subscription after a few. The tag folds a burst from one conversation into one notification. */
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'New message', {
      body: data.body || '',
      tag: data.tag || 'live-chat',
      renotify: true,
      icon: '/icons/icon-192.png',
      data: {url: data.url || '/inbox'},
    }),
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/inbox', self.location.origin);
  if (target.origin !== self.location.origin) {
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
      const open = windows.find(client => new URL(client.url).origin === self.location.origin);
      if (open) {
        open.postMessage({type: 'open', url: target.pathname + target.search});
        await open.focus().catch(() => undefined);
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
