import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import type { CampaignModel, CampaignSummary } from '../campaigns.types'
import { getDetailActions } from '../campaign-health'
import { CampaignConfirmSheet, confirmSpecFor, type ConfirmSpec } from '../mobile/CampaignConfirmSheet'
import { fetchCampaignCockpit, fetchCohortPoints, fetchMarketIndex, type CockpitRead, type CockpitTargetRow, type MarketIndex } from './cockpit-api'
import {
  DEFAULT_FILTERS, NAV_GROUPS, attentionFor, bookSummary, execState, matchesNav, navGroupOf, navRow, nf,
  type NavFilters, type NavGroup,
} from './cockpit-model'
import { CockpitNav, type NavSection } from './CockpitNav'
import { CockpitRoom, type HeaderAction, type RoomMode } from './CockpitRoom'
import { CockpitInspector, type InspectorContext, type InspectorTab } from './CockpitInspector'
import { DEFAULT_TARGET_FILTER, type TargetFilter } from './CockpitTargets'
import { cls } from './cockpit-ui'
import './campaign-cockpit.css'

/**
 * CAMPAIGN COMMAND — DESKTOP 2.0: the live execution cockpit.
 *
 * Desktop only (rendered when the modern product runs on a wide screen); the
 * phone keeps its own index and detail untouched. Three planes: campaign
 * navigation, the operating room for one campaign, and a contextual
 * inspector. Every number comes from the campaign list or the campaign's one
 * bounded cockpit read; every action goes through the existing campaign
 * action path (executeCampaignAction), confirmed exactly as the phone does.
 */

const UI_KEY = 'nexus.cpk.ui.v1'
const POLL_COCKPIT_MS = 30_000
const POLL_LIST_MS = 45_000
const COCKPIT_FRESH_MS = 25_000
const INSP_MIN = 300
const INSP_MAX = 520

type UiState = { filters: NavFilters; mode: RoomMode; tab: InspectorTab; inspOpen: boolean; inspWidth: number }

function readUi(): UiState {
  const base: UiState = { filters: DEFAULT_FILTERS, mode: 'overview', tab: 'overview', inspOpen: true, inspWidth: 360 }
  try {
    const raw = sessionStorage.getItem(UI_KEY)
    if (!raw) return base
    const v = JSON.parse(raw) as Partial<UiState>
    return {
      filters: { ...DEFAULT_FILTERS, ...(v.filters ?? {}) },
      mode: v.mode === 'targets' || v.mode === 'activity' ? v.mode : 'overview',
      tab: (['overview', 'audience', 'channels', 'sequence', 'performance', 'technical'] as InspectorTab[]).includes(v.tab as InspectorTab) ? v.tab as InspectorTab : 'overview',
      inspOpen: v.inspOpen !== false,
      inspWidth: Math.min(INSP_MAX, Math.max(INSP_MIN, Number(v.inspWidth) || 360)),
    }
  } catch {
    return base
  }
}

const ACTION_LABEL: Record<string, string> = {
  convert_to_live: 'Convert to live…',
  queue_batch_live: 'Send live batch…',
  queue_batch: 'Queue next batch…',
  review_blockers: 'Review blockers',
  build_targets: 'Build audience',
  activate: 'Launch now…',
  resume: 'Resume',
  pause: 'Pause',
  schedule: 'Schedule',
  reschedule: 'Reschedule',
  archive: 'Archive',
  restore: 'Restore',
  duplicate: 'Duplicate',
  edit: 'Setup',
  sync_metrics: 'Recalculate numbers',
  refresh: 'Reload',
}

/** The header's one visible action; everything else lives in More. */
const PRIMARY_ORDER = ['resume', 'pause', 'schedule', 'reschedule', 'build_targets', 'restore', 'duplicate']

function headerActions(c: CampaignSummary): { primary: HeaderAction | null; more: HeaderAction[] } {
  const defs = getDetailActions(c)
  const ids = defs.map((d) => d.id)
  const primaryId = PRIMARY_ORDER.find((id) => ids.includes(id)) ?? null
  const tone = (id: string): HeaderAction['tone'] => (id === 'archive' ? 'danger' : id === 'resume' || id === 'schedule' || id === 'build_targets' ? 'go' : 'neutral')
  const primary = primaryId ? { id: primaryId, label: ACTION_LABEL[primaryId] ?? primaryId, tone: tone(primaryId) } : null
  const more: HeaderAction[] = defs
    .filter((d) => d.id !== primaryId)
    .map((d) => ({ id: d.id, label: ACTION_LABEL[d.id] ?? d.label, tone: tone(d.id) }))
  more.push({ id: 'edit', label: ACTION_LABEL.edit }, { id: 'sync_metrics', label: ACTION_LABEL.sync_metrics }, { id: 'refresh', label: ACTION_LABEL.refresh })
  return { primary, more }
}

