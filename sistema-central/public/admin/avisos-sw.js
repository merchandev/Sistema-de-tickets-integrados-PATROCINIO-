// Service worker of the panel, used only for system notifications of new payments. Showing them through
// the worker works on desktop and Android, and a click brings the panel back with the order open.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const orderId = event.notification.data && event.notification.data.orderId;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const panel = tabs.find(tab => new URL(tab.url).pathname.startsWith('/admin'));
    if (panel) {
      await panel.focus();
      if (orderId) panel.postMessage({ type: 'open-order', id: orderId });
      return;
    }
    await self.clients.openWindow('/admin/');
  })());
});
