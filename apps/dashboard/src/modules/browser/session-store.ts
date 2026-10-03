import { useSyncExternalStore } from 'react'
import { guardUrl } from './registry'
import { createSession, reviveSession, serializeSession, type BrowserSession, type Histories } from './session-model'
import { registerSessionFlusher, SESSION_KEY } from './session-snapshot'

/**
 * Browser sessions, keyed by session id (the `?s=` the Browser instance
 * carries in its workspace path — so a saved workspace restores its
 * Browser's tabs by reference).
 *
 *   tabs     localStorage  lc.browser.session.v1:<sid>   (workspace state)
 *   history  sessionStorage lc.browser.history.v1:<sid>  (transient, this OS tab)
 *   recent   localStorage  lc.browser.recent.v1          (Recent research, local only)
 *
 * Nothing here leaves the device. No cookies or page data are ever stored —
 * only URLs and titles the operator opened.
 */

const HISTORY_KEY = (sid: string) => `lc.browser.history.v1:${sid}`
const RECENT_KEY = 'lc.browser.recent.v1'
const MAX_RECENT = 12

interface Entry { s: BrowserSession; h: Histories; listeners: Set<() => void>; snap: { s: BrowserSession; h: Histories } }
const entries = new Map<string, Entry>()

const storage = (kind: 'local' | 'session'): Storage | null => {
  try { return typeof window === 'undefined' ? null : kind === 'local' ? window.localStorage : window.sessionStorage } catch { return null }
}
const read = (kind: 'local' | 'session', key: string): unknown => {
  try { const raw = storage(kind)?.getItem(key); return raw ? JSON.parse(raw) : null } catch { return null }
}
const write = (kind: 'local' | 'session', key: string, value: unknown) => {
  try { storage(kind)?.setItem(key, JSON.stringify(value)) } catch { /* quota / private mode: the session simply is not kept */ }
}

const guard = (url: string) => { const g = guardUrl(url); return g.ok ? g.url : null }

function reviveHistories(raw: unknown, s: BrowserSession): Histories {
  const out: Histories = {}
  const r = raw && typeof raw === 'object' ? (raw as Record<string, { stack?: unknown; index?: unknown }>) : {}
  for (const t of s.tabs) {
    const h = r[t.id]
    const stack = Array.isArray(h?.stack) ? h!.stack.map((u) => (typeof u === 'string' ? guard(u) : null)).slice(-50) : []
    const index = Number(h?.index)
    out[t.id] = stack.length && Number.isInteger(index) && index >= 0 && index < stack.length && stack[index] === t.url
      ? { stack, index }
      : { stack: [t.url], index: 0 }
  }
  return out
}

function load(sid: string): Entry {
  let e = entries.get(sid)
  if (e) return e
  const now = Date.now()
  const s = reviveSession(read('local', SESSION_KEY(sid)), guard, now) ?? createSession(sid, now)
  const h = reviveHistories(read('session', HISTORY_KEY(sid)), s)
  e = { s, h, listeners: new Set(), snap: { s, h } }
  entries.set(sid, e)
  return e
}

let timer: number | null = null
const dirty = new Set<string>()
function flush() {
  timer = null
  for (const sid of dirty) {
    const e = entries.get(sid)
    if (!e) continue
    write('local', SESSION_KEY(sid), serializeSession(e.s))
    write('session', HISTORY_KEY(sid), e.h)
  }
  dirty.clear()
}
function flushNow() { if (timer !== null) { if (typeof window !== 'undefined') window.clearTimeout(timer); flush() } }
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushNow)
// a workspace save / restore / duplicate copies the latest tabs, never a stale write-behind
registerSessionFlusher(flushNow)

export function getSession(sid: string): { s: BrowserSession; h: Histories } {
  return load(sid).snap
}

export function updateSession(sid: string, fn: (cur: { s: BrowserSession; h: Histories }) => { s: BrowserSession; h: Histories }) {
  const e = load(sid)
  const next = fn({ s: e.s, h: e.h })
  if (next.s === e.s && next.h === e.h) return
  e.s = next.s
  e.h = next.h
  e.snap = { s: e.s, h: e.h }
  dirty.add(sid)
  if (timer === null && typeof window !== 'undefined') timer = window.setTimeout(flush, 400)
  e.listeners.forEach((l) => l())
}

export function useBrowserSession(sid: string): { s: BrowserSession; h: Histories } {
  const e = load(sid)
  return useSyncExternalStore(
    (l) => { e.listeners.add(l); return () => { e.listeners.delete(l) } },
    () => e.snap,
    () => e.snap,
  )
}

/* ── recent research (local only) ─────────────────────────────────────── */

export interface RecentItem { url: string; title: string | null; host: string; context: string | null; at: number }

export function readRecent(): RecentItem[] {
  const raw = read('local', RECENT_KEY)
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r: unknown) => {
    if (!r || typeof r !== 'object') return []
    const x = r as Record<string, unknown>
    const url = typeof x.url === 'string' ? guard(x.url) : null
    if (!url) return []
    let host = ''
    try { host = new URL(url).hostname.replace(/^www\./, '') } catch { return [] }
    return [{ url, host, title: typeof x.title === 'string' ? x.title.slice(0, 200) : null, context: typeof x.context === 'string' ? x.context.slice(0, 160) : null, at: Number(x.at) || 0 }]
  }).slice(0, MAX_RECENT)
}

export function pushRecent(item: Omit<RecentItem, 'at' | 'host'>) {
  const g = guardUrl(item.url)
  if (!g.ok) return
  const list = readRecent().filter((r) => r.url !== g.url)
  write('local', RECENT_KEY, [{ ...item, url: g.url, at: Date.now() }, ...list].slice(0, MAX_RECENT))
}

export function clearRecent() { write('local', RECENT_KEY, []) }
