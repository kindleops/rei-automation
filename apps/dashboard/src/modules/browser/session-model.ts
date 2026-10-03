/**
 * THE BROWSER SESSION — pure state, no rendering.
 *
 * A session is one Browser instance's research: its tabs (each with its own
 * back/forward history), which tab is active, and the research subject it is
 * linked to. Rendering (an iframe today, a native WebView later) lives behind
 * the surface provider and never owns this state.
 *
 *   tabs       persisted with the workspace (URL, title, context, destination
 *              type, embed mode, timestamps) — explicit, operator-visible
 *   history    per tab, transient: kept in this tab of the OS only
 *   subject    what "Research current property" means right now
 *   link       linked: a new workspace selection is OFFERED (never applied);
 *              pinned: the selection is ignored
 *
 * RULE: a subject change never closes, retargets or navigates a tab. It only
 * raises a prompt the operator answers (research the new property in a new
 * context group, or keep going).
 */
import type { DestinationType, EmbedMode } from './destinations/types'
import type { ResearchRole } from './intent'

export type LinkMode = 'linked' | 'pinned'

export interface ResearchSubject {
  kind: 'property' | 'company'
  id: string
  label: string | null
  role?: ResearchRole
}

export interface BrowserTab {
  id: string
  /** null = the start surface */
  url: string | null
  /** untrusted when it came from a page; React escapes it, and the host is always shown beside it */
  title: string | null
  context: ResearchSubject | null
  destinationType: DestinationType | null
  destinationId: string | null
  embed: EmbedMode | null
  createdAt: number
  lastActive: number
}

export interface TabHistory { stack: Array<string | null>; index: number }

export interface BrowserSession {
  v: 1
  id: string
  tabs: BrowserTab[]
  activeId: string
  link: LinkMode
  subject: ResearchSubject | null
  /** a newer workspace selection waiting for the operator (linked mode only) */
  offered: ResearchSubject | null
  /** intent nonces already run (bounded) */
  handled: string[]
}

export type Histories = Record<string, TabHistory>

export const MAX_TABS = 20
const MAX_HISTORY = 50
const MAX_HANDLED = 30

let seq = 0
export const newTabId = () => `t${Date.now().toString(36)}${(++seq).toString(36)}`
export const newSessionId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export const sameSubject = (a: ResearchSubject | null | undefined, b: ResearchSubject | null | undefined) =>
  Boolean(a && b && a.kind === b.kind && a.id === b.id)

export function startTab(now: number, context: ResearchSubject | null = null): BrowserTab {
  return { id: newTabId(), url: null, title: null, context, destinationType: null, destinationId: null, embed: null, createdAt: now, lastActive: now }
}

export function createSession(id: string, now: number, subject: ResearchSubject | null = null): BrowserSession {
  const tab = startTab(now, subject)
  return { v: 1, id, tabs: [tab], activeId: tab.id, link: 'linked', subject, offered: null, handled: [] }
}

export const activeTab = (s: BrowserSession): BrowserTab => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]

export interface TabInit {
  url?: string | null
  title?: string | null
  context?: ResearchSubject | null
  destinationType?: DestinationType | null
  destinationId?: string | null
  embed?: EmbedMode | null
}

/** Open a tab next to the active one. At the cap the oldest inactive tab yields (never the active one). */
export function openTab(s: BrowserSession, h: Histories, init: TabInit, now: number, opts: { activate?: boolean } = {}): { s: BrowserSession; h: Histories; tab: BrowserTab } {
  const tab: BrowserTab = {
    ...startTab(now, init.context === undefined ? s.subject : init.context),
    url: init.url ?? null,
    title: init.title ?? null,
    destinationType: init.destinationType ?? null,
    destinationId: init.destinationId ?? null,
    embed: init.embed ?? null,
  }
  let tabs = [...s.tabs]
  let hist = { ...h }
  if (tabs.length >= MAX_TABS) {
    const victim = [...tabs].filter((t) => t.id !== s.activeId).sort((a, b) => a.lastActive - b.lastActive)[0]
    if (victim) { tabs = tabs.filter((t) => t.id !== victim.id); delete hist[victim.id] }
  }
  const at = tabs.findIndex((t) => t.id === s.activeId)
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab)
  hist = { ...hist, [tab.id]: { stack: [tab.url], index: 0 } }
  const activate = opts.activate !== false
  return { s: { ...s, tabs, activeId: activate ? tab.id : s.activeId }, h: hist, tab }
}

