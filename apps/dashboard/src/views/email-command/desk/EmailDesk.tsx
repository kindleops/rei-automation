import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { PaneRouteContext, replaceRoutePath } from '../../../app/router'
import { fetchHome, fetchThread, isDemoMode, postThreadAction, type Home, type ThreadRoom, type ThreadSummary } from '../mobile/email-command-api'
import { ROLE_LABEL, ago, who, where } from '../mobile/email-format'
import {
  QUICK, VIEWS, VIEW_BY_KEY, allThreads, groupRows, initials, isViewKey, quickMatch, rowSignal, searchMatch, stateMetaFor, viewCount, viewRows,
  type Group, type QuickKey, type ViewKey,
} from './desk-model'
import { DeskRoom } from './DeskRoom'
import './email-desk.css'

const DeskInspector = lazy(() => import('./DeskInspector').then((m) => ({ default: m.DeskInspector })))

/**
 * EMAIL COMMAND — DESKTOP. A multi-plane control room over the one Email
 * Command read model: a data-driven rail (lenses), a dense conversation
 * index, the conversation room (the heart), and an intelligence inspector
 * that explains the selected thread. The phone keeps its own surface.
 *
 * Nothing here decides business state or fabricates it: every count, state,
 * reason and link is the server's; the desk only arranges and navigates.
 */

const INSPECTOR_PREF = 'nx.email.desk.inspector'
const ROW_H = 80
const GROUP_H = 40

function readSearch(paneLocation: string | null): URLSearchParams {
  try { return new URLSearchParams(paneLocation ? (paneLocation.split('?')[1] ?? '') : window.location.search) } catch { return new URLSearchParams() }
}

