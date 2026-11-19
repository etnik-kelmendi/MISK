/* MISK service worker: shows push notifications from the MISK API and opens the app when tapped. */
self.addEventListener('push', (event) => {
  let message = { title: 'MISK', body: '' };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    message.body = event.data ? event.data.text() : '';
  }
  // A message can lead to a page of the app, e.g. the chat of a booking (D83). Only paths inside the app.
  const url = typeof message.url === 'string' && /^\/[A-Za-z0-9/_-]{0,200}$/.test(message.url) ? message.url : '/';
  event.waitUntil(self.registration.showNotification(message.title, { body: message.body, tag: 'misk', renotify: true, data: { url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      if (!open) return self.clients.openWindow(url);
      // An open app goes to the page the message is about; without navigate() it is only brought forward.
      return url !== '/' && 'navigate' in open ? open.navigate(url).then((w) => (w || open).focus()) : open.focus();
    }),
  );
});
