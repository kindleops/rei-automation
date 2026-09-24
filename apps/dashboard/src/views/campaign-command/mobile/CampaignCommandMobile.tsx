/**
 * CAMPAIGN COMMAND — mobile index.
 *
 * Built to answer four questions in two seconds: what is running, what needs
 * attention, what is coming next, what should I do. The composition, top down:
 *
 *   header      identity + one line of state + two actions (search, new)
 *   segments    Active · Scheduled · Drafts · Completed, with live counts
 *   today       sellers ready · sent today · the attention callout
 *   cards       one anatomy per campaign state (see CampaignIndexCard)
 *
 * The previous screen spent its first 470px on a 30px title, a subtitle, a row
 * of capsule filters and a three-column KPI table before the first campaign.
 * This one reaches the first card at about half that.
 *
 * STATE THAT SURVIVES: the tab, the search and the scroll position are kept
 * across a trip into a campaign and back — the index unmounts while Detail is
 * open, so they live in a module store (and sessionStorage for the tab/search)
 * rather than in component state.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { getCampaignSendsSinceBackend, getQueueControlSettings } from '../../../lib/api/backendClient'
import type { CampaignModel, CampaignSummary } from '../campaigns.types'
import type { CampaignListFilter } from '../campaign-health'
import { formatWhen } from '../campaign-operator-language'
import { CampaignCardSkeleton, CampaignIndexCard, CountUp } from './CampaignIndexCard'
import { CampaignIndexMenu } from './CampaignIndexMenu'
import {
  EMPTY_STATE,
  PRIMARY_FILTERS,
  SECONDARY_FILTERS,
  displayName,
  matchesIndexFilter,
  nextStart,
  orderForIndex,
  rollupCampaigns,
  summaryLine,
  tabCounts,
} from './campaign-index-model'
import './campaign-index.css'

export {
  PRIMARY_FILTERS,
  SECONDARY_FILTERS,
  rollupCampaigns,
  summaryLine,
  targetModePhrase,
  targetingPhrase,
  toneOf,
  TONE_LABEL,
  type Tone,
} from './campaign-index-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return n.toLocaleString()
}

// ── State that outlives the component ───────────────────────────────────────

const STORE_KEY = 'campaign-command.index.v1'
type IndexMemory = { filter: CampaignListFilter; search: string; searchOpen: boolean; scope: CampaignListFilter; scrollTop: number }

function readMemory(): IndexMemory {
  const base: IndexMemory = { filter: 'live', search: '', searchOpen: false, scope: 'all', scrollTop: 0 }
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<IndexMemory>), scrollTop: 0 }
  } catch { /* private mode */ }
  return base
}

let memory: IndexMemory | null = null
export function getMemory(): IndexMemory {
  if (!memory) memory = readMemory()
  return memory
}
export function remember(patch: Partial<IndexMemory>) {
  memory = { ...getMemory(), ...patch }
  try {
    const { filter, search, searchOpen, scope } = memory
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ filter, search, searchOpen, scope }))
  } catch { /* private mode */ }
}

/** For tests: forget the in-memory copy so the next read comes from storage. */
export function resetIndexMemoryForTest() { memory = null }

/** Only the first paint of a session staggers in; returns never replay it. */
let enteredOnce = false

const POLL_MS = 45_000

