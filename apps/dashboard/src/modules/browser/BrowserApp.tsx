import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { replaceRoutePath, useRouteLocation } from '../../app/router'
import { PROPERTY_LOCATOR_EVENT, readPropertyLocator, type PropertyLocator } from '../../domain/locator/property-locator'
import { Icon } from '../../shared/icons'
import { LCButton, LCEmpty, lcToast, type LCMenuEntry } from '../../shared/lc'
import { useBreakpoint } from '../mobile/useBreakpoint'
import { useDeckSubject } from '../desktop/workspace/deck-subject'
import { useAppInstance } from '../desktop/workspace/instance-context'
import * as WL from '../desktop/workspace/layout'
import { getWorkspace, isWorkspaceRunning, selectionInSession } from '../desktop/workspace/workspace-store'
import { BrowserChrome } from './BrowserChrome'
import { parseIntent, sessionIdOf, type BrowserIntent } from './intent'
import { browserKeyAction, IS_MAC, isEditing } from './keys'
import { pickItem, propertyLaunchItems, companyLaunchItems, TYPE_NOUN, type LaunchItem } from './launch-plane'
import { PageState } from './PageStates'
import { classify, guardUrl, hostOf, interpretInput, searchUrl, type DestinationType, type SearchProvider } from './registry'
import { loadPropertyFacts } from './research-context'
import * as M from './session-model'
import { getSession, pushRecent, updateSession, useBrowserSession, type RecentItem } from './session-store'
import { sourcesApi } from './sources-api'
import { StartSurface } from './StartSurface'
import type { SurfaceStatus } from './surface/provider'
import { WebEmbedProvider } from './surface/web-embed'
import './browser.css'

/**
 * LEADCOMMAND BROWSER 1.0 — a contextual research instrument.
 *
 * It knows the object (linked selection or an explicit Research), its
 * county and sources (the destination registry), and the workspace (one
 * instance, its own session id in the pane path). External pages are drawn
 * inside the cockpit and kept outside it: see ./surface/WebEmbedProvider.
 */

const PROVIDER: SearchProvider = 'google'
/** Live (mounted) framed tabs kept warm; older ones unmount and reload when revisited. */
const KEEP_ALIVE = 6

const surfaceProvider = WebEmbedProvider
const now = () => Date.now()

const GUARD_MESSAGE: Record<string, string> = {
  invalid_url: 'That is not a web address.',
  unsafe_scheme: 'Only http and https pages can open here.',
  credentials_in_url: 'Addresses with embedded credentials are refused.',
  self_origin: 'LeadCommand pages open in their own apps, not in the Browser.',
}

function openExternally(url: string) {
  const g = guardUrl(url)
  if (!g.ok) return
  window.open(g.url, '_blank', 'noopener,noreferrer')
}

async function copyText(text: string, what = 'Link') {
  try { await navigator.clipboard.writeText(text); lcToast({ title: `${what} copied`, severity: 'success', source: 'browser', silent: true }) }
  catch { lcToast({ title: `${what} could not be copied`, detail: text, severity: 'warning', source: 'browser', silent: true }) }
}

const subjectOfLocator = (l: PropertyLocator | null): M.ResearchSubject | null =>
  l?.propertyId ? { kind: 'property', id: l.propertyId, label: l.address ?? null } : null

export default function BrowserApp() {
  // the PHONE (device class) — on desktop the modern product is also "mobile" in useBreakpoint's product sense
  const { isPhone } = useBreakpoint()
  if (isPhone) {
    return (
      <div className="lcb lcb--phone">
        <LCEmpty icon="compass" title="Browser is a desktop instrument" body="Open LeadCommand on a desktop to research inside the cockpit." />
      </div>
    )
  }
  return <BrowserDesktop />
}

