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
import { SignalBadges, signalLines, signalRowHeight } from './SignalBadges'
import { propertySignals } from '../mobile/property-signals'
import { DeskCampaignStack, stackScopeSupported, type StackResult } from './DeskCampaignStack'
import { deskSearch, initialDeskState, withViewFilters, writeSessionDeskState, type DeskState } from './desk-state'
import { useOutreachStates } from './desk-outreach'
import { equityDisplay } from '../equity-display'
import { absorbPageAttachments, completePageParams, pageKey } from './desk-page'
import { buildSelectionDetail, publishSelection, selectionSignature } from './desk-selection'
import { useAppInstance } from '../../desktop/workspace/instance-context'
import { DeskGraph } from './DeskGraph'
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
  const [deskInit] = useState<DeskState>(() => initialDeskState(new URLSearchParams(location.split('?')[1] ?? '')))
  const initialParams = useMemo(() => new URLSearchParams(location.split('?')[1] ?? ''), []) // eslint-disable-line react-hooks/exhaustive-deps

  const [scope, setScope] = useState<EntityScope>(deskInit.scope)
  const [contactSubtype, setContactSubtype] = useState<'phone' | 'email'>(deskInit.contactSubtype)
  const [query, setQuery] = useState(deskInit.query)
  const [debouncedQuery, setDebouncedQuery] = useState(deskInit.query.trim())
  const [filtersByScope, setFiltersByScope] = useState<DeskState['filtersByScope']>(deskInit.filtersByScope)
  const filters = filtersByScope[scope] ?? NO_FILTERS
  const setFilters = (next: EntityGraphFieldFilter[]) => setFiltersByScope((cur) => ({ ...cur, [scope]: next }))
  const [center, setCenter] = useState<'grid' | 'graph'>(deskInit.center)
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

  // [persistence] write the state back: session (every scope) + this pane's URL
  useEffect(() => {
    const state: DeskState = { scope, query: debouncedQuery, filtersByScope, center, graphFull: center === 'graph' && graphFull, contactSubtype }
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
  }, [scope, debouncedQuery, filtersByScope, center, graphFull, contactSubtype]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 260)
    return () => window.clearTimeout(t)
  }, [query])

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

  useEffect(() => {
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
  }, [signature, cursor])

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

  /* ── Selection → the agent (contract: agent-context.ts) ────────────────── */
  const instanceId = useAppInstance().instanceId
  const publishedSig = useRef('')
  useEffect(() => {
    const selectedIds = [...selected].filter((k) => k.startsWith('property:')).map((k) => k.slice('property:'.length))
    const focusId = anchor?.type === 'property' ? anchor.id : null
    const focusRow = focusId ? rows.find((r) => r.entityType === 'property' && r.entityId === focusId) : null
    const focusAddress = focusId
      ? (network?.properties.find((p) => p.id === focusId)?.address ?? (focusRow ? [focusRow.title, focusRow.subtitle].filter(Boolean).join(', ') : null))
      : null
    const detail = buildSelectionDetail({ scope, selectedPropertyIds: selectedIds, focused: focusId ? { property_id: focusId, address: focusAddress || null } : null, instanceId })
    const sig = selectionSignature(detail)
    if (sig === publishedSig.current) return
    publishedSig.current = sig
    publishSelection(detail)
  }, [selected, anchor, scope, rows, network, instanceId])

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
      width: Math.round(c.width * 1.18) + 12,
      minWidth: 64,
      align: c.align === 'right' ? 'right' : 'left',
      // whole-cohort server sort, or not sortable (never a sort of just the loaded rows)
      sortable: Boolean(c.sortBy) && !searching,
      hint: searching ? `${c.label} · search results are ranked by match — sort is off while searching`
        : c.sortBy ? `${c.label} · sorts the whole filtered cohort (server)`
          : `${c.label} · not sortable: the database has no whole-cohort order for it${c.source ? ` · ${c.source}` : ''}`,
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
  }, [scope, visibleKeys, searching])

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
  const total = isCurrent ? list.total : null
  const noun = scopeNoun(scope, total ?? 2)
  const summary = loading
    ? 'Reading the universe…'
    : list.error && !results.length
      ? 'This cohort could not be read'
      : `${total !== null ? fmtCount(total) : 'Uncounted'} ${noun}${searching ? ` matching “${debouncedQuery}”` : ''}${filters.length ? ` · ${filters.length} ${filters.length === 1 ? 'filter' : 'filters'}` : ''}`
  const sortNote = !isCurrent ? null
    : list.sortApplied === false ? 'The server could not apply that order — showing its fallback order'
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
    <section ref={rootRef} className={cx('egdk', `is-${themeMode}`, narrow && 'is-narrow', wide && 'is-wide', !railShown && 'is-rail-hidden', narrow && railShown && 'is-rail-over', inspectorOpen && inspectorMode === 'dock' && 'has-dock', center === 'graph' && graphFull && 'is-graph-full')} data-scope={scope}>
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
        <LCIconButton icon="filter" label={railShown ? 'Collapse filters' : 'Show filters'} size="sm" selected={railShown} count={filters.length || null} onClick={() => { if (narrow) { setRailOverOpen((o) => !o); return } if (!railShown && graphFold) { setRailGraphOverride(true); return } setRailGraphOverride(false); setRailCollapsed(railShown) }} className="egdk-bar__rail" />
        <LCTabs items={scopeTabs} value={scope} onChange={(id) => { setScope(id as EntityScope); setSelected(new Set()) }} label="Entity scope" variant="line" className="egdk-bar__tabs" />
        <div className="egdk-bar__tools">
          {stackScopeSupported(scope) ? (
            <LCButton size="sm" variant="secondary" icon="target" onClick={() => openStack(selectedRows.map((r) => r.entityId))} title="Pin this cohort (or the selected rows) on a draft campaign — nothing is sent">
              Add to campaign
            </LCButton>
          ) : null}
          <LCSegmented size="sm" label="View" value={center} onChange={(v) => { setCenter(v as 'grid' | 'graph'); if (v === 'grid') setGraphFull(false) }} options={[{ value: 'grid', icon: 'list', label: 'Grid' }, { value: 'graph', icon: 'layers', label: 'Graph' }]} />
          {center === 'graph' ? <LCIconButton icon="maximize" label="Fullscreen graph (Esc to exit)" size="sm" selected={graphFull} onClick={() => setGraphFull((f) => !f)} /> : null}
        </div>
      </div>

      <div className="egdk-body">
        {narrow && !railShown ? <DeskFilterRail scope={scope} filters={filters} onChange={setFilters} collapsed onCollapsedChange={() => setRailOverOpen(true)} />
          : <DeskFilterRail scope={scope} filters={filters} onChange={setFilters} collapsed={!railShown} onCollapsedChange={(c) => { if (narrow) { setRailOverOpen(!c); return } if (!c && graphFold) { setRailGraphOverride(true); return } setRailGraphOverride(false); setRailCollapsed(c) }} />}
        <main className="egdk-center" aria-label={center === 'grid' ? 'Records' : 'Relationship view'}>
          {center === 'grid' ? (
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
                rowHeight={signalsVisible ? (r, colWidth) => signalRowHeight(signalLines(propertySignals(r).map((x) => x.label), colWidth('flags') ?? 390), 30) : undefined}
                density="dense"
                loading={loading}
                error={isCurrent && list.error && !list.unsupported ? { what: 'These records didn’t load', onRetry: () => setList(EMPTY_LIST) } : null}
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
