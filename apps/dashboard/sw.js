/* eslint-disable no-restricted-globals */
// Tombstone worker.
//
// The previous worker answered fetches after the first load, which made a URL
// serve one build on load 1 and potentially another on load 2 — the "it was
// full-screen, then I refreshed and it wasn't" symptom. It also told the page to
// reload on controllerchange, so a deploy could swap the build under a running
// session.
//
// This file replaces it with a worker whose only job is to remove itself, clear
// every cache it created, and hand control back to the network. It exists rather
// than 404ing so that handsets which already have the old worker installed get a
// definitive uninstall.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => { for (const client of clients) client.navigate(client.url) })
      .catch(() => undefined),
  )
})

// No fetch handler: every request goes straight to the network.
