/**
 * PIPELINE — the living bloodstream of the acquisition operation (mobile).
 *
 * Automation-first. The screen answers, in order:
 *   is the machine working?     hero: live deals, how many the automation holds
 *   where is everything?        the S1–S10 flow (exact stages, grouped labels)
 *   whose move is it?           the lane meter (automation · seller · outside · you · exception)
 *   what needs a human?         Exceptions — only what the automation handed back
 *   what moved?                 Movement — real stage/price/offer changes + replies
 *   the deals themselves        feed, by view, server-paged
 *
 * Nothing here moves a stage. Stages advance only through the autopilot and
 * the authority registry; this surface reads them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { CountUp } from '../../../shared/motion/CountUp'
import { pushRoutePath } from '../../../app/router'
import { routeEntityGraphAction } from '../../../domain/entity-graph/entity-graph-route-actions'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT } from '../../../domain/entity-graph/universal-entity-context'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { subscribeToTableChanges } from '../../../lib/data/realtime'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import {
  fetchPipelineFeed,
  fetchPipelineOverview,
  fetchPipelinePoints,
  compactMoney,
  relTime,
  LANE_META,
  STAGE_TONE,
  type LaneKey,
  type PipelineCommandCard,
  type PipelineCommandOverview,
  type PipelineCommandParams,
  type PipelineMovement,
} from '../../../domain/pipeline/pipeline-command-api'
import { PipelineDealInspector } from './PipelineDealInspector'
import './pipeline-command-tokens.css'
import './pipeline-command.css'
import './pipeline-desktop.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const fmt = (n: number) => Math.round(n).toLocaleString()

type Props = {
  onOpenCommandView: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
}

const VIEWS: Array<{ key: string; label: string }> = [
  { key: 'working', label: 'Working' },
  { key: 'attention', label: 'Exceptions' },
  { key: 'moving', label: 'Moving' },
  { key: 'stalled', label: 'Stalled' },
  { key: 'dormant', label: 'Dormant' },
  { key: 'all', label: 'All' },
]
const SORTS: Array<{ key: string; label: string }> = [
  { key: '', label: 'Smart' },
  { key: 'urgent', label: 'Most urgent' },
  { key: 'recent', label: 'Newest activity' },
  { key: 'stage_age', label: 'Longest in stage' },
  { key: 'progression', label: 'Furthest along' },
  { key: 'asking', label: 'Highest asking' },
  { key: 'value', label: 'Highest value' },
  { key: 'newest', label: 'Newest deal' },
]
const LANE_ORDER: LaneKey[] = ['system', 'seller', 'external', 'operator', 'blocked']
const GROUP_SPANS: Array<{ key: string; label: string; from: number; to: number; tone: string }> = [
  { key: 'discovery', label: 'Discovery', from: 1, to: 2, tone: 'var(--plc-s-early)' },
  { key: 'qualification', label: 'Qualify', from: 3, to: 4, tone: 'var(--plc-s-qualify)' },
  { key: 'negotiation', label: 'Offer', from: 5, to: 5, tone: 'var(--plc-s-negotiate)' },
  { key: 'contracting', label: 'Sign', from: 6, to: 6, tone: 'var(--plc-s-contract)' },
  { key: 'disposition', label: 'Dispo', from: 7, to: 7, tone: 'var(--plc-s-dispo)' },
  { key: 'closing', label: 'Closing', from: 8, to: 9, tone: 'var(--plc-s-closing)' },
  { key: 'complete', label: 'Closed', from: 10, to: 10, tone: 'var(--plc-s-closed)' },
]
const MOVE_ICON: Record<PipelineMovement['kind'], IconName> = {
  advance: 'arrow-up-right', regress: 'arrow-down-left', price: 'dollar-sign', offer: 'send', counter: 'refresh-cw',
  created: 'spark', exit: 'x', reply: 'message',
}

function readOpp(): string | null {
  try { return new URLSearchParams(window.location.search).get('opp') } catch { return null }
}
function writeOpp(id: string | null) {
  try {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('opp', id)
    else url.searchParams.delete('opp')
    window.history.replaceState(window.history.state, '', url.toString())
  } catch { /* ignore */ }
}

