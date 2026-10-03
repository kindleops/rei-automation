/**
 * BROWSER STATE BELONGS TO A WORKSPACE INSTANCE — copy-on-save, copy-on-restore,
 * copy-on-duplicate. Light on purpose (no registry, no React): the workspace
 * store imports it.
 *
 * A Browser pane names its session in its own path (`/browser?s=<sid>`), so
 * every pane already has its own tab set. What this module adds is OWNERSHIP:
 *
 *   save       the saved workspace gets a SNAPSHOT (a new sid holding a copy of
 *              the live tabs). Browsing on afterwards changes the live session,
 *              never the saved one, until the operator saves again.
 *   restore    the live workspace gets a FORK of the snapshot (a new sid), so
 *              using a restored workspace never rewrites what was saved.
 *   duplicate  the copy gets its own sids — never shared.
 *   delete     the snapshot's sessions are released.
 *   migrate    saved workspaces that shared a sid (before this existed) are
 *              split at boot: each gets its own copy; nothing is lost.
 *
 * Only tabs are copied (URL, title, context, destination type, embed mode).
 * Back/forward history is transient and stays with the live session.
 */
import { sessionIdOf } from './intent'

export const SESSION_KEY = (sid: string) => `lc.browser.session.v1:${sid}`
const HISTORY_KEY = (sid: string) => `lc.browser.history.v1:${sid}`

let flusher: (() => void) | null = null
/** session-store registers its write-behind flush, so a copy always sees the latest tabs. */
export function registerSessionFlusher(fn: () => void) { flusher = fn }

const ls = (): Storage | null => { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }

let seq = 0
export const newSnapshotSid = () => `b${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Copy one session's tabs to a new sid. Returns the new sid (an empty session when the source has nothing stored). */
export function copySession(from: string): string {
  flusher?.()
  const to = newSnapshotSid()
  const store = ls()
  try {
    const raw = store?.getItem(SESSION_KEY(from))
    if (raw) {
      const doc = JSON.parse(raw) as Record<string, unknown>
      store?.setItem(SESSION_KEY(to), JSON.stringify({ ...doc, id: to, handled: [] }))
    }
  } catch { /* storage unavailable: the copy starts empty, the source is untouched */ }
  return to
}

export function releaseSession(sid: string) {
  try { ls()?.removeItem(SESSION_KEY(sid)) } catch { /* ignore */ }
  try { window.sessionStorage?.removeItem(HISTORY_KEY(sid)) } catch { /* ignore */ }
}

const queryOf = (path: string) => (path.includes('?') ? path.slice(path.indexOf('?')) : '')
export const browserSidOf = (path: string): string | null => sessionIdOf(queryOf(path))

/** The same Browser path, pointing at another session (intent params dropped — they already ran). */
export function withSid(path: string, sid: string): string {
  return `${path.split('?')[0].split('#')[0] || '/browser'}?s=${sid}`
}

/** Path → path with its own copy of the session (paths without a session are returned as they are). */
export function copyPath(path: string): string {
  const sid = browserSidOf(path)
  return sid ? withSid(path, copySession(sid)) : path
}

export function releasePath(path: string) {
  const sid = browserSidOf(path)
  if (sid) releaseSession(sid)
}
