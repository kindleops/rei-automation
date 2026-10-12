/**
 * ENTITY GRAPH · DESK — the relationship intelligence workspace for a desk.
 *
 * Not the phone surface stretched: a records workspace in three planes.
 *
 *   header     title, live summary, six exact KPIs, scope tabs, search,
 *              saved views, columns, Grid ↔ Graph
 *   rail       the campaign field catalog as filters (facets with every
 *              value, quick filters, any field)
 *   center     a dense windowed grid (sortable — whole-cohort server sort
 *              where an index exists, else the loaded rows, said so —
 *              resizable columns, keyboard, selection) or the relationship
 *              view of the selected network
 *   inspector  owner → properties → people/contacts (with the vendor
 *              matching tags) → title entities → debt/liens/transfers →
 *              related owners → conversations
 *
 * Layout follows the PANE (container queries on .egdk), so a split pane gets
 * a narrower composition: the rail folds behind a button and the inspector
 * floats. A selected property is the workspace's linked selection (the view
 * publishes it through the property locator); a property arriving from the
 * Map / Inbox / Deal Intelligence re-anchors the inspector.
 *
 * Phones never mount this (EntityGraphWorkspace routes isPhone to the
 * console), so the phone DOM is unchanged.
 */
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  LCBulkBar,
  LCButton,
  LCDataGrid,
  LCEmpty,
  LCIconButton,
  LCMenu,
  LCPopover,
  LCSearch,
  LCSegmented,
  LCTabs,
  cx,
  lcPrompt,
  lcToast,
  type LCColumn,
  type LCMenuEntry,
  type LCSort,
} from '../../../shared/lc'
import { useAuth } from '../../../components/auth/AuthProvider'
import { Icon } from '../../../shared/icons'
import { reorderColumnIds } from '../../../shared/lc/DataGrid'
import { fetchEntityGraphList, fetchEntityGraphTabCounts, EntityGraphFilterError } from '../../../domain/entity-graph/entity-graph-api'
import type { EntityGraphAction, EntityGraphListResponse, EntityGraphTabCounts, EntitySearchResult, UniversalEntityContext } from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT } from '../../../domain/entity-graph/universal-entity-context'
import { fieldFiltersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import type { EntityGraphFieldFilter, UnsupportedFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { PaneRouteContext, replaceRoutePath, useRouteLocation } from '../../../app/router'
import { BuyerInspectorSheet, type BuyerMapPoint } from '../buyer/BuyerInspector'
import { fetchEntityNetwork, type EntityNetwork } from '../console/entity-network-api'
import {
  COLUMN_GROUP_LABELS,
  COLUMN_GROUP_ORDER,
  IDENTITY_SORT_COLUMN,
  SCOPE_TABLE_COLUMNS,
  defaultVisibleColumns,
  visibleEnrichmentFields,
  type ColumnUnit,
  type HeaderSort,
  type TableColumn,
} from '../mobile/entity-graph-table-columns'
import { IDENTITY_COLUMN_KEY, migrateLayoutColumns, useEntityGraphTableLayout } from '../mobile/entity-graph-table-layout'
import { useEntityGraphColumns } from '../mobile/use-entity-graph-columns'
import { MOBILE_SCOPES, resolveIdentity, scopeNoun, tabForScope, type EntityScope } from '../mobile/entity-graph-mobile-format'
import { DeskFilterRail } from './DeskFilterRail'
import { DeskHeaderFilter } from './DeskHeaderFilter'
import { headerAsOfText, headerFieldKeyFor } from './desk-header-filter'
import { fetchEntityGraphFilterCatalog, type EntityGraphFilterCatalog } from '../../../domain/entity-graph/entity-graph-field-filters'
import { SignalBadges, signalLines, signalRowHeight } from './SignalBadges'
import { propertySignals } from '../mobile/property-signals'
import { DeskCampaignStack, stackScopeSupported, type StackResult } from './DeskCampaignStack'
import { deskSearch, initialDeskState, NO_GLOBALS, readViewByScope, viewForScope, withViewFilters, writeSessionDeskState, writeViewByScope, type DeskCenter, type DeskState, type UniverseGlobals, type ViewByScope } from './desk-state'
import { EntityGraphUniverse } from './universe/EntityGraphUniverse'
import { campaignIdsInFilters, isCampaignScopeFilter } from '../../../domain/entity-graph/entity-graph-campaign-link'
import { fetchCampaignScope, type CampaignScopeSummary } from './overview/overview-api'
import { setColumnCampaign } from '../mobile/use-entity-graph-columns'
import { useOutreachStates } from './desk-outreach'
import { equityDisplay } from '../equity-display'
import { absorbPageAttachments, completePageParams, pageKey } from './desk-page'
import { DeskGraph } from './DeskGraph'
import { DeskOverviewBand, DeskOverviewMode, useOverviewPrefs } from './overview/DeskOverview'
import { fmtInt } from './overview/overview-model'
import { DeskInspector } from './DeskInspector'
import { fetchDeskKpis, kpisFromCounts } from './desk-api'
import {
  anchorForResult,
  anchorKey,
  GRAPH_LAYERS,
  fmtCount,
  kpiTiles,
  makeView,
  readViews,
  serverSortFor,
  writeViews,
  type DeskKpis,
  type DeskView,
  type NetworkAnchor,
} from './desk-model'
import './entity-graph-desk.css'

type Props = {
  themeMode?: string
  universalContext: UniversalEntityContext
  onUniversalContextChange: (next: UniversalEntityContext) => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
}

const PAGE_SIZE = 60
const NO_FILTERS: EntityGraphFieldFilter[] = []
const OUTREACH_SEED = ['smsEligible', 'lastContact', 'stage', 'convoStage', 'flags']
/** A campaign-scoped grid opens with the campaign's outcome + the facts that decide a target (once per campaign). */
const CAMPAIGN_SEED = ['camp.template', 'camp.sent_at', 'camp.delivery', 'camp.target_status', 'camp.reply_intent', 'camp.opted_out', 'lastContact', 'stage', 'convoStage', 'smsEligible', 'flags', 'equity', 'fact.company_status_raw', 'rec.pf_verified_verdict', 'probate.validity_class', 'probate.best_contact_role']
const RAIL_KEY = 'nexus.entityGraph.desk.rail.v1'
const readRailCollapsed = (uid: string): boolean => { try { return window.localStorage.getItem(`${RAIL_KEY}:${uid}`) === 'collapsed' } catch { return false } }
const rowKey = (r: EntitySearchResult) => `${r.entityType}:${r.entityId}`

type ListState = {
  signature: string
  cursor: number
  results: EntitySearchResult[]
  total: number | null
  hasMore: boolean
  nextAfter: string | null
  sortApplied: boolean | null
  /** how the server ordered the whole cohort (facts read model / live facts / keyset) and as of when */
  sortMeta?: { mode?: string; asOf?: string | null; source?: string; computedMs?: number; cached?: boolean } | null
  error: string | null
  unsupported: UnsupportedFieldFilter[] | null
  /** browse attachments that failed for the latest page (those cells read —, said so) */
  attachErrors?: Array<{ source: string; message: string }>
}
const EMPTY_LIST: ListState = { signature: '', cursor: 0, results: [], total: null, hasMore: false, nextAfter: null, sortApplied: null, error: null, unsupported: null }

/** The network the universal context names (respecting its entity type, so an owner stays an owner). */
function anchorFromContext(ctx: UniversalEntityContext | null | undefined): NetworkAnchor | null {
  if (!ctx) return null
  if (ctx.entityType === 'master_owner' && ctx.masterOwnerId) return { type: 'owner', id: String(ctx.masterOwnerId) }
  if (ctx.entityType === 'prospect' && ctx.prospectId) return { type: 'person', id: String(ctx.prospectId) }
  if (ctx.propertyId) return { type: 'property', id: String(ctx.propertyId) }
  if (ctx.masterOwnerId) return { type: 'owner', id: String(ctx.masterOwnerId) }
  if (ctx.prospectId) return { type: 'person', id: String(ctx.prospectId) }
  return null
}

function contextForAnchor(a: NetworkAnchor, net?: EntityNetwork | null): UniversalEntityContext {
  if (a.type === 'property') return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: a.id, propertyId: a.id, masterOwnerId: net?.owner.id ?? null }
  if (a.type === 'person') return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'prospect', entityId: a.id, prospectId: a.id }
  return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'master_owner', entityId: a.id, masterOwnerId: a.id }
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function EntityGraphDesk({ themeMode = 'dark', universalContext, onUniversalContextChange, onAction }: Props) {
  const uid = useAuth().user?.id || 'local'
  const location = useRouteLocation()
  const pane = useContext(PaneRouteContext)
  // [persistence] scope · search · per-scope filters · Grid/Graph/fullscreen
  // start from this pane's URL (reload / Back / a shared link) or, when the
  // address carries none, from the session — see desk-state.ts.
  // the last view per scope (Overview the first time) — localStorage, per operator
  const [viewByScope, setViewByScope] = useState<ViewByScope>(() => readViewByScope(uid))
  const [deskInit] = useState<DeskState>(() => initialDeskState(new URLSearchParams(location.split('?')[1] ?? ''), undefined, readViewByScope(uid)))
  const initialParams = useMemo(() => new URLSearchParams(location.split('?')[1] ?? ''), []) // eslint-disable-line react-hooks/exhaustive-deps

  const [scope, setScope] = useState<EntityScope>(deskInit.scope)
  const [contactSubtype, setContactSubtype] = useState<'phone' | 'email'>(deskInit.contactSubtype)
  const [query, setQuery] = useState(deskInit.query)
  const [debouncedQuery, setDebouncedQuery] = useState(deskInit.query.trim())
  const [filtersByScope, setFiltersByScope] = useState<DeskState['filtersByScope']>(deskInit.filtersByScope)
  const filters = filtersByScope[scope] ?? NO_FILTERS
  const setFilters = (next: EntityGraphFieldFilter[]) => setFiltersByScope((cur) => ({ ...cur, [scope]: next }))
  const [center, setCenterState] = useState<DeskCenter>(deskInit.center)
  // the view is remembered per scope (Overview · Grid · Graph); a scope opens where the operator left it
  const setCenter = (next: DeskCenter, forScope: EntityScope = scope) => {
    setCenterState(next)
    setViewByScope((cur) => { const out = { ...cur, [forScope]: next }; writeViewByScope(uid, out); return out })
  }
  // the Overview PAGE (owner 2026-10-12): one dashboard across every table — the landing view
  // a deep link to a record (Map / Inbox / ?buyer=) opens the records, not the page
  const [home, setHome] = useState<boolean>(() => Boolean(deskInit.home) && !/\/entity-graph\/[a-z_]+\/[^/?]+/.test(location.split('?')[0]) && !initialParams.get('buyer') && !anchorFromContext(universalContext))
  const [universe, setUniverse] = useState<UniverseGlobals>(deskInit.universe ?? NO_GLOBALS)
  const switchScope = (next: EntityScope) => {
    setHome(false)
    setScope(next)
    setSelected(new Set())
    setCenterState(viewForScope(viewByScope, next))
    setGraphFull(false)
  }
  // Overview (spec 9 §4; owner 2026-10-10): the LANDING view of every scope + a band above the Properties grid
  const overviewPrefs = useOverviewPrefs(uid)
  const overviewMode = center === 'overview'
  const onOverviewFilters = (next: EntityGraphFieldFilter[], opts?: { showRecords?: boolean }) => { setFilters(next); if (opts?.showRecords) setCenter('grid') }
  // a chart / KPI / total on the Overview page opens that scope's grid with exactly that cohort
  const drillFromUniverse = (target: EntityScope, next: EntityGraphFieldFilter[]) => {
    setFiltersByScope((cur) => ({ ...cur, [target]: next }))
    setQuery('')
    setDebouncedQuery('')
    switchScope(target)
    setCenter('grid', target)
  }

  /* ── Campaign scope (Campaign → Entity Graph): the "Campaign: <name>" chip ── */
  const campaignId = campaignIdsInFilters(filters)[0] ?? null
  const [campaignScope, setCampaignScope] = useState<{ id: string; summary: CampaignScopeSummary | null; failed: boolean } | null>(null)
  useEffect(() => {
    setColumnCampaign(campaignId)
    if (!campaignId) return
    const ctl = new AbortController()
    void fetchCampaignScope(campaignId, ctl.signal)
      .then((summary) => { if (!ctl.signal.aborted) setCampaignScope({ id: campaignId, summary, failed: !summary }) })
      .catch(() => { if (!ctl.signal.aborted) setCampaignScope({ id: campaignId, summary: null, failed: true }) })
    return () => ctl.abort()
  }, [campaignId])
  const campaign = campaignScope?.id === campaignId ? campaignScope.summary : null
  const scopeChipLabel = (f: EntityGraphFieldFilter) => {
    if (!isCampaignScopeFilter(f)) return null
    const ids = campaignIdsInFilters([f])
    if (campaignScope && ids[0] === campaignScope.id) return campaignScope.summary?.name ?? (campaignScope.failed ? `${ids[0].slice(0, 8)}… (not found)` : 'Loading…')
    return 'Loading…'
  }
  const [graphFull, setGraphFull] = useState(deskInit.graphFull)
  // The rail stays where the operator left it (collapsed strip or open) —
  // it no longer folds itself away when the inspector opens.
  const [railCollapsed, setRailCollapsedState] = useState(() => readRailCollapsed(uid))
  const setRailCollapsed = (next: boolean) => {
    setRailCollapsedState(next)
    try { window.localStorage.setItem(`${RAIL_KEY}:${uid}`, next ? 'collapsed' : 'open') } catch { /* private mode */ }
  }
  const [railOverOpen, setRailOverOpen] = useState(false)
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // `?buyer=<public buyer_id>` (Comps "View buyer", Buyer Match) opens that buyer.
  const [buyerId, setBuyerId] = useState<string | null>(() => initialParams.get('buyer') || null)
  const [views, setViews] = useState<DeskView[]>(() => readViews(uid))
  const [rootRef, width] = useElementWidth<HTMLElement>()
  const narrow = width > 0 && width < 980
  const wide = width >= 1060

  const { layout, setColumns, setSort } = useEntityGraphTableLayout()
  const headerSort: HeaderSort | null = layout.sort[scope] ?? null
  const visibleKeys = layout.columns[scope] ?? defaultVisibleColumns(scope)
  // Outreach columns (last contact · stage · status · SMS eligible) are put in
  // front once per operator, also into a layout saved before they existed.
  useEffect(() => {
    const key = `nexus.entityGraph.desk.outreachSeeded.v2:${uid}`
    try {
      if (window.localStorage.getItem(key)) return
      const current = layout.columns.properties ?? defaultVisibleColumns('properties')
      setColumns('properties', [...OUTREACH_SEED.filter((k) => !current.includes(k)), ...current])
      window.localStorage.setItem(key, '1')
    } catch { /* private mode */ }
  }, [uid]) // eslint-disable-line react-hooks/exhaustive-deps

  // a campaign-scoped Properties grid shows the campaign's outcome columns first (once per campaign, per operator)
  useEffect(() => {
    if (!campaignId || scope !== 'properties') return
    const key = `nexus.entityGraph.desk.campaignSeeded.v1:${uid}:${campaignId}`
    try {
      if (window.localStorage.getItem(key)) return
      const current = layout.columns.properties ?? defaultVisibleColumns('properties')
      const known = new Set(SCOPE_TABLE_COLUMNS.properties.map((c) => c.key))
      setColumns('properties', [...CAMPAIGN_SEED.filter((k) => known.has(k)), ...current.filter((k) => !CAMPAIGN_SEED.includes(k))])
      window.localStorage.setItem(key, '1')
    } catch { /* private mode */ }
  }, [campaignId, scope, uid]) // eslint-disable-line react-hooks/exhaustive-deps

  // [persistence] write the state back: session (every scope) + this pane's URL
  useEffect(() => {
    const state: DeskState = { scope, query: debouncedQuery, filtersByScope, center, graphFull: center === 'graph' && graphFull, contactSubtype, home, universe }
    writeSessionDeskState(state)
    // The primary pane IS the address bar (read it live — the hook's copy can
    // lag a transition behind a property click); a side pane owns its own path.
    const here = pane ? location : `${window.location.pathname}${window.location.search}`
    const at = here.indexOf('?')
    const path = at >= 0 ? here.slice(0, at) : here
    const search = at >= 0 ? here.slice(at) : ''
    const next = deskSearch(search, state)
    if (next !== search) replaceRoutePath(`${path}${next}`)
    // `location` is read, not followed: a path change (property click) keeps the search
  }, [scope, debouncedQuery, filtersByScope, center, graphFull, contactSubtype, home, universe]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 260)
    return () => window.clearTimeout(t)
  }, [query])

  /* ── Filter catalog (header filters resolve their field from it, the same rule as the server) ── */
  const [catalog, setCatalog] = useState<EntityGraphFilterCatalog | null>(null)
  useEffect(() => {
    if (scope !== 'properties') return
    const ctl = new AbortController()
    void fetchEntityGraphFilterCatalog('properties', ctl.signal).then((c) => { if (!ctl.signal.aborted) setCatalog(c) }).catch(() => {})
    return () => ctl.abort()
  }, [scope])

  /* ── KPIs + scope counts ───────────────────────────────────────────────── */
  const [counts, setCounts] = useState<EntityGraphTabCounts | null>(null)
  const [kpis, setKpis] = useState<DeskKpis | null | 'loading'>('loading')
  useEffect(() => {
    const ctl = new AbortController()
    void fetchEntityGraphTabCounts(ctl.signal).then(setCounts).catch(() => setCounts(null))
    void fetchDeskKpis(ctl.signal).then((k) => { if (!ctl.signal.aborted) setKpis(k) }).catch(() => { if (!ctl.signal.aborted) setKpis(null) })
    return () => ctl.abort()
  }, [])
  const effectiveKpis = kpis === 'loading' ? null : (kpis ?? kpisFromCounts(counts))
  const tiles = kpiTiles(effectiveKpis)

  /* ── The list ──────────────────────────────────────────────────────────── */
  /*
   * Sorting is SERVER-SIDE over the whole filtered cohort, or not offered
   * (owner, 2026-10-08: "sorting doesn't show everything"). A header without a
   * whole-cohort order is not sortable (its tooltip says why) — the old
   * "sorted within N loaded rows" reordered a fraction of the cohort and
   * sorted not-yet-enriched cells as blanks.
   */
  const searching = Boolean(debouncedQuery)
  const sort = serverSortFor(scope, headerSort, searching)
  const headerSortActive = Boolean(headerSort) && sort.source === 'header'
  const signature = `${scope}|${contactSubtype}|${debouncedQuery}|${JSON.stringify(filters)}|${sort.sortBy}|${sort.ascending ? 1 : 0}`
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [cursor, setCursor] = useState(0)
  const [seenSig, setSeenSig] = useState(signature)
  if (seenSig !== signature) {
    setSeenSig(signature)
    setCursor(0)
    setSelected(new Set())
  }
  const isCurrent = list.signature === signature
  const results = isCurrent ? list.results : EMPTY_LIST.results
  const loading = !isCurrent
  const loadingMore = isCurrent && cursor > list.cursor
  const generation = useRef(0)

  // ONE complete page: the visible columns' values + outreach ride on the browse request
  const enrichFields = visibleEnrichmentFields(scope, visibleKeys)
  const wantsOutreach = scope === 'properties' && visibleKeys.some((k) => SCOPE_TABLE_COLUMNS.properties.find((c) => c.key === k)?.outreach)
  const pageExtras = useRef({ fields: enrichFields, outreach: wantsOutreach })
  pageExtras.current = { fields: enrichFields, outreach: wantsOutreach }
  const prefetch = useRef<{ key: string; promise: Promise<EntityGraphListResponse>; ctl: AbortController } | null>(null)
  const requestPage = (reqSig: string, reqCursor: number, after: string | null, signal?: AbortSignal): Promise<EntityGraphListResponse> => {
    const key = pageKey(reqSig, reqCursor, after)
    const hit = prefetch.current
    if (hit && hit.key === key) { prefetch.current = null; return hit.promise }
    return fetchEntityGraphList({
      tab: tabForScope(scope),
      q: debouncedQuery || undefined,
      cursor: reqCursor,
      page_size: PAGE_SIZE,
      ...(reqCursor > 0 && after ? { after } : {}),
      subtype: scope === 'contact_methods' ? contactSubtype : undefined,
      sort_by: sort.sortBy,
      ascending: sort.ascending ? '1' : '0',
      ...fieldFiltersToApiParams(filters),
      ...completePageParams(pageExtras.current.fields, pageExtras.current.outreach),
    }, signal).then((res) => { absorbPageAttachments(res); return res })
  }

  // the Overview reads its own exact totals: the grid's page (and its count) is read only when a records view is open
  const listActive = !home && center !== 'overview'
  useEffect(() => {
    if (!listActive) return
    const ctl = new AbortController()
    const gen = ++generation.current
    const reqSig = signature
    const reqCursor = cursor
    const after = reqCursor > 0 && list.signature === reqSig ? list.nextAfter : null
    if (prefetch.current && !prefetch.current.key.startsWith(`${reqSig}#`)) { prefetch.current.ctl.abort(); prefetch.current = null }
    void requestPage(reqSig, reqCursor, after, ctl.signal)
      .then((res) => {
        if (gen !== generation.current) return
        setList((cur) => {
          const appending = reqCursor > 0 && cur.signature === reqSig
          const seen = new Set(appending ? cur.results.map(rowKey) : [])
          const fresh = res.results.filter((r) => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true })
          return {
            signature: reqSig,
            cursor: reqCursor,
            results: appending ? [...cur.results, ...fresh] : fresh,
            total: appending && res.pagination.total === null ? cur.total : res.pagination.total,
            hasMore: res.pagination.hasMore,
            nextAfter: res.pagination.nextAfter ?? null,
            sortApplied: res.pagination.sort ? res.pagination.sort.sortApplied : null,
            sortMeta: res.pagination.sort ? { mode: res.pagination.sort.mode, asOf: res.pagination.sort.asOf ?? null, source: res.pagination.sort.source, computedMs: res.pagination.sort.computedMs, cached: res.pagination.sort.cached } : (appending ? cur.sortMeta : null),
            error: null,
            unsupported: null,
            attachErrors: res.attached?.errors ?? [],
          }
        })
        // prefetch the next page in the background: scrolling reaches it already loaded
        if (res.pagination.hasMore) {
          const nextCursor = reqCursor + PAGE_SIZE
          const nextAfter = res.pagination.nextAfter ?? null
          const pctl = new AbortController()
          const promise = requestPage(reqSig, nextCursor, nextAfter, pctl.signal)
          promise.catch(() => { if (prefetch.current?.promise === promise) prefetch.current = null })
          prefetch.current = { key: pageKey(reqSig, nextCursor, nextAfter), promise, ctl: pctl }
        }
      })
      .catch((error: unknown) => {
        if (gen !== generation.current || ctl.signal.aborted) return
        const unsupported = error instanceof EntityGraphFilterError ? error.unsupportedFilters : null
        const message = error instanceof Error ? error.message : 'load_failed'
        setList((cur) => (reqCursor > 0 && cur.signature === reqSig
          ? { ...cur, cursor: reqCursor, error: message }
          : { ...EMPTY_LIST, signature: reqSig, cursor: reqCursor, error: message, unsupported }))
      })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature + cursor encode the request
  }, [signature, cursor, listActive])

  // a column made visible AFTER the page loaded is read for the loaded rows (user-driven, once)
  const enrichment = useEntityGraphColumns(results, enrichFields, scope === 'properties')
  const outreach = useOutreachStates(enrichment.rows, wantsOutreach)
  const rows = outreach.rows

  /* ── Selection → inspector ─────────────────────────────────────────────── */
  const [anchor, setAnchor] = useState<NetworkAnchor | null>(() => anchorFromContext(universalContext))
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(() => Boolean(anchorFromContext(universalContext)))
  // The inspector docks wherever the grid keeps ≥ ~600px; on a mid-width pane
  // an open inspector folds the rail (auto) rather than squeezing the grid.
  // The relationship view needs the width: with an open inspector that would
  // otherwise FLOAT over the graph, the rail shows as its slim strip (filter
  // count still in view; one click re-expands it) so the inspector can dock.
  const [railGraphOverride, setRailGraphOverride] = useState(false)
  const fitsWith = (rw: number) => wide && width - rw - 440 >= 600
  const graphFold = center === 'graph' && inspectorOpen && !narrow && !railCollapsed && !railGraphOverride && !fitsWith(272) && fitsWith(44)
  const railW = narrow ? 44 : railCollapsed || graphFold ? 44 : 272
  const inspectorMode: 'dock' | 'float' = fitsWith(railW) ? 'dock' : 'float'
  const railShown = narrow ? railOverOpen : !railCollapsed && !graphFold
  // A subject arriving from another app (Map, Inbox, a deep link) re-anchors the inspector.
  const ctxAnchor = anchorFromContext(universalContext)
  const ctxKey = anchorKey(ctxAnchor)
  const [seenCtx, setSeenCtx] = useState(ctxKey)
  if (seenCtx !== ctxKey) {
    setSeenCtx(ctxKey)
    if (ctxAnchor && ctxKey !== anchorKey(anchor)) {
      setAnchor(ctxAnchor)
      setInspectorOpen(true)
    }
  }

  const [netState, setNetState] = useState<{ key: string; data: EntityNetwork | null; failed: boolean; reason?: string } | null>(null)
  const [netAttempt, setNetAttempt] = useState(0)
  const netKey = `${anchorKey(anchor)}#${netAttempt}`
  const network = netState?.key === netKey ? netState.data : null
  const netLoading = Boolean(anchor) && netState?.key !== netKey
  const netFailed = netState?.key === netKey && netState.failed
  useEffect(() => {
    if (!anchor) return
    const ctl = new AbortController()
    const key = netKey
    void fetchEntityNetwork(anchor.type, anchor.id, ctl.signal)
      .then((n) => { if (!ctl.signal.aborted) setNetState({ key, data: n, failed: !n, reason: n ? undefined : 'This record has no network on file (404)' }) })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setNetState({ key, data: null, failed: true, reason: e instanceof Error ? e.message : undefined }) })
    return () => ctl.abort()
  }, [anchor, netKey])

  const openAnchor = (a: NetworkAnchor, opts: { rowKey?: string | null } = {}) => {
    setAnchor(a)
    setActiveKey(opts.rowKey ?? null)
    setInspectorOpen(true)
    const ctx = contextForAnchor(a)
    setSeenCtx(anchorKey(a))
    onUniversalContextChange(ctx)
  }

  const activate = (r: EntitySearchResult) => {
    if (r.entityType === 'buyer') { setBuyerId(r.entityId); return }
    const a = anchorForResult(r)
    if (!a) { lcToast({ title: 'This record has no relationship network to open.', severity: 'info' }); return }
    openAnchor(a, { rowKey: rowKey(r) })
  }

  /* ── Grid columns ──────────────────────────────────────────────────────── */
  const gridColumns = useMemo<Array<LCColumn<EntitySearchResult>>>(() => {
    const identity: LCColumn<EntitySearchResult> = {
      id: IDENTITY_COLUMN_KEY,
      header: scope === 'properties' ? 'Property' : scope === 'contact_methods' ? 'Contact' : 'Name',
      width: scope === 'properties' ? 300 : 260,
      minWidth: 180,
      // server-side whole-cohort order or not offered (search results are ranked)
      sortable: Boolean(IDENTITY_SORT_COLUMN[scope]) && !searching,
      hint: searching ? 'Search results are ranked by match — sort is off while searching' : IDENTITY_SORT_COLUMN[scope] ? 'Sorts the whole cohort (server)' : 'Not sortable — no whole-cohort order for this scope',
      render: (r) => {
        const id = resolveIdentity(scope, r)
        return (
          <span className="egdk-cell-id">
            <span className="egdk-cell-id__primary">{id.primary}</span>
            {id.secondary ? <span className="egdk-cell-id__secondary">{id.secondary}</span> : null}
          </span>
        )
      },
    }
    const byKey = new Map(SCOPE_TABLE_COLUMNS[scope].map((c) => [c.key, c]))
    const cols = visibleKeys.map((k) => byKey.get(k)).filter((c): c is TableColumn => Boolean(c)).map((c): LCColumn<EntitySearchResult> => ({
      id: c.key,
      header: c.label,
      // adjacent columns of one group share a band above their headers
      group: c.group,
      width: Math.round(c.width * 1.18) + 12,
      minWidth: 64,
      align: c.align === 'right' ? 'right' : 'left',
      // whole-cohort server sort (properties: every column, on its facts column); never a sort of just the loaded rows
      sortable: Boolean(c.sortBy) && !searching,
      hint: searching ? `${c.label} · search results are ranked by match — sort is off while searching`
        : c.sortBy ? `${c.label} · click to sort the whole filtered cohort (server)${scope === 'properties' ? ' · ▾ to filter' : ''}${c.source ? ` · ${c.source}` : ''}`
          : `${c.label}${c.source ? ` · ${c.source}` : ''}`,
      ...(scope === 'properties' && c.sortBy && !searching ? (() => {
        const factCol = c.filterColumn ?? c.sortBy
        const fieldKey = headerFieldKeyFor(catalog, factCol)
        const dir = headerSort?.key === c.key && headerSortActive ? headerSort.dir : null
        return {
          headerActive: Boolean(fieldKey && filters.some((f) => f.field_key === fieldKey)),
          headerAccessory: (
            <DeskHeaderFilter
              label={c.label}
              column={factCol}
              fieldKey={fieldKey}
              filters={filters}
              onFiltersChange={setFilters}
              sortDir={dir}
              onSort={(d) => setSort(scope, d ? { key: c.key, dir: d } : null)}
              sortable
            />
          ),
        }
      })() : {}),
      render: (r) => {
        if (c.signals) return <SignalBadges signals={propertySignals(r)} />
        const v = c.render(r)
        if (v === null || v === '') return <span className="egdk-cell-none">—</span>
        // good vs bad, at a glance: eligibility and equity carry a tone
        if (c.key === 'smsEligible') return <span className={cx('egdk-tone', v === 'Yes' ? 'is-ok' : 'is-bad')}>{v}</span>
        if (c.key === 'equity') {
          const e = equityDisplay({ percent: r.details?.equity ?? null, amount: r.details?.equityAmount ?? null, rule: r.details?.equityRule ?? null })
          return <span className={cx('egdk-tone', e.tone && `is-${e.tone}`)} title={e.hint}>{v}</span>
        }
        if (c.key === 'liens' && r.details?.records?.lienCount) return <span className="egdk-tone is-crit">{v}</span>
        return v
      },
    }))
    return [identity, ...cols]
  }, [scope, visibleKeys, searching, catalog, filters, headerSort, headerSortActive]) // eslint-disable-line react-hooks/exhaustive-deps

  // a saved sort on a column that cannot be server-sorted shows no arrow (the order IS the default)
  // every signal is listed: rows grow to fit the wrapped chips (no "+N")
  const signalsVisible = scope === 'properties' && visibleKeys.includes('flags')
  const gridSort: LCSort = headerSort && headerSortActive ? { id: headerSort.key, dir: headerSort.dir } : null
  const onSortChange = (next: LCSort) => setSort(scope, next ? { key: next.id, dir: next.dir } : null)

  /* ── Saved views ───────────────────────────────────────────────────────── */
  const saveView = async () => {
    const name = await lcPrompt({ title: 'Save view', label: 'Name', placeholder: 'e.g. Atlanta probate, 60%+ equity', confirmLabel: 'Save view', nativeText: 'Name this view' })
    if (name === null) return
    const next = [makeView({ name, scope, query: debouncedQuery, fieldFilters: filters, sort: headerSort, columns: layout.columns[scope] ?? null }), ...views]
    setViews(next)
    writeViews(uid, next)
    lcToast({ title: `Saved “${next[0].name}”`, severity: 'success' })
  }
  const applyView = (v: DeskView) => {
    setScope(v.scope)
    setCenterState(viewForScope(viewByScope, v.scope))
    setQuery(v.query)
    setDebouncedQuery(v.query)
    // the VIEW's scope: setFilters writes the scope being left (stale closure)
    setFiltersByScope((cur) => withViewFilters(cur, v))
    setSort(v.scope, v.sort)
    // a view saved under an older layout is migrated (a renamed key never shows the wrong value)
    if (v.columns) setColumns(v.scope, migrateLayoutColumns(v.scope, v.columns, v.layoutVersion ?? 1))
  }
  const deleteView = (v: DeskView) => {
    const next = views.filter((x) => x.id !== v.id)
    setViews(next)
    writeViews(uid, next)
  }
  const viewItems: LCMenuEntry[] = [
    ...(views.length ? views.map((v): LCMenuEntry => ({
      kind: 'sub', id: v.id, label: v.name,
      items: [
        { id: `${v.id}:open`, label: 'Open', hint: `${MOBILE_SCOPES.find((s) => s.key === v.scope)?.label ?? v.scope}${v.fieldFilters.length ? ` · ${v.fieldFilters.length} filters` : ''}${v.query ? ` · “${v.query}”` : ''}`, onSelect: () => applyView(v) },
        { id: `${v.id}:delete`, label: 'Delete', tone: 'danger', onSelect: () => deleteView(v) },
      ],
    })) : [{ kind: 'label' as const, id: 'none', label: 'No saved views yet' }]),
    { kind: 'separator', id: 'sep' },
    { id: 'save', label: 'Save current view…', icon: 'bookmark', onSelect: () => { void saveView() } },
  ]

  /* ── Bulk (selected rows) ──────────────────────────────────────────────── */
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)))
  const exportSelected = () => {
    const cols = gridColumns
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const byKey = new Map(SCOPE_TABLE_COLUMNS[scope].map((c) => [c.key, c]))
    const header = ['id', ...cols.map((c) => c.header)]
    const lines = selectedRows.map((r) => [r.entityId, resolveIdentity(scope, r).primary, ...cols.slice(1).map((c) => byKey.get(c.id)?.render(r) ?? '')].map(esc).join(','))
    const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `entity-graph-${scope}-${selectedRows.length}.csv`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  const showOnMap = () => {
    const pts = selectedRows.map((r) => ({ id: r.entityId, lat: Number(r.details?.lat), lng: Number(r.details?.lng), label: r.title }))
    const ok = writeMapFocusSet({ label: `${pts.length} from Entity Graph`, tone: 'property', points: pts })
    if (!ok) { lcToast({ title: 'None of these have map coordinates.', severity: 'info' }); return }
    const first = selectedRows[0]
    onAction?.('open_in_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: first.entityId, propertyId: first.entityId })
  }

  /* ── Add to campaign (stacked cohorts into a DRAFT) ────────────────────── */
  const [stack, setStack] = useState<{ open: boolean; scope: EntityScope; ids: string[]; label: string; cohort: boolean }>({ open: false, scope: 'properties', ids: [], label: '', cohort: true })
  const cohortLabel = (() => {
    const parts = filters.slice(0, 2).map((f) => (Array.isArray(f.value) ? `${f.field_key.split('.').pop()}: ${(f.value as unknown[]).slice(0, 2).join(', ')}` : f.field_key.split('.').pop()))
    return `${MOBILE_SCOPES.find((x) => x.key === scope)?.label ?? scope}${parts.length ? ` · ${parts.join(' · ')}` : ''}${filters.length > 2 ? ` +${filters.length - 2}` : ''}`
  })()
  const openStack = (ids: string[], forScope: EntityScope = scope, label = cohortLabel, cohort = true) => setStack({ open: true, scope: forScope, ids, label, cohort })
  const onStacked = (r: StackResult) => {
    lcToast({ title: r.created ? `Draft “${r.campaign_name ?? ''}” created · ${fmtCount(r.added)} properties` : `${fmtCount(r.added)} added to “${r.campaign_name ?? 'draft'}” · ${fmtCount(r.total_after)} total`, severity: 'success' })
    for (const w of r.warnings ?? []) lcToast({ title: w.message, severity: 'info' })
  }

  /* ── The relationship view: map + campaign for the network on screen ───── */
  const networkPropertyIds = network ? network.properties.map((p) => p.id) : []
  const showNetworkOnMap = () => {
    if (!network) return
    const pts = network.properties.map((p) => ({ id: p.id, lat: Number(p.lat), lng: Number(p.lng), label: p.address }))
    if (!writeMapFocusSet({ label: `${network.owner.name} · ${pts.length} properties`, tone: 'property', points: pts })) { lcToast({ title: 'None of these properties have map coordinates.', severity: 'info' }); return }
    const first = network.properties.find((p) => p.id === (anchor?.type === 'property' ? anchor.id : '')) ?? network.properties[0]
    if (first) onAction?.('open_in_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: first.id, propertyId: first.id })
  }
  // fullscreen graph: Esc returns to the split view, state intact
  useEffect(() => {
    if (!(center === 'graph' && graphFull)) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setGraphFull(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [center, graphFull])

  /* ── Render ────────────────────────────────────────────────────────────── */
  const scopeTabs = MOBILE_SCOPES.map((s) => ({
    id: s.key,
    label: s.label,
    count: counts ? (s.key === 'contact_methods' ? counts.contact_methods : (counts[s.countKey as keyof EntityGraphTabCounts] as number | null | undefined) ?? null) : null,
  }))
  const pageTabs = [{ id: 'overview', label: 'Overview', count: null }, ...scopeTabs]
  const total = isCurrent ? list.total : null
  const scopeCount = scopeTabs.find((t) => t.id === scope)?.count ?? null
  const noun = scopeNoun(scope, total ?? 2)
  const summary = home
    ? `Overview · every table${universe.markets.length + universe.states.length ? ` · ${[...universe.markets, ...universe.states].slice(0, 2).join(', ')}${universe.markets.length + universe.states.length > 2 ? ` +${universe.markets.length + universe.states.length - 2}` : ''}` : ''}`
    : !listActive
    ? `${MOBILE_SCOPES.find((x) => x.key === scope)?.label ?? 'Records'} · Overview${filters.length ? ` · ${filters.length} ${filters.length === 1 ? 'filter' : 'filters'}` : ''}`
    : loading
    ? 'Reading the universe…'
    : list.error && !results.length
      ? 'This cohort could not be read'
      : `${total !== null ? fmtCount(total) : 'Uncounted'} ${noun}${searching ? ` matching “${debouncedQuery}”` : ''}${filters.length ? ` · ${filters.length} ${filters.length === 1 ? 'filter' : 'filters'}` : ''}`
  const factsSort = isCurrent && (list.sortMeta?.mode === 'facts_live' || list.sortMeta?.mode === 'facts_table') ? list.sortMeta : null
  const sortNote = !isCurrent ? null
    : list.sortApplied === false ? 'The server could not apply that order — showing its fallback order'
      : factsSort && headerSortActive ? `Sorted across the whole cohort · ${headerAsOfText(factsSort.mode, factsSort.source, factsSort.asOf)}${factsSort.mode === 'facts_live' && factsSort.computedMs && !factsSort.cached ? ` · ${(factsSort.computedMs / 1000).toFixed(1)} s` : ''}`
      : list.attachErrors?.length ? `Some column values did not load (${list.attachErrors.map((e) => e.source).join(', ')}) — those cells read —`
        : null

  const emptyState: { title: string; body?: ReactNode } = list.unsupported?.length
    ? { title: 'These filters could not be applied', body: `Nothing was queried, so no cohort is shown. Remove or change: ${list.unsupported.map((u) => `${u.field_key ?? 'filter'} (${u.reason.replace(/_/g, ' ')})`).join(', ')}` }
    : searching ? { title: `No ${scopeNoun(scope, 2)} match “${debouncedQuery}”`, body: 'Search reads addresses, names, phones and emails in this scope; a market name returns the whole market.' }
      : filters.length ? { title: 'No records match these filters', body: 'Every filter is applied exactly — remove one to widen the cohort.' }
        : { title: 'No records in this scope' }

  const graphPane = (
    <div className="egdk-graphpane">
      {network ? (
        <>
          <div className="egdk-graphpane__bar">
            <div className="egdk-graphpane__title">
              <span className="egdk-eyebrow">Relationship view</span>
              <strong>{network.owner.name}</strong>
              <small>{`${fmtCount(network.graph.nodes.length)} records · ${fmtCount(network.graph.edges.length)} links`}</small>
            </div>
            <div className="egdk-layers" role="group" aria-label="Layers">
              {GRAPH_LAYERS.filter((l) => network.graph.nodes.some((n) => n.type === l.type || (l.type === 'phone' && n.type === 'email'))).map((l) => {
                const off = hiddenLayers.has(l.type)
                return (
                  <button key={l.type} type="button" aria-pressed={!off} className={cx('egdk-layer', `is-${l.type}`, off && 'is-off')} onClick={() => setHiddenLayers((cur) => { const n = new Set(cur); if (n.has(l.type)) n.delete(l.type); else n.add(l.type); return n })}>
                    <span className="egdk-dot" aria-hidden="true" />{l.label}
                  </button>
                )
              })}
            </div>
            <div className="egdk-graphpane__actions">
              <LCButton size="sm" variant="quiet" icon="map" onClick={showNetworkOnMap} title="Show this network's properties on the Map">Map</LCButton>
              <LCButton size="sm" variant="quiet" icon="target" disabled={!networkPropertyIds.length} onClick={() => openStack(networkPropertyIds, 'properties', `${network.owner.name} · network`, false)} title="Pin this network's properties on a draft campaign">Add to campaign</LCButton>
              <LCIconButton icon={graphFull ? 'close' : 'maximize'} label={graphFull ? 'Exit fullscreen (Esc)' : 'Fullscreen graph'} size="sm" selected={graphFull} onClick={() => setGraphFull((f) => !f)} />
            </div>
          </div>
          <DeskGraph network={network} hiddenTypes={hiddenLayers} onOpen={(a) => openAnchor(a)} />
        </>
      ) : netLoading ? (
        <div className="egdk-graphpane__state"><span className="lc-skel egdk-graphpane__skel" role="status" aria-label="Drawing the network" /></div>
      ) : (
        <div className="egdk-graphpane__state">
          <LCEmpty icon="layers" title={anchor ? 'This network did not load' : 'Pick a record to draw its network'} body={anchor ? undefined : 'Select any property, owner or person in the grid — its owner, portfolio, people, contacts, title entities and recorded documents draw here.'} action={anchor ? { label: 'Try again', onClick: () => setNetAttempt((n) => n + 1) } : { label: 'Back to the grid', onClick: () => setCenter('grid') }} />
        </div>
      )}
    </div>
  )

  return (
    <section ref={rootRef} className={cx('egdk', `is-${themeMode}`, narrow && 'is-narrow', wide && 'is-wide', (!railShown || home) && 'is-rail-hidden', home && 'is-home', narrow && railShown && 'is-rail-over', inspectorOpen && inspectorMode === 'dock' && 'has-dock', center === 'graph' && graphFull && 'is-graph-full')} data-scope={scope}>
      <header className="egdk-head">
        <div className="egdk-head__id">
          <h1>Entity Graph</h1>
          <p className="egdk-head__summary" aria-live="polite">{summary}</p>
        </div>
        <div className="egdk-kpis" role="list" aria-label="Universe">
          {tiles.map((t) => (
            <div key={t.key} role="listitem" className={cx('egdk-kpi', t.value === null && 'is-na')} title={t.basis}>
              <span className="egdk-kpi__label">{t.label}</span>
              <b className="egdk-kpi__value">{kpis === 'loading' && t.value === null ? <span className="lc-skel egdk-kpi__skel" /> : t.value === null ? 'Not available' : t.unit === '%' ? `${t.value}%` : fmtCount(t.value)}</b>
              <span className="egdk-kpi__basis">{t.basis}</span>
            </div>
          ))}
        </div>
      </header>

      <div className="egdk-bar">
        {!home ? <LCIconButton icon="filter" label={railShown ? 'Collapse filters' : 'Show filters'} size="sm" selected={railShown} count={filters.length || null} onClick={() => { if (narrow) { setRailOverOpen((o) => !o); return } if (!railShown && graphFold) { setRailGraphOverride(true); return } setRailGraphOverride(false); setRailCollapsed(railShown) }} className="egdk-bar__rail" /> : null}
        <LCTabs items={pageTabs} value={home ? 'overview' : scope} onChange={(id) => { if (id === 'overview') { setHome(true); setSelected(new Set()); setGraphFull(false) } else switchScope(id as EntityScope) }} label="Entity scope" variant="line" className="egdk-bar__tabs" />
        {home ? null : <div className="egdk-bar__tools">
          {stackScopeSupported(scope) ? (
            <LCButton size="sm" variant="secondary" icon="target" onClick={() => openStack(selectedRows.map((r) => r.entityId))} title="Pin this cohort (or the selected rows) on a draft campaign — nothing is sent">
              Add to campaign
            </LCButton>
          ) : null}
          <LCSegmented size="sm" label="View" value={center} onChange={(v) => { setCenter(v as DeskCenter); if (v !== 'graph') setGraphFull(false) }} options={[{ value: 'overview', icon: 'stats', label: 'Overview' }, { value: 'grid', icon: 'list', label: 'Grid' }, { value: 'graph', icon: 'layers', label: 'Graph' }]} />
          {center === 'graph' ? <LCIconButton icon="maximize" label="Fullscreen graph (Esc to exit)" size="sm" selected={graphFull} onClick={() => setGraphFull((f) => !f)} /> : null}
        </div>}
      </div>

      <div className="egdk-body">
        {home ? null : narrow && !railShown ? <DeskFilterRail scope={scope} filters={filters} onChange={setFilters} collapsed onCollapsedChange={() => setRailOverOpen(true)} scopeChipLabel={scopeChipLabel} />
          : <DeskFilterRail scope={scope} filters={filters} onChange={setFilters} scopeChipLabel={scopeChipLabel} collapsed={!railShown} onCollapsedChange={(c) => { if (narrow) { setRailOverOpen(!c); return } if (!c && graphFold) { setRailGraphOverride(true); return } setRailGraphOverride(false); setRailCollapsed(c) }} />}
        <main className="egdk-center" aria-label={center === 'grid' ? 'Records' : center === 'overview' ? 'Overview' : 'Relationship view'}>
          {home ? (
            <EntityGraphUniverse globals={universe} onGlobalsChange={setUniverse} onDrill={drillFromUniverse} />
          ) : null}
          {!home && campaignId ? (
            <CampaignScopeBanner
              id={campaignId}
              summary={campaign}
              failed={Boolean(campaignScope?.id === campaignId && campaignScope.failed)}
              scope={scope}
              onClear={() => setFilters(filters.filter((f) => !isCampaignScopeFilter(f)))}
              onOpenGrid={center !== 'grid' ? () => setCenter('grid') : undefined}
            />
          ) : null}
          {home ? null : overviewMode ? (
            <DeskOverviewMode scope={scope} filters={filters} onFiltersChange={onOverviewFilters} onOpenGrid={() => setCenter('grid')} campaign={campaign} universeTotal={scopeCount} />
          ) : center === 'grid' ? (
            <>
              <div className="egdk-tablebar">
                <LCSearch value={query} onChange={setQuery} label={`Search ${MOBILE_SCOPES.find((s) => s.key === scope)?.label.toLowerCase() ?? 'records'}`} placeholder={scope === 'properties' ? 'Search address, city or market…' : 'Search name, phone, email…'} loading={loading && searching} className="egdk-tablebar__search" />
                {scope === 'contact_methods' ? (
                  <LCSegmented size="sm" label="Contact type" value={contactSubtype} onChange={(v) => setContactSubtype(v as 'phone' | 'email')} options={[{ value: 'phone', label: 'Phones' }, { value: 'email', label: 'Emails' }]} />
                ) : null}
                <span className="egdk-tablebar__count">{loading ? '' : total !== null ? `${fmtCount(total)} ${noun}` : `${fmtCount(results.length)} loaded · count unavailable`}</span>
                <LCMenu trigger={<LCButton size="sm" variant="quiet" icon="bookmark">Views{views.length ? ` · ${views.length}` : ''}</LCButton>} items={viewItems} label="Saved views" title="Saved views" width={280} />
                <ColumnPicker scope={scope} visible={visibleKeys} onChange={(next) => setColumns(scope, next)} />
              </div>
              {scope === 'properties' && !searching ? (
                <DeskOverviewBand scope={scope} filters={filters} onFiltersChange={onOverviewFilters} open={overviewPrefs.bandOpen} onOpenChange={overviewPrefs.setBandOpen} onOpenMode={() => setCenter('overview')} />
              ) : null}
              {sortNote || enrichment.error ? (
                <p className="egdk-note" role="status">{sortNote}{sortNote && enrichment.error ? ' · ' : ''}{enrichment.error ? 'Some column values did not load — those cells read —' : ''}</p>
              ) : null}
              <LCDataGrid
                id={`entity-graph-desk-${scope}`}
                label={`${MOBILE_SCOPES.find((s) => s.key === scope)?.label ?? 'Records'}`}
                rows={rows}
                rowKey={rowKey}
                columns={gridColumns}
                sort={gridSort}
                onSortChange={onSortChange}
                activeKey={activeKey}
                onActivate={(r) => activate(r)}
                selected={selected}
                onSelectedChange={setSelected}
                onColumnOrderChange={(ids) => setColumns(scope, ids.filter((id) => id !== IDENTITY_COLUMN_KEY))}
                pinnedColumns={[IDENTITY_COLUMN_KEY]}
                columnGroupLabels={COLUMN_GROUP_LABELS}
                rowHeight={signalsVisible ? (r, colWidth) => signalRowHeight(signalLines(propertySignals(r).map((x) => x.label), colWidth('flags') ?? 390), 30) : undefined}
                density="dense"
                loading={loading}
                error={isCurrent && list.error && !list.unsupported ? { what: /more than [\d,]+ properties match/.test(list.error) ? list.error : 'These records didn’t load', onRetry: () => setList(EMPTY_LIST) } : null}
                empty={emptyState}
                total={total}
                loadingMore={loadingMore}
                onEndReached={() => { if (isCurrent && list.hasMore && !loadingMore && !list.error) setCursor(list.cursor + PAGE_SIZE) }}
                className="egdk-grid"
              />
              {selected.size ? (
                <LCBulkBar
                  className="egdk-bulk"
                  count={selected.size}
                  inView={rows.length}
                  all={selected.size >= rows.length ? 'all' : 'some'}
                  noun={{ one: scopeNoun(scope, 1), many: scopeNoun(scope, 2) }}
                  onSelectAll={() => setSelected(new Set(rows.map(rowKey)))}
                  onClear={() => setSelected(new Set())}
                  actions={[
                    { id: 'campaign', label: 'Add to campaign', icon: 'target', onRun: () => openStack(selectedRows.map((r) => r.entityId)), disabled: !stackScopeSupported(scope), disabledReason: 'Campaigns target properties, owners and people' },
                    { id: 'map', label: 'Show on Map', icon: 'map', onRun: showOnMap, disabled: scope !== 'properties', disabledReason: 'Map handoff is property-scoped' },
                    { id: 'export', label: 'Export CSV', icon: 'archive', onRun: exportSelected },
                  ]}
                />
              ) : null}
            </>
          ) : graphPane}
        </main>
        <DeskInspector
          open={inspectorOpen && Boolean(anchor)}
          mode={inspectorMode}
          anchor={anchor}
          network={network}
          loading={netLoading}
          error={netFailed}
          errorDetail={netFailed ? netState?.reason : undefined}
          onRetry={() => setNetAttempt((n) => n + 1)}
          onClose={() => { setInspectorOpen(false); setActiveKey(null) }}
          onOpen={(a) => openAnchor(a)}
          onOpenGraph={() => setCenter('graph')}
          onAction={onAction}
          onOpenBuyer={(id) => setBuyerId(id)}
          onAddToCampaign={(ids, label) => openStack(ids, 'properties', label, false)}
        />
      </div>

      <DeskCampaignStack
        open={stack.open}
        onOpenChange={(o) => setStack((cur) => ({ ...cur, open: o }))}
        scope={stack.scope}
        selectedIds={stack.ids}
        filters={stack.cohort && stack.scope === scope ? filters : NO_FILTERS}
        query={stack.cohort ? debouncedQuery : ''}
        cohortTotal={stack.cohort && stack.scope === scope ? total : null}
        cohortLabel={stack.label}
        onDone={onStacked}
      />

      <BuyerInspectorSheet
        buyerId={buyerId}
        open={Boolean(buyerId)}
        onClose={() => setBuyerId(null)}
        onOpenProperty={(propertyId) => { setBuyerId(null); openAnchor({ type: 'property', id: propertyId }) }}
        onOpenBuyer={(id) => setBuyerId(id)}
        onShowOnMap={(points: BuyerMapPoint[]) => {
          setBuyerId(null)
          if (writeMapFocusSet({ label: 'from this buyer', tone: 'buyer', points: points.map((p) => ({ lat: p.lat, lng: p.lng, id: p.propertyId, label: p.address ?? null })) })) {
            const first = points.find((p) => p.propertyId)
            if (first?.propertyId) onAction?.('open_in_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: first.propertyId, propertyId: first.propertyId })
          }
        }}
        onOpenBuyerMatch={(propertyId) => onAction?.('open_buyer_match', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: propertyId ? 'property' : null, entityId: propertyId ?? null, propertyId: propertyId ?? null })}
      />
    </section>
  )
}

const UNIT_LABEL: Record<ColumnUnit, string> = {
  currency: '$', currency_per_sqft: '$/sqft', count: 'count', decimal: 'number', sqft: 'sqft', acres: 'acres', feet: 'ft',
  percent: '%', rate: 'rate %', date: 'date', year: 'year', years: 'years', score: 'score', coordinate: 'lat/lng', code: 'code',
  id: 'id', text: 'text', list: 'list', boolean: 'yes/no', composite: 'combined', signals: 'signals',
}

function ColumnPicker({ scope, visible, onChange }: { scope: EntityScope; visible: string[]; onChange: (next: string[]) => void }) {
  const all = SCOPE_TABLE_COLUMNS[scope]
  const on = new Set(visible)
  const groups = COLUMN_GROUP_ORDER.map((g) => ({ g, cols: all.filter((c) => c.group === g) })).filter((x) => x.cols.length)
  const [find, setFind] = useState('')
  const [drag, setDrag] = useState<string | null>(null)
  const q = find.trim().toLowerCase()
  const byKey = new Map(all.map((c) => [c.key, c]))
  const shownVisible = visible.filter((k) => byKey.has(k))
  return (
    <LCPopover
      trigger={<LCButton size="sm" variant="quiet" icon="grid">Columns · {visible.length}</LCButton>}
      align="end"
      width={360}
      label="Columns"
      className="egdk-cols"
    >
      <div className="egdk-cols__head">
        <LCSearch value={find} onChange={setFind} label="Find a column" placeholder={`Find a column · ${all.length}`} />
        <button type="button" className="egdk-link" onClick={() => onChange(all.filter((c) => !c.noData).map((c) => c.key))} title="Every column with data, grouped (scroll sideways)">Show all</button>
        <button type="button" className="egdk-link" onClick={() => onChange(defaultVisibleColumns(scope))}>Reset</button>
      </div>
      <div className="egdk-cols__list lc-scroll">
        {!q && shownVisible.length ? (
          <div className="egdk-cols__group">
            <span className="egdk-eyebrow">Shown · drag to reorder (or drag a header in the grid)</span>
            <ol className="egdk-cols__order">
              {shownVisible.map((k) => (
                <li
                  key={k}
                  draggable
                  className={cx('egdk-cols__orderitem', drag === k && 'is-dragging')}
                  onDragStart={(e) => { setDrag(k); e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={(e) => { if (drag) e.preventDefault() }}
                  onDrop={(e) => { e.preventDefault(); if (drag && drag !== k) onChange(reorderColumnIds(visible, drag, k)); setDrag(null) }}
                  onDragEnd={() => setDrag(null)}
                >
                  <Icon name="drag" size={12} />
                  <span>{byKey.get(k)?.label}</span>
                  <button type="button" className="egdk-cols__x" aria-label={`Hide ${byKey.get(k)?.label}`} onClick={() => onChange(visible.filter((x) => x !== k))}><Icon name="x" size={11} /></button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {groups.map(({ g, cols }) => {
          const shown = q ? cols.filter((c) => c.label.toLowerCase().includes(q) || c.key.toLowerCase().includes(q)) : cols
          if (!shown.length) return null
          return (
            <div key={g} className="egdk-cols__group">
              <span className="egdk-eyebrow">{COLUMN_GROUP_LABELS[g]} · {cols.length}</span>
              {shown.map((c) => (
                <label key={c.key} className={cx('egdk-cols__item', c.noData && 'is-nodata')} title={[c.source, `unit: ${UNIT_LABEL[c.unit]}`].filter(Boolean).join(' · ')}>
                  {/* a column whose source holds no data is listed, never offered as a normal column */}
                  <input type="checkbox" checked={on.has(c.key)} disabled={c.noData && !on.has(c.key)} onChange={() => onChange(on.has(c.key) ? visible.filter((k) => k !== c.key) : [...visible, c.key])} />
                  <span>{c.label}</span>
                  {c.noData ? <small className="is-nodata">no data in source</small>
                    : <small title={c.sortBy ? 'Sorts the whole cohort (server)' : 'Not sortable across the cohort'}>{UNIT_LABEL[c.unit]}{c.sortBy ? ' · sortable' : c.outreach ? ' · live' : ''}</small>}
                </label>
              ))}
            </div>
          )
        })}
      </div>
    </LCPopover>
  )
}

/**
 * The campaign scope, stated: which campaign, how its scope was built and the
 * exact counts (targets · distinct properties · sent · delivered · failed ·
 * waiting). Clear removes the chip; nothing else changes.
 */
function CampaignScopeBanner({ id, summary, failed, scope, onClear, onOpenGrid }: { id: string; summary: CampaignScopeSummary | null; failed: boolean; scope: EntityScope; onClear: () => void; onOpenGrid?: () => void }) {
  const unit = scope === 'master_owners' ? summary?.owners : scope === 'people' ? summary?.people : summary?.properties
  const unitNoun = scope === 'master_owners' ? 'owners' : scope === 'people' ? 'people' : 'properties'
  const modeText = summary?.mode === 'built' ? 'targets + queued / sent' : summary?.mode === 'explicit' ? 'draft · pinned list' : summary?.mode === 'definition' ? 'draft · saved filters' : summary?.mode === 'empty' ? 'no targets yet' : ''
  return (
    <div className={cx('egdk-campaign', failed && 'is-failed')} role="status" aria-live="polite">
      <span className="egdk-campaign__icon" aria-hidden="true"><Icon name="target" size={14} /></span>
      <div className="egdk-campaign__id">
        <span className="egdk-eyebrow">Campaign scope{modeText ? ` · ${modeText}` : ''}</span>
        <strong title={summary?.basis}>{summary ? summary.name : failed ? `Campaign ${id.slice(0, 8)}… could not be read` : <i className="lc-skel egdk-campaign__skel" />}</strong>
      </div>
      {summary ? (
        <dl className="egdk-campaign__facts">
          <div><dt>Targets</dt><dd>{fmtInt(summary.targets)}</dd></div>
          <div><dt>{unitNoun}</dt><dd>{unit === null || unit === undefined ? '—' : fmtInt(unit)}</dd></div>
          <div><dt>Sent</dt><dd>{fmtInt(summary.queue.sent)}</dd></div>
          <div><dt>Delivered</dt><dd>{fmtInt(summary.queue.delivered)}</dd></div>
          <div><dt>Failed</dt><dd>{fmtInt(summary.queue.failed)}</dd></div>
          <div><dt>Waiting</dt><dd>{fmtInt(summary.queue.waiting)}</dd></div>
          {summary.status ? <div><dt>Status</dt><dd className="is-text">{summary.status}</dd></div> : null}
        </dl>
      ) : <span className="egdk-campaign__fill" />}
      <div className="egdk-campaign__actions">
        {onOpenGrid ? <LCButton size="sm" variant="quiet" icon="list" onClick={onOpenGrid} title="Every target, every column">All columns</LCButton> : null}
        <LCButton size="sm" variant="quiet" icon="x" onClick={onClear} title="Remove the campaign scope">Clear</LCButton>
      </div>
    </div>
  )
}