export function CampaignCommandMobile({
  model,
  loading,
  failed,
  onRetry,
  onRefresh,
  onSelect,
  onNew,
  onContinueSetup,
  onAction,
}: {
  model: CampaignModel | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  onRefresh: () => void
  onSelect: (campaign: CampaignSummary) => void
  onNew: () => void
  onContinueSetup: (campaign: CampaignSummary) => void
  onAction: (action: string, campaign: CampaignSummary, payload?: Record<string, unknown>) => Promise<unknown> | void
}) {
  const initial = getMemory()
  const [filter, setFilterState] = useState<CampaignListFilter>(initial.filter)
  const [search, setSearchState] = useState(initial.search)
  const [searchOpen, setSearchOpenState] = useState(initial.searchOpen)
  const [scope, setScopeState] = useState<CampaignListFilter>(initial.scope)
  const [menuFor, setMenuFor] = useState<CampaignSummary | null>(null)
  const [sendMode, setSendMode] = useState<string | null>(null)
  const [sentToday, setSentToday] = useState<number | null>(null)

  const setFilter = (f: CampaignListFilter) => { setFilterState(f); remember({ filter: f }) }
  const setSearch = (s: string) => { setSearchState(s); remember({ search: s }) }
  const setScope = (s: CampaignListFilter) => { setScopeState(s); remember({ scope: s }) }
  // Closing search ends it: query and scope both reset, so the next search
  // starts across every campaign rather than inside whatever cut was last used.
  const setSearchOpen = (open: boolean) => {
    setSearchOpenState(open)
    remember({ searchOpen: open, ...(open ? {} : { search: '', scope: 'all' }) })
    if (!open) { setSearchState(''); setScopeState('all') }
  }

  const rootRef = useRef<HTMLDivElement | null>(null)
  const chromeRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const segRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [indicator, setIndicator] = useState<{ x: number; w: number; dir: 'l' | 'r' } | null>(null)

  const all = useMemo(() => model?.campaigns ?? [], [model])
  const roll = useMemo(() => rollupCampaigns(all), [all])
  const counts = useMemo(() => tabCounts(all), [all])
  const upcoming = useMemo(() => nextStart(all), [all])

  const activeFilter = searchOpen ? scope : filter
  const query = searchOpen ? search.trim().toLowerCase() : ''
  const list = useMemo(() => {
    const scoped = all.filter((c) => matchesIndexFilter(c, activeFilter))
    const found = query
      ? scoped.filter((c) => {
          const { title, subtitle } = displayName(c)
          return [c.campaign_name, title, subtitle, c.market_label].some((v) => String(v ?? '').toLowerCase().includes(query))
        })
      : scoped
    return orderForIndex(found)
  }, [all, activeFilter, query])

  // ── realtime: a quiet refresh while the index is on screen ────────────────
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh
  useEffect(() => {
    let last = Date.now()
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      last = Date.now()
      refreshRef.current()
    }
    const id = window.setInterval(tick, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible' && Date.now() - last > POLL_MS / 2) tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  // Sent today: measured from the message log since this device's midnight.
  useEffect(() => {
    let dead = false
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    void getCampaignSendsSinceBackend(midnight.toISOString()).then((res) => {
      if (!dead && res.ok && res.data?.ok) setSentToday(res.data.total)
    })
    return () => { dead = true }
  }, [model])

  useEffect(() => {
    let dead = false
    void getQueueControlSettings().then((res) => {
      if (dead || !res.ok) return
      const d = (res.data?.diagnostics ?? {}) as Record<string, unknown>
      setSendMode(d.queue_execution_mode ? String(d.queue_execution_mode) : null)
    })
    return () => { dead = true }
  }, [])

  useEffect(() => { if (searchOpen) searchRef.current?.focus({ preventScroll: true }) }, [searchOpen])

  // ── segmented control indicator ──────────────────────────────────────────
  // The liquid selection: its leading edge travels faster than its trailing
  // edge, so it stretches toward the new tab and settles — `dir` picks which
  // edge leads.
  useLayoutEffect(() => {
    const rail = segRef.current
    const el = rail?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!rail || !el) { setIndicator(null); return }
    setIndicator((prev) => ({ x: el.offsetLeft, w: el.offsetWidth, dir: prev && el.offsetLeft < prev.x ? 'l' : 'r' }))
  }, [filter, searchOpen, counts])

  // The chrome floats over the list; the list reserves its height.
  useLayoutEffect(() => {
    const chrome = chromeRef.current, root = rootRef.current
    if (!chrome || !root) return
    // Reserve the EXPANDED chrome. The large title shrinks as the list
    // scrolls; following that height would pull the list up under the
    // operator's finger mid-scroll. Re-measure only at rest or when it grows
    // (search opening, a wrap).
    let reserved = 0
    const apply = () => {
      const h = chrome.offsetHeight
      const atRest = (scrollRef.current?.scrollTop ?? 0) <= 2
      if (!atRest && h <= reserved) return
      reserved = h
      root.style.setProperty('--cx-chrome-h', `${h}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(chrome)
    return () => ro.disconnect()
  }, [])

  // Large-title collapse, driven by one CSS variable written straight to the
  // root on scroll — no React render per frame.
  const collapseFrame = useRef(0)
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    remember({ scrollTop: el.scrollTop })
    if (collapseFrame.current) return
    collapseFrame.current = requestAnimationFrame(() => {
      collapseFrame.current = 0
      const t = Math.max(0, Math.min(1, el.scrollTop / 64))
      rootRef.current?.style.setProperty('--cx-collapse', t.toFixed(3))
      rootRef.current?.classList.toggle('is-scrolled', el.scrollTop > 2)
    })
  }, [])


  // ── scroll position survives a trip into a campaign ──────────────────────
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || !scrollRef.current || all.length === 0) return
    restored.current = true
    scrollRef.current.scrollTop = getMemory().scrollTop
    onScroll()
  }, [all.length, onScroll])
  const changeFilter = (f: CampaignListFilter) => {
    if (f === filter) {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setFilter(f)
    remember({ scrollTop: 0 })
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }

  const openAttention = () => {
    setSearchOpenState(true)
    remember({ searchOpen: true })
    setScope('needs_attention')
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }

  const animate = !enteredOnce && list.length > 0
  useEffect(() => { if (animate) enteredOnce = true }, [animate])

  const subtitle = model ? summaryLine(roll, sendMode) || 'Nothing is running' : ''
  const empty = EMPTY_STATE[activeFilter] ?? EMPTY_STATE.all
  const showSkeleton = loading && !model
  const showError = failed && !model

  return (
    <div className="cxi" ref={rootRef}>
      {/* Ambient light: one composited layer, slow drift, behind the chrome only. */}
      <div className="cxi__aurora" aria-hidden="true">
        <span className="cxi__aurora-a" />
        <span className="cxi__aurora-b" />
        <span className="cxi__aurora-c" />
      </div>

      <div className="cxi__chrome" ref={chromeRef}>
      <header className={cls('cxi__head', searchOpen && 'is-searching')}>
        {searchOpen ? (
          <div className="cxi__search">
            <label className="cxi__search-field">
              <Icon name="search" size={15} />
              <input
                ref={searchRef}
                type="search"
                inputMode="search"
                enterKeyHint="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search campaigns"
                aria-label="Search campaigns"
              />
              {search && (
                <button type="button" className="cxi__search-clear" aria-label="Clear search" onClick={() => setSearch('')}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                </button>
              )}
            </label>
            <button type="button" className="cxi__search-done" onClick={() => setSearchOpen(false)}>Done</button>
          </div>
        ) : (
          <>
            <div className="cxi__id">
              <h1 className="cxi__title">Campaigns</h1>
              <p className={cls('cxi__state', roll.attention > 0 && 'has-attention')}>
                {roll.running > 0 && <span className="cxi__state-dot" aria-hidden="true" />}
                {subtitle}
              </p>
            </div>
            <div className="cxi__actions">
              <button type="button" className="cxi__icon" aria-label="Search campaigns" onClick={() => setSearchOpen(true)}>
                <Icon name="search" size={17} />
              </button>
              <button type="button" className="cxi__icon cxi__icon--new" aria-label="New campaign" onClick={onNew}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2.75v10.5M2.75 8h10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </>
        )}
      </header>

      {searchOpen ? (
        <div className="cxi__scopes" role="tablist" aria-label="Search in">
          {SECONDARY_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={scope === key}
              className={cls('cxi__scope', scope === key && 'is-on', key === 'needs_attention' && (counts[key] ?? 0) > 0 && 'is-alert')}
              onClick={() => setScope(key)}
            >
              {label}
              <span className="cxi__scope-count">{counts[key] ?? 0}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="cxi__seg" role="tablist" aria-label="Campaign state" ref={segRef}>
          {PRIMARY_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={cls('cxi__seg-tab', filter === key && 'is-on')}
              onClick={() => changeFilter(key)}
            >
              {label}
              {model && (counts[key] ?? 0) > 0 && <span className="cxi__seg-count">{counts[key]}</span>}
            </button>
          ))}
          {indicator && (
            <span
              className={cls('cxi__seg-blob', `is-${indicator.dir}`)}
              aria-hidden="true"
              style={{ left: indicator.x, right: `calc(100% - ${indicator.x + indicator.w}px)` }}
            />
          )}
        </div>
      )}
      </div>

      <div className="cxi__scroll" ref={scrollRef} onScroll={onScroll}>
        {!searchOpen && model && (
          <section className="cxi__today" aria-label="Today">
            <span className="cxi__stat">
              <CountUp className={cls('cxi__stat-value', roll.readyLive > 0 && 'is-ready')} value={roll.readyLive} format={compact} />
              <span className="cxi__stat-label">sellers ready</span>
            </span>
            {sentToday != null && (
              <span className="cxi__stat">
                <CountUp className={cls('cxi__stat-value', sentToday === 0 && 'is-quiet')} value={sentToday} format={compact} />
                <span className="cxi__stat-label">sent today</span>
              </span>
            )}
            {roll.attention > 0 ? (
              <button type="button" className="cxi__alert" onClick={openAttention}>
                <span className="cxi__alert-count">{roll.attention}</span>
                <span className="cxi__alert-label">{roll.attention === 1 ? 'needs attention' : 'need attention'}</span>
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            ) : (
              <span className="cxi__clear">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 8.4 6.6 11.3 12.5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                All clear
              </span>
            )}
            {upcoming && (
              <span className="cxi__next">
                Next start · <strong>{displayName(upcoming.campaign).title}</strong> {formatWhen(upcoming.campaign.next_send_at as string)}
              </span>
            )}
          </section>
        )}

        {searchOpen && model && (
          <p className="cxi__results" role="status">
            {list.length === 0 ? '' : `${list.length} ${list.length === 1 ? 'campaign' : 'campaigns'}`}
            {model.truncated && ` · the ${all.length} most recent`}
          </p>
        )}

        {showError ? (
          <div className="cxi__empty is-error" role="alert">
            <p className="cxi__empty-title">Campaigns couldn’t be loaded.</p>
            <p className="cxi__empty-body">Check your connection and try again.</p>
            <button type="button" className="cxi__empty-action" onClick={onRetry}>Retry</button>
          </div>
        ) : showSkeleton ? (
          <div className="cxi__list" aria-busy="true" aria-label="Loading campaigns">
            {Array.from({ length: 4 }).map((_, i) => <CampaignCardSkeleton key={i} />)}
          </div>
        ) : list.length > 0 ? (
          <div className="cxi__list" role="list" key={`${searchOpen ? 's' : 't'}:${activeFilter}`}>
            {list.map((c, i) => (
              <CampaignIndexCard
                key={c.id}
                campaign={c}
                onOpen={onSelect}
                onMenu={setMenuFor}
                onContinueSetup={onContinueSetup}
                enterIndex={animate ? i : undefined}
              />
            ))}
          </div>
        ) : model ? (
          <div className="cxi__empty">
            {query ? (
              <>
                <p className="cxi__empty-title">No campaigns match “{search.trim()}”</p>
                <p className="cxi__empty-body">Search looks at campaign names and markets.</p>
                {scope !== 'all' && (
                  <button type="button" className="cxi__empty-action" onClick={() => setScope('all')}>Search all campaigns</button>
                )}
              </>
            ) : (
              <>
                <p className="cxi__empty-title">{empty.title}</p>
                <p className="cxi__empty-body">{empty.body}</p>
                {empty.action === 'new' && (
                  <button type="button" className="cxi__empty-action" onClick={onNew}>New campaign</button>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>

      {menuFor && (
        <CampaignIndexMenu
          campaign={menuFor}
          onClose={() => setMenuFor(null)}
          onOpen={onSelect}
          onContinueSetup={onContinueSetup}
          onAction={onAction}
        />
      )}
    </div>
  )
}