function BrowserDesktop() {
  const location = useRouteLocation()
  const search = location.includes('?') ? location.slice(location.indexOf('?')) : ''
  const [fallbackSid] = useState(() => M.newSessionId())
  const sid = sessionIdOf(search) ?? fallbackSid
  const { s, h } = useBrowserSession(sid)
  const active = M.activeTab(s)
  const inst = useAppInstance()
  const linkForced = Boolean(inst.instanceId) && !inst.follows

  /* transient per-tab view state (never persisted) */
  const [status, setStatus] = useState<Record<string, SurfaceStatus>>({})
  const [reloads, setReloads] = useState<Record<string, number>>({})
  const [drift, setDrift] = useState<Record<string, true>>({})
  const [notices, setNotices] = useState<Record<string, string>>({})
  const [copyHints, setCopyHints] = useState<Record<string, { label: string; value: string }>>({})
  const [addressError, setAddressError] = useState<string | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const mutate = useCallback((fn: (cur: { s: M.BrowserSession; h: M.Histories }) => { s: M.BrowserSession; h: M.Histories }) => updateSession(sid, fn), [sid])

  /*
   * Lazy + bounded: a framed tab mounts only once it has been in front during
   * this mount (restored tabs stay cold until visited), and at most KEEP_ALIVE
   * stay mounted — the least recently used unmount and reload when revisited.
   */
  const [mountedAt] = useState(() => Date.now())
  const activeFramed = active.url && classify(active.url).embed === 'EMBEDS' ? active.id : null
  const warmList = useMemo(() => s.tabs
    .filter((t) => t.url && (t.id === s.activeId || t.lastActive >= mountedAt) && classify(t.url).embed === 'EMBEDS')
    .sort((a, b) => (a.id === s.activeId ? -1 : b.id === s.activeId ? 1 : b.lastActive - a.lastActive))
    .slice(0, KEEP_ALIVE)
    .map((t) => t.id), [s.tabs, s.activeId, mountedAt])

  /* ── navigation ─────────────────────────────────────────────────────── */

  const describe = (url: string, extra: Partial<M.TabInit> = {}): M.TabInit => {
    const c = classify(url)
    return { url, title: extra.title ?? null, destinationType: extra.destinationType ?? null, destinationId: extra.destinationId ?? c.destinationId, embed: c.embed, ...(extra.context !== undefined ? { context: extra.context } : {}) }
  }

  const remember = (url: string, title: string | null, ctx: M.ResearchSubject | null) => pushRecent({ url, title, context: ctx?.label ?? null })

  /** Open a URL: in the active tab when it is a blank start tab, else a new tab. */
  const openUrl = (url: string, extra: Partial<M.TabInit> & { newTab?: boolean } = {}) => {
    const g = guardUrl(url)
    if (!g.ok) { setAddressError(GUARD_MESSAGE[g.reason]); return }
    setAddressError(null)
    const init = describe(g.url, extra)
    mutate(({ s: cs, h: ch }) => {
      const cur = M.activeTab(cs)
      const reuse = !extra.newTab && !cur.url
      if (reuse) {
        const r = M.navigate(cs, ch, cur.id, { ...init, context: init.context === undefined ? cur.context : init.context }, now())
        return r
      }
      const r = M.openTab(cs, ch, { ...init, context: init.context === undefined ? cs.subject : init.context }, now())
      return { s: r.s, h: r.h }
    })
    remember(g.url, extra.title ?? null, extra.context ?? s.subject)
  }

  const navigateActive = (input: string) => {
    const r = interpretInput(input, PROVIDER)
    if (r.kind === 'invalid') { setAddressError(GUARD_MESSAGE[r.reason]); return }
    setAddressError(null)
    const init = describe(r.url, { title: r.kind === 'search' ? `Search · ${r.query}` : null })
    mutate(({ s: cs, h: ch }) => M.navigate(cs, ch, cs.activeId, init, now()))
    remember(r.url, init.title ?? null, active.context)
  }

  const openItem = (item: LaunchItem, ctx: M.ResearchSubject | null, newTab = false) => {
    if (!item.url) return
    openUrl(item.url, { title: item.label, destinationType: item.type, destinationId: item.destinationId, context: ctx, newTab })
    // a search-page destination: keep what to paste beside the page (this tab, this OS session only)
    const copy = item.copy
    if (copy) setCopyHints((c) => ({ ...c, [getSession(sid).s.activeId]: copy }))
  }

  const newTab = (ctx: M.ResearchSubject | null = s.subject) => mutate(({ s: cs, h: ch }) => { const r = M.openTab(cs, ch, { context: ctx }, now()); return { s: r.s, h: r.h } })
  const closeTab = (id: string) => mutate(({ s: cs, h: ch }) => M.closeTab(cs, ch, id, now()))
  const activate = (id: string) => mutate(({ s: cs, h: ch }) => ({ s: M.activate(cs, id, now()), h: ch }))
  const stepTab = (delta: -1 | 1) => mutate(({ s: cs, h: ch }) => {
    const r = M.step(cs, ch, cs.activeId, delta, now())
    if (!r.moved) return { s: cs, h: ch }
    const embed = r.url ? classify(r.url).embed : null
    return { s: M.patchTab(r.s, cs.activeId, { embed }), h: r.h }
  })
  const reload = (id = s.activeId) => { setReloads((x) => ({ ...x, [id]: (x[id] ?? 0) + 1 })); setDrift((d) => { const n = { ...d }; delete n[id]; return n }) }

  const onStatus = useCallback((tabId: string, st: SurfaceStatus) => setStatus((x) => (x[tabId] === st ? x : { ...x, [tabId]: st })), [])
  const onInner = useCallback((tabId: string) => setDrift((d) => (d[tabId] ? d : { ...d, [tabId]: true })), [])

  /* ── intents (object menus, Deck, Missions) ─────────────────────────── */

  const notice = (tabId: string, text: string) => setNotices((n) => ({ ...n, [tabId]: text }))

  /** A research tab for a subject: reuse an empty start tab of the same subject, else a new one (never retargets another tab). */
  const researchTab = (ctx: M.ResearchSubject): string => {
    let id = ''
    mutate(({ s: cs, h: ch }) => {
      const base = cs.subject ? cs : M.adoptSubject(cs, ctx)
      const empty = base.tabs.find((t) => !t.url && (M.sameSubject(t.context, ctx) || (!t.context && t.id === base.activeId)))
      if (empty) { id = empty.id; const ctxd = { ...base, tabs: base.tabs.map((t) => (t.id === empty.id ? { ...t, context: ctx } : t)) }; return { s: M.activate(ctxd, empty.id, now()), h: ch } }
      const r = M.openTab(base, ch, { context: ctx }, now())
      id = r.tab.id
      return { s: r.s, h: r.h }
    })
    return id
  }

  async function runIntent(it: BrowserIntent) {
    mutate(({ s: cs, h: ch }) => ({ s: M.markHandled(cs, it.nonce), h: ch }))
    if (it.do === 'start') { newTab(); return }
    if (it.do === 'search') {
      const url = searchUrl(it.q, PROVIDER)
      if (url) openUrl(url, { title: `Search · ${it.q}`, destinationType: 'WEB_SEARCH', newTab: true, context: null })
      return
    }
    if (it.do === 'find') {
      // a free-text destination ("zillow 3635 emerson"): the registry's own builder decides; a web search otherwise
      const items = propertyLaunchItems({ property_address_full: it.q, property_address: it.q }, PROVIDER)
      const { item } = it.type === 'WEB_SEARCH' ? { item: null } : pickItem(items, it.type)
      if (item?.url) { openItem(item, null, true); return }
      const url = searchUrl(`${it.type === 'WEB_SEARCH' ? '' : `${TYPE_NOUN[it.type]} `}${it.q}`.trim(), PROVIDER)
      if (url) openUrl(url, { title: `Search · ${it.q}`, destinationType: 'WEB_SEARCH', newTab: true, context: null })
      if (it.type !== 'WEB_SEARCH') lcToast({ title: `${TYPE_NOUN[it.type]} needs a full address`, detail: 'Searched the web instead.', severity: 'info', source: 'browser', silent: true })
      return
    }
    const ctx: M.ResearchSubject = { kind: it.kind, id: it.id, label: it.label, role: it.role }
    if (it.do === 'research') { researchTab(ctx); return }
    // a direct destination: resolve against the canonical record
    const tabId = researchTab(ctx)
    const type: DestinationType = it.type
    let items: LaunchItem[] = []
    if (it.kind === 'company') items = it.label ? companyLaunchItems({ name: it.label, state: null }, PROVIDER) : []
    else {
      const facts = await loadPropertyFacts(it.id)
      if (facts) items = propertyLaunchItems(facts.property, PROVIDER)
      else if (it.label) items = propertyLaunchItems({ property_address_full: it.label, property_address: it.label.split(',')[0] }, PROVIDER).filter((i) => i.group === 'search')
    }
    const { item, reason } = pickItem(items, type)
    if (item?.url) {
      mutate(({ s: cs, h: ch }) => M.navigate(M.activate(cs, tabId, now()), ch, tabId, describe(item.url!, { title: item.label, destinationType: item.type, destinationId: item.destinationId, context: ctx }), now()))
      remember(item.url, item.label, ctx)
      const copy = item.copy
      if (copy) setCopyHints((c) => ({ ...c, [tabId]: copy }))
      return
    }
    notice(tabId, reason ? `${TYPE_NOUN[type][0].toUpperCase()}${TYPE_NOUN[type].slice(1)}: ${reason}` : `No ${TYPE_NOUN[type]} source is on record for this ${it.kind === 'company' ? 'company' : 'county'} — here is what exists.`)
  }

  /* the pane path names this session (and loses any intent once it has run) */
  const intent = useMemo(() => parseIntent(search), [search])
  useEffect(() => {
    if (sessionIdOf(search) && !intent) return
    // after this commit (the intent may open tabs and raise notices): run first, then rename — a reload never repeats it
    const t = window.setTimeout(() => {
      if (intent && !getSession(sid).s.handled.includes(intent.nonce)) void runIntent(intent)
      replaceRoutePath(`/browser?s=${sid}`)
    }, 0)
    return () => window.clearTimeout(t)
    // runIntent is stable for a session; search drives this effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sid])

  /* ── linked context: a new selection is OFFERED, never applied ──────── */

  useEffect(() => {
    const onLoc = (e: Event) => {
      if (linkForced) return
      const next = subjectOfLocator((e as CustomEvent<PropertyLocator | null>).detail ?? null)
      if (next) mutate(({ s: cs, h: ch }) => ({ s: M.selectionChanged(cs, next), h: ch }))
    }
    window.addEventListener(PROPERTY_LOCATOR_EVENT, onLoc)
    // a selection made in this session before the Browser opened is the subject to start from
    if (!linkForced && selectionInSession()) {
      const cur = subjectOfLocator(readPropertyLocator())
      if (cur) mutate(({ s: cs, h: ch }) => ({ s: M.selectionChanged(cs, cur), h: ch }))
    }
    return () => window.removeEventListener(PROPERTY_LOCATOR_EVENT, onLoc)
  }, [mutate, linkForced])

  /* ── keys: Browser-local, only while this is the focused pane ───────── */

  const actions = useRef({ newTab, closeTab, reload, stepTab, activeId: s.activeId })
  useEffect(() => { actions.current = { newTab, closeTab, reload, stepTab, activeId: s.activeId } })
  useEffect(() => {
    const isFocused = () => {
      if (!inst.instanceId || !isWorkspaceRunning()) return true
      const ws = getWorkspace().layout
      const pane = WL.findPane(ws.root, ws.focus)
      return pane?.active === inst.instanceId
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const a = browserKeyAction(e, { active: isFocused(), editing: isEditing(e.target), mac: IS_MAC })
      if (!a) return
      // a key inside another pane's field is that pane's business
      if (isEditing(e.target) && !rootRef.current?.contains(e.target as Node)) return
      e.preventDefault()
      const x = actions.current
      if (a === 'focus-address') addressRef.current?.focus()
      else if (a === 'reload') x.reload(x.activeId)
      else if (a === 'new-tab') x.newTab()
      else if (a === 'close-tab') x.closeTab(x.activeId)
      else if (a === 'back') x.stepTab(-1)
      else if (a === 'forward') x.stepTab(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inst.instanceId])

  /* ── save source (observational) ─────────────────────────────────────── */

  const saveSource = async () => {
    const t = active
    if (!t.url || !t.context) return
    const r = await sourcesApi.save({ objectType: t.context.kind, objectId: t.context.id, url: t.url, pageTitle: t.title, destinationType: t.destinationType })
    if (r.ok) lcToast({ title: `Source saved to ${t.context.label ?? 'this record'}`, detail: r.source.where === 'device' ? 'Kept on this device until server storage is enabled.' : hostOf(t.url) ?? undefined, severity: 'success', source: 'browser' })
    else lcToast({ title: 'Source not saved', detail: r.message, severity: 'warning', source: 'browser' })
  }

  const reportBroken = async () => {
    const t = active
    if (!t.url || !t.destinationId) return
    const r = await sourcesApi.report({ destinationId: t.destinationId, url: t.url })
    lcToast({ title: r.where === 'server' ? 'Destination reported' : 'Destination report kept on this device', detail: r.where === 'server' ? 'It will be re-verified.' : 'Server storage is not enabled yet.', severity: 'info', source: 'browser', silent: true })
  }

  /* ── what the Deck names ─────────────────────────────────────────────── */

  useDeckSubject(active.context ? { title: active.context.label ?? 'Research', subtitle: hostOf(active.url) ?? 'Browser' } : active.url ? { title: hostOf(active.url) ?? 'Browser' } : null)

  /* ── render ───────────────────────────────────────────────────────────── */

  const more: LCMenuEntry[] = [
    { id: 'new', label: 'New tab', icon: 'plus', shortcut: '⌘T', onSelect: () => newTab() },
    ...(active.url ? [
      { kind: 'separator' as const, id: 's1' },
      { id: 'copy', label: 'Copy link', icon: 'link' as const, onSelect: () => { void copyText(active.url!) } },
      { id: 'ext', label: 'Open externally', icon: 'external-link' as const, onSelect: () => openExternally(active.url!) },
      ...(active.context ? [{ id: 'save', label: `Save source to ${active.context.label ?? 'record'}`, icon: 'bookmark' as const, hint: 'A pointer only — no facts change', onSelect: () => { void saveSource() } }] : []),
    ] : []),
    ...(active.url && active.destinationId ? [{ id: 'report', label: 'Report broken destination', icon: 'flag' as const, hint: 'Flags this registry entry for review', onSelect: () => { void reportBroken() } }] : []),
    { kind: 'separator', id: 's2' },
    { id: 'link', label: s.link === 'pinned' ? 'Follow the selection (linked)' : 'Pin to current research', icon: s.link === 'pinned' ? 'link' : 'pin', disabled: linkForced, reason: linkForced ? 'This pane is pinned or independent in the workspace' : undefined, onSelect: () => mutate(({ s: cs, h: ch }) => ({ s: M.setLink(cs, cs.link === 'pinned' ? 'linked' : 'pinned'), h: ch })) },
    ...(s.tabs.length > 1 ? [{ id: 'close-others', label: 'Close other tabs', icon: 'x' as const, onSelect: () => mutate(({ s: cs, h: ch }) => { let cur = { s: cs, h: ch }; for (const t of cs.tabs) if (t.id !== cs.activeId) cur = M.closeTab(cur.s, cur.h, t.id, now()); return cur }) }] : []),
  ]

  const loading = Boolean(active.url && activeFramed && (status[active.id] ?? 'loading') === 'loading')
  const framedTabs = s.tabs.filter((t) => t.url && warmList.includes(t.id))

  const body = (() => {
    if (!active.url) {
      return (
        <StartSurface
          key={active.id}
          subject={active.context ?? s.subject}
          provider={PROVIDER}
          notice={notices[active.id] ?? null}
          onSearch={(q) => navigateActive(q)}
          onOpenItem={(item, ctx) => openItem(item, ctx)}
          onOpenRecent={(r: RecentItem) => openUrl(r.url, { title: r.title })}
        />
      )
    }
    if (activeFramed) {
      const st = status[active.id]
      if (st === 'timeout' || st === 'offline') return <PageState problem={{ kind: st }} url={active.url} host={hostOf(active.url)} title={active.title} insecure={active.url.startsWith('http:')} contextLabel={active.context?.label ?? null} onOpenExternal={() => openExternally(active.url!)} onCopy={() => { void copyText(active.url!) }} onKeep={null} onReturn={() => closeTab(active.id)} onRetry={() => reload(active.id)} />
      return null
    }
    const embed = classify(active.url).embed
    const others = s.tabs.filter((t) => t.id !== active.id).sort((a, b) => b.lastActive - a.lastActive)
    return (
      <PageState
        problem={{ kind: 'external', embed }}
        url={active.url}
        host={hostOf(active.url)}
        title={active.title}
        insecure={active.url.startsWith('http:')}
        contextLabel={active.context?.label ?? null}
        onOpenExternal={() => openExternally(active.url!)}
        onCopy={() => { void copyText(active.url!) }}
        onKeep={others.length ? () => activate(others[0].id) : null}
        onReturn={() => closeTab(active.id)}
        onRetry={() => reload(active.id)}
      />
    )
  })()

  const offered = s.offered && !linkForced && s.link === 'linked' ? s.offered : null

  return (
    <div className="lcb" ref={rootRef} data-browser-session={sid}>
      <BrowserChrome
        tabs={s.tabs}
        activeId={s.activeId}
        active={active}
        canBack={M.canBack(h, active)}
        canForward={M.canForward(h, active)}
        loading={loading}
        drifted={Boolean(drift[active.id])}
        link={s.link}
        linkForced={linkForced}
        addressRef={addressRef}
        addressError={addressError}
        more={more}
        onActivate={activate}
        onClose={closeTab}
        onNewTab={() => newTab()}
        onReorder={(id, to) => mutate(({ s: cs, h: ch }) => ({ s: M.reorder(cs, id, to), h: ch }))}
        onBack={() => stepTab(-1)}
        onForward={() => stepTab(1)}
        onReload={() => reload()}
        onSubmit={navigateActive}
        onExternal={() => active.url && openExternally(active.url)}
        onToggleLink={() => mutate(({ s: cs, h: ch }) => ({ s: M.setLink(cs, cs.link === 'pinned' ? 'linked' : 'pinned'), h: ch }))}
      />
      {offered ? (
        <div className="lcb-offer" role="status">
          <Icon name="link" size={13} />
          <span>Property changed — <b>{offered.label ?? 'new selection'}</b>. Research it?</span>
          <LCButton size="sm" variant="primary" onClick={() => { const ctx = offered; mutate(({ s: cs, h: ch }) => { const a = M.adoptSubject(cs, ctx); const r = M.openTab(a, ch, { context: ctx }, now()); return { s: r.s, h: r.h } }) }}>Research in new tabs</LCButton>
          <LCButton size="sm" variant="ghost" onClick={() => mutate(({ s: cs, h: ch }) => ({ s: M.dismissOffer(cs), h: ch }))}>Keep current</LCButton>
        </div>
      ) : null}
      {active.url && copyHints[active.id] ? (
        <div className="lcb-copy" role="note">
          <span>This site searches by hand — paste {copyHints[active.id].label}:</span>
          <b>{copyHints[active.id].value}</b>
          <LCButton size="sm" variant="ghost" icon="link" onClick={() => { void copyText(copyHints[active.id].value, copyHints[active.id].label) }}>Copy</LCButton>
        </div>
      ) : null}
      <div className="lcb-body">
        {framedTabs.map((t) => {
          const shown = t.id === active.id && !['timeout', 'offline'].includes(status[t.id] ?? '')
          const c = classify(t.url!)
          if (!surfaceProvider.canRender(c.embed)) return null
          return (
            <div key={t.id} className="lcb-surface" hidden={!shown} data-tab={t.id}>
              <surfaceProvider.Surface tabId={t.id} url={t.url!} title={t.title ?? hostOf(t.url) ?? 'Research page'} sandbox={c.sandbox} reloadKey={reloads[t.id] ?? 0} visible={shown} onStatus={onStatus} onInnerNavigation={onInner} />
            </div>
          )
        })}
        {body ? <div className="lcb-page">{body}</div> : null}
      </div>
    </div>
  )
}
