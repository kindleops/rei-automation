import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { Icon } from '../../../shared/icons'
import { PaneRouteContext, replaceRoutePath } from '../../../app/router'
import {
  demoNow, fetchDemoPortfolio, fetchDemoRoom, fetchPortfolioRows, fetchRoom, fetchStoredFiles, isDemoMode,
  type AttentionEntry, type AttentionGroup, type ClosingRow, type PortfolioRows, type Room, type StoredFile,
} from '../mobile/closing-execution-api'
import { clock, money, weekdayDate, zoneAbbr } from '../mobile/closing-format'
import {
  ATTENTION_ORDER, FILTERS, SORTS, countdown, groupRows, isSection, matchesFilter, matchesQuery, readinessFact, reasonFacts,
  relativeMoment, resolveCaseParam, sortRows, stateWord, toRow, whenFact, type Filter, type Section,
} from './desk-model'
import { DeskRoom } from './DeskRoom'
import { DeskInspector, type Subject } from './DeskInspector'
import { Empty, Spec, StateChip } from './desk-ui'
import './closing-desk-desktop.css'

/**
 * CLOSING DESK · DESKTOP 3.0 — a real-time transaction war room: what has to
 * happen between contract execution and money actually settling.
 *
 *   header + status rail   one line of truth (no KPI boxes)
 *   navigation (smoke)     every closing grouped by real state
 *   the room (crystal)     the selected transaction — or the portfolio view
 *   inspector (L3)         explains what you pointed at; hosts the one form
 *
 * Every state, owner, blocker and number is the server's derivation
 * (closing-execution-model.js). Nothing here decides business state.
 */

const ClosingSurface = lazy(() => import('../mobile/ClosingSurface').then((m) => ({ default: m.ClosingSurface })))
// Live closings re-read every minute while visible; an empty desk only every five.
const POLL_MS = 60_000
const POLL_IDLE_MS = 5 * 60_000

function readSearch(paneLocation: string | null): URLSearchParams {
  try { return new URLSearchParams(paneLocation ? (paneLocation.split('?')[1] ?? '') : window.location.search) } catch { return new URLSearchParams() }
}

