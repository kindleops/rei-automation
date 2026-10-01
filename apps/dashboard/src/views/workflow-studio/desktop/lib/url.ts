/** The studio's own URL state — written only while the studio owns the window URL (never another pane's). */

export const readParam = (k: string): string | null => {
  try { return new URLSearchParams(window.location.search).get(k) } catch { return null }
}

export function writeParams(patch: Record<string, string | null | undefined>) {
  try {
    if (!window.location.pathname.startsWith('/workflow-studio')) return
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(patch)) { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k) }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
  } catch { /* best effort */ }
}

/** A remembered local preference (rail width, minimap, direction). */
export function pref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(`ws4.${key}`); return v === null ? fallback : (JSON.parse(v) as T) } catch { return fallback }
}
export function savePref<T>(key: string, value: T) {
  try { localStorage.setItem(`ws4.${key}`, JSON.stringify(value)) } catch { /* private mode */ }
}
