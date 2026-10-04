/**
 * PIPELINE · DESKTOP 2 — the pipeline itself is alive.
 *
 *   Overview  the S1–S10 river (live deals, $ value, entering / leaving in the
 *             period, system vs human, aging, one pulse per real movement),
 *             the machine's activity, whose move it is, and the offer picture
 *   Flow      every live deal by stage × age-in-stage, coloured by owner
 *   Table     every deal in the shared data grid
 *   Offers    autonomous · system resolving · exception · not being worked
 *
 * Desktop only — phones keep the mobile command center untouched. Pane-ready:
 * one scroll root, container queries, no window-level keys. Selecting a deal
 * publishes the property locator so linked panes can follow. Read-only: every
 * judgement is the server's; nothing here moves a stage or sends anything.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { LCChip, LCIconButton, LCLive, LCPopover, LCSearch, LCSegmented, LCSelect, LCTabs, cx, type LCRowActivationEvent, type LCTabItem } from '../../../shared/lc'
import { PaneRouteContext } from '../../../app/router'
import { gestureOf, inspectObject, openObjectBeside, showOnMap } from '../../../modules/desktop/objects'
import { deskDealObject, deskPropertyObject } from './desk-objects'
import { setPropertyLocator, type PropertyLocator } from '../../../domain/locator/property-locator'
import type { LinkedApplyContext } from '../../../domain/locator/linked-property-bus'
import { useLinkedProperty } from '../../../modules/desktop/workspace/linked-property'
import { LinkedNotice } from '../../../modules/desktop/workspace/LinkedNotice'
import { fetchOpportunityRefs, resolvePipelineItem } from './pipeline-linked'
import { sound } from '../../../shared/sound'
import type { PipelineCommandParams } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskCard, DeskMove } from './pipeline-desk-api'
import { OWNER_META, PERIODS, STAGE_CODES, STAGE_SHORT_LABEL, type LiveOwner, type RiverLens } from './pipeline-desk-model'
import { useDeskFlow, useDeskOffers, useDeskOverview, useDeskRows, useLiveTick, useMovedToday, useNowTick, usePersistedChoice } from './use-pipeline-desk'
import { DeskRiver } from './DeskRiver'
import { DeskRail } from './DeskRail'
import { MovingNowPlane, OffersStrip, OwnershipPlane } from './DeskPlanes'
import { DeskFlowMatrix } from './DeskFlow'
import { DeskTable } from './DeskTable'
import { DeskOffersView, type OfferActions } from './DeskOffers'
import { DeskInspector, type InspectorActions } from './DeskInspector'
import { openFromPipeline, type PipelineTarget } from './pipeline-open'
import { clearReturnState, peekReturnState, saveReturnState, type PipelineReturnState } from './pipeline-return'
import './pipeline-desk.css'

type Mode = 'overview' | 'flow' | 'table' | 'offers'
const MODES: ReadonlyArray<LCTabItem<Mode>> = [
  { id: 'overview', label: 'Overview', icon: 'stats' },
  { id: 'flow', label: 'Flow', icon: 'activity' },
  { id: 'table', label: 'Table', icon: 'list' },
  { id: 'offers', label: 'Offers', icon: 'dollar-sign' },
]
const MODE_KEY = 'nexus.pipeline.desktop.mode'
const isMode = (v: unknown): v is Mode => v === 'overview' || v === 'flow' || v === 'table' || v === 'offers'

function readMode(location?: string | null): Mode {
  try {
    const search = typeof location === 'string' ? (location.includes('?') ? location.slice(location.indexOf('?')) : '') : window.location.search
    const fromUrl = new URLSearchParams(search).get('pv')
    if (fromUrl === 'board') return 'flow'
    if (isMode(fromUrl)) return fromUrl
    const stored = window.localStorage.getItem(MODE_KEY)
    if (stored === 'board') return 'flow'
    if (isMode(stored)) return stored
  } catch { /* private mode */ }
  return 'overview'
}

function writeUrlParam(name: string, value: string | null) {
  try {
    const url = new URL(window.location.href)
    if (value) url.searchParams.set(name, value)
    else url.searchParams.delete(name)
    window.history.replaceState(window.history.state, '', url.toString())
  } catch { /* ignore */ }
}

const SCOPES: ReadonlyArray<{ value: NonNullable<PipelineCommandParams['scope']>; label: string }> = [
  { value: 'active', label: 'Live' },
  { value: 'closed', label: 'Closed' },
  { value: 'dead', label: 'Dead' },
  { value: 'suppressed', label: 'Suppressed' },
  { value: 'all', label: 'All' },
]
const HEAT: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'any', label: 'Any heat' },
  { value: 'hot', label: 'Hot' },
  { value: 'warm', label: 'Warm' },
  { value: 'cold', label: 'Cold' },
]