export function ClosingDeskDesktop() {
  const pane = useContext(PaneRouteContext)
  const initial = useMemo(() => readSearch(pane?.location ?? null), []) // eslint-disable-line react-hooks/exhaustive-deps
  const demo = useMemo(isDemoMode, [])

  const [data, setData] = useState<PortfolioRows | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState('most_urgent')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [resolvedParam, setResolvedParam] = useState(false)
  const [section, setSection] = useState<Section>(() => (isSection(initial.get('section')) ? (initial.get('section') as Section) : 'overview'))
  const [highlight, setHighlight] = useState<string[] | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [roomError, setRoomError] = useState<string | null>(null)
  const [roomTick, setRoomTick] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [files, setFiles] = useState<StoredFile[] | null>(null)
  const [filesState, setFilesState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [subject, setSubject] = useState<Subject | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [demoClock, setDemoClock] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const lastSeen = useRef<Map<string, string>>(new Map())
  const selectedRef = useRef<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const now = demo && demoClock ? demoClock : clockNow

  /* ── width tiers: under 1320 the inspector stops reserving room (it floats over it) — it goes first; then the nav narrows ── */
  const [width, setWidth] = useState(1440)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)))
    ro.observe(el)
    setWidth(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  const tier = width >= 2200 ? 'ultra' : width >= 1500 ? 'wide' : width >= 1320 ? 'mid' : width >= 1000 ? 'narrow' : 'compact'

  /* ── data ───────────────────────────────────────────────────────────── */
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      let next: PortfolioRows
      if (demo) {
        const p = await fetchDemoPortfolio()
        setDemoClock(await demoNow())
        next = { ...p, items: p.items.map(toRow) }
      } else next = await fetchPortfolioRows(sort, signal)
      // A closing that changed since the last read gets one quiet pulse on its row.
      const changed = new Set<string>()
      for (const r of next.items) {
        const prev = lastSeen.current.get(r.id)
        if (prev && r.updatedAt && prev !== r.updatedAt) changed.add(r.id)
        if (r.updatedAt) lastSeen.current.set(r.id, r.updatedAt)
      }
      setData(next)
      setError(null)
      setRefreshedAt(Date.now())
      if (changed.size) {
        setFresh(changed)
        window.setTimeout(() => setFresh(new Set()), 2600)
        if (selectedRef.current && changed.has(selectedRef.current)) setRoomTick((n) => n + 1)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError((err as Error)?.message || 'unavailable')
    } finally { setLoading(false) }
  }, [demo, sort])

  useEffect(() => { selectedRef.current = selectedId }, [selectedId])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])
  // Near-real-time: closing tables are not in the realtime publication, so the
  // desk re-reads every minute while visible and on return to the tab.
  const hasLive = (data?.summary.counts.active ?? 0) > 0
  useEffect(() => {
    if (demo) return
    const tick = () => { if (document.visibilityState === 'visible') void load() }
    const t = window.setInterval(tick, hasLive ? POLL_MS : POLL_IDLE_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [demo, load, hasLive])
  useEffect(() => { if (demo) return; const t = window.setInterval(() => setClockNow(Date.now()), 30_000); return () => window.clearInterval(t) }, [demo])

  // Resolve the URL's closing once (canonical ?case=, or a hand-off id).
  useEffect(() => {
    if (!data || resolvedParam) return
    setResolvedParam(true)
    const id = resolveCaseParam(initial, data.items)
    if (id) setSelectedId(id)
  }, [data, resolvedParam, initial])

  /* ── the room ───────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!selectedId) { setRoom(null); setRoomError(null); return }
    const ac = new AbortController()
    setRoomError(null)
    ;(demo ? fetchDemoRoom(selectedId) : fetchRoom(selectedId, null, ac.signal))
      .then((r) => { setRoom(r); setRoomError(null) })
      .catch((err) => { if ((err as Error)?.name !== 'AbortError') setRoomError((err as Error)?.message || 'unavailable') })
    return () => ac.abort()
  }, [selectedId, demo, roomTick])
  useEffect(() => { setFiles(null); setFilesState('idle') }, [selectedId])

  const loadFiles = useCallback(async () => {
    if (!selectedId) return
    if (demo) { setFiles([]); setFilesState('ready'); return }
    setFilesState('loading')
    try { const r = await fetchStoredFiles(selectedId); setFiles(r.files); setFilesState('ready') } catch { setFilesState('error') }
  }, [selectedId, demo])

  const moreActivity = useCallback(async () => {
    if (!room || demo || !selectedId) return
    const last = room.activity[room.activity.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const more = await fetchRoom(selectedId, last.at)
      setRoom((r) => (r ? { ...r, activity: [...r.activity, ...more.activity], activityMore: more.activityMore } : r))
    } finally { setLoadingMore(false) }
  }, [room, demo, selectedId])

  /* ── lenses ─────────────────────────────────────────────────────────── */
  const rows = useMemo(() => sortRows((data?.items ?? []).filter((r) => matchesFilter(r, filter) && matchesQuery(r, query)), sort), [data, filter, query, sort])
  const groups = useMemo(() => groupRows(rows), [rows])
  const visibleIds = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.id)), [groups])
  const selectedRow = selectedId ? data?.items.find((r) => r.id === selectedId) ?? null : null

  const open = useCallback((id: string | null, opts: { section?: Section; highlight?: string[] | null; subject?: Subject | null } = {}) => {
    setSelectedId(id)
    setSection(opts.section ?? 'overview')
    setHighlight(opts.highlight ?? null)
    setSubject(opts.subject ?? null)
    if (id !== selectedId) setRoom(null)
  }, [selectedId])

  /* ── url (main pane only: a secondary pane never rewrites the window URL) ── */
  useEffect(() => {
    if (pane || !resolvedParam) return
    try {
      const url = new URL(window.location.href)
      const set = (k: string, v: string | null) => { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k) }
      for (const k of ['opp', 'opportunity_id', 'property_id', 'master_owner_id', 'closing', 'closing_id']) url.searchParams.delete(k)
      set('case', selectedId)
      set('section', selectedId && section !== 'overview' ? section : null)
      const next = `${url.pathname}${url.search}`
      if (next !== `${window.location.pathname}${window.location.search}`) replaceRoutePath(next)
    } catch { /* best effort */ }
  }, [pane, selectedId, section, resolvedParam])

  /* ── keyboard: ↑/↓ (j/k) move · Enter opens · / search · Esc closes · ] inspector ── */
  const onKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
      if (e.key === 'Escape' && target === searchRef.current) { setQuery(''); searchRef.current?.blur() }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return }
    if (e.key === ']') { e.preventDefault(); setCollapsed((v) => !v); return }
    if (e.key === 'Escape') {
      if (subject) { e.preventDefault(); setSubject(null); return }
      if (query) { e.preventDefault(); setQuery(''); return }
      if (selectedId) { e.preventDefault(); open(null); return }
      return
    }
    if (e.key === 'Enter' && target?.dataset?.closingId) { e.preventDefault(); open(target.dataset.closingId); return }
    const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir || !visibleIds.length) return
    // Arrows move the selection from the navigation (or nowhere in particular); inside the room they scroll it.
    if (target?.closest?.('.cdx-main, .cdx-insp')) return
    e.preventDefault()
    const i = selectedId ? visibleIds.indexOf(selectedId) : -1
    const next = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, i + dir))]
    if (next && next !== selectedId) {
      open(next)
      window.requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-closing-id="${CSS.escape(next)}"]`)?.focus({ preventScroll: false }))
    }
  }, [subject, query, selectedId, visibleIds, open])

  const inspect = useCallback((s: Subject) => { setSubject(s); setCollapsed(false) }, [])
  const inspectKey = subject?.kind === 'item' ? `item:${subject.item.key}` : subject?.kind === 'requirement' ? `req:${subject.key}` : null
  const afterWrite = useCallback(() => { setSubject(null); setRoomTick((n) => n + 1); void load() }, [load])

  const counts = data?.summary.counts
  const c = room && room.closing.id === selectedId ? room.closing : null

  // A narrow split pane keeps the phone's composition (it is built for that width).
  if (width < 760) {
    return (
      <div ref={rootRef} className="cdx-narrow">
        <Suspense fallback={null}><ClosingSurface /></Suspense>
      </div>
    )
  }

  return (
    <div ref={rootRef} className={`cdx is-tier-${tier}${selectedId ? ' has-room' : ''}${subject && !collapsed ? ' has-insp' : ''}${demo ? ' is-demo' : ''}`} data-testid="closing-desk-desktop" onKeyDown={onKey}>
      <Header data={data} demo={demo} query={query} setQuery={setQuery} searchRef={searchRef} refreshedAt={refreshedAt} now={now} />
      {data ? <StatusRail data={data} filter={filter} setFilter={setFilter} now={now} /> : null}

      <div className="cdx-body">
        <nav ref={navRef} className="cdx-nav" aria-label="Closings">
          <div className="cdx-nav__tools">
            <button type="button" className={`cdx-nav__home${!selectedId ? ' is-on' : ''}`} onClick={() => open(null)} aria-current={!selectedId ? 'page' : undefined}>
              <Icon name="grid" /><span>Portfolio</span>{counts ? <em>{counts.active} active</em> : null}
            </button>
            <label className="cdx-sort">
              <span className="cdx-sr">Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort closings">{SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            </label>
          </div>
          {filter !== 'all' || query ? (
            <p className="cdx-nav__lens">{FILTERS.find((f) => f.key === filter)?.label}{query ? ` · “${query}”` : ''}<button type="button" className="cdx-link" onClick={() => { setFilter('all'); setQuery('') }}>Clear</button></p>
          ) : null}
          <div className="cdx-nav__scroll">
            {error && !data ? <Empty title="Closings could not be read">Nothing is shown rather than a guess.</Empty>
              : loading && !data ? <NavSkeleton />
                : groups.length ? groups.map((g) => (
                  <section key={g.key} className={`cdx-group is-${g.key}`} aria-label={g.label}>
                    <h2>{g.label}<span>{g.rows.length}</span></h2>
                    <ul>{g.rows.map((r) => <NavRow key={r.id} r={r} now={now} on={r.id === selectedId} fresh={fresh.has(r.id)} onOpen={() => open(r.id)} />)}</ul>
                  </section>
                )) : data?.items.length ? <p className="cdx-muted cdx-nav__none">Nothing matches.</p> : <p className="cdx-muted cdx-nav__none">No closings yet.</p>}
          </div>
        </nav>

        <main className="cdx-main">
          {!selectedId ? (
            data ? <PortfolioView data={data} now={now} onOpen={open} setFilter={setFilter} /> : error ? <ErrorState onRetry={() => void load()} /> : <RoomSkeleton />
          ) : c && room ? (
            <DeskRoom c={c} room={room} demo={demo} now={now} section={section} onSection={(s) => { setSection(s); setHighlight(null) }} highlight={highlight} inspectKey={inspectKey} onInspect={inspect} files={files} filesState={filesState} onLoadFiles={loadFiles} onMoreActivity={moreActivity} loadingMore={loadingMore} />
          ) : roomError ? (
            <Empty title={roomError === 'closing_not_found' ? 'This closing no longer exists' : 'Could not open this closing'}>{selectedRow ? 'The portfolio row is shown in the navigation; the room could not be read.' : 'Check the link — closings open by their canonical id.'}</Empty>
          ) : <RoomSkeleton />}
        </main>

        {c ? <DeskInspector c={c} subject={subject} demo={demo} now={now} collapsed={collapsed} onClose={() => setSubject(null)} onCollapse={() => setCollapsed(true)} onExpand={() => setCollapsed(false)} onSubject={inspect} onDone={afterWrite} /> : null}
      </div>
    </div>
  )
}

/* ── header + status rail ─────────────────────────────────────────────── */

function Header({ data, demo, query, setQuery, searchRef, refreshedAt, now }: { data: PortfolioRows | null; demo: boolean; query: string; setQuery: (q: string) => void; searchRef: RefObject<HTMLInputElement>; refreshedAt: number | null; now: number }) {
  const k = data?.summary.counts
  return (
    <header className="cdx-head">
      <div className="cdx-head__id">
        <h1>Closing Desk</h1>
        {k ? (
          <p className="cdx-head__line" role="status">
            <span><b>{k.active}</b> active</span>
            <span className={k.needsYou ? 'is-attn' : ''}><b>{k.needsYou}</b> need{k.needsYou === 1 ? 's' : ''} you</span>
            <span className={k.ready ? 'is-ready' : ''}><b>{k.ready}</b> ready to close</span>
          </p>
        ) : null}
        {demo ? <span className="cdx-demo" title="Scenario rows run through the real derivation. Nothing is written.">Demo data</span> : null}
      </div>
      <div className="cdx-head__tools">
        {refreshedAt && !demo ? <span className="cdx-head__fresh"><i />Live · read {Math.max(0, Math.round((now - refreshedAt) / 1000)) < 45 ? 'just now' : relativeMoment(new Date(refreshedAt).toISOString(), null, now)}</span> : null}
        <label className="cdx-search">
          <Icon name="search" />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Address, seller, buyer, title, file #, closing ID, market" aria-label="Search closings" />
          {query ? <button type="button" className="cdx-icon" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="x" /></button> : <kbd>/</kbd>}
        </label>
      </div>
    </header>
  )
}

const RAIL_SEGMENTS: Array<{ key: string; label: string; filter: Filter; count: (d: PortfolioRows) => number; tone: string }> = [
  { key: 'needs_you', label: 'Needs you', filter: 'needs_you', count: (d) => d.summary.counts.needsYou, tone: 'attention' },
  { key: 'week', label: 'This week', filter: 'this_week', count: (d) => (d.summary.counts.closingToday ?? 0) + (d.summary.counts.closingSoon ?? 0), tone: 'active' },
  { key: 'waiting', label: 'Waiting', filter: 'waiting', count: (d) => d.items.filter((r) => r.group?.startsWith('waiting_')).length, tone: 'external' },
  { key: 'system', label: 'System handling', filter: 'system', count: (d) => d.summary.counts.systemHandling ?? 0, tone: 'system' },
  { key: 'ready', label: 'Ready', filter: 'ready', count: (d) => d.summary.counts.ready, tone: 'ready' },
  { key: 'closed', label: 'Closed', filter: 'closed', count: (d) => d.summary.counts.closed, tone: 'closed' },
  { key: 'cancelled', label: 'Cancelled', filter: 'cancelled', count: (d) => d.summary.counts.cancelled, tone: 'terminated' },
]

function StatusRail({ data, filter, setFilter, now }: { data: PortfolioRows; filter: Filter; setFilter: (f: Filter) => void; now: number }) {
  const rt = data.runtime
  const stale = rt?.heartbeatAt ? now - Date.parse(rt.heartbeatAt) > 30 * 60_000 : null
  return (
    <div className="cdx-rail-status" role="toolbar" aria-label="Portfolio status">
      <div className="cdx-rail-status__segs">
        {RAIL_SEGMENTS.map((s) => {
          const n = s.count(data)
          return (
            <button key={s.key} type="button" className={`is-${s.tone}${n ? '' : ' is-zero'}${filter === s.filter ? ' is-on' : ''}`} aria-pressed={filter === s.filter} onClick={() => setFilter(filter === s.filter ? 'all' : s.filter)}>
              <b>{n}</b>{s.label}
            </button>
          )
        })}
      </div>
      {rt ? (
        <Spec className="cdx-rail-status__rt" parts={[
          <><i className={`cdx-dot ${rt.automationEnabled ? 'is-good' : 'is-bad'}`} />Automation {rt.automationEnabled ? 'on' : 'off'}</>,
          rt.heartbeatAt ? <><i className={`cdx-dot ${stale ? 'is-bad' : 'is-good'}`} />Checked in {relativeMoment(rt.heartbeatAt, null, now)}</> : null,
          <><i className={`cdx-dot ${rt.emailSendEnabled ? 'is-good' : 'is-warn'}`} />Email sending {rt.emailSendEnabled ? 'on' : 'off'}</>,
        ]} />
      ) : null}
    </div>
  )
}

/* ── navigation rows ──────────────────────────────────────────────────── */

function NavRow({ r, now, on, fresh, onOpen }: { r: ClosingRow; now: number; on: boolean; fresh: boolean; onOpen: () => void }) {
  const reasons = reasonFacts(r, now)
  const ready = readinessFact(r)
  return (
    <li>
      <button type="button" className={`cdx-row is-${r.state.tone}${on ? ' is-on' : ''}${fresh ? ' is-fresh' : ''}`} data-closing-id={r.id} aria-current={on ? 'true' : undefined} onClick={onOpen}>
        <span className="cdx-row__top">
          <b>{r.property.line || r.property.address || 'Address not on record'}</b>
          <StateChip tone={r.state.tone} word={stateWord(r)} />
        </span>
        <span className="cdx-row__line">
          <span className="cdx-row__spec" title={[whenFact(r, now), ...reasons].join(' · ')}>{[whenFact(r, now), ...reasons].join(' · ')}</span>
          {ready ? <em className={`cdx-row__ready${r.ready ? ' is-ready' : ''}`}>{ready}</em> : null}
        </span>
      </button>
    </li>
  )
}

function NavSkeleton() {
  return <div className="cdx-skel" aria-busy="true" aria-label="Loading closings">{[0, 1, 2, 3, 4].map((i) => <span key={i}><i /><i /></span>)}</div>
}
function RoomSkeleton() {
  return <div className="cdx-skel is-room" aria-busy="true" aria-label="Loading"><span className="is-hero" /><span /><span /></div>
}
function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="cdx-empty is-error" role="alert">
      <strong>Closing Desk is unavailable</strong>
      <p>The closing records could not be read. Nothing is shown rather than a guess.</p>
      <button type="button" className="cdx-btn" onClick={onRetry}>Try again</button>
    </div>
  )
}

/* ── the portfolio view (no closing selected) ─────────────────────────── */

function PortfolioView({ data, now, onOpen, setFilter }: { data: PortfolioRows; now: number; onOpen: (id: string, opts?: { section?: Section; highlight?: string[] | null }) => void; setFilter: (f: Filter) => void }) {
  const k = data.summary.counts
  const next = data.summary.nextClosing ? data.items.find((x) => x.id === data.summary.nextClosing?.id) ?? null : null
  const attention = data.summary.attention
  const system = data.items.filter((x) => x.group === 'system_handling')
  const closed = data.items.filter((x) => x.closed).slice(0, 4)
  const cancelled = data.items.filter((x) => x.terminal).slice(0, 4)
  const empty = k.active === 0
  const attentionTotal = attention ? ATTENTION_ORDER.reduce((n, g) => n + (attention[g.key]?.length ?? 0), 0) : 0
  const attentionClosings = attention ? new Set(ATTENTION_ORDER.flatMap((g) => (attention[g.key] ?? []).map((a) => a.closingId))).size : 0
  return (
    <div className="cdx-portfolio">
      {data.degraded.length ? <p className="cdx-note is-warn"><Icon name="alert" />{data.degraded.map((d) => d.source.replace(/_/g, ' ')).join(', ')} unavailable — those facts are hidden, not zero.</p> : null}
      {empty ? (
        <section className="cdx-void" aria-label="No active closings">
          <span className="cdx-void__mark" aria-hidden><Icon name="key" /></span>
          <strong>No active closings</strong>
          <p>Deals appear automatically after canonical contract execution. Nothing is in contract, title or escrow right now.</p>
        </section>
      ) : null}

      {next ? <NextClosing r={next} now={now} onOpen={() => onOpen(next.id)} /> : !empty ? <p className="cdx-note"><Icon name="calendar" />No confirmed closing ahead — targets stay targets until title confirms them.</p> : null}

      {!empty ? (
        <section className="cdx-plane cdx-attn" aria-label="Needs attention">
          <h2>Needs attention <span>{attentionTotal ? `${attentionTotal} item${attentionTotal === 1 ? '' : 's'} · ${attentionClosings} closing${attentionClosings === 1 ? '' : 's'}` : 'Nothing needs you'}</span></h2>
          {attentionTotal ? (
            <div className="cdx-attn__groups">
              {ATTENTION_ORDER.map((g) => {
                const list = attention?.[g.key] ?? []
                return list.length ? <AttentionGroupView key={g.key} group={g.key} label={g.label} list={list} data={data} now={now} onOpen={onOpen} /> : null
              })}
            </div>
          ) : <p className="cdx-block__clear"><Icon name="check" />No blocker, overdue item, missing record or decision is waiting on you.</p>}
        </section>
      ) : null}

      {system.length ? (
        <section className="cdx-plane cdx-sys" aria-label="System handling">
          <h2>System handling <span>{system.length}</span></h2>
          <ul>
            {system.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r.id, { section: 'automation' })}>
                  <b>{r.property.line || r.property.address}</b>
                  <Spec parts={[r.ball?.automation ? `${r.ball.automation.label}${r.ball.automation.sequence ? ` #${r.ball.automation.sequence}` : ''}` : r.ball?.what, r.ball?.automation?.at ? relativeMoment(r.ball.automation.at, r.property.tz, now) : null, r.ball?.automation?.why ? `Why: ${r.ball.automation.why.toLowerCase()}` : null]} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {closed.length || cancelled.length ? (
        <div className="cdx-history">
          {closed.length ? (
            <section className="cdx-plane cdx-closedlist" aria-label="Recently closed">
              <h2>Recently closed <button type="button" className="cdx-link" onClick={() => setFilter('closed')}>All</button></h2>
              <ul>{closed.map((r) => <li key={r.id}><button type="button" onClick={() => onOpen(r.id)}><b>{r.property.line || r.property.address}</b><Spec parts={[whenFact(r, now), r.money?.actualNet !== null && r.money?.actualNet !== undefined ? <span className="cdx-gold">Net {money(r.money.actualNet)}</span> : 'Settlement record unavailable']} /></button></li>)}</ul>
            </section>
          ) : null}
          {cancelled.length ? (
            <section className="cdx-plane cdx-cancelledlist" aria-label="Cancelled">
              <h2>Cancelled <button type="button" className="cdx-link" onClick={() => setFilter('cancelled')}>All</button></h2>
              <ul>{cancelled.map((r) => <li key={r.id}><button type="button" onClick={() => onOpen(r.id)}><b>{r.property.line || r.property.address || 'Address not on record'}</b><Spec parts={[whenFact(r, now), r.cancellation?.reason ? truncate(r.cancellation.reason, 72) : null]} /></button></li>)}</ul>
            </section>
          ) : null}
        </div>
      ) : null}
      <p className="cdx-prov">From closing cases, buyer offers & agreements, EMD receipts, settlement records, title issues and the closing automation's own requests{data.recentDays ? ` · closed & cancelled from the last ${data.recentDays} days` : ''}.</p>
    </div>
  )
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function NextClosing({ r, now, onOpen }: { r: ClosingRow; now: number; onOpen: () => void }) {
  const c = r.closing!
  const cd = countdown(c.at, now)
  return (
    <button type="button" className={`cdx-next is-${r.state.tone}`} onClick={onOpen} data-testid="closing-next">
      <span className="cdx-eyebrow">Next closing{r.proximity ? ` · ${r.proximity.label}` : ''}{cd ? ` · ${cd}` : ''}</span>
      <span className="cdx-next__row">
        <span className="cdx-next__id">
          <strong>{r.property.line || r.property.address}</strong>
          <small>{[[r.property.city, r.property.state].filter(Boolean).join(', '), r.market && r.market !== [r.property.city, r.property.state].filter(Boolean).join(', ') ? r.market : null, r.title.escrowFile ? `File ${r.title.escrowFile}` : null].filter(Boolean).join(' · ')}</small>
        </span>
        <span className="cdx-next__when">
          <strong>{c.time ? `${weekdayDate(c.date)} · ${clock(c.time)}${c.tz ? ` ${zoneAbbr(c.tz)}` : ''}` : weekdayDate(c.date)}</strong>
          <StateChip tone={r.state.tone} word={stateWord(r)} />
        </span>
      </span>
      <Spec className="cdx-next__spec" parts={[r.readiness ? `Ready ${r.readiness.met}/${r.readiness.total}` : null, r.ball ? `${r.ball.owner === 'system' ? 'System handling' : `${r.ball.ownerLabel} has the ball`} · ${r.ball.what}` : null, r.buyer?.name ? `Buyer ${r.buyer.name}` : null, r.title.company]} />
    </button>
  )
}

function AttentionGroupView({ group, label, list, data, now, onOpen }: { group: AttentionGroup; label: string; list: AttentionEntry[]; data: PortfolioRows; now: number; onOpen: (id: string, opts?: { section?: Section; highlight?: string[] | null }) => void }) {
  return (
    <div className={`cdx-attn__g is-${group}`}>
      <h3>{label}<span>{list.length}</span></h3>
      <ul>
        {list.map((a) => {
          const r = data.items.find((x) => x.id === a.closingId)
          const hl = a.requirements || (a.requirement ? [a.requirement] : null)
          return (
            <li key={`${a.closingId}:${a.key}`}>
              <button type="button" onClick={() => onOpen(a.closingId, { highlight: hl })}>
                <b>{a.what}</b>
                <Spec parts={[a.address, a.owner ? `${a.owner === 'you' ? 'You' : a.owner[0].toUpperCase() + a.owner.slice(1)}` : null, a.at && r ? relativeMoment(a.at, r.property.tz, now, a.dateOnly) : null]} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

