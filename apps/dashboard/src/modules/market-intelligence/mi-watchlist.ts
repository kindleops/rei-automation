import { useSyncExternalStore } from 'react'

/**
 * Market watchlist (brief §36): favourite geographies for quick access and
 * comparison presets. Device-local (localStorage), attention only. It arms no
 * alert and creates no Signal rule. The server watchlist
 * (notification_watchlist) accepts seller / property / campaign / prospect /
 * owner entities only, so a geography cannot be watched server-side yet.
 */
export interface MiWatch { id: string; label: string; level: string; addedAt: number }
const KEY = 'lc.mi.watchlist.v1'
const MAX = 40
const subs = new Set<() => void>()
let cache: MiWatch[] | null = null

function read(): MiWatch[] {
  if (cache) return cache
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    cache = Array.isArray(v) ? v.filter((w) => w && typeof w.id === 'string' && typeof w.label === 'string').slice(0, MAX) : []
  } catch { cache = [] }
  return cache
}
function write(list: MiWatch[]) {
  cache = list.slice(0, MAX)
  try { localStorage.setItem(KEY, JSON.stringify(cache)) } catch { /* private mode: session only */ }
  for (const s of subs) s()
}

export const isWatched = (id: string) => read().some((w) => w.id === id)
export function toggleWatch(w: Omit<MiWatch, 'addedAt'>): boolean {
  const list = read()
  if (list.some((x) => x.id === w.id)) { write(list.filter((x) => x.id !== w.id)); return false }
  write([{ ...w, addedAt: Date.now() }, ...list])
  return true
}
export function useWatchlist(): MiWatch[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, read, () => [])
}
export const _resetWatchlist = () => { cache = null }
