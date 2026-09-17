/* eslint-disable no-restricted-globals */
// CACHE_VERSION is injected at build time by vite (pwa-manifest plugin).
const CACHE_VERSION = '__NEXUS_CACHE_VERSION__'
const ACTIVE_CACHE = `nexus-shell-${CACHE_VERSION}`
const LEGACY_CACHES = ['nexus-shell-v1']

const isDocumentRequest = (request, url) =>
  request.mode === 'navigate'
  || request.destination === 'document'
  || url.pathname === '/'
  || url.pathname.endsWith('.html')

const isImmutableAsset = (url) =>
  url.pathname.startsWith('/assets/')
  || /\.[a-f0-9]{8,}\.(js|css|woff2?)$/i.test(url.pathname)

const isCacheableAssetResponse = (url, response) => {
  if (!response?.ok) return false
  const type = (response.headers.get('content-type') || '').toLowerCase()
  if (type.includes('text/html')) return false
  if (url.pathname.startsWith('/assets/')) {
    return type.includes('javascript') || type.includes('css') || type.includes('font')
  }
  return type.includes('javascript') || type.includes('css') || type.includes('font')
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('nexus-shell') || LEGACY_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      ))
      .then(() => caches.open(ACTIVE_CACHE))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'NEXUS_SW_ACTIVATED', cache: ACTIVE_CACHE })
        }
      }),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/version') return
  if (url.pathname === '/sw.js') return

  if (isImmutableAsset(url)) {
    // Network-first: never serve a stale (possibly HTML-poisoned) cache before the network.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isCacheableAssetResponse(url, response)) {
            const copy = response.clone()
            void caches.open(ACTIVE_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => caches.match(request).then((cached) => {
          const cachedType = (cached?.headers.get('content-type') || '').toLowerCase()
          if (cached && !cachedType.includes('text/html')) return cached
          return Response.error()
        })),
    )
    return
  }

  if (isDocumentRequest(request, url)) {
    event.respondWith(
      fetch(request)
        .then((response) => response)
        .catch(() => caches.match(request)),
    )
    return
  }

  event.respondWith(
    fetch(request).catch(() => caches.match(request)),
  )
})

/* ══════════════════════════════════════════════════════════════════════════
   WEB PUSH — RFC 8030 delivery, and the tap that follows it
   ══════════════════════════════════════════════════════════════════════════

   This worker had no push handling at all, so a delivered push was dropped by
   the browser and (on Chrome) replaced with the generic "This site has been
   updated in the background" notification. These two listeners are the whole
   client half of §5's push requirement.

   The payload is written by the server from the notification row it just
   inserted, which is what keeps a push and the in-app notification centre
   pointing at the same entity. `data.url` is that deep link; the worker never
   computes one itself, because two independent link resolvers is how a push
   ends up on a different screen than the notification it copies.
   ══════════════════════════════════════════════════════════════════════════ */

const parsePushPayload = (event) => {
  try {
    return event.data ? event.data.json() : null
  } catch {
    // A push with a non-JSON body is not ours. Showing a raw string as a title
    // would be worse than the fallback.
    return null
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event)
  // The Push API requires a visible notification for a user-visible-only
  // subscription. Bailing out silently would get the subscription revoked by
  // the browser, so an unreadable payload still shows something truthful.
  const title = payload?.title || 'LeadCommand'
  const options = {
    body: payload?.body || 'New operational signal',
    tag: payload?.id || undefined,
    // Same tag replaces rather than stacks: a grouped signal that fires twice
    // should update one notification, not fill the shade.
    renotify: Boolean(payload?.id) && payload?.severity === 'critical',
    requireInteraction: payload?.severity === 'critical',
    timestamp: payload?.createdAt ? Date.parse(payload.createdAt) || Date.now() : Date.now(),
    data: { url: payload?.url || '/inbox', id: payload?.id || null },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification?.data?.url || '/inbox'

  event.waitUntil((async () => {
    const url = new URL(target, self.location.origin).href
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

    // Focus an existing window and navigate it rather than opening a second copy
    // of the app — a PWA that spawns a new window per notification is unusable
    // after three alerts.
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue
      await client.focus()
      if ('navigate' in client) {
        await client.navigate(url).catch(() => undefined)
      } else {
        client.postMessage({ type: 'NEXUS_PUSH_NAVIGATE', url: target })
      }
      return
    }

    await self.clients.openWindow(url)
  })())
})
