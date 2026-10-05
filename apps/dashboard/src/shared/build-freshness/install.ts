import {
  hasUnsavedInput,
  parseMainEntry,
  recoverFromChunkFailure,
  startVersionPoll,
  type ChunkRecoveryOutcome,
  type FreshnessDeps,
} from './build-freshness'

/** The entry this tab booted from — the boot script appends it to <body>. */
function runningEntry(): string | null {
  if (typeof document === 'undefined') return null
  for (const script of Array.from(document.scripts)) {
    const entry = parseMainEntry(script.getAttribute('src'))
    if (entry) return entry
  }
  return null
}

async function fetchLatestEntry(): Promise<string | null> {
  // `/` is served no-cache/no-store (static/_headers); `/index.html` 307s to `/`.
  const res = await fetch(`/?lc-build-probe=${Date.now()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'text/html' },
  })
  if (!res.ok) return null
  return parseMainEntry(await res.text())
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function browserFreshnessDeps(): FreshnessDeps {
  return {
    runningEntry,
    fetchLatestEntry,
    hasUnsavedInput: () => hasUnsavedInput(typeof document === 'undefined' ? null : document),
    storage: typeof window === 'undefined' ? null : safeSessionStorage(),
    reload: () => window.location.reload(),
  }
}

export function recoverChunkFailureInBrowser(): Promise<ChunkRecoveryOutcome> {
  return recoverFromChunkFailure(browserFreshnessDeps())
}

let installed = false

/**
 * Global chunk-load recovery + the proactive version poll. Vite dispatches
 * `vite:preloadError` for EVERY failed dynamic import (deps and the module
 * itself), including the lazy views nested inside app chunks. The event is not
 * prevented, so the error still reaches the surface's error state; this only
 * decides whether a newer build explains it.
 */
export function installBuildFreshness() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('vite:preloadError', () => {
    void recoverChunkFailureInBrowser()
  })
  if (!runningEntry()) return // dev server: no hashed entry, nothing to compare
  startVersionPoll(browserFreshnessDeps(), {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    addFocusListener: (fn) => {
      const onVisible = () => {
        if (document.visibilityState === 'visible') fn()
      }
      window.addEventListener('focus', fn)
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        window.removeEventListener('focus', fn)
        document.removeEventListener('visibilitychange', onVisible)
      }
    },
    now: () => Date.now(),
  })
}
