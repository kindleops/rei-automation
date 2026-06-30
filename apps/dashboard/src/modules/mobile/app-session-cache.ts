import type { AppSessionSnapshot, PinnedAppId } from './pinned-app-dock.types'

const STORAGE_KEY = 'nx.app-session-cache.v1'

const SCROLL_SELECTORS = [
  '.nx-intel-scroll-body',
  '.nx-inbox-list-scroll',
  '.nx-workspace-pane.is-view-thread',
  '.nx-workspace-pane.is-view-sms_thread',
  '.nx-fullscreen-app-shell',
  '.nx-premium-inbox',
  'main',
] as const

type SessionMap = Record<PinnedAppId, AppSessionSnapshot>

function readStore(): SessionMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as SessionMap
  } catch {
    return {}
  }
}

function writeStore(store: SessionMap) {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

export function resolveAppIdFromRoute(routePath: string): PinnedAppId {
  if (routePath === '/' || routePath.startsWith('/conversation')) return '/inbox'
  if (routePath === '/deal-intelligence' || routePath.startsWith('/deal-intelligence/')) {
    return '__deal_intelligence__'
  }
  const match = [
    '/campaign-command',
    '/workflow-studio',
    '/email-command',
    '/buyer-match',
    '/comp-intelligence',
    '/closing-desk',
    '/entity-graph',
    '/analytics',
    '/calendar',
    '/pipeline',
    '/inbox',
    '/queue',
    '/map',
  ].find((prefix) => routePath === prefix || routePath.startsWith(`${prefix}/`))
  return match ?? routePath
}

function collectContainerScrolls(): Record<string, number> {
  const containerScrolls: Record<string, number> = {}
  SCROLL_SELECTORS.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node, index) => {
      if (!(node instanceof HTMLElement)) return
      if (node.scrollHeight <= node.clientHeight) return
      const key = index === 0 ? selector : `${selector}:${index}`
      containerScrolls[key] = node.scrollTop
    })
  })
  return containerScrolls
}

function readSelectedId(): string | null {
  const selected = document.querySelector('[data-thread-id][aria-selected="true"]') as HTMLElement | null
  if (selected?.dataset.threadId) return selected.dataset.threadId
  const activeRow = document.querySelector('.nx-row25.is-selected, .nx-conversation-row.is-selected') as HTMLElement | null
  return activeRow?.dataset.threadId ?? activeRow?.dataset.id ?? null
}

export function captureAppSession(appId: PinnedAppId) {
  const store = readStore()
  store[appId] = {
    scrollY: window.scrollY,
    containerScrolls: collectContainerScrolls(),
    selectedId: readSelectedId(),
    savedAt: Date.now(),
  }
  writeStore(store)
}

export function restoreAppSession(appId: PinnedAppId) {
  const snapshot = readStore()[appId]
  if (!snapshot) return

  requestAnimationFrame(() => {
    window.scrollTo({ top: snapshot.scrollY, behavior: 'auto' })
    Object.entries(snapshot.containerScrolls).forEach(([key, scrollTop]) => {
      const [selector, indexRaw] = key.split(':')
      const index = indexRaw ? Number(indexRaw) : 0
      const nodes = document.querySelectorAll(selector)
      const node = nodes.item(index)
      if (node instanceof HTMLElement) node.scrollTop = scrollTop
    })
  })
}