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
          .filter((key) => (key.startsWith('nexus-shell') && key !== ACTIVE_CACHE) || LEGACY_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      ))
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
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(ACTIVE_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
      }),
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