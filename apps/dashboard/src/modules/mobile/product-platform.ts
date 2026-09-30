/**
 * ONE PRODUCT ON EVERY SCREEN.
 *
 * The modern LeadCommand product (the shell, dock, launcher and every surface
 * rebuilt for the phone) now also runs on desktop and tablet, recomposed for the
 * wide screen by `html.is-desktop-modern` (see desktop-modern.css). The legacy
 * desktop views remain reachable as "Classic desktop" for anything that has
 * not been rebuilt yet:
 *
 *   ?view=classic   switch this browser to the classic desktop (persisted)
 *   ?view=modern    switch back (persisted)
 *
 * Phones always get the modern product; classic is a desktop-only fallback.
 */

const KEY = 'nexus.desktop.classic'
export const PRODUCT_PLATFORM_EVENT = 'nexus:product-platform'

let cached: boolean | null = null

function readFromUrl(): boolean | null {
  if (typeof window === 'undefined') return null
  try {
    const view = new URLSearchParams(window.location.search).get('view')
    if (view === 'classic') return true
    if (view === 'modern') return false
  } catch { /* ignore */ }
  return null
}

/** True when this desktop browser asked for the classic (legacy) desktop views. */
export function isClassicDesktop(): boolean {
  const fromUrl = readFromUrl()
  if (fromUrl !== null) {
    if (fromUrl !== cached) {
      cached = fromUrl
      try { if (fromUrl) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY) } catch { /* private mode */ }
    }
    return fromUrl
  }
  if (cached === null) {
    try { cached = typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1' } catch { cached = false }
  }
  return cached
}

export function setClassicDesktop(classic: boolean) {
  cached = classic
  try { if (classic) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY) } catch { /* private mode */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PRODUCT_PLATFORM_EVENT, { detail: { classic } }))
}
