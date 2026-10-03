import { useSyncExternalStore } from 'react'

/**
 * Whether the Brief plane is open, and when the operator last opened it (per
 * device) — "new since you last looked" is that timestamp compared with each
 * line's own evidence time. Nothing else is remembered.
 */

const SEEN_KEY = 'lc.brief.seen.v1'
let open = false
let lastSeen: number | null = readSeen()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function readSeen(): number | null {
  try { const v = Number(localStorage.getItem(SEEN_KEY)); return Number.isFinite(v) && v > 0 ? v : null } catch { return null }
}

/** Open the plane. The previous "seen" time is kept for this opening so new lines can be marked. */
export function openBrief() {
  if (open) return
  open = true
  emit()
}
export function closeBrief() {
  if (!open) return
  open = false
  lastSeen = Date.now()
  try { localStorage.setItem(SEEN_KEY, String(lastSeen)) } catch { /* private mode */ }
  emit()
}
export const toggleBrief = () => (open ? closeBrief() : openBrief())

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useBriefOpen = () => useSyncExternalStore(subscribe, () => open, () => false)
export const useBriefSeen = () => useSyncExternalStore(subscribe, () => lastSeen, () => null)