export function PipelineCommandCenter({ onOpenCommandView, onOpenDealIntelligence }: Props) {
  const [params, setParams] = useState<PipelineCommandParams>({ scope: 'active' })
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [overview, setOverview] = useState<PipelineCommandOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [view, setView] = useState('working')
  const [stage, setStage] = useState<string | null>(null)
  const [sort, setSort] = useState('')
  const [feed, setFeed] = useState<{ key: string; rows: PipelineCommandCard[]; total: number; next: number | null; error: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [open, setOpen] = useState<{ id: string; seed?: PipelineCommandCard } | null>(() => {
    const id = readOpp()
    return id ? { id } : null
  })
  const [toast, setToast] = useState<string | null>(null)
  const [pulseKey, setPulseKey] = useState(0)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  // Debounced server-side search.
  useEffect(() => {
    const t = window.setTimeout(() => setParams((p) => ({ ...p, q: query.trim() || undefined })), 320)
    return () => window.clearTimeout(t)
  }, [query])

  const effectiveView = stage ? `stage:${stage}` : (params.q ? 'all' : view)
  const feedKey = JSON.stringify({ params, effectiveView, sort })

  const loadOverview = useCallback((signal?: AbortSignal, silent = false) => {
    if (!silent) setOverviewError(null)
    return fetchPipelineOverview(params, signal)
      .then((o) => {
        setOverview((prev) => {
          if (prev && o.totals.movedToday > prev.totals.movedToday) setPulseKey((k) => k + 1)
          return o
        })
      })
      .catch((e: unknown) => { if (!signal?.aborted && !silent) setOverviewError(e instanceof Error ? e.message : 'failed') })
  }, [params])

  const loadFeed = useCallback((signal?: AbortSignal) => {
    const key = feedKey
    return fetchPipelineFeed({ ...params, view: effectiveView, sort: sort || undefined, limit: 30 }, signal)
      .then((f) => setFeed({ key, rows: f.rows, total: f.total, next: f.nextCursor, error: null }))
      .catch((e: unknown) => { if (!signal?.aborted) setFeed({ key, rows: [], total: 0, next: null, error: e instanceof Error ? e.message : 'failed' }) })
  }, [effectiveView, feedKey, params, sort])

  useEffect(() => {
    const c = new AbortController()
    void loadOverview(c.signal)
    return () => c.abort()
  }, [loadOverview])

  useEffect(() => {
    const c = new AbortController()
    void loadFeed(c.signal)
    return () => c.abort()
  }, [loadFeed])

  // Live: replies and thread state stream in; refresh quietly, coalesced.
  useEffect(() => {
    let timer: number | null = null
    const bump = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => { void loadOverview(undefined, true); void loadFeed() }, 1800)
    }
    const subs = ['inbox_thread_state', 'message_events'].map((t) => subscribeToTableChanges(t, bump))
    return () => { if (timer) window.clearTimeout(timer); subs.forEach((s) => s.unsubscribe()) }
  }, [loadFeed, loadOverview])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(t)
  }, [toast])

  const feedCurrent = feed && feed.key === feedKey ? feed : null
  const rows = feedCurrent?.rows ?? []

  const loadMore = () => {
    if (!feedCurrent?.next || loadingMore) return
    setLoadingMore(true)
    void fetchPipelineFeed({ ...params, view: effectiveView, sort: sort || undefined, limit: 30, cursor: feedCurrent.next })
      .then((f) => setFeed((cur) => (cur && cur.key === feedKey ? { ...cur, rows: [...cur.rows, ...f.rows], next: f.nextCursor } : cur)))
      .finally(() => setLoadingMore(false))
  }

  const openDeal = (card: PipelineCommandCard | { id: string }) => {
    setOpen({ id: card.id, seed: 'stage' in card ? card : undefined })
    writeOpp(card.id)
  }
  const closeDeal = useCallback(() => { setOpen(null); writeOpp(null) }, [])
  useBackHandler(Boolean(open), 'pipeline:deal', 'Deal', () => { closeDeal(); return true })

  const pickView = (key: string) => {
    setView(key)
    setStage(null)
    feedRef.current?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' })
  }
  const pickStage = (code: string | null) => {
    setStage((cur) => (cur === code ? null : code))
    window.setTimeout(() => feedRef.current?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' }), 30)
  }

  const showViewOnMap = async () => {
    try {
      const res = await fetchPipelinePoints({ ...params, view: effectiveView })
      if (!res.points.length) { setToast('No mapped properties in this view.'); return }
      const label = stage ? `in ${overview?.stages.find((s) => s.code === stage)?.short ?? 'stage'}` : `${VIEWS.find((v) => v.key === view)?.label.toLowerCase() ?? 'pipeline'} deals`
      writeMapFocusSet({ label, tone: 'property', points: res.points.map((p) => ({ lat: p.lat, lng: p.lng, id: p.id, label: p.label })) })
      pushRoutePath('/map')
    } catch {
      setToast('Couldn’t load map points.')
    }
  }

  const o = overview
  const stagesMax = useMemo(() => Math.max(1, ...(o?.stages.map((s) => s.count) ?? [1])), [o])
  const working = o?.totals.working ?? 0
  const laneTotal = LANE_ORDER.reduce((n, k) => n + (o?.lanes[k] ?? 0), 0)
  const activeStage = o?.stages.find((s) => s.code === stage) ?? null

  return (
    <section className="plc" data-scope={params.scope}>
      <div className="plc__liquid" aria-hidden="true"><i /><i /><i /></div>

      <div className="plc__scroll">
        {/* ── Machine state ─────────────────────────────────────────────── */}
        <header className="plc-hero">
          <div className="plc-hero__top">
            <span className="plc-eyebrow">Pipeline</span>
            <span className="plc-live" title="Live — replies and automation stream in">
              <i key={pulseKey} />Live{o ? ` · ${relTime(o.generatedAt) === 'now' ? 'just now' : relTime(o.generatedAt)}` : ''}
            </span>
            <button type="button" className="plc-icon" onClick={() => setSearchOpen((v) => !v)} aria-label="Search pipeline" aria-expanded={searchOpen}><Icon name="search" /></button>
            <button type="button" className={cls('plc-icon', (params.market || params.property_type || params.temperature || params.scope !== 'active') && 'is-on')} onClick={() => setFiltersOpen(true)} aria-label="Filters"><Icon name="filter" /></button>
          </div>

          {searchOpen ? (
            <label className="plc-search">
              <Icon name="search" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Address, seller, phone, market…" inputMode="search" enterKeyHint="search" aria-label="Search pipeline" />
              {query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" /></button> : null}
            </label>
          ) : null}

          {overviewError && !o ? (
            <div className="plc-error">
              <b>Pipeline didn’t load</b>
              <span>Check the connection and try again.</span>
              <button type="button" onClick={() => void loadOverview()}>Retry</button>
            </div>
          ) : (
            <>
              <div className="plc-hero__headline">
                <span className="plc-hero__num">{o ? <CountUp value={working} format={fmt} /> : <i className="plc-ghost is-num" />}</span>
                <span className="plc-hero__words">
                  <b>{params.scope === 'active' ? 'live deals' : 'deals'}</b>
                  <small>
                    {o
                      ? `${fmt(o.totals.automated)} handled by automation${o.lanes.gated ? ` · ${o.lanes.gated} held by send gates` : ''}`
                      : 'Reading the machine…'}
                  </small>
                </span>
              </div>
              <div className="plc-hero__pills">
                <button type="button" className={cls('plc-pill is-move', view === 'moving' && !stage && 'is-on')} onClick={() => pickView('moving')}>
                  <span>Moved 24h</span><b>{o ? <CountUp value={o.totals.movedToday} format={fmt} /> : '—'}</b>
                </button>
                <button type="button" className={cls('plc-pill is-exception', view === 'attention' && !stage && 'is-on', o && o.totals.attention === 0 && 'is-calm')} onClick={() => pickView('attention')}>
                  <span>Exceptions</span><b>{o ? <CountUp value={o.totals.attention} format={fmt} /> : '—'}</b>
                </button>
                <button type="button" className={cls('plc-pill is-stall', view === 'stalled' && !stage && 'is-on')} onClick={() => pickView('stalled')}>
                  <span>Stalled</span><b>{o ? <CountUp value={o.totals.stalled} format={fmt} /> : '—'}</b>
                </button>
                <button type="button" className={cls('plc-pill is-dormant', view === 'dormant' && !stage && 'is-on')} onClick={() => pickView('dormant')}>
                  <span>Dormant</span><b>{o ? <CountUp value={o.totals.dormant} format={fmt} /> : '—'}</b>
                </button>
              </div>
              {o && (o.totals.asking || o.totals.value) ? (
                <p className="plc-hero__money">
                  {o.totals.value ? <><b>{compactMoney(o.totals.value)}</b> est. value across {fmt(o.totals.valued)} valued · </> : null}
                  {o.totals.asking ? <><b>{compactMoney(o.totals.asking)}</b> in seller asking prices</> : null}
                  {o.totals.offersOut ? <> · <b>{o.totals.offersOut}</b> offers out</> : null}
                </p>
              ) : null}
            </>
          )}
        </header>

        {/* ── The lifecycle flow: exact S1–S10, grouped ─────────────────── */}
        <section className="plc-flow" aria-label="Lifecycle">
          <div className="plc-flow__stream" aria-hidden="true"><i /><i /><i /></div>
          <div className="plc-flow__cols">
            {(o?.stages ?? Array.from({ length: 10 }, (_, i) => ({ code: `s${i}`, short: `S${i + 1}`, count: 0, working: 0, dormant: 0, attention: 0, movedToday: 0, label: '', index: i + 1 }))).map((s, i) => {
              const h = s.count ? Math.max(0.12, Math.log10(s.count + 1) / Math.log10(stagesMax + 1)) : 0
              const workingShare = s.count ? s.working / s.count : 0
              const tone = STAGE_TONE[s.code] ?? 'var(--plc-s-early)'
              return (
                <button
                  key={s.code}
                  type="button"
                  className={cls('plc-col', stage === s.code && 'is-on', !s.count && 'is-empty', s.movedToday > 0 && 'is-moved')}
                  style={{ ['--h' as string]: h, ['--w' as string]: workingShare, ['--tone' as string]: tone, ['--i' as string]: i }}
                  onClick={() => o && pickStage(s.code)}
                  disabled={!o}
                  aria-label={`${s.short} ${s.label}: ${s.count} (${s.working} being worked, ${s.dormant} dormant)`}
                >
                  <span className="plc-col__count">{o ? (s.count ? <CountUp value={s.count} format={fmt} /> : '0') : ''}</span>
                  <span className="plc-col__bar">
                    <i className="plc-col__dormant" />
                    <i className="plc-col__working" />
                    {s.attention ? <em className="plc-col__alert">{s.attention}</em> : null}
                  </span>
                  <span className="plc-col__label">{s.short}</span>
                </button>
              )
            })}
          </div>
          <div className="plc-flow__groups">
            {GROUP_SPANS.map((g) => (
              <span key={g.key} style={{ gridColumn: `${g.from} / ${g.to + 1}`, ['--tone' as string]: g.tone }}>{g.label}</span>
            ))}
          </div>
          {activeStage ? (
            <div className="plc-flow__focus">
              <b>{activeStage.short} · {activeStage.label}</b>
              <span>{fmt(activeStage.working)} working · {fmt(activeStage.dormant)} dormant{activeStage.stalled ? ` · ${activeStage.stalled} stalled` : ''}</span>
              <button type="button" onClick={() => pickStage(null)} aria-label="Clear stage"><Icon name="close" /></button>
            </div>
          ) : null}
        </section>

        {/* ── Whose move is it ──────────────────────────────────────────── */}
        {o ? (
          <section className="plc-lanes" aria-label="Whose move">
            <header><span className="plc-eyebrow">Whose move</span><small>{fmt(laneTotal)} live deals</small></header>
            <div className="plc-lanes__meter" role="img" aria-label="Share of live deals by who acts next">
              {LANE_ORDER.map((k) => {
                const n = o.lanes[k] ?? 0
                return n ? <i key={k} style={{ flexGrow: n, ['--tone' as string]: LANE_META[k].tone }} /> : null
              })}
            </div>
            <div className="plc-lanes__keys">
              {LANE_ORDER.map((k) => (
                <button key={k} type="button" className={cls('plc-lane', view === `lane:${k}` && 'is-on')} style={{ ['--tone' as string]: LANE_META[k].tone }} onClick={() => pickView(`lane:${k}`)} disabled={!o.lanes[k]}>
                  <i /><span>{LANE_META[k].label}</span><b>{fmt(o.lanes[k] ?? 0)}</b>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Exceptions — only what the automation handed back ────────── */}
        {o ? (
          o.totals.attention === 0 ? (
            <section className="plc-calm">
              <span className="plc-calm__orb" aria-hidden="true" />
              <div><b>Nothing needs you.</b><small>Automation is handling the active pipeline.</small></div>
            </section>
          ) : (
            <section className="plc-exceptions">
              <header>
                <span className="plc-eyebrow">Exceptions</span>
                <small>Only what the automation handed back</small>
                <button type="button" className="plc-link" onClick={() => pickView('attention')}>All {o.totals.attention}</button>
              </header>
              {o.attentionTop.slice(0, 3).map((c, i) => (
                <button key={c.id} type="button" className="plc-exception" style={{ ['--tone' as string]: LANE_META[c.lane.key].tone, ['--i' as string]: i }} onClick={() => openDeal(c)}>
                  <span className="plc-exception__icon"><Icon name={(LANE_META[c.lane.key].icon as IconName)} /></span>
                  <span className="plc-exception__body">
                    <b>{c.lane.detail || c.lane.label}</b>
                    <small>{c.address || c.seller || 'Unaddressed deal'} · S{c.stageIndex}</small>
                  </span>
                  <span className="plc-exception__since">{relTime(c.lane.since)}</span>
                </button>
              ))}
            </section>
          )
        ) : null}

        {/* ── Movement ──────────────────────────────────────────────────── */}
        {o && o.movement.length ? (
          <section className="plc-moves">
            <header>
              <span className="plc-eyebrow">Movement</span>
              <small>Last 7 days</small>
              <button type="button" className="plc-link" onClick={() => pickView('moving')}>Deals</button>
            </header>
            <ol>
              {o.movement.slice(0, 6).map((m, i) => (
                <li key={m.id} style={{ ['--i' as string]: i, ['--tone' as string]: STAGE_TONE[m.toStage ?? m.stage] ?? 'var(--plc-s-early)' }}>
                  <button type="button" className={cls('plc-move', `is-${m.kind}`)} onClick={() => openDeal({ id: m.opportunityId })}>
                    <span className="plc-move__icon"><Icon name={MOVE_ICON[m.kind]} /></span>
                    <span className="plc-move__body">
                      <b>{m.title}{m.detail && m.kind !== 'reply' ? <em> · {m.detail}</em> : null}</b>
                      <small>{m.kind === 'reply' && m.detail ? `“${m.detail}” — ` : ''}{m.address || m.seller || 'Deal'}</small>
                    </span>
                    <span className="plc-move__at">{relTime(m.at)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {/* ── Deals ─────────────────────────────────────────────────────── */}
        <div className="plc-feedhead" ref={feedRef}>
          <div className="plc-tabs" role="tablist" aria-label="Pipeline view">
            {stage && activeStage ? (
              <button type="button" role="tab" aria-selected className="plc-tab is-on is-stage" style={{ ['--tone' as string]: STAGE_TONE[stage] }} onClick={() => pickStage(null)}>
                {activeStage.short} · {activeStage.label} <Icon name="close" />
              </button>
            ) : null}
            {VIEWS.map((v) => (
              <button key={v.key} type="button" role="tab" aria-selected={!stage && view === v.key} className={cls('plc-tab', !stage && view === v.key && 'is-on')} onClick={() => pickView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="plc-feedhead__bar">
            <span>{feedCurrent ? <><b>{fmt(feedCurrent.total)}</b> {params.q ? `matching “${params.q}”` : 'deals'}</> : 'Loading…'}</span>
            <button type="button" className="plc-chip" onClick={() => setSort((cur) => SORTS[(SORTS.findIndex((s) => s.key === cur) + 1) % SORTS.length].key)}>
              <Icon name="trending-up" />{SORTS.find((s) => s.key === sort)?.label}
            </button>
            <button type="button" className="plc-chip" onClick={() => void showViewOnMap()} aria-label="Show this view on the Map"><Icon name="map" />Map</button>
          </div>
        </div>

        <div className="plc-feed">
          {!feedCurrent ? (
            Array.from({ length: 4 }).map((_, i) => <div key={i} className="plc-card is-ghost" style={{ ['--i' as string]: i }} />)
          ) : feedCurrent.error ? (
            <div className="plc-error"><b>Deals didn’t load</b><span>Try again in a moment.</span><button type="button" onClick={() => void loadFeed()}>Retry</button></div>
          ) : rows.length === 0 ? (
            <div className="plc-empty">
              <span className="plc-calm__orb" aria-hidden="true" />
              <b>{view === 'attention' ? 'Nothing needs you.' : view === 'stalled' ? 'Nothing is stalled.' : 'No deals here.'}</b>
              <small>{view === 'attention' ? 'Automation is handling the active pipeline.' : params.q ? 'Try another address, seller or phone.' : 'Pick another view or stage.'}</small>
            </div>
          ) : (
            rows.map((c, i) => <DealCard key={c.id} card={c} index={i} onOpen={() => openDeal(c)} />)
          )}
          {feedCurrent?.next ? (
            <button type="button" className="plc-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : `Show more · ${fmt(feedCurrent.total - rows.length)} left`}</button>
          ) : null}
        </div>
      </div>

      {filtersOpen ? (
        <FilterSheet
          params={params}
          sort={sort}
          onClose={() => setFiltersOpen(false)}
          onApply={(next, nextSort) => { setParams(next); setSort(nextSort); setFiltersOpen(false) }}
        />
      ) : null}

      {toast ? <div className="plc-toast" role="status">{toast}</div> : null}

      <PipelineDealInspector
        opportunityId={open?.id ?? null}
        seed={open?.seed}
        open={Boolean(open)}
        onClose={closeDeal}
        onOpenConversation={(threadKey) => { if (threadKey) { closeDeal(); onOpenCommandView(threadKey) } }}
        onOpenDealIntelligence={(threadKey) => { closeDeal(); onOpenDealIntelligence(threadKey) }}
        onOpenEntityGraph={(propertyId) => { if (propertyId) pushRoutePath(`/entity-graph/property/${encodeURIComponent(propertyId)}`) }}
        onShowOnMap={(card) => {
          if (!card.propertyId) return
          routeEntityGraphAction('show_on_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: card.propertyId, propertyId: card.propertyId, masterOwnerId: card.masterOwnerId })
        }}
        onOpenBuyerMatch={(propertyId) => { if (propertyId) pushRoutePath(`/buyer-match?property_id=${encodeURIComponent(propertyId)}`) }}
        onOpenClosingDesk={(card) => {
          const q = new URLSearchParams()
          if (card.propertyId) q.set('property_id', card.propertyId)
          if (card.masterOwnerId) q.set('master_owner_id', card.masterOwnerId)
          pushRoutePath(`/closing-desk${q.toString() ? `?${q}` : ''}`)
        }}
      />
    </section>
  )
}

function DealCard({ card, index, onOpen }: { card: PipelineCommandCard; index: number; onOpen: () => void }) {
  const lane = LANE_META[card.lane.key]
  const tone = STAGE_TONE[card.stage] ?? 'var(--plc-s-early)'
  const figures: Array<[string, string]> = []
  const ask = compactMoney(card.money.asking)
  const offer = compactMoney(card.money.offer)
  const counter = compactMoney(card.money.counter)
  const value = compactMoney(card.money.value)
  if (ask) figures.push(['Ask', ask])
  if (offer) figures.push(['Offer', offer])
  if (counter) figures.push(['Counter', counter])
  if (value) figures.push(['Value', value])
  const late = card.stageIndex !== null && card.stageIndex >= 6
  return (
    <button
      type="button"
      className={cls('plc-card', `lane-${card.lane.key}`, late && 'is-late', card.lane.key === 'complete' && 'is-closed', card.lane.key === 'dormant' && 'is-dormant')}
      style={{ ['--tone' as string]: tone, ['--lane' as string]: lane.tone, ['--i' as string]: Math.min(index, 8) }}
      onClick={onOpen}
    >
      <span className="plc-card__glow" aria-hidden="true" />
      <span className="plc-card__top">
        <span className="plc-stage"><i />S{card.stageIndex ?? '–'}<em>{card.stageLabel}</em></span>
        {card.hot ? <span className="plc-hot"><Icon name="zap" />Hot</span> : null}
        <span className="plc-card__age">{card.daysInStage !== null ? `${card.daysInStage}d in stage` : ''}</span>
      </span>
      <span className="plc-card__title">{card.address || card.seller || 'Unaddressed deal'}</span>
      <span className="plc-card__sub">{[card.address ? card.seller : null, card.market, card.propertyType].filter(Boolean).join(' · ')}</span>
      <span className="plc-card__lane">
        <span className="plc-card__lane-dot" aria-hidden="true" />
        <b>{card.lane.label}</b>
        {card.lane.detail ? <span>{card.lane.detail}</span> : null}
        {card.lane.since ? <em>{relTime(card.lane.since)}</em> : null}
      </span>
      {figures.length ? (
        <span className="plc-card__figures">
          {figures.map(([k, v]) => <span key={k}><small>{k}</small><b>{v}</b></span>)}
        </span>
      ) : null}
      {card.lastMessage && card.lastDirection === 'inbound' && card.lane.key !== 'dormant' ? (
        <span className="plc-card__quote">“{card.lastMessage}”</span>
      ) : null}
      {card.stall ? <span className="plc-card__stall"><Icon name="clock" />{card.stall.label}</span> : null}
    </button>
  )
}

function FilterSheet({ params, sort, onClose, onApply }: {
  params: PipelineCommandParams
  sort: string
  onClose: () => void
  onApply: (next: PipelineCommandParams, sort: string) => void
}) {
  const [draft, setDraft] = useState<PipelineCommandParams>(params)
  const [draftSort, setDraftSort] = useState(sort)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const scopes: Array<{ key: NonNullable<PipelineCommandParams['scope']>; label: string }> = [
    { key: 'active', label: 'Live' },
    { key: 'closed', label: 'Closed / archived' },
    { key: 'dead', label: 'Dead' },
    { key: 'suppressed', label: 'Suppressed' },
    { key: 'all', label: 'Everything' },
  ]
  const temps = ['hot', 'warm', 'cold']
  return (
    <div className="plc-sheet" role="dialog" aria-modal="true" aria-label="Filter pipeline">
      <button type="button" className="plc-sheet__scrim" aria-label="Close filters" onClick={onClose} />
      <div className="plc-sheet__panel">
        <div className="plc-sheet__grip" aria-hidden="true" />
        <header><b>Filter</b><button type="button" className="plc-icon" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>
        <section>
          <h4>Scope</h4>
          <div className="plc-seg">
            {scopes.map((s) => <button key={s.key} type="button" className={cls(draft.scope === s.key && 'is-on')} onClick={() => setDraft((d) => ({ ...d, scope: s.key }))}>{s.label}</button>)}
          </div>
        </section>
        <section>
          <h4>Seller heat</h4>
          <div className="plc-seg">
            <button type="button" className={cls(!draft.temperature && 'is-on')} onClick={() => setDraft((d) => ({ ...d, temperature: undefined }))}>Any</button>
            {temps.map((t) => <button key={t} type="button" className={cls(draft.temperature === t && 'is-on')} onClick={() => setDraft((d) => ({ ...d, temperature: t }))}>{t[0].toUpperCase() + t.slice(1)}</button>)}
          </div>
        </section>
        <section className="plc-sheet__fields">
          <label><span>Market</span><input value={draft.market ?? ''} onChange={(e) => setDraft((d) => ({ ...d, market: e.target.value || undefined }))} placeholder="Houston, TX" /></label>
          <label><span>Property type</span><input value={draft.property_type ?? ''} onChange={(e) => setDraft((d) => ({ ...d, property_type: e.target.value || undefined }))} placeholder="Single Family" /></label>
        </section>
        <section>
          <h4>Sort</h4>
          <div className="plc-seg is-wrap">
            {SORTS.map((s) => <button key={s.key || 'smart'} type="button" className={cls(draftSort === s.key && 'is-on')} onClick={() => setDraftSort(s.key)}>{s.label}</button>)}
          </div>
        </section>
        <footer>
          <button type="button" className="plc-btn is-ghost" onClick={() => { setDraft({ scope: 'active' }); setDraftSort('') }}>Reset</button>
          <button type="button" className="plc-btn is-primary" onClick={() => onApply(draft, draftSort)}>Apply</button>
        </footer>
      </div>
    </div>
  )
}
