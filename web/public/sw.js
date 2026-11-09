/* MISK service worker: shows push notifications from the MISK API and opens the app when tapped. */
self.addEventListener('push', (event) => {
  let message = { title: 'MISK', body: '' };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    message.body = event.data ? event.data.text() : '';
  }
  event.waitUntil(self.registration.showNotification(message.title, { body: message.body, tag: 'misk', renotify: true }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      return open ? open.focus() : self.clients.openWindow('/');
    }),
  );
});