function readInitialCampaign(): string | null {
  try { return new URLSearchParams(window.location.search).get('campaign')?.trim() || null } catch { return null }
}

function writeCampaignUrl(id: string | null) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('campaign', id)
  else url.searchParams.delete('campaign')
  url.searchParams.delete('section')
  const next = `${url.pathname}${url.search}${url.hash}`
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, '', next)
  }
}

const isTyping = (el: EventTarget | null) => {
  const node = el as HTMLElement | null
  if (!node) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable
}

export function CampaignCockpit({
  model, loading, failed, onRetry, onRefresh, onNew, onAction, focusCampaignId = null,
}: {
  model: CampaignModel | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  onRefresh: () => void
  onNew: () => void
  onAction: (action: string, campaign: CampaignSummary, payload?: Record<string, unknown>) => Promise<unknown> | void
  /** Open this campaign when it appears (a campaign just created in the builder). */
  focusCampaignId?: string | null
}) {
  const initialUi = useMemo(readUi, [])
  const [filters, setFilters] = useState<NavFilters>(initialUi.filters)
  const [mode, setMode] = useState<RoomMode>(initialUi.mode)
  const [tab, setTab] = useState<InspectorTab>(initialUi.tab)
  const [inspOpen, setInspOpen] = useState(initialUi.inspOpen)
  const [inspWidth, setInspWidth] = useState(initialUi.inspWidth)
  const [activeId, setActiveId] = useState<string | null>(readInitialCampaign)
  const [cursorId, setCursorId] = useState<string | null>(null)
  const [context, setContext] = useState<InspectorContext>(null)
  const [targetFilter, setTargetFilter] = useState<TargetFilter>(DEFAULT_TARGET_FILTER)
  const [moreOpen, setMoreOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<{ action: string; campaign: CampaignSummary; spec: ConfirmSpec } | null>(null)
  const [mapState, setMapState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null })
  const [navOpen, setNavOpen] = useState(false)
  const [paneW, setPaneW] = useState(1440)
  const rootRef = useRef<HTMLDivElement>(null)

  // ── persisted UI (filters, mode, tab, inspector) across switches & visits ─
  useEffect(() => {
    try { sessionStorage.setItem(UI_KEY, JSON.stringify({ filters, mode, tab, inspOpen, inspWidth })) } catch { /* private mode */ }
  }, [filters, mode, tab, inspOpen, inspWidth])

  // ── the pane's width decides the composition (split panes are narrow) ────
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => setPaneW(Math.round(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Docked inspector only when the room keeps ~720px beside the navigation
  // and the inspector (≈1728px screens and up, or a collapsed sidebar);
  // below that the inspector is an overlay.
  const wide = paneW >= 1420
  const medium = paneW >= 860 && !wide
  const narrow = paneW < 860
  // The overlay inspector starts closed each visit; the docked one remembers.
  const [overlayOpen, setOverlayOpen] = useState(false)
  const inspVisible = wide ? inspOpen : overlayOpen
  const setInspVisible = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    if (wide) setInspOpen(v)
    else setOverlayOpen(v)
  }, [wide])

  // ── cockpit reads: one per selected campaign, cached, polled while visible ─
  const cache = useRef(new Map<string, { at: number; data: CockpitRead }>())
  const [cacheTick, setCacheTick] = useState(0)
  const [kLoading, setKLoading] = useState(false)
  const [kError, setKError] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)

  const loadCockpit = useCallback(async (id: string, force = false) => {
    const hit = cache.current.get(id)
    if (!force && hit && Date.now() - hit.at < COCKPIT_FRESH_MS) return
    inflight.current?.abort()
    const ctl = new AbortController()
    inflight.current = ctl
    setKLoading(true)
    setKError(null)
    try {
      const data = await fetchCampaignCockpit(id, ctl.signal)
      cache.current.set(id, { at: Date.now(), data })
      setCacheTick((n) => n + 1)
    } catch (err) {
      if (!ctl.signal.aborted) setKError(err instanceof Error ? err.message : 'unavailable')
    } finally {
      if (inflight.current === ctl) {
        inflight.current = null
        setKLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!activeId) return
    void loadCockpit(activeId)
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCockpit(activeId, true)
    }, POLL_COCKPIT_MS)
    return () => window.clearInterval(id)
  }, [activeId, loadCockpit])

  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') onRefresh() }, POLL_LIST_MS)
    return () => window.clearInterval(id)
  }, [onRefresh])

  // ── markets, once, for the filter and search (never from names) ─────────
  const [marketIndex, setMarketIndex] = useState<MarketIndex | null>(null)
  const [marketsLoading, setMarketsLoading] = useState(true)
  useEffect(() => {
    const ctl = new AbortController()
    fetchMarketIndex(ctl.signal)
      .then((m) => setMarketIndex(m))
      .catch(() => { /* the filter says so; nothing is guessed */ })
      .finally(() => { if (!ctl.signal.aborted) setMarketsLoading(false) })
    return () => ctl.abort()
  }, [])

  const campaigns = useMemo(() => model?.campaigns ?? [], [model])
  const cockpitOf = useCallback((id: string) => cache.current.get(id)?.data ?? null, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const k = useMemo(() => (activeId ? cockpitOf(activeId) : null), [activeId, cacheTick, cockpitOf])

  const marketsOf = useCallback((c: CampaignSummary): string[] => {
    const fromIndex = marketIndex?.campaigns[c.id]?.top.map((m) => m.market) ?? []
    const fromCockpit = cache.current.get(c.id)?.data.geography?.markets.map((m) => m.market ?? '').filter(Boolean) ?? []
    return [...new Set([...fromIndex, ...fromCockpit, ...(c.lineage?.market_values ?? [])])]
  }, [marketIndex])

  // ── navigation model ─────────────────────────────────────────────────────
  const { sections, groups, flat } = useMemo(() => {
    const now = Date.now()
    const groupMap = new Map<string, NavGroup>()
    const bucket = new Map<NavGroup, ReturnType<typeof navRow>[]>()
    for (const c of campaigns) {
      const kc = cache.current.get(c.id)?.data ?? null
      const group = navGroupOf(c, kc, now)
      groupMap.set(c.id, group)
      if (!matchesNav(c, filters, { group, markets: marketsOf(c) })) continue
      const row = navRow(c, kc, now)
      const list = bucket.get(group) ?? []
      list.push(row)
      bucket.set(group, list)
    }
    const needs = bucket.get('needs_you')
    if (needs) needs.sort((a, b) => (a.state.key === b.state.key ? 0 : a.state.key === 'degraded' ? -1 : b.state.key === 'degraded' ? 1 : 0))
    const out: NavSection[] = NAV_GROUPS.map((g) => ({ key: g.key, label: g.label, rows: bucket.get(g.key) ?? [] }))
    return { sections: out, groups: groupMap, flat: out.flatMap((s) => s.rows.map((r) => r.id)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns, filters, marketsOf, cacheTick])

  const summary = useMemo(() => bookSummary(campaigns, groups), [campaigns, groups])

  // Pick a campaign when none is chosen: what needs you, else what is running.
  useEffect(() => {
    if (!campaigns.length) return
    if (activeId && campaigns.some((c) => c.id === activeId)) return
    const first = flat[0] ?? campaigns[0]?.id ?? null
    setActiveId(first)
  }, [campaigns, activeId, flat])

  useEffect(() => { writeCampaignUrl(activeId) }, [activeId])

  useEffect(() => {
    if (focusCampaignId && campaigns.some((c) => c.id === focusCampaignId)) {
      setActiveId(focusCampaignId)
      setCursorId(focusCampaignId)
      setContext(null)
    }
  }, [focusCampaignId, campaigns])

  const active = useMemo(() => campaigns.find((c) => c.id === activeId) ?? null, [campaigns, activeId])

  const select = useCallback((id: string) => {
    setActiveId(id)
    setCursorId(id)
    setContext(null)
    setMoreOpen(false)
    setTargetFilter(DEFAULT_TARGET_FILTER)
    if (narrow) setNavOpen(false)
  }, [narrow])

  // ── keyboard: ↑/↓ move, Enter opens, Esc steps back ─────────────────────
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (e: KeyboardEvent) => {
      if (pending) return
      if (e.key === 'Escape') {
        if (moreOpen) { setMoreOpen(false); return }
        if (context) { setContext(null); return }
        if (navOpen) { setNavOpen(false); return }
        if (!wide && overlayOpen) { setOverlayOpen(false); return }
        return
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return
      if ((e.target as HTMLElement | null)?.closest?.('.cpk-table, .cpk-menu, .cpk-insp')) return
      if (!flat.length) return
      if (e.key === 'Enter') {
        if (cursorId && cursorId !== activeId) { e.preventDefault(); select(cursorId) }
        return
      }
      e.preventDefault()
      const from = flat.indexOf(cursorId ?? activeId ?? '')
      const next = e.key === 'ArrowDown' ? Math.min(flat.length - 1, from + 1) : Math.max(0, from < 0 ? 0 : from - 1)
      setCursorId(flat[next])
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [flat, cursorId, activeId, select, pending, moreOpen, context, navOpen, wide, overlayOpen])

  // ── actions: existing paths only, confirmed like the phone ───────────────
  const run = useCallback(async (action: string, campaign: CampaignSummary, payload?: Record<string, unknown>) => {
    setBusy(action)
    try {
      await onAction(action, campaign, payload)
    } finally {
      setBusy(null)
      void loadCockpit(campaign.id, true)
    }
  }, [onAction, loadCockpit])

  const request = useCallback((action: string) => {
    if (!active) return
    setMoreOpen(false)
    if (action === 'view_targets') { setMode('targets'); setTargetFilter({ ...DEFAULT_TARGET_FILTER, status: 'planned' }); return }
    if (action === 'review_blockers' || action === 'inspector:audience') { setInspVisible(true); setContext(null); setTab('audience'); return }
    if (action === 'inspector:channels') { setInspVisible(true); setContext(null); setTab('channels'); return }
    if (action.startsWith('route:')) { pushRoutePath(action.slice('route:'.length)); return }
    if (action === 'refresh') { onRefresh(); void loadCockpit(active.id, true); return }
    const spec = confirmSpecFor(action, active)
    if (spec) setPending({ action, campaign: active, spec })
    else void run(action, active)
  }, [active, onRefresh, loadCockpit, run, setInspVisible])

  // ── the exact cohort on the Map (existing focus-set handoff) ────────────
  const viewOnMap = useCallback(async () => {
    if (!active) return
    setMapState({ busy: true, note: null })
    try {
      const cohort = await fetchCohortPoints(active.id)
      if (!cohort.points.length) {
        setMapState({ busy: false, note: 'None of these properties have map coordinates.' })
        return
      }
      const label = cohort.basis === 'source_cohort' ? `in ${active.campaign_name}` : `in ${active.campaign_name}’s audience`
      writeMapFocusSet({ label, tone: 'property', points: cohort.points.map((p) => ({ lat: p.lat, lng: p.lng, id: p.id, label: p.label })) })
      setMapState({ busy: false, note: null })
      pushRoutePath('/map')
    } catch {
      setMapState({ busy: false, note: 'The cohort couldn’t be loaded. Nothing was changed.' })
    }
  }, [active])

  const state = active ? execState(active, k) : null
  const attention = useMemo(() => (active ? attentionFor(active, k) : []), [active, k])
  const { primary, more } = active ? headerActions(active) : { primary: null, more: [] }

  const showInspector = Boolean(active) && inspVisible
  const inspectorOverlay = !wide
  const navAsDrawer = narrow

  return (
    <div
      ref={rootRef}
      className={cls('cpk', wide ? 'is-wide' : medium ? 'is-medium' : 'is-narrow', showInspector && !inspectorOverlay && 'has-insp', navAsDrawer && navOpen && 'is-nav-open')}
      style={{ ['--cpk-insp-w' as string]: `${inspWidth}px` }}
      tabIndex={-1}
    >
      <header className="cpk-top">
        <div className="cpk-top__title">
          <h1>Campaign Command</h1>
          <p>
            {model ? (
              <>
                <span>{nf(summary.active)} active</span>
                <span className={cls(summary.attention > 0 && 'is-warn')}>{nf(summary.attention)} {summary.attention === 1 ? 'needs' : 'need'} attention</span>
                <span>{nf(summary.remaining)} remaining</span>
              </>
            ) : loading ? <span>Loading campaigns…</span> : <span>Campaigns unavailable</span>}
          </p>
        </div>
        <label className="cpk-search">
          <Icon name="search" size={13} />
          <input
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
            placeholder="Search name, market, id, source, stage"
            aria-label="Search campaigns"
          />
          {filters.query ? <button type="button" className="cpk-search__x" aria-label="Clear search" onClick={() => setFilters({ ...filters, query: '' })}><Icon name="close" size={11} /></button> : null}
        </label>
        <button type="button" className="cpk-btn is-primary" onClick={onNew}>
          <Icon name="bolt" size={12} /> New campaign
        </button>
      </header>

      <div className="cpk-body">
        {navAsDrawer && navOpen ? <button type="button" className="cpk-scrim" aria-label="Close campaigns" onClick={() => setNavOpen(false)} /> : null}
        <div className={cls('cpk-nav-slot', navAsDrawer && 'is-drawer', navAsDrawer && navOpen && 'is-open')}>
          <CockpitNav
            sections={sections}
            total={campaigns.length}
            filters={filters}
            onFilters={setFilters}
            markets={(marketIndex?.markets ?? []).map((m) => m.market)}
            marketsLoading={marketsLoading}
            activeId={activeId}
            cursorId={cursorId}
            onSelect={select}
            loading={loading}
            failed={failed}
            onRetry={onRetry}
          />
        </div>

        {active && state ? (
          <CockpitRoom
            c={active}
            k={k}
            kLoading={kLoading && !k}
            kError={kError}
            state={state}
            attention={attention}
            mode={mode}
            onMode={setMode}
            primary={primary}
            more={more}
            busy={busy}
            onHeaderAction={request}
            onAttentionAction={request}
            moreOpen={moreOpen}
            setMoreOpen={setMoreOpen}
            inspOpen={showInspector}
            onToggleInspector={() => setInspVisible((v) => !v)}
            onOpenNav={() => setNavOpen(true)}
            showNavToggle={navAsDrawer}
            onViewMap={viewOnMap}
            mapState={mapState}
            targetFilter={targetFilter}
            onTargetFilter={setTargetFilter}
            selectedTargetId={context?.kind === 'target' ? context.row.id : null}
            onSelectTarget={(row: CockpitTargetRow) => { setContext({ kind: 'target', row }); setInspVisible(true) }}
          />
        ) : (
          <main className="cpk-room is-empty">
            {loading && !model ? <p className="cpk-muted">Loading campaigns…</p> : failed && !model ? (
              <div className="cpk-empty">
                <p>Campaigns couldn’t be loaded.</p>
                <button type="button" className="cpk-btn is-ghost" onClick={onRetry}>Try again</button>
              </div>
            ) : (
              <div className="cpk-empty">
                <p>{campaigns.length ? 'Select a campaign.' : 'No campaigns yet.'}</p>
                {!campaigns.length ? <button type="button" className="cpk-btn is-primary" onClick={onNew}>New campaign</button> : null}
              </div>
            )}
          </main>
        )}

        {showInspector && active ? (
          <>
            {inspectorOverlay ? <button type="button" className="cpk-scrim is-insp" aria-label="Close inspector" onClick={() => setInspVisible(false)} /> : null}
            <CockpitInspector
              c={active}
              k={k}
              kLoading={kLoading}
              tab={tab}
              onTab={setTab}
              context={context}
              onContext={setContext}
              width={inspWidth}
              onResize={(w) => setInspWidth(Math.min(INSP_MAX, Math.max(INSP_MIN, Math.round(w))))}
              onClose={() => { setInspVisible(false); setContext(null) }}
              onOpenTargets={() => setMode('targets')}
              overlay={inspectorOverlay}
            />
          </>
        ) : null}
      </div>

      {pending ? (
        <CampaignConfirmSheet
          spec={pending.spec}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { action, campaign } = pending
            setPending(null)
            // `confirmed` tells the action path this sheet already asked.
            void run(action, campaign, { confirmed: true })
          }}
        />
      ) : null}
    </div>
  )
}

export default CampaignCockpit