export function EmailDesk() {
  const pane = useContext(PaneRouteContext)
  const initial = useMemo(() => readSearch(pane?.location ?? null), []) // eslint-disable-line react-hooks/exhaustive-deps
  const demo = useMemo(isDemoMode, [])

  const [home, setHome] = useState<Home | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewKey>(() => (isViewKey(initial.get('view')) ? (initial.get('view') as ViewKey) : 'overview'))
  const [quick, setQuick] = useState<QuickKey>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(() => initial.get('thread'))
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => {
    const q = initial.get('inspector')
    if (q === '0' || q === '1') return q === '1'
    try { return localStorage.getItem(INSPECTOR_PREF) !== '0' } catch { return true }
  })
  const [room, setRoom] = useState<ThreadRoom | null>(null)
  const [roomError, setRoomError] = useState<string | null>(null)
  const [roomTick, setRoomTick] = useState(0)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const lastSeen = useRef<Map<string, string>>(new Map())
  const searchRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  /* ── width tiers: the inspector collapses first, then the rail, then the planes stack ── */
  const [width, setWidth] = useState(1400)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    // The desk's own box (padding included) is what the planes share.
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)))
    ro.observe(el)
    setWidth(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  // The inspector collapses FIRST. wide: every plane · mid: the inspector becomes an
  // on-demand layer over the room · narrow: the rail folds to glyphs · compact: one plane at a time.
  const tier = width >= 1620 ? 'wide' : width >= 1060 ? 'mid' : width >= 760 ? 'narrow' : 'compact'
  const columnInspector = tier === 'wide'
  // Below the wide tier the inspector is an on-demand layer over the room (session only).
  const [peek, setPeek] = useState(false)
  // Compact: the room replaces the index only when a conversation is opened on purpose.
  const [roomOpen, setRoomOpen] = useState(() => Boolean(initial.get('thread')))

  /* ── data ───────────────────────────────────────────────────────────── */
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchHome({}, signal)
      // New inbound since the last read → a quiet "new reply" pulse on that row.
      const arrived = new Set<string>()
      for (const t of allThreads(next)) {
        const prev = lastSeen.current.get(t.id)
        const at = t.last_message.at || ''
        if (prev && at && at !== prev && t.last_message.direction === 'inbound') arrived.add(t.id)
        lastSeen.current.set(t.id, at)
      }
      setHome(next)
      setError(null)
      if (arrived.size) { setFresh(arrived); window.setTimeout(() => setFresh(new Set()), 2400) }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError((err as Error)?.message || 'unavailable')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])
  // Near-realtime: the dispatcher ticks every minute.
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 45_000)
    return () => window.clearInterval(t)
  }, [load])

  /* ── lenses ─────────────────────────────────────────────────────────── */
  const base = useMemo(() => viewRows(home, view), [home, view])
  const quickCounts = useMemo(() => Object.fromEntries(QUICK.map((q) => [q.key, base.filter((t) => quickMatch(t, q.key) && searchMatch(t, query)).length])) as Record<QuickKey, number>, [base, query])
  const rows = useMemo(() => base.filter((t) => quickMatch(t, quick) && searchMatch(t, query)), [base, quick, query])
  const groups = useMemo(() => groupRows(view, rows), [view, rows])
  const visibleIds = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.id)), [groups])
  const summaryById = useMemo(() => new Map(allThreads(home).map((t) => [t.id, t])), [home])

  // A selection always exists while the lens has rows (the room is never an empty slab).
  useEffect(() => {
    if (!home) return
    if (selectedId && (visibleIds.includes(selectedId) || summaryById.has(selectedId))) return
    setSelectedId(visibleIds[0] ?? null)
  }, [home, visibleIds, selectedId, summaryById])

  // A lens change moves the selection only if the current one left the lens.
  const changeLens = useCallback((next: { view?: ViewKey; quick?: QuickKey }) => {
    const v = next.view ?? view
    const qk = next.quick ?? quick
    if (next.view) setView(next.view)
    if (next.quick) setQuick(next.quick)
    const nextRows = viewRows(home, v).filter((t) => quickMatch(t, qk) && searchMatch(t, query))
    if (!selectedId || !nextRows.some((t) => t.id === selectedId)) setSelectedId(nextRows[0]?.id ?? null)
  }, [home, view, quick, query, selectedId])

  /* ── room ───────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!selectedId) { setRoom(null); return }
    const ac = new AbortController()
    setRoomError(null)
    fetchThread(selectedId, ac.signal)
      .then((r) => { setRoom(r) })
      .catch((err) => { if ((err as Error)?.name !== 'AbortError') setRoomError((err as Error)?.message || 'unavailable') })
    return () => ac.abort()
  }, [selectedId, roomTick])
  // The list refreshed and the open thread moved on → re-read the room.
  const selectedStamp = selectedId ? `${summaryById.get(selectedId)?.last_message.at}|${summaryById.get(selectedId)?.state}|${summaryById.get(selectedId)?.next?.status}` : ''
  const stampRef = useRef(selectedStamp)
  useEffect(() => {
    if (stampRef.current && selectedStamp && stampRef.current !== selectedStamp && room?.thread.id === selectedId) setRoomTick((n) => n + 1)
    stampRef.current = selectedStamp
  }, [selectedStamp]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((id: string) => {
    setSelectedId(id)
    setRoomOpen(true)
    // An explicit open is a read; an automatic selection is not.
    void postThreadAction(id, 'mark_read')
  }, [])

  const refreshAll = useCallback(() => { void load(); setRoomTick((n) => n + 1) }, [load])

  /* ── url (main pane only: a secondary pane never rewrites the window URL) ── */
  useEffect(() => {
    if (pane) return
    try {
      const url = new URL(window.location.href)
      const set = (k: string, v: string | null) => { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k) }
      set('view', view === 'overview' ? null : view)
      set('thread', selectedId)
      set('inspector', inspectorOpen ? null : '0')
      const next = `${url.pathname}${url.search}`
      if (next !== `${window.location.pathname}${window.location.search}`) replaceRoutePath(next)
    } catch { /* best effort */ }
  }, [pane, view, selectedId, inspectorOpen])

  const toggleInspector = useCallback(() => {
    if (!columnInspector) { setPeek((v) => !v); return }
    setInspectorOpen((v) => { try { localStorage.setItem(INSPECTOR_PREF, v ? '0' : '1') } catch { /* ignore */ } return !v })
  }, [columnInspector])

  /* ── keyboard: j/k · ↑/↓ move, / search, ] inspector ─────────────────── */
  const onKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
      if (e.key === 'Escape' && e.target === searchRef.current) { setQuery(''); searchRef.current?.blur() }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return }
    if (e.key === ']') { e.preventDefault(); toggleInspector(); return }
    const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir || !visibleIds.length) return
    e.preventDefault()
    const i = selectedId ? visibleIds.indexOf(selectedId) : -1
    const next = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, i + dir))]
    if (next && next !== selectedId) open(next)
  }, [visibleIds, selectedId, open, toggleInspector])

  const counts = home?.counts
  const delivery = home?.delivery
  const selected = selectedId ? (room?.thread.id === selectedId ? room.thread : summaryById.get(selectedId) ?? null) : null
  const roomReady = Boolean(room && room.thread.id === selectedId)
  const hasInspector = Boolean(selected)
  const inspectorShown = hasInspector && (columnInspector ? inspectorOpen : peek)

  return (
    <div
      ref={rootRef}
      className={`emd${inspectorShown ? ' has-insp' : ''}${selected ? ' has-room' : ''}${tier === 'compact' && roomOpen && selected ? ' is-room-open' : ''}`}
      data-tier={tier}
      data-testid="email-desk"
      onKeyDown={onKey}
    >
      <header className="emd-head">
        <div className="emd-head__id">
          <h1>Email Command</h1>
          {demo ? <span className="emd-demo" title="Scenario data run through the real read model. Nothing is written or sent.">Demo data</span> : null}
        </div>
        {counts ? (
          <nav className="emd-live" aria-label="Email Command state">
            {([['needs_you', 'needs you', 'gold'], ['system_handling', 'system handling', 'cyan'], ['waiting', 'waiting', 'quiet'], ['failed', 'failed', 'red']] as Array<[ViewKey & keyof typeof counts, string, string]>).map(([k, label, tone], i) => (
              <button key={k} type="button" className={`emd-live__seg is-${tone}${counts[k] ? '' : ' is-zero'}${view === k ? ' is-on' : ''}`} onClick={() => changeLens({ view: k })}>
                {i ? <i aria-hidden>·</i> : null}<b>{counts[k]}</b> {label}
              </button>
            ))}
          </nav>
        ) : <span className="emd-live is-loading" aria-hidden />}
        <div className="emd-head__tools">
          {delivery ? (
            <span className={`emd-sendstate${delivery.send_enabled ? ' is-on' : ''}`} title={delivery.send_enabled ? 'Email sending is on' : delivery.operator_switch ? 'Sending is not enabled for this deployment' : 'The operator switch (email_enabled) is off'}>
              <i aria-hidden />{delivery.send_enabled ? 'Sending on' : 'Sending off'}
            </span>
          ) : null}
          <label className="emd-search">
            <Icon name="search" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="People, emails, properties, subjects" aria-label="Search email" />
            {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" /></button> : <kbd>/</kbd>}
          </label>
        </div>
        <nav className="emd-quick" aria-label="Quick filters">
          {QUICK.map((q, i) => {
            const n = quickCounts[q.key] ?? 0
            const sep = q.key === 'seller' || q.key === 'automated'
            return (
              <span key={q.key} className="emd-quick__slot">
                {sep && i ? <i className="emd-quick__sep" aria-hidden /> : null}
                <button type="button" className={`emd-quick__chip${quick === q.key ? ' is-on' : ''}`} aria-pressed={quick === q.key} disabled={q.key !== 'all' && !n && quick !== q.key} onClick={() => changeLens({ quick: quick === q.key ? 'all' : q.key })}>
                  {q.label}{q.key !== 'all' && n ? <b>{n}</b> : null}
                </button>
              </span>
            )
          })}
        </nav>
      </header>

      <div className="emd-planes">
        <Rail home={home} view={view} onView={(v) => changeLens({ view: v, quick: 'all' })} />

        <section className="emd-index" aria-label={VIEW_BY_KEY[view].label}>
          <header className="emd-index__head">
            <span className="emd-index__title">
              <Icon name={VIEW_BY_KEY[view].icon} />
              <b>{VIEW_BY_KEY[view].label}</b>
              {home ? <em>{rows.length}</em> : null}
            </span>
            <span className="emd-index__hint">{VIEW_BY_KEY[view].hint}</span>
          </header>
          {error && !home ? (
            <div className="emd-error" role="alert">
              <Icon name="alert" />
              <strong>Email Command is unavailable</strong>
              <p>Conversations could not be read. Nothing is shown rather than an empty inbox.</p>
              <button type="button" className="emd-btn" onClick={() => { setLoading(true); void load() }}>Try again</button>
            </div>
          ) : loading && !home ? (
            <IndexSkeleton />
          ) : home && !rows.length ? (
            <IndexEmpty home={home} view={view} query={query} quick={quick} onClear={() => { setQuery(''); changeLens({ quick: 'all' }) }} />
          ) : home ? (
            <VirtualIndex groups={groups} view={view} selectedId={selectedId} fresh={fresh} onOpen={open} />
          ) : null}
          {home?.truncated ? <p className="emd-index__note">Showing the most recent conversations — search to reach older ones.</p> : null}
        </section>

        <DeskRoom
          key={selectedId || 'none'}
          id={selectedId}
          room={roomReady ? room : null}
          fallback={selected}
          error={roomError}
          home={home}
          homeError={error}
          inspectorOpen={inspectorShown}
          onToggleInspector={toggleInspector}
          onChanged={refreshAll}
          onBack={tier === 'compact' ? () => setRoomOpen(false) : null}
        />

        {hasInspector ? (
          <aside className={`emd-insp${inspectorShown ? ' is-open' : ''}${columnInspector ? '' : ' is-layer'}`} aria-label="Conversation intelligence" aria-hidden={!inspectorShown}>
            {inspectorShown ? (
              <Suspense fallback={<div className="emd-insp__loading"><span /><span /><span /></div>}>
                <DeskInspector room={roomReady ? room : null} fallback={selected} onClose={toggleInspector} />
              </Suspense>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  )
}

/* ── rail ─────────────────────────────────────────────────────────────── */

function Rail({ home, view, onView }: { home: Home | null; view: ViewKey; onView: (v: ViewKey) => void }) {
  const d = home?.delivery
  const beat = d?.heartbeat_at ? ago(d.heartbeat_at) : null
  const health = d?.health?.status || null
  return (
    <nav className="emd-rail" aria-label="Email lenses">
      {(['inbox', 'parties', 'automation'] as const).map((g) => (
        <div key={g} className="emd-rail__group">
          <span className="emd-rail__label">{g === 'inbox' ? 'Inbox' : g === 'parties' ? 'Parties' : 'Automation'}</span>
          {VIEWS.filter((v) => v.group === g).map((v) => {
            const n = viewCount(home, v.key)
            const tone = v.key === 'needs_you' || v.key === 'escalated' ? 'gold' : v.key === 'system_handling' || v.key === 'automations' ? 'cyan' : v.key === 'failed' ? 'red' : 'plain'
            return (
              <button key={v.key} type="button" className={`emd-rail__item is-${tone}${view === v.key ? ' is-on' : ''}${n ? '' : ' is-zero'}`} aria-current={view === v.key || undefined} onClick={() => onView(v.key)} title={v.hint}>
                <span className="emd-rail__glyph"><Icon name={v.icon} /></span>
                <span className="emd-rail__name">{v.label}</span>
                <b className="emd-rail__n">{home ? n : ''}</b>
              </button>
            )
          })}
        </div>
      ))}
      {d ? (
        <div className="emd-rail__sys" title={d.health?.issues?.length ? d.health.issues.join(', ') : undefined}>
          <span className={`emd-rail__beat${health === 'healthy' ? ' is-ok' : health ? ' is-bad' : ''}`}><i aria-hidden /></span>
          <span className="emd-rail__sysbody">
            <b>Dispatcher{health ? ` · ${health}` : ''}</b>
            <small>{beat ? `Heartbeat ${beat}` : 'No heartbeat recorded'}</small>
          </span>
        </div>
      ) : null}
    </nav>
  )
}

/* ── index (windowed: only rows near the viewport are mounted) ─────────── */

type Flat = { kind: 'group'; g: Group } | { kind: 'row'; t: ThreadSummary; i: number }

function VirtualIndex({ groups, view, selectedId, fresh, onOpen }: { groups: Group[]; view: ViewKey; selectedId: string | null; fresh: Set<string>; onOpen: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(800)
  const showGroups = groups.length > 1 || view === 'overview'
  const flat = useMemo<Flat[]>(() => {
    const out: Flat[] = []
    let i = 0
    for (const g of groups) {
      if (showGroups) out.push({ kind: 'group', g })
      for (const t of g.rows) out.push({ kind: 'row', t, i: i++ })
    }
    return out
  }, [groups, showGroups])
  const offsets = useMemo(() => {
    const o: number[] = []
    let y = 0
    for (const f of flat) { o.push(y); y += f.kind === 'group' ? GROUP_H : ROW_H }
    return { o, total: y }
  }, [flat])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 800))
    ro.observe(el)
    setHeight(el.clientHeight || 800)
    return () => ro.disconnect()
  }, [])

  // Keep the selected row in view when it moves by keyboard.
  useEffect(() => {
    const el = scroller.current
    if (!el || !selectedId) return
    const idx = flat.findIndex((f) => f.kind === 'row' && f.t.id === selectedId)
    if (idx < 0) return
    const top = offsets.o[idx]
    if (top < el.scrollTop) el.scrollTo({ top: Math.max(0, top - GROUP_H) })
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTo({ top: top + ROW_H - el.clientHeight + 8 })
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const OVERSCAN = 6 * ROW_H
  let start = 0
  while (start < flat.length - 1 && offsets.o[start + 1] <= scrollTop - OVERSCAN) start++
  let end = start
  while (end < flat.length && offsets.o[end] < scrollTop + height + OVERSCAN) end++

  return (
    <div className="emd-index__scroll" ref={scroller} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} role="listbox" aria-label="Conversations">
      <div className="emd-index__canvas" style={{ height: offsets.total }}>
        {flat.slice(start, end).map((f, k) => {
          const top = offsets.o[start + k]
          if (f.kind === 'group') {
            return (
              <div key={`g:${f.g.key}`} className={`emd-group is-${f.g.tone}`} style={{ top, height: GROUP_H }} role="presentation">
                <Icon name={f.g.icon} /><span>{f.g.label}</span><em>{f.g.rows.length}</em>
              </div>
            )
          }
          return (
            <div key={f.t.id} className="emd-index__slot" style={{ top, height: ROW_H, ['--i' as string]: Math.min(f.i, 7) } as CSSProperties}>
              <Row t={f.t} view={view} selected={f.t.id === selectedId} fresh={fresh.has(f.t.id)} onOpen={() => onOpen(f.t.id)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function autoGlyph(t: ThreadSummary): { icon: 'bolt' | 'user' | 'pause' | 'refresh-cw'; label: string } | null {
  if (t.automation === 'paused_you_own_it') return { icon: 'user', label: 'You own this conversation' }
  if (t.automation === 'paused') return { icon: 'pause', label: 'Automation paused' }
  if (t.next?.status === 'retrying') return { icon: 'refresh-cw', label: 'Retrying delivery' }
  if (t.next) return { icon: 'bolt', label: 'Automation armed' }
  return null
}

function Row({ t, view, selected, fresh, onOpen }: { t: ThreadSummary; view: ViewKey; selected: boolean; fresh: boolean; onOpen: () => void }) {
  const meta = stateMetaFor(t, view)
  const place = where(t)
  const glyph = autoGlyph(t)
  const lastOut = t.last_message.direction === 'outbound'
  const preview = t.last_message.preview ? `${lastOut ? (t.automation === 'paused_you_own_it' || t.origin?.manual ? 'You: ' : 'LeadCommand: ') : ''}${t.last_message.preview}` : t.subject || ''
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-thread-id={t.id}
      className={`emd-row is-${meta.tone} is-${t.category}${selected ? ' is-selected' : ''}${t.operator_unread ? ' is-unread' : ''}${fresh ? ' is-new' : ''}`}
      onClick={onOpen}
    >
      <span className={`emd-orb is-${t.category}${t.state === 'system_handling' ? ' is-live' : ''}`} aria-hidden>{initials(t)}</span>
      <span className="emd-row__main">
        <span className="emd-row__l1">
          <b className="emd-row__who">{who(t)}</b>
          <span className="emd-row__role">{ROLE_LABEL[t.category] || t.category}</span>
          {t.operator_unread ? <i className="emd-row__unread" aria-label="Unread" /> : null}
          <time>{ago(t.last_message.at)}</time>
        </span>
        <span className="emd-row__l2">{place ? <span className="emd-row__place">{place.split(',')[0]}</span> : null}{place && preview ? <i aria-hidden>—</i> : null}<span className="emd-row__preview">{preview}</span></span>
        <span className="emd-row__l3">
          <span className={`emd-state is-${meta.tone}`} key={`${t.state}:${meta.label}`}><Icon name={meta.icon} /><b>{meta.label}</b></span>
          <span className="emd-row__signal">{rowSignal(t)}</span>
          {glyph ? <span className="emd-row__auto" title={glyph.label} aria-label={glyph.label}><Icon name={glyph.icon} /></span> : null}
        </span>
      </span>
    </button>
  )
}

function IndexSkeleton() {
  return (
    <div className="emd-skel" aria-busy="true" aria-label="Loading conversations">
      {[0, 1, 2, 3, 4].map((i) => <span key={i} className="emd-skel__row" style={{ ['--i' as string]: i } as CSSProperties}><i /><span><i /><i /><i /></span></span>)}
    </div>
  )
}

function IndexEmpty({ home, view, query, quick, onClear }: { home: Home; view: ViewKey; query: string; quick: QuickKey; onClear: () => void }) {
  const total = allThreads(home).length
  if (query || quick !== 'all') {
    return (
      <div className="emd-empty">
        <span className="emd-empty__mark" aria-hidden><Icon name="search" /></span>
        <strong>{query ? `Nothing matches “${query}”` : 'Nothing in this filter'}</strong>
        <button type="button" className="emd-btn is-quiet" onClick={onClear}>Clear filters</button>
      </div>
    )
  }
  if (!total) {
    return (
      <div className="emd-empty">
        <span className="emd-empty__mark" aria-hidden><Icon name="mail" /></span>
        <strong>No email conversations yet</strong>
        <p>Seller replies, title and buyer threads appear here the moment email is used. Nothing is simulated.</p>
      </div>
    )
  }
  const calm: Partial<Record<ViewKey, [string, string]>> = {
    needs_you: ['Nothing needs you', 'LeadCommand is handling every open conversation.'],
    escalated: ['Nothing escalated', 'Automation has not handed anything to you.'],
    failed: ['Nothing failed', 'Every recent send was accepted or is still in flight.'],
    system_handling: ['Nothing in flight', 'No conversation is waiting on LeadCommand right now.'],
    waiting: ['Not waiting on anyone', 'No conversation is waiting on a reply.'],
  }
  const [title, body] = calm[view] || [`No ${VIEW_BY_KEY[view].label.toLowerCase()} conversations`, VIEW_BY_KEY[view].hint]
  return (
    <div className="emd-empty is-calm">
      <span className="emd-empty__mark" aria-hidden><Icon name="check" /></span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}