/**
 * Cross-app opens no longer go through the hosting InboxPage's callbacks —
 * those switched the host's own views (the trap; see ./pipeline-open).
 */
export function PipelineDesk() {
  const pane = useContext(PaneRouteContext)
  const ownsUrl = !pane
  // The exact Pipeline the operator left, when a cross-app open had to take
  // this pane (./pipeline-return). Read once; cleared after mount.
  const [back] = useState<PipelineReturnState | null>(() => peekReturnState())
  useEffect(() => { if (back) clearReturnState() }, [back])
  const [mode, setMode] = useState<Mode>(() => back?.mode ?? readMode(pane ? pane.location : undefined))
  const [period, setPeriod] = usePersistedChoice('nexus.pipeline.desk.period', ['24h', '7d', '30d'] as const, '7d')
  const [lens, setLens] = usePersistedChoice<RiverLens>('nexus.pipeline.desk.lens', ['stage', 'owner', 'age'] as const, 'owner')
  const [params, setParams] = useState<PipelineCommandParams>(() => back?.params ?? { scope: 'active' })
  const [query, setQuery] = useState(() => back?.query ?? '')
  const [owner, setOwner] = useState<LiveOwner | null>(() => back?.owner ?? null)
  const [stage, setStage] = useState<string | null>(() => back?.stage ?? null)
  const [showDormant, setShowDormant] = useState(() => back?.showDormant ?? false)
  const [open, setOpen] = useState<{ id: string; seed: DeskCard | null } | null>(() => {
    if (back?.openId) return { id: back.openId, seed: null }
    if (pane) return null
    try {
      const id = new URLSearchParams(window.location.search).get('opp')
      return id ? { id, seed: null } : null
    } catch { return null }
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  /** linked context found no deal for the property (a quiet line, nothing created) */
  const [linkedMiss, setLinkedMiss] = useState<{ subject: string | null } | null>(null)

  // Server-side search, debounced (the timeout callback sets state, not the effect).
  useEffect(() => {
    const t = window.setTimeout(() => setParams((p) => (p.q === (query.trim() || undefined) ? p : { ...p, q: query.trim() || undefined })), 320)
    return () => window.clearTimeout(t)
  }, [query])

  const tick = useLiveTick(true)
  const now = useNowTick(30_000)
  const overview = useDeskOverview(params, tick)
  const flow = useDeskFlow(params, period, tick)
  const rows = useDeskRows(params, tick)
  // The rail reads the offer picture in every mode, so it stays one truth.
  const offers = useDeskOffers(params, true, tick)
  const movedToday = useMovedToday(flow.data, now)

  // DEV-only QA seam: replay SAMPLE movement through the river so the one-shot
  // pulse can be verified visually. Never present in production builds; a real
  // arrival always wins over a replayed one.
  const [qa, setQa] = useState<{ moves: DeskMove[]; at: number } | null>(null)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onQa = (e: Event) => {
      const moves = (e as CustomEvent<DeskMove[]>).detail
      if (Array.isArray(moves)) setQa({ moves, at: Date.now() })
    }
    window.addEventListener('pd2:qa-arrivals', onQa)
    return () => window.removeEventListener('pd2:qa-arrivals', onQa)
  }, [])
  const replay = qa && (!flow.arrivedAt || qa.at > flow.arrivedAt) ? qa : null
  const arrivals = replay ? replay.moves : flow.arrivals
  const arrivedAt = replay ? replay.at : flow.arrivedAt
  const periodMeta = PERIODS.find((p) => p.value === period) ?? PERIODS[1]

  const pickMode = useCallback((next: Mode) => {
    sound.ui.select()
    setMode(next)
    try { window.localStorage.setItem(MODE_KEY, next) } catch { /* private mode */ }
    if (ownsUrl) writeUrlParam('pv', next === 'overview' ? null : next)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [ownsUrl])

  const isOpen = Boolean(open)
  // [8.2] the object click grammar for every deal surface (beads, table, planes):
  // click opens the deal here · ⇧-click inspects it · ⌘/Ctrl-click opens its property beside
  const openDeal = useCallback((card: DeskCard | { id: string }, e?: LCRowActivationEvent) => {
    const seed = 'owner' in card ? card : (rows.data?.find((c) => c.id === card.id) ?? null)
    const g = gestureOf(e)
    if (g !== 'activate') {
      const deal = deskDealObject(seed ?? { id: card.id })
      const target = g === 'beside' && seed?.propertyId ? deskPropertyObject(seed) : deal
      if ((g === 'inspect' ? inspectObject(deal) : openObjectBeside(target)).ok) return
    }
    if (isOpen) sound.ui.select()
    else sound.panel.open()
    setOpen({ id: card.id, seed })
    setLinkedMiss(null)
    if (ownsUrl) writeUrlParam('opp', card.id)
    // Linked panes follow the deal the operator is looking at.
    if (seed) setPropertyLocator({ propertyId: seed.propertyId, threadKey: seed.threadKey, masterOwnerId: seed.masterOwnerId, opportunityId: seed.id, address: seed.address })
    else setPropertyLocator({ opportunityId: card.id })
  }, [isOpen, ownsUrl, rows.data])
  const closeDeal = useCallback(() => {
    sound.panel.close()
    setOpen(null)
    if (ownsUrl) writeUrlParam('opp', null)
  }, [ownsUrl])

  // LINKED CONTEXT — a property selected in another open app opens ITS deal
  // here (read-only; silent; never publishes back). No deal: a quiet line.
  const rowsRef = useRef(rows.data)
  useEffect(() => { rowsRef.current = rows.data }, [rows.data])
  const followLinked = useCallback((loc: PropertyLocator, ctx: LinkedApplyContext) => {
    void resolvePipelineItem(loc, { rows: rowsRef.current ?? null, fetchOpportunities: fetchOpportunityRefs }, ctx.signal).then((r) => {
      ctx.apply(() => {
        if (r.kind === 'open') {
          setLinkedMiss(null)
          setOpen({ id: r.id, seed: r.seed })
          if (ownsUrl) writeUrlParam('opp', r.id)
        } else if (r.kind === 'none') {
          setOpen(null)
          if (ownsUrl) writeUrlParam('opp', null)
          setLinkedMiss({ subject: loc.address })
        }
      })
    }, () => { /* a failed or cancelled lookup changes nothing */ })
  }, [ownsUrl])
  useLinkedProperty(followLinked)
  const openById = useCallback((id: string, e?: LCRowActivationEvent) => openDeal({ id }, e), [openDeal])

  // Choosing an owner anywhere on the Overview opens those deals in the Table.
  const goOwner = useCallback((o: LiveOwner | null) => {
    setOwner(o)
    if (o && mode === 'overview') pickMode('table')
  }, [mode, pickMode])
  const pickStage = useCallback((code: string) => {
    setStage(code)
    pickMode('flow')
  }, [pickMode])

  // Everything a Back must bring back, read at the moment Pipeline leaves.
  const stateRef = useRef({ mode, params, query, owner, stage, showDormant, openId: open?.id ?? null })
  useEffect(() => { stateRef.current = { mode, params, query, owner, stage, showDormant, openId: open?.id ?? null } })
  const saveReturn = useCallback(() => {
    const root = scrollRef.current
    const grid = root?.querySelector<HTMLElement>('.lc-grid__scroller') ?? null
    saveReturnState({ ...stateRef.current, scrollTop: root?.scrollTop ?? 0, gridScrollTop: grid?.scrollTop ?? 0 })
  }, [])

  /** Open Beside: the target app beside Pipeline, aimed at the deal; Pipeline stays put. */
  const openIn = useCallback((target: PipelineTarget, card: DeskCard) => {
    openFromPipeline(target, card, { saveReturn })
  }, [saveReturn])
  const toDealIntelligence = useCallback((card: DeskCard) => openIn('deal_intelligence', card), [openIn])

  const actions = useMemo<InspectorActions>(() => ({
    onConversation: (card) => openIn('conversation', card),
    onDealIntelligence: toDealIntelligence,
    // [8.2] Show on Map without leaving Pipeline (an open Map focuses in place; a closed one opens beside)
    onMap: (card) => { if (card.propertyId) showOnMap(deskPropertyObject(card), { source: 'pipeline' }) },
    onEntityGraph: (card) => openIn('entity_graph', card),
    onBuyerMatch: (card) => openIn('buyer_match', card),
    onComps: (card) => openIn('comps', card),
    onClosingDesk: (card) => openIn('closing', card),
  }), [openIn, toDealIntelligence])
  const offerActions = useMemo<OfferActions>(() => ({
    onOpen: openDeal,
    onDealIntelligence: toDealIntelligence,
    onConversation: actions.onConversation,
    onMap: actions.onMap,
  }), [openDeal, toDealIntelligence, actions])

  const markets = useMemo(() => [...new Set((rows.data ?? []).map((c) => c.market).filter((m): m is string => Boolean(m)))].sort(), [rows.data])
  const types = useMemo(() => [...new Set((rows.data ?? []).map((c) => c.propertyType).filter((m): m is string => Boolean(m)))].sort(), [rows.data])
  const filterCount = (params.scope && params.scope !== 'active' ? 1 : 0) + (params.market ? 1 : 0) + (params.property_type ? 1 : 0) + (params.temperature ? 1 : 0)

  const ready = Boolean(overview.data)
    && (mode !== 'overview' || Boolean(flow.data))
    && (mode !== 'offers' || Boolean(offers.data))
    && (!(mode === 'flow' || mode === 'table') || Boolean(rows.data))

  // Restore the scroll position the operator left, once the view has rows.
  const [restoredScroll, setRestoredScroll] = useState(!back || (!back.scrollTop && !back.gridScrollTop))
  useEffect(() => {
    if (restoredScroll || !ready) return
    const id = window.requestAnimationFrame(() => {
      const root = scrollRef.current
      if (root && back) {
        root.scrollTop = back.scrollTop
        const grid = root.querySelector<HTMLElement>('.lc-grid__scroller')
        if (grid) grid.scrollTop = back.gridScrollTop
      }
      setRestoredScroll(true)
    })
    return () => window.cancelAnimationFrame(id)
  })

  const chips = [
    owner ? { id: 'owner', field: 'Whose move', value: OWNER_META[owner].label, onRemove: () => setOwner(null) } : null,
    stage ? { id: 'stage', field: 'Stage', value: `S${STAGE_CODES.indexOf(stage as typeof STAGE_CODES[number]) + 1} · ${STAGE_SHORT_LABEL[stage] ?? stage}`, onRemove: () => setStage(null) } : null,
    params.market ? { id: 'market', field: 'Market', value: params.market, onRemove: () => setParams((p) => ({ ...p, market: undefined })) } : null,
    params.property_type ? { id: 'type', field: 'Type', value: params.property_type, onRemove: () => setParams((p) => ({ ...p, property_type: undefined })) } : null,
    params.temperature ? { id: 'heat', field: 'Heat', value: params.temperature, onRemove: () => setParams((p) => ({ ...p, temperature: undefined })) } : null,
    params.scope && params.scope !== 'active' ? { id: 'scope', field: 'Scope', value: SCOPES.find((s) => s.value === params.scope)?.label ?? params.scope, onRemove: () => setParams((p) => ({ ...p, scope: 'active' })) } : null,
  ].filter((c): c is NonNullable<typeof c> => Boolean(c))
  const showChips = chips.filter((c) => mode !== 'overview' || !['owner', 'stage'].includes(c.id))

  return (
    <section className={cx('pd2', `is-${mode}`)} data-ready={ready ? '1' : '0'} data-mode={mode} aria-label="Pipeline">
      <div className="pd2-field" aria-hidden="true"><i /><i /></div>

      <header className="pd2-head">
        <div className="pd2-head__row">
          <div className="pd2-head__id">
            <h1 className="pd2-head__title">Pipeline</h1>
            <LCLive live={!overview.error} stale={Boolean(overview.error && overview.data)} updatedAt={overview.at} />
          </div>
          <LCTabs items={MODES} value={mode} onChange={pickMode} label="Pipeline mode" className="pd2-head__modes" />
          <div className="pd2-head__tools">
            <LCSegmented options={PERIODS.map((p) => ({ value: p.value, label: p.label, title: `Movement over the ${p.long}` }))} value={period} onChange={(v) => { sound.ui.select(); setPeriod(v) }} label="Movement period" size="sm" />
            <LCSearch value={query} onChange={setQuery} label="Search pipeline" placeholder="Address, seller, phone, market" loading={Boolean(params.q) && overview.loading} className="pd2-head__search" />
            <LCPopover
              trigger={<LCIconButton icon="filter" label={filterCount ? `Filters · ${filterCount} on` : 'Filters'} dot={filterCount ? 'exec' : null} variant="glass" />}
              align="end"
              width={320}
              label="Pipeline filters"
            >
              <div className="pd2-filters">
                <span className="lc-eyebrow">Scope</span>
                <LCSegmented options={SCOPES} value={params.scope ?? 'active'} onChange={(v) => { sound.ui.select(); setParams((p) => ({ ...p, scope: v })) }} label="Scope" size="sm" />
                <span className="lc-eyebrow">Seller heat</span>
                <LCSegmented options={HEAT} value={params.temperature ?? 'any'} onChange={(v) => { sound.ui.select(); setParams((p) => ({ ...p, temperature: v === 'any' ? undefined : v })) }} label="Seller heat" size="sm" />
                <span className="lc-eyebrow">Market</span>
                <LCSelect value={params.market ?? '__any'} onChange={(v) => setParams((p) => ({ ...p, market: v === '__any' ? undefined : v }))} options={[{ value: '__any', label: 'Every market' }, ...markets.map((m) => ({ value: m, label: m }))]} label="Market" variant="field" size="sm" />
                <span className="lc-eyebrow">Property type</span>
                <LCSelect value={params.property_type ?? '__any'} onChange={(v) => setParams((p) => ({ ...p, property_type: v === '__any' ? undefined : v }))} options={[{ value: '__any', label: 'Every type' }, ...types.map((m) => ({ value: m, label: m }))]} label="Property type" variant="field" size="sm" />
              </div>
            </LCPopover>
          </div>
        </div>
        <DeskRail overview={overview.data} flow={flow.data} offers={offers.data} periodLabel={periodMeta.label} onOwner={(o) => { setOwner(o); pickMode('table') }} onOffers={() => pickMode('offers')} />
        {linkedMiss ? <LinkedNotice text="No pipeline item for this property" subject={linkedMiss.subject} onDismiss={() => setLinkedMiss(null)} /> : null}
        {showChips.length ? (
          <div className="pd2-chips" aria-label="Active filters">
            {showChips.map((c) => <LCChip key={c.id} field={c.field} value={c.value} onRemove={c.onRemove} />)}
          </div>
        ) : null}
      </header>

      <div className={cx('pd2-scroll', mode === 'table' && 'is-fill')} ref={scrollRef} data-pd2-scroll>
        {mode === 'overview' ? (
          <div className="pd2-overview">
            <DeskRiver
              stages={overview.data?.stages ?? null}
              flows={flow.data?.stages ?? null}
              periodLabel={periodMeta.long}
              lens={lens}
              onLens={(l) => { sound.ui.select(); setLens(l) }}
              arrivals={arrivals}
              arrivedAt={arrivedAt}
              selectedStage={stage}
              onPickStage={pickStage}
              dimmed={overview.stale}
            />
            <div className="pd2-planes">
              <MovingNowPlane flow={flow.data} loading={flow.loading} error={flow.error} onRetry={flow.retry} periodLong={periodMeta.long} onOpenDeal={openById} liveAt={flow.at} now={now} />
              <OwnershipPlane overview={overview.data} rows={rows.data} movedToday={flow.data ? movedToday.size : null} owner={owner} onOwner={goOwner} onOpenDeal={openDeal} now={now} />
            </div>
            <OffersStrip offers={offers.data} error={offers.error} onRetry={offers.retry} onOpenOffers={() => pickMode('offers')} />
            {overview.data?.excluded?.synthetic ? (
              <p className="pd2-foot">{overview.data.excluded.synthetic} test fixture deal{overview.data.excluded.synthetic === 1 ? '' : 's'} (canary properties) excluded from every count.</p>
            ) : null}
          </div>
        ) : null}

        {mode === 'flow' ? (
          <DeskFlowMatrix
            rows={rows.data}
            loading={rows.loading}
            error={rows.error}
            onRetry={rows.retry}
            stages={overview.data?.stages ?? null}
            flows={flow.data?.stages ?? null}
            periodLabel={periodMeta.label}
            owner={owner}
            onOwner={setOwner}
            stage={stage}
            onStage={setStage}
            showDormant={showDormant}
            onShowDormant={setShowDormant}
            selectedId={open?.id ?? null}
            onOpen={openDeal}
            now={now}
          />
        ) : null}

        {mode === 'table' ? (
          <DeskTable rows={rows.data} loading={rows.loading} error={rows.error} onRetry={rows.retry} owner={owner} stage={stage} showDormant={showDormant || Boolean(owner)} onShowDormant={setShowDormant} selectedId={open?.id ?? null} onOpen={openDeal} now={now} total={rows.total} onBulkChanged={rows.retry} offers={offers.data} />
        ) : null}

        {mode === 'offers' ? (
          <DeskOffersView offers={offers.data} loading={offers.loading} error={offers.error} onRetry={offers.retry} actions={offerActions} now={now} onBulkChanged={() => { offers.retry(); rows.retry() }} />
        ) : null}
      </div>

      <DeskInspector id={open?.id ?? null} seed={open?.seed ?? null} onClose={closeDeal} actions={actions} now={now} />
    </section>
  )
}
