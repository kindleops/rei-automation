/**
 * UI MEMORY — view state that must survive a component remount (closing the
 * workspace, navigating apps, switching runs) but is not domain state:
 * which timeline rows are expanded and where each scroll column was. Kept in
 * sessionStorage so a reload restores it too. Never sent anywhere.
 */
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'

const KEY = 'lc.agent.ui.memory.v1'
let expanded: Record<string, true> = {}
const scroll = new Map<string, number>()
let loaded = false
let version = 0
const listeners = new Set<() => void>()

function load() {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(KEY) || '{}') as { expanded?: Record<string, true>; scroll?: Record<string, number> }
    expanded = raw.expanded ?? {}
    for (const [k, v] of Object.entries(raw.scroll ?? {})) scroll.set(k, v)
  } catch { /* ignore */ }
}
let saveTimer: ReturnType<typeof setTimeout> | null = null
function save() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try { window.sessionStorage.setItem(KEY, JSON.stringify({ expanded, scroll: Object.fromEntries([...scroll.entries()].slice(-200)) })) } catch { /* quota */ }
  }, 200)
}

export function isExpanded(key: string): boolean { load(); return Boolean(expanded[key]) }
export function toggleExpanded(key: string, value?: boolean) {
  load()
  const next = value ?? !expanded[key]
  const copy = { ...expanded }
  if (next) copy[key] = true; else delete copy[key]
  expanded = copy
  version += 1
  listeners.forEach((l) => l())
  save()
}
export function useExpandedVersion(): number {
  return useSyncExternalStore((l) => { load(); listeners.add(l); return () => { listeners.delete(l) } }, () => version, () => version)
}

/** Restore and track a scroll container's position under `key` (one per run × column). */
export function usePreservedScroll<T extends HTMLElement>(key: string | null): [RefObject<T>, () => void] {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    load()
    const el = ref.current
    if (!el || !key) return
    const y = scroll.get(key)
    el.scrollTop = y ?? 0
  }, [key])
  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el || !key) return
    scroll.set(key, el.scrollTop)
    save()
  }, [key])
  return [ref, onScroll]
}