/** Close a tab. The Browser is never empty: closing the last tab leaves a start tab. */
export function closeTab(s: BrowserSession, h: Histories, tabId: string, now: number): { s: BrowserSession; h: Histories } {
  const i = s.tabs.findIndex((t) => t.id === tabId)
  if (i < 0) return { s, h }
  const tabs = s.tabs.filter((t) => t.id !== tabId)
  const hist = { ...h }
  delete hist[tabId]
  if (!tabs.length) {
    const fresh = startTab(now, s.subject)
    return { s: { ...s, tabs: [fresh], activeId: fresh.id }, h: { ...hist, [fresh.id]: { stack: [null], index: 0 } } }
  }
  let activeId = s.activeId
  if (activeId === tabId) {
    // the most recently used remaining tab, like every good browser
    activeId = [...tabs].sort((a, b) => b.lastActive - a.lastActive)[0].id
  }
  return { s: { ...s, tabs, activeId }, h: hist }
}

export function activate(s: BrowserSession, tabId: string, now: number): BrowserSession {
  if (!s.tabs.some((t) => t.id === tabId)) return s
  return { ...s, activeId: tabId, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, lastActive: now } : t)) }
}

const histOf = (h: Histories, tab: BrowserTab): TabHistory => h[tab.id] ?? { stack: [tab.url], index: 0 }

/** Navigate one tab (pushes its history; forward entries are dropped). */
export function navigate(s: BrowserSession, h: Histories, tabId: string, init: TabInit, now: number): { s: BrowserSession; h: Histories } {
  const tab = s.tabs.find((t) => t.id === tabId)
  if (!tab) return { s, h }
  const url = init.url ?? null
  const cur = histOf(h, tab)
  const stack = [...cur.stack.slice(0, cur.index + 1), url].slice(-MAX_HISTORY)
  const next: BrowserTab = {
    ...tab,
    url,
    title: init.title ?? null,
    context: init.context === undefined ? tab.context : init.context,
    destinationType: init.destinationType ?? null,
    destinationId: init.destinationId ?? null,
    embed: init.embed ?? null,
    lastActive: now,
  }
  return { s: { ...s, tabs: s.tabs.map((t) => (t.id === tabId ? next : t)) }, h: { ...h, [tabId]: { stack, index: stack.length - 1 } } }
}

export const canBack = (h: Histories, tab: BrowserTab) => histOf(h, tab).index > 0
export const canForward = (h: Histories, tab: BrowserTab) => { const x = histOf(h, tab); return x.index < x.stack.length - 1 }

/**
 * Step one tab's history. Returns the URL to show; the caller re-derives
 * the embed mode for it (the registry is authority, not the stored copy).
 */
export function step(s: BrowserSession, h: Histories, tabId: string, delta: -1 | 1, now: number): { s: BrowserSession; h: Histories; url: string | null; moved: boolean } {
  const tab = s.tabs.find((t) => t.id === tabId)
  if (!tab) return { s, h, url: null, moved: false }
  const cur = histOf(h, tab)
  const index = cur.index + delta
  if (index < 0 || index >= cur.stack.length) return { s, h, url: tab.url, moved: false }
  const url = cur.stack[index]
  const next: BrowserTab = { ...tab, url, title: url === tab.url ? tab.title : null, lastActive: now }
  return { s: { ...s, tabs: s.tabs.map((t) => (t.id === tabId ? next : t)) }, h: { ...h, [tabId]: { stack: cur.stack, index } }, url, moved: true }
}

/** Patch what a tab learned about itself (its title, a derived embed mode). Never its URL. */
export function patchTab(s: BrowserSession, tabId: string, patch: Partial<Pick<BrowserTab, 'title' | 'embed' | 'destinationId' | 'destinationType'>>): BrowserSession {
  return { ...s, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) }
}

/** Move a tab to a new index (drag reorder). */
export function reorder(s: BrowserSession, tabId: string, toIndex: number): BrowserSession {
  const from = s.tabs.findIndex((t) => t.id === tabId)
  if (from < 0) return s
  const tabs = [...s.tabs]
  const [tab] = tabs.splice(from, 1)
  tabs.splice(Math.max(0, Math.min(tabs.length, toIndex)), 0, tab)
  return { ...s, tabs }
}

export const setLink = (s: BrowserSession, link: LinkMode): BrowserSession => ({ ...s, link, offered: link === 'pinned' ? null : s.offered })

/**
 * The workspace selection moved. Linked: the new subject is OFFERED (unless
 * it is the one already researched, or there is no subject yet — then it is
 * simply adopted, since there is nothing to protect). Pinned: ignored.
 * Tabs are never touched here.
 */
export function selectionChanged(s: BrowserSession, next: ResearchSubject | null): BrowserSession {
  if (s.link === 'pinned' || !next) return s
  if (sameSubject(s.subject, next)) return s.offered ? { ...s, offered: null } : s
  if (!s.subject) return { ...s, subject: next }
  if (sameSubject(s.offered, next)) return s
  return { ...s, offered: next }
}

/** The operator accepted the offer: the subject moves; existing tabs keep their own context. */
export function adoptSubject(s: BrowserSession, subject: ResearchSubject): BrowserSession {
  return { ...s, subject, offered: null }
}

export const dismissOffer = (s: BrowserSession): BrowserSession => ({ ...s, offered: null })

export function markHandled(s: BrowserSession, nonce: string): BrowserSession {
  return s.handled.includes(nonce) ? s : { ...s, handled: [...s.handled, nonce].slice(-MAX_HANDLED) }
}

/** Context groups, in tab order: consecutive tabs that research the same subject. */
export function contextGroups(s: BrowserSession): Array<{ key: string; subject: ResearchSubject | null; tabIds: string[] }> {
  const out: Array<{ key: string; subject: ResearchSubject | null; tabIds: string[] }> = []
  for (const t of s.tabs) {
    const key = t.context ? `${t.context.kind}:${t.context.id}` : 'none'
    const last = out[out.length - 1]
    if (last && last.key === key) last.tabIds.push(t.id)
    else out.push({ key, subject: t.context, tabIds: [t.id] })
  }
  return out
}

/* ── persistence ──────────────────────────────────────────────────────── */

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

function reviveSubject(raw: unknown): ResearchSubject | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'property' || r.kind === 'company' ? r.kind : null
  const id = str(r.id, 128)
  if (!kind || !id) return null
  return { kind, id, label: str(r.label, 160), ...(r.role === 'comp' ? { role: 'comp' as const } : {}) }
}

/**
 * Restore a persisted session. Every URL passes the caller's guard again
 * (a stored document is input like any other); a tab whose URL no longer
 * passes comes back as a start tab, never as a page.
 */
export function reviveSession(raw: unknown, guard: (url: string) => string | null, now: number): BrowserSession | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || typeof r.id !== 'string' || !Array.isArray(r.tabs)) return null
  const tabs: BrowserTab[] = []
  for (const t of r.tabs.slice(0, MAX_TABS)) {
    if (!t || typeof t !== 'object') continue
    const x = t as Record<string, unknown>
    const id = str(x.id, 40)
    if (!id) continue
    const rawUrl = str(x.url, 4000)
    const url = rawUrl ? guard(rawUrl) : null
    tabs.push({
      id,
      url,
      title: url ? str(x.title, 200) : null,
      context: reviveSubject(x.context),
      destinationType: (str(x.destinationType, 40) as DestinationType | null) ?? null,
      destinationId: str(x.destinationId, 80),
      embed: url ? ((str(x.embed, 20) as EmbedMode | null) ?? null) : null,
      createdAt: Number(x.createdAt) || now,
      lastActive: Number(x.lastActive) || now,
    })
  }
  if (!tabs.length) return null
  const activeId = tabs.some((t) => t.id === r.activeId) ? String(r.activeId) : tabs[0].id
  return {
    v: 1,
    id: r.id,
    tabs,
    activeId,
    link: r.link === 'pinned' ? 'pinned' : 'linked',
    subject: reviveSubject(r.subject),
    offered: null,
    handled: Array.isArray(r.handled) ? r.handled.filter((n): n is string => typeof n === 'string').slice(-MAX_HANDLED) : [],
  }
}

/** What is stored with the workspace: the tabs, never history. */
export function serializeSession(s: BrowserSession): Omit<BrowserSession, 'offered'> {
  const { offered: _offered, ...rest } = s
  void _offered
  return rest
}

/** What a tab is called: the page (or destination) title, else its real host, else what it researches. */
export function tabTitle(t: BrowserTab): string {
  if (t.url) {
    if (t.title) return t.title
    try { return new URL(t.url).hostname.replace(/^www\./, '') } catch { return 'Page' }
  }
  return t.context?.label ? `Research · ${t.context.label}` : 'New tab'
}
