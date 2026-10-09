import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCIconButton, LCSegmented, LCSelect, LCTabs } from '../../../shared/lc'
import { useBreakpoint } from '../../mobile/useBreakpoint'
import { buildEntityGraphActions } from '../../../domain/entity-graph/entity-graph-actions'
import {
  fetchEntityGraphDossier,
  fetchEntityGraphList,
  fetchEntityGraphTabCounts,
} from '../../../domain/entity-graph/entity-graph-api'
import {
  fetchCohortPropertyIds,
  fetchComposition,
  fetchCompositionCatalog,
  type Composition,
  type CompositionDimension,
} from '../../../domain/entity-graph/entity-graph-intel-api'
import type {
  EntityGraphAction,
  EntityGraphDossier,
  EntityGraphFilters,
  EntityGraphTabCounts,
  EntitySearchResult,
  UniversalEntityContext,
} from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_ENTITY_GRAPH_FILTERS } from '../../../domain/entity-graph/entity-graph.types'
import { fieldFiltersToApiParams, filtersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import { completeFieldFilters } from '../../../domain/entity-graph/entity-graph-field-filters'
import {
  selectedEntityFromResult,
  selectedEntityToContext,
  dossierApiType,
} from '../../../domain/entity-graph/selected-entity'
import { EntityGraphMobileRow } from './EntityGraphMobileRow'
import { EntityGraphMobileTable } from './EntityGraphMobileTable'
import {
  IDENTITY_SORT_COLUMN,
  SCOPE_TABLE_COLUMNS,
  defaultVisibleColumns,
  nextHeaderSort,
  sortLoadedRows,
  visibleEnrichmentFields,
  type TableColumn,
} from './entity-graph-table-columns'
import { IDENTITY_COLUMN_KEY, useEntityGraphTableLayout } from './entity-graph-table-layout'
import { useEntityGraphColumns } from './use-entity-graph-columns'
import { EntityGraphColumnSheet } from './EntityGraphColumnSheet'
import { EntityGraphMobileGraph } from './EntityGraphMobileGraph'
import { EntityGraphComposition } from './EntityGraphComposition'
import { EntityGraphUniverseOverview } from './EntityGraphUniverseOverview'
import { EntityGraphCampaignSheet } from './EntityGraphCampaignSheet'
import { saveSegment, type SavedSegment } from './entity-graph-segments'
import { EntityGraphMobileFilterSheet } from './EntityGraphMobileFilterSheet'
import { EntityGraphMobileDetailSheet } from './EntityGraphMobileDetailSheet'
import { EntityGraphMobileSelectionDock, type BulkAction } from './EntityGraphMobileSelectionDock'
import {
  MOBILE_SCOPES,
  SCOPE_DEFAULT_SORT_KEY,
  SCOPE_SORTS,
  countActiveFilters,
  compactCount,
  resolveIdentity,
  scopeNoun,
  scopeForEntityType,
  tabForScope,
  type EntityScope,
} from './entity-graph-mobile-format'
import './entity-graph-mobile.css'
import './entity-graph-mobile-liquid.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const PAGE_SIZE = 25

const SEARCH_PLACEHOLDER = 'Address, owner, person, phone, email, entity…'

/** Scopes the composition endpoint can break down. Others show the count only. */
const COMPOSITION_TABS = new Set(['properties', 'buyers'])

type ViewMode = 'cards' | 'table' | 'graph'

const VIEW_MODES: Array<{ key: ViewMode; label: string; icon: 'grid' | 'list' | 'layers' }> = [
  { key: 'cards', label: 'Cards', icon: 'grid' },
  { key: 'table', label: 'Table', icon: 'list' },
  { key: 'graph', label: 'Graph', icon: 'layers' },
]

type Props = {
  themeMode?: string
  universalContext: UniversalEntityContext
  onUniversalContextChange: (context: UniversalEntityContext) => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  /** Opens the hero relationship network for a record (the console's stage). */
  onOpenNetwork?: (result: EntitySearchResult) => void
  /** Opens the buyer intelligence inspector. */
  onOpenBuyer?: (buyerId: string) => void
  /** Hands a set of properties to the Map, emphasised. */
  onShowOnMap?: (points: Array<{ propertyId: string; lat?: number | null; lng?: number | null; address?: string | null }>) => void
  /** A saved segment to restore (from the console / deep link). */
  restoreSegment?: SavedSegment | null
}

const resultKey = (result: EntitySearchResult) => `${result.entityType}:${result.entityId}`

/** Stable empty references so derived values don't churn identity per render. */
const EMPTY_RESULTS: EntitySearchResult[] = []
const EMPTY_NOTES: string[] = []

type ListState = {
  /** The query this record answers. Anything else is stale by definition. */
  signature: string
  /** Highest page cursor folded into `results`. */
  cursor: number
  results: EntitySearchResult[]
  total: number | null
  hasMore: boolean
  notes: string[]
  /** false when the server could not apply the requested sort (fallback order). */
  sortApplied: boolean | null
  /** Keyset continuation token for the next page (whole-cohort sorts). */
  nextAfter: string | null
  error: string | null
}

const EMPTY_LIST_STATE: ListState = {
  signature: '',
  cursor: 0,
  results: EMPTY_RESULTS,
  total: null,
  hasMore: false,
  notes: EMPTY_NOTES,
  sortApplied: null,
  nextAfter: null,
  error: null,
}

type DossierState = { key: string; data: EntityGraphDossier | null }

export function EntityGraphMobile({
  themeMode = 'dark',
  universalContext,
  onUniversalContextChange,
  onAction,
  onOpenNetwork,
  onOpenBuyer,
  onShowOnMap,
  restoreSegment,
}: Props) {
  const [scope, setScope] = useState<EntityScope>('properties')
  /** "All" — the interconnected universe overview (no query). */
  const [universeAll, setUniverseAll] = useState(false)
  const [sortKey, setSortKey] = useState<string>(SCOPE_DEFAULT_SORT_KEY.properties)
  const [contactSubtype, setContactSubtype] = useState<'phone' | 'email'>('phone')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [filters, setFilters] = useState<EntityGraphFilters>({ ...EMPTY_ENTITY_GRAPH_FILTERS })
  const [fieldFilters, setFieldFilters] = useState<EntityGraphFieldFilter[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)

  /**
   * One signature-tagged record instead of six loose pieces of list state.
   * Loading and error are *derived* from whether the record matches the query
   * currently on screen, so changing scope cannot flash the previous scope's
   * rows and a late response for an abandoned query cannot land in the list.
   */
  const [list, setList] = useState<ListState>(EMPTY_LIST_STATE)
  const [cursor, setCursor] = useState(0)
  const [counts, setCounts] = useState<EntityGraphTabCounts | null>(null)

  const [viewMode, setViewMode] = useState<ViewMode>('cards')
  /**
   * GLOBAL SEARCH MEANS THE WHOLE CORPUS, NOT THE ACTIVE TAB.
   *
   * The search box advertises "Address, owner, person, phone, email, entity…"
   * and was wired to `tab: tabForScope(scope)` -- so it could only ever answer
   * with whichever tab the operator was standing in. Measured 2026-09-14:
   * q="Bertha" from Properties returned 8 streets named Bertha and none of the
   * 17 OWNERS named Bertha; q="9012812981", a real phone in the corpus,
   * returned 0 from every tab.
   *
   * While a query is active the request goes cross-type and each row renders as
   * its own type. Tapping a scope chip narrows back to that one type, which is
   * the in-tab search that used to be the only behaviour.
   */
  /**
   * DESKTOP SEARCHES THE SCOPE ON SCREEN. The desk table is one entity type,
   * and a cross-type search merges seven per-type lists capped at 25 each:
   * "Atlanta" read "84 properties" (the merged length) with blank columns.
   * On a desk the query stays in the active scope (an exact count, full
   * rows); the All chip still asks every type. Phones keep cross-type first.
   */
  const { isModernDesktop } = useBreakpoint()
  const [searchScopeLocked, setSearchScopeLocked] = useState(isModernDesktop)
  const [columnsOpen, setColumnsOpen] = useState(false)
  /** Visible columns + header sort, per scope, persisted per operator. */
  const { layout: tableLayout, setColumns: setScopeColumns, setSort: setHeaderSort } = useEntityGraphTableLayout()
  const [sortNotice, setSortNotice] = useState<{ scope: EntityScope; text: string } | null>(null)

  // Composition: signature-tagged like the list, so a late response for an
  // abandoned cohort is never shown and `loading` is derived.
  const [dimensionByScope, setDimensionByScope] = useState<Record<string, string>>({})
  const [dimensions, setDimensions] = useState<Record<string, CompositionDimension[]>>({})
  const [compositionState, setCompositionState] = useState<{ signature: string; data: Composition | null; error: boolean }>(
    { signature: '', data: null, error: false },
  )
  const [compositionRetry, setCompositionRetry] = useState(0)
  const [compositionCollapsed, setCompositionCollapsed] = useState(false)

  const [campaignOpen, setCampaignOpen] = useState(false)
  /** "Select all matching" — explicit property ids for the whole cohort. */
  const [cohortSelection, setCohortSelection] = useState<{ signature: string; ids: string[]; points: Array<{ id: string; lat: number; lng: number }>; truncated: boolean } | null>(null)
  const [selectingAll, setSelectingAll] = useState(false)
  const [graphFullscreen, setGraphFullscreen] = useState(false)
  const [graphState, setGraphState] = useState<{ key: string; anchor: EntitySearchResult | null; dossier: EntityGraphDossier | null }>(
    { key: '', anchor: null, dossier: null },
  )

  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  const [openResult, setOpenResult] = useState<EntitySearchResult | null>(null)
  const [dossierState, setDossierState] = useState<DossierState>({ key: '', data: null })

  const [toast, setToast] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement | null>(null)
  const listGenerationRef = useRef(0)

  /**
   * DESKTOP COMPOSITION. On a wide screen the same surface recomposes for
   * width: the Lens moves into a left rail, the record inspector docks beside
   * the list instead of covering it, and a pane with room opens on the table.
   * Phones never take this path (isModernDesktop is false on every phone), so
   * their DOM is exactly what it was.
   */
  const rootRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    // Decided once, before first paint, from the pane this surface actually
    // has: a desk pane with room for columns opens on the data table; a narrow
    // split pane keeps the phone's cards.
    if (isModernDesktop && (rootRef.current?.clientWidth ?? 0) >= 720) setViewMode('table')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const dossierGenerationRef = useRef(0)
  /**
   * The entity id whose universal-context arrival has already been acted on.
   * Without it the deep-link handler re-opened the sheet on the very next
   * render after the user closed it — opening a row publishes that row into the
   * universal context, so closing left a context that still matched a loaded
   * row and the sheet reappeared. The sheet was effectively undismissable.
   *
   * State rather than a ref: it is read and written during render, where a ref
   * write would not survive StrictMode's discarded first pass.
   */
  const [handledContextId, setHandledContextId] = useState<string | null>(null)

  // The catalog filters count toward the chip badge too, or an operator with
  // four field filters is told there are none.
  const activeFilterCount = countActiveFilters(filters, scope) + completeFieldFilters(fieldFilters).length

  // Contacts browse one subtype at a time, so the header must report the
  // subtype's universe. The chip's combined 287,089 next to a list of 121,434
  // phones reads as a broken count.
  const scopeTotal = !counts
    ? null
    : scope === 'contact_methods'
      ? (contactSubtype === 'phone' ? counts.phones : counts.emails)
      : (counts[MOBILE_SCOPES.find((s) => s.key === scope)!.countKey as keyof EntityGraphTabCounts] as number)

  const scopeTotalNoun = scope === 'contact_methods'
    ? (contactSubtype === 'phone' ? 'phones' : 'emails')
    : scopeNoun(scope, scopeTotal ?? 2)

  /* ── Toast ─────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  /* ── Debounced query ───────────────────────────────────────────────────── */
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 280)
    return () => window.clearTimeout(timer)
  }, [query])

  /* ── Scope totals ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController()
    void fetchEntityGraphTabCounts(controller.signal)
      .then(setCounts)
      .catch(() => setCounts(null))
    return () => controller.abort()
  }, [])

  /* ── Query identity + derived list view ────────────────────────────────── */
  // A query goes cross-type unless the operator has narrowed to one type by
  // tapping a scope chip. No query means browsing this tab, which is never
  // cross-type.
  const crossTypeSearch = Boolean(debouncedQuery) && !searchScopeLocked

  /**
   * Header sort. A column the browse adapter can order by (`sortBy`, or the
   * identity column) sorts server-side across the whole cohort; anything else
   * — and every column while a search is active, since search results are
   * ranked, not ordered — sorts the loaded rows and says so.
   */
  const headerSort = viewMode === 'table' ? tableLayout.sort[scope] ?? null : null
  /** The pinned identity column, as a sortable column (sorted by its primary label). */
  const identityColumn = useMemo<TableColumn>(
    () => ({ key: IDENTITY_COLUMN_KEY, label: 'Name', group: 'overview', unit: 'text', width: 0, render: (r) => resolveIdentity(scope, r).primary || null }),
    [scope],
  )
  const headerSortKey = headerSort?.key ?? null
  const headerColumn = useMemo<TableColumn | null>(() => {
    if (!headerSortKey) return null
    if (headerSortKey === IDENTITY_COLUMN_KEY) return identityColumn
    return SCOPE_TABLE_COLUMNS[scope].find((c) => c.key === headerSortKey) ?? null
  }, [headerSortKey, identityColumn, scope])
  const headerServerColumn = headerSort
    ? (headerSort.key === IDENTITY_COLUMN_KEY ? IDENTITY_SORT_COLUMN[scope] : headerColumn?.sortBy ?? null)
    : null
  const serverHeaderSort = headerSort && headerServerColumn && !debouncedQuery
    ? { sortBy: headerServerColumn, ascending: headerSort.dir === 'asc' }
    : null
  const localHeaderDir = headerSort && !serverHeaderSort && headerColumn ? headerSort.dir : null
  const localHeaderSort = useMemo(
    () => (localHeaderDir && headerColumn ? { column: headerColumn, dir: localHeaderDir } : null),
    [localHeaderDir, headerColumn],
  )
  const sortSignature = serverHeaderSort ? `h:${serverHeaderSort.sortBy}:${serverHeaderSort.ascending ? 1 : 0}` : sortKey

  const querySignature = `${scope}|${sortSignature}|${debouncedQuery}|${contactSubtype}|${crossTypeSearch}|${JSON.stringify(filters)}|${JSON.stringify(fieldFilters)}`

  // Adjusting state during render rather than in an effect: this is the
  // documented way to reset state when an input changes, and it avoids both the
  // extra render pass and the visible flash of stale rows an effect causes.
  const [renderedSignature, setRenderedSignature] = useState(querySignature)
  if (renderedSignature !== querySignature) {
    setRenderedSignature(querySignature)
    setCursor(0)
    setSelectedKeys(new Set())
  }

  const isCurrent = list.signature === querySignature
  const results = isCurrent ? list.results : EMPTY_RESULTS
  const total = isCurrent ? list.total : null
  const hasMore = isCurrent ? list.hasMore : false
  const notes = isCurrent ? list.notes : EMPTY_NOTES
  const loadError = isCurrent ? list.error : null
  const loading = !isCurrent
  const loadingMore = isCurrent && cursor > list.cursor

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
    // A narrow desk pane scrolls the body (Lens + list together), as the phone does.
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [querySignature])

  /* ── Composition ───────────────────────────────────────────────────────── */
  // Keyed on scope + dimension + filters. The text query is not a composition
  // dimension (search has no facet support), so while searching the chart
  // says it describes the filter set, not the search results.
  const compositionTab = COMPOSITION_TABS.has(scope) ? scope : null
  const scopeDimensions = compositionTab ? (dimensions[compositionTab] ?? []) : []
  const dimensionKey = compositionTab ? (dimensionByScope[compositionTab] ?? scopeDimensions[0]?.key ?? null) : null
  const compositionSignature = `${compositionTab}|${dimensionKey}|${JSON.stringify(filters)}|${JSON.stringify(fieldFilters)}|${compositionRetry}`
  const compositionIsCurrent = compositionState.signature === compositionSignature
  const composition = compositionIsCurrent ? compositionState.data : (compositionState.data?.dimension?.key === dimensionKey ? compositionState.data : null)
  const compositionLoading = Boolean(compositionTab && dimensionKey) && !compositionIsCurrent
  const compositionError = compositionIsCurrent && compositionState.error

  useEffect(() => {
    if (!compositionTab || dimensions[compositionTab]) return
    const controller = new AbortController()
    void fetchCompositionCatalog(compositionTab, controller.signal)
      .then((dims) => setDimensions((current) => ({ ...current, [compositionTab]: dims })))
      .catch(() => { /* chart stays hidden */ })
    return () => controller.abort()
  }, [compositionTab, dimensions])

  useEffect(() => {
    if (!compositionTab || !dimensionKey || compositionCollapsed) return
    const controller = new AbortController()
    const requestSignature = compositionSignature
    void fetchComposition({
      tab: compositionTab,
      dimension: dimensionKey,
      // Desk: every value of a categorical facet (searchable list), not the top nine.
      ...(isModernDesktop ? { all: '1' } : {}),
      ...filtersToApiParams(filters),
      ...fieldFiltersToApiParams(fieldFilters),
    }, controller.signal)
      .then((data) => setCompositionState({ signature: requestSignature, data, error: !data }))
      .catch(() => {
        if (controller.signal.aborted) return
        setCompositionState({ signature: requestSignature, data: null, error: true })
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositionSignature, compositionCollapsed])

  const toggleFieldFilter = useCallback((filter: EntityGraphFieldFilter) => {
    setFieldFilters((current) => {
      const same = current.find((f) => f.field_key === filter.field_key
        && f.operator === filter.operator
        && JSON.stringify(f.value ?? null) === JSON.stringify(filter.value ?? null))
      if (same) return current.filter((f) => f !== same)
      // One bucket per field: tapping another bucket of the same field swaps it.
      return [...current.filter((f) => f.field_key !== filter.field_key), filter]
    })
  }, [])

  /* ── Fetch a page ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController()
    const generation = ++listGenerationRef.current
    const requestSignature = querySignature
    const requestCursor = cursor

    const sortOptions = SCOPE_SORTS[scope]
    const sort = serverHeaderSort ?? sortOptions.find((s) => s.key === sortKey) ?? sortOptions[0]
    void fetchEntityGraphList(
      {
        tab: crossTypeSearch ? 'all' : tabForScope(scope),
        q: debouncedQuery || undefined,
        cursor,
        page_size: PAGE_SIZE,
        // Keyset sorts continue from the last row, never by offset: page 2 is
        // exactly what follows page 1 in the whole-cohort order.
        ...(requestCursor > 0 && list.signature === requestSignature && list.nextAfter ? { after: list.nextAfter } : {}),
        subtype: scope === 'contact_methods' ? contactSubtype : undefined,
        sort_by: sort.sortBy,
        ascending: sort.ascending ? '1' : '0',
        // Property rows carry the owner + contact chain; the desktop table does
        // not need the extra round trips, so it stays opt-in.
        ...(scope === 'properties' ? { include_links: '1' } : {}),
        ...filtersToApiParams(filters),
        ...fieldFiltersToApiParams(fieldFilters),
      },
      controller.signal,
    )
      .then((response) => {
        if (generation !== listGenerationRef.current) return
        setList((current) => {
          const appending = requestCursor > 0 && current.signature === requestSignature
          // One row per entity, within a page as well as across pages: a page
          // can carry the same entity twice (desktop QA 2026-09-30: React
          // "two children with the same key" on /entity-graph).
          const seen = new Set(appending ? current.results.map(resultKey) : [])
          const fresh = response.results.filter((row) => {
            const key = resultKey(row)
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          const merged = appending ? [...current.results, ...fresh] : fresh
          return {
            signature: requestSignature,
            cursor: requestCursor,
            results: merged,
            // Keyset continuation pages do not re-count; keep page 1's count.
            total: appending && response.pagination.total === null ? current.total : response.pagination.total,
            hasMore: response.pagination.hasMore,
            nextAfter: response.pagination.nextAfter ?? null,
            notes: response.pagination.notes ?? EMPTY_NOTES,
            sortApplied: response.pagination.sort ? response.pagination.sort.sortApplied : null,
            error: null,
          }
        })
      })
      .catch((error: unknown) => {
        if (generation !== listGenerationRef.current) return
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : 'load_failed'
        // A first page that fails under a non-default order (a persisted header
        // sort, a heavy Sort-menu choice) falls back to the default order with a
        // notice, instead of leaving the operator an empty table on every reload.
        if (requestCursor === 0 && !debouncedQuery && (serverHeaderSort || sortKey !== SCOPE_DEFAULT_SORT_KEY[scope])) {
          setSortNotice({ scope, text: 'That sort did not finish in time — showing the default order.' })
          if (serverHeaderSort) setHeaderSort(scope, null)
          else setSortKey(SCOPE_DEFAULT_SORT_KEY[scope])
        }
        // Tag the failure with the signature so `loading` resolves and the
        // operator sees the error instead of an endless skeleton. A failed
        // "load more" keeps the rows already on screen.
        setList((current) => (
          requestCursor > 0 && current.signature === requestSignature
            ? { ...current, cursor: requestCursor, error: message }
            : { ...EMPTY_LIST_STATE, signature: requestSignature, cursor: requestCursor, error: message }
        ))
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySignature, cursor])

  /* ── Dossier for the open record ───────────────────────────────────────── */
  // Same shape as the list: the dossier carries the key it answers, so
  // "loading" is derived rather than a separate flag toggled inside an effect.
  const openKey = openResult ? resultKey(openResult) : ''
  const openEntity = openResult ? selectedEntityFromResult(openResult) : null
  const openApiType = openEntity ? dossierApiType(openEntity) : null
  const dossier = dossierState.key === openKey ? dossierState.data : null
  // An entity with no dossier endpoint is not "loading" — it has nothing to load.
  const dossierLoading = Boolean(openApiType && openEntity?.id) && dossierState.key !== openKey

  useEffect(() => {
    const entityId = openEntity?.id
    if (!openResult || !openApiType || !entityId) return
    const apiType = openApiType
    const key = openKey

    const controller = new AbortController()
    const generation = ++dossierGenerationRef.current

    void fetchEntityGraphDossier(apiType, entityId, { signal: controller.signal })
      .then((next) => {
        if (generation !== dossierGenerationRef.current) return
        setDossierState({ key, data: next })
      })
      .catch(() => {
        if (generation !== dossierGenerationRef.current) return
        setDossierState({ key, data: null })
      })

    return () => controller.abort()
  }, [openApiType, openEntity, openKey, openResult])

  /* ── Graph anchor ──────────────────────────────────────────────────────── */
  // The graph anchors on the open record if there is one, else the first row of
  // the current cohort — it always starts from a real record and grows by tap,
  // never from the whole universe.
  const graphCandidate = openResult ?? results[0] ?? null
  const graphKey = graphCandidate ? resultKey(graphCandidate) : ''
  const graphIsCurrent = graphState.key === graphKey
  const graphAnchor = graphIsCurrent ? graphState.anchor : null
  const graphDossier = graphIsCurrent ? graphState.dossier : null
  const graphLoading = Boolean(graphCandidate) && !graphIsCurrent

  /**
   * The dossier is fetched for the SCOPE STRIP as well as the graph, so the
   * landing state can state relationship scope (§9) without the operator first
   * switching to the graph tab. It was gated on `viewMode === 'graph'`, which is
   * why nothing above the fold ever knew an owner had seven properties.
   */
  useEffect(() => {
    // Only the in-list graph fallback needs this; the network host has its own.
    if (!graphCandidate || viewMode !== 'graph' || onOpenNetwork) return
    const entity = selectedEntityFromResult(graphCandidate)
    const apiType = dossierApiType(entity)
    if (!apiType || !entity.id) return

    const controller = new AbortController()
    let cancelled = false
    const requestKey = graphKey
    void fetchEntityGraphDossier(apiType, entity.id, { signal: controller.signal })
      .then((next) => {
        if (cancelled) return
        setGraphState({ key: requestKey, anchor: graphCandidate, dossier: next })
      })
      .catch(() => {
        if (cancelled) return
        setGraphState({ key: requestKey, anchor: graphCandidate, dossier: null })
      })

    return () => { cancelled = true; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey, viewMode])

  /* ── Deep links from elsewhere in the app open the sheet ───────────────── */
  /**
   * A DEEP LINK MUST NOT DEPEND ON THE RECORD BEING ON SCREEN ALREADY.
   *
   * This only searched the 25 loaded rows, so arriving from another app landed
   * on the unfiltered universe with the requested record nowhere in sight.
   * Measured 2026-09-14: /entity-graph/property/278477219 (5115 Michigan Ave,
   * Kansas City) rendered "Showing 25 of 169,802" starting at 300 S 3rd St and
   * never opened the sheet -- the URL named the subject and the surface ignored
   * it, which is the last leg of the cross-app chain.
   *
   * The loaded page is still checked first (free, and the common case when the
   * operator taps a row). On a miss the record is resolved by id through the
   * search endpoint, which routes a long digit run or a prefixed id straight at
   * the id column, so this is one indexed lookup rather than a scan.
   */
  const deepLinkId = universalContext?.entityType ? universalContext.entityId : null
  if (deepLinkId && handledContextId !== deepLinkId) {
    const match = results.find((row) => row.entityId === deepLinkId)
    if (match) {
      setHandledContextId(deepLinkId)
      setOpenResult(match)
    }
  }

  useEffect(() => {
    if (!deepLinkId || handledContextId === deepLinkId) return undefined
    if (results.some((row) => row.entityId === deepLinkId)) return undefined
    const controller = new AbortController()
    let cancelled = false
    void fetchEntityGraphList(
      { tab: tabForScope(scopeForEntityType(universalContext?.entityType) ?? scope), q: deepLinkId, page_size: 5 },
      controller.signal,
    )
      .then((response) => {
        if (cancelled) return
        const exact = response.results.find((row) => row.entityId === deepLinkId)
        // No exact id match is NOT an invitation to open the closest thing.
        if (!exact) return
        setHandledContextId(deepLinkId)
        setOpenResult(exact)
      })
      .catch(() => { /* a failed lookup leaves the list as it was */ })
    return () => { cancelled = true; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, handledContextId, results, scope, universalContext?.entityType])

  /* ── Selection ─────────────────────────────────────────────────────────── */
  const toggleSelect = useCallback((result: EntitySearchResult) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      const key = resultKey(result)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const enterSelection = useCallback((result: EntitySearchResult) => {
    setSelectionMode(true)
    setSelectedKeys(new Set([resultKey(result)]))
  }, [])

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelectedKeys(new Set())
  }, [])

  const selectedResults = useMemo(
    () => results.filter((row) => selectedKeys.has(resultKey(row))),
    [results, selectedKeys],
  )

  const allPageSelected = results.length > 0 && selectedKeys.size >= results.length

  const handleSelectPage = useCallback(() => {
    setSelectedKeys((current) =>
      current.size >= results.length ? new Set() : new Set(results.map(resultKey)),
    )
  }, [results])

  /* ── Open a record ─────────────────────────────────────────────────────── */
  const openRecord = useCallback((result: EntitySearchResult) => {
    // A buyer opens the buyer intelligence inspector, not the seller dossier.
    if (result.entityType === 'buyer' && onOpenBuyer) {
      onOpenBuyer(result.entityId)
      return
    }
    setHandledContextId(result.entityId)
    setOpenResult(result)
    onUniversalContextChange(selectedEntityToContext(selectedEntityFromResult(result), result))
  }, [onOpenBuyer, onUniversalContextChange])

  const closeRecord = useCallback(() => {
    setHandledContextId(openResult?.entityId ?? null)
    setOpenResult(null)
  }, [openResult])

  const handleOpenEntity = useCallback((entityType: string, entityId: string) => {
    // Jump the graph without leaving the sheet: synthesise the minimum result
    // shape and let the dossier fetch fill in the rest.
    setHandledContextId(entityId)
    setOpenResult({
      entityType,
      entityId,
      title: entityId,
      badges: [],
      linkedCounts: {},
      contextIds: {},
    })
  }, [])

  const actionContext = useMemo(
    () => (openResult
      ? selectedEntityToContext(selectedEntityFromResult(openResult), openResult)
      : null),
    [openResult],
  )

  const actions = useMemo(
    () => (actionContext ? buildEntityGraphActions(actionContext, dossier?.threads?.length ?? 0) : []),
    [actionContext, dossier?.threads?.length],
  )

  const handleAction = useCallback((action: EntityGraphAction) => {
    if (!actionContext) return
    // Add to campaign from a record: that record becomes the selection and the
    // draft sheet opens right here (a DRAFT — Campaigns decides whether it sends).
    if (action === 'add_to_campaign' && openResult) {
      const record = openResult
      setCohortSelection(null)
      setSelectionMode(true)
      setSelectedKeys(new Set([resultKey(record)]))
      setList((current) => (current.results.some((r) => resultKey(r) === resultKey(record))
        ? current
        : { ...current, results: [record, ...current.results] }))
      closeRecord()
      setCampaignOpen(true)
      return
    }
    onAction?.(action, actionContext)
    closeRecord()
  }, [actionContext, closeRecord, onAction, openResult])

  /* ── Saved segments ────────────────────────────────────────────────────── */
  const handleSaveSegment = useCallback(() => {
    const segment = saveSegment({ scope, filters, fieldFilters, query: debouncedQuery, total })
    setToast(`Saved segment “${segment.name}”.`)
  }, [debouncedQuery, fieldFilters, filters, scope, total])

  // A segment handed in from outside (saved list, deep link) restores the cohort.
  const [restoredSegmentId, setRestoredSegmentId] = useState<string | null>(null)
  const [pendingSegment, setPendingSegment] = useState<SavedSegment | null>(null)
  const segmentInput = pendingSegment ?? restoreSegment ?? null
  if (segmentInput && segmentInput.id !== restoredSegmentId) {
    setRestoredSegmentId(segmentInput.id)
    setUniverseAll(false)
    setScope(segmentInput.scope)
    setSortKey(SCOPE_DEFAULT_SORT_KEY[segmentInput.scope])
    setFilters({ ...EMPTY_ENTITY_GRAPH_FILTERS, ...segmentInput.filters })
    setFieldFilters(segmentInput.fieldFilters)
    setQuery(segmentInput.query ?? '')
  }

  /* ── Select every property in the cohort ───────────────────────────────── */
  const cohortSignature = `${scope}|${JSON.stringify(filters)}|${JSON.stringify(fieldFilters)}`
  const activeCohortSelection = cohortSelection && cohortSelection.signature === cohortSignature ? cohortSelection : null
  const selectAllMatching = useCallback(() => {
    if (scope !== 'properties' || selectingAll) return
    setSelectingAll(true)
    const signature = cohortSignature
    void fetchCohortPropertyIds({ ...filtersToApiParams(filters), ...fieldFiltersToApiParams(fieldFilters), limit: 5000 })
      .then((result) => {
        if (!result) { setToast('Couldn’t gather the cohort — try again.'); return }
        setCohortSelection({ signature, ids: result.ids, points: result.points, truncated: result.truncated })
        setSelectionMode(true)
        setToast(result.truncated
          ? `Selected the first ${result.ids.length.toLocaleString()} matching properties (cap).`
          : `Selected all ${result.ids.length.toLocaleString()} matching properties.`)
      })
      .finally(() => setSelectingAll(false))
  }, [cohortSignature, fieldFilters, filters, scope, selectingAll])

  /* ── Bulk actions ──────────────────────────────────────────────────────── */
  const handleBulkAction = useCallback((action: BulkAction) => {
    if (action.unavailable) {
      setToast(`${action.label}: ${action.unavailable}`)
      return
    }
    if (action.key === 'list') {
      handleSaveSegment()
      return
    }
    const rows = activeCohortSelection
      ? activeCohortSelection.ids.map((id) => ({ entityType: 'property', entityId: id, title: id, badges: [], linkedCounts: {}, contextIds: { propertyId: id } }) as EntitySearchResult)
      : selectedResults
    if (rows.length === 0) return

    if (action.key === 'copy') {
      const ids = rows.map((row) => row.entityId).join('\n')
      void navigator.clipboard?.writeText(ids)
        .then(() => setToast(`Copied ${rows.length} ${scopeNoun(scope, rows.length)} ID${rows.length === 1 ? '' : 's'}.`))
        .catch(() => setToast('Clipboard unavailable in this browser.'))
      return
    }

    if (action.key === 'export') {
      exportCsv(scope, rows)
      setToast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to CSV.`)
      return
    }

    if (action.key === 'campaign') {
      setCampaignOpen(true)
      return
    }

    if (action.key === 'map' && rows[0]) {
      if (onShowOnMap && scope === 'properties') {
        const points = activeCohortSelection
          ? activeCohortSelection.points.map((p) => ({ propertyId: p.id, lat: p.lat, lng: p.lng }))
          : rows.map((row) => ({ propertyId: row.entityId, lat: row.details?.lat ?? null, lng: row.details?.lng ?? null, address: row.title }))
        onShowOnMap(points)
        return
      }
      const context = selectedEntityToContext(selectedEntityFromResult(rows[0]), rows[0])
      onAction?.('open_in_map', context)
    }
  }, [activeCohortSelection, handleSaveSegment, onAction, onShowOnMap, scope, selectedResults])

  /* ── Render ────────────────────────────────────────────────────────────── */
  const resolvedTheme = themeMode === 'light' ? 'light' : themeMode === 'red_ops' ? 'red_ops' : 'dark'
  const searching = Boolean(debouncedQuery)
  const sortOptions = SCOPE_SORTS[scope]
  const activeSort = sortOptions.find((s) => s.key === sortKey) ?? sortOptions[0]
  const scopeColumns = tableLayout.columns[scope] ?? defaultVisibleColumns(scope)
  const tableFields = useMemo(() => visibleEnrichmentFields(scope, scopeColumns), [scope, scopeColumns])
  const columnEnrichment = useEntityGraphColumns(results, tableFields, viewMode === 'table')
  /**
   * The server said it could not apply the requested order (no index drives
   * it): the page is in the fallback order, so sort what is loaded by the
   * requested column and say so.
   */
  const serverSortRefused = isCurrent && list.sortApplied === false
  const refusedLocalSort = useMemo(() => {
    if (!serverSortRefused || localHeaderSort) return null
    if (headerSort && headerColumn) return { column: headerColumn, dir: headerSort.dir }
    const column = SCOPE_TABLE_COLUMNS[scope].find((c) => c.sortBy === activeSort.sortBy)
      ?? (IDENTITY_SORT_COLUMN[scope] === activeSort.sortBy ? identityColumn : null)
    return column ? { column, dir: activeSort.ascending ? 'asc' as const : 'desc' as const } : null
  }, [serverSortRefused, localHeaderSort, headerSort, headerColumn, identityColumn, scope, activeSort.sortBy, activeSort.ascending])
  const effectiveLocalSort = localHeaderSort ?? refusedLocalSort
  const displayRows = useMemo(
    () => (effectiveLocalSort ? sortLoadedRows(scope, columnEnrichment.rows, effectiveLocalSort.column, effectiveLocalSort.dir) : columnEnrichment.rows),
    [columnEnrichment.rows, effectiveLocalSort, scope],
  )
  const tableRows = displayRows
  const listStatus = [
    sortNotice && sortNotice.scope === scope ? sortNotice.text : null,
    effectiveLocalSort ? `Sorted within ${displayRows.length.toLocaleString()} loaded rows` : null,
    viewMode === 'table' && columnEnrichment.loading ? 'Loading columns…' : null,
    viewMode === 'table' && columnEnrichment.error ? 'Some columns could not load — shown as —' : null,
  ].filter(Boolean).join(' · ') || null
  // The Lens counts the filter set, the list counts filter + search. When a
  // search is active they are different cohorts, so the Lens says so instead of
  // implying its composition describes the search results.
  const lensTotalForCampaign = searching ? null : (composition?.total ?? total)
  const campaignSelection = activeCohortSelection
    ? activeCohortSelection.ids.map((id) => ({ entityType: 'property', entityId: id, title: id, badges: [], linkedCounts: {}, contextIds: { propertyId: id } }) as EntitySearchResult)
    : selectedResults
  const selectedCount = activeCohortSelection ? activeCohortSelection.ids.length : selectedKeys.size

  // The adapter bounds the score column so the DESC index can drive the order;
  // that drops rows with no score. Say how many rather than let the operator
  // read 104,217 as the size of the property universe.
  const unrankedCount = notes.includes('score_order_excludes_unscored')
    && scopeTotal !== null && total !== null
    ? scopeTotal - total
    : null

  /**
   * What the total actually counts, so "Showing 25 of 104,217" is never read as
   * "the other 104,192 failed to load":
   *   · a search narrowed it        -> matching
   *   · a score sort ranked it      -> ranked (the unscored are excluded)
   *   · neither                     -> nothing to qualify
   */
  const countQualifier = searching
    ? ' matching'
    : unrankedCount !== null && unrankedCount > 0 ? ' ranked' : ''

  // The graph is the relationship network of a record. With a network host
  // available it opens full-bleed for the open record (or the first in the
  // cohort) instead of a thumbnail.
  const pickView = (key: ViewMode) => {
    if (key === 'graph' && onOpenNetwork) {
      const anchor = openResult ?? results[0]
      if (anchor) onOpenNetwork(anchor)
      return
    }
    setViewMode(key)
  }

  // Desk: LC segmented control + an icon tool for columns (phones keep the pills).
  const viewSwitch = isModernDesktop ? (
    <span className="egm-desk-views">
      <LCSegmented
        size="sm"
        label="View mode"
        value={viewMode}
        onChange={pickView}
        options={VIEW_MODES.map((entry) => ({ value: entry.key, label: entry.label, icon: entry.icon }))}
      />
      {viewMode === 'table' ? <LCIconButton icon="settings" label="Columns" size="sm" onClick={() => setColumnsOpen(true)} /> : null}
    </span>
  ) : (
    <div className="egm-views" role="tablist" aria-label="View mode">
      {VIEW_MODES.map((entry) => (
        <button
          key={entry.key}
          type="button"
          role="tab"
          aria-selected={viewMode === entry.key}
          className={cls('egm-view', viewMode === entry.key && 'is-active')}
          onClick={() => {
            // The graph is the relationship network of a record. With a
            // network host available it opens full-bleed for the open
            // record (or the first in the cohort) instead of a thumbnail.
            if (entry.key === 'graph' && onOpenNetwork) {
              const anchor = openResult ?? results[0]
              if (anchor) onOpenNetwork(anchor)
              return
            }
            setViewMode(entry.key)
          }}
        >
          <Icon name={entry.icon} />
          {entry.label}
        </button>
      ))}
      {viewMode === 'table' ? (
        <button type="button" className="egm-view is-aux" onClick={() => setColumnsOpen(true)} aria-label="Columns">
          <Icon name="settings" />
        </button>
      ) : null}
    </div>
  )

  const lens = compositionTab && !selectionMode ? (
    <EntityGraphComposition
      // A cross-type result count is matches of every type, never "properties".
      scopeNoun={crossTypeSearch ? 'matches · every type' : scopeTotalNoun}
      total={searching ? total : (composition?.total ?? total)}
      dimensions={scopeDimensions}
      dimensionKey={dimensionKey}
      composition={searching ? null : composition}
      loading={compositionLoading}
      error={compositionError}
      collapsed={compositionCollapsed || searching}
      fieldFilters={fieldFilters}
      cohortLabel={searching ? `matching “${debouncedQuery}”` : activeFilterCount > 0 ? `${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} · ${isModernDesktop ? 'click' : 'tap'} a bar to refine` : isModernDesktop ? 'Click a bar to filter' : 'Tap a bar to filter'}
      onToggleCollapsed={() => setCompositionCollapsed((c) => !c)}
      onPickDimension={(key) => setDimensionByScope((current) => ({ ...current, [compositionTab]: key }))}
      onToggleFilter={toggleFieldFilter}
      onRetry={() => setCompositionRetry((n) => n + 1)}
    />
  ) : null

  const detailSheet = (
    <EntityGraphMobileDetailSheet
      open={Boolean(openResult)}
      docked={isModernDesktop}
      scope={scope}
      result={openResult}
      dossier={dossier}
      loading={dossierLoading}
      actions={actions}
      onClose={closeRecord}
      onAction={handleAction}
      onOpenEntity={handleOpenEntity}
      onOpenBuyer={onOpenBuyer}
      onOpenGraph={openResult && onOpenNetwork ? () => { const r = openResult; closeRecord(); onOpenNetwork(r) } : undefined}
    />
  )

  /**
   * The desk body: Lens rail · list · docked inspector, laid out by the pane's
   * width (entity-graph-desktop.css). On a phone the list renders bare, as it
   * always has.
   */
  const deskBody = (list: ReactNode) => (isModernDesktop ? (
    <div ref={bodyRef} className={cls('egm-body', lens && 'has-rail', openResult && 'has-inspector')}>
      {lens ? <aside className="egm-rail" aria-label="Composition">{lens}</aside> : null}
      {list}
      {detailSheet}
    </div>
  ) : list)

  return (
    <section ref={rootRef} className={cls('egm', `is-${resolvedTheme}`, isModernDesktop && 'is-desk')}>
      <header className="egm-header">
        <div className="egm-header__id">
          <h1>Entity Graph</h1>
          <span className="egm-header__total">
            {scopeTotal !== null
              ? `${scopeTotal.toLocaleString()} ${scopeTotalNoun}`
              : isModernDesktop
                ? <i className="lc-skel egm-desk-skel" style={{ width: 112 }} role="status" aria-label="Counting" />
                : 'counting…'}
          </span>
        </div>

        <div className="egm-search">
          <span className="egm-search__icon"><Icon name="search" /></span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // A fresh query searches everything again (phone) or the scope on
              // screen (desk). Without this, one tap on a type chip would
              // silently narrow every later search too.
              setSearchScopeLocked(isModernDesktop)
            }}
            placeholder={SEARCH_PLACEHOLDER}
            aria-label="Search the entity universe"
            type="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="egm-search__clear egm-hit" onClick={() => { setQuery(''); setSearchScopeLocked(isModernDesktop) }} aria-label="Clear search">×</button>
          ) : null}
        </div>

        {isModernDesktop ? (
          <LCTabs
            className="egm-desk-scopes"
            label="Universe"
            value={(debouncedQuery ? crossTypeSearch : universeAll) ? 'all' : scope}
            items={[
              { id: 'all', label: 'All' },
              ...MOBILE_SCOPES.map((entry) => {
                const count = counts?.[entry.countKey as keyof EntityGraphTabCounts] as number | null | undefined
                return { id: entry.key as string, label: entry.label, count: typeof count === 'number' ? count : null }
              }),
            ]}
            onChange={(id) => {
              if (id === 'all') {
                if (debouncedQuery) setSearchScopeLocked(false)
                else setUniverseAll(true)
                exitSelection()
                return
              }
              const key = id as EntityScope
              setUniverseAll(false)
              if (scope !== key) {
                setScope(key)
                setSortKey(SCOPE_DEFAULT_SORT_KEY[key])
                setFieldFilters([])
              }
              setSearchScopeLocked(true)
              exitSelection()
            }}
          />
        ) : (
        <div className="egm-scopes" role="tablist" aria-label="Universe">
          {/* ALL: with a query it searches every type; without one it is the
              interconnected-universe overview. */}
          <button
            type="button"
            role="tab"
            aria-selected={debouncedQuery ? crossTypeSearch : universeAll}
            className={cls('egm-scope', 'egm-hit', 'is-all', (debouncedQuery ? crossTypeSearch : universeAll) && 'is-active')}
            onClick={() => {
              if (debouncedQuery) setSearchScopeLocked(false)
              else setUniverseAll(true)
              exitSelection()
            }}
          >
            <span>All</span>
          </button>
          {MOBILE_SCOPES.map((entry) => {
            const count = counts?.[entry.countKey as keyof EntityGraphTabCounts] as number | null | undefined
            const active = debouncedQuery ? (!crossTypeSearch && scope === entry.key) : (!universeAll && scope === entry.key)
            return (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={active}
                className={cls('egm-scope', 'egm-hit', `is-${entry.key}`, active && 'is-active')}
                onClick={() => {
                  setUniverseAll(false)
                  if (scope !== entry.key) {
                    setScope(entry.key)
                    setSortKey(SCOPE_DEFAULT_SORT_KEY[entry.key])
                    // Field filters are per-universe; a property filter means
                    // nothing to a buyer and would fail closed.
                    setFieldFilters([])
                  }
                  // Tapping a type while searching narrows to that type.
                  setSearchScopeLocked(true)
                  exitSelection()
                }}
              >
                <span>{entry.label}</span>
                {typeof count === 'number' ? <span className="egm-scope__count">{compactCount(count)}</span> : null}
              </button>
            )
          })}
        </div>
        )}
      </header>

      {universeAll && !debouncedQuery ? (
        <EntityGraphUniverseOverview
          counts={counts}
          onOpen={(target) => {
            setUniverseAll(false)
            setScope(target.scope)
            setSortKey(target.sortKey ?? SCOPE_DEFAULT_SORT_KEY[target.scope])
            setFilters({ ...EMPTY_ENTITY_GRAPH_FILTERS })
            setFieldFilters(target.fieldFilters ?? [])
            exitSelection()
          }}
        />
      ) : null}

      {!universeAll || debouncedQuery ? deskBody(
      <div className="egm-list" ref={listRef}>
          {/* On a desk the Lens lives in the left rail instead (deskBody). */}
          {isModernDesktop ? null : lens}

          {isModernDesktop ? null : viewSwitch}

      <div className="egm-toolbar is-sticky">
        <span className="egm-toolbar__count">
          {loading && results.length === 0 ? (
            isModernDesktop ? <i className="lc-skel egm-desk-skel" style={{ width: 132 }} role="status" aria-label="Loading records" /> : 'Loading…'
          ) : (
            <>
              {/* "loaded" implied the rest had failed to arrive. What is
                  actually true is that the operator is looking at a page of a
                  larger set, and the qualifier depends on why the set is that
                  size: a search narrowed it, or a score sort ranked it. */}
              Showing <b>{results.length.toLocaleString()}</b>
              {total !== null ? ` of ${total.toLocaleString()}` : ''}
              {countQualifier}
            </>
          )}
        </span>

        {/* Desk: one toolbar row — count, view, sort, filter, select. */}
        {isModernDesktop ? viewSwitch : null}

        {isModernDesktop ? (
          <>
            {scope === 'contact_methods' ? (
              <LCIconButton
                size="sm"
                icon={contactSubtype === 'phone' ? 'phone' : 'mail'}
                label={contactSubtype === 'phone' ? 'Showing phones. Click for emails.' : 'Showing emails. Click for phones.'}
                onClick={() => setContactSubtype((c) => (c === 'phone' ? 'email' : 'phone'))}
              />
            ) : null}
            {sortOptions.length > 1 ? (
              <LCSelect
                size="sm"
                variant="quiet"
                label="Sort"
                prefix="Sort"
                align="end"
                value={activeSort.key}
                onChange={(key) => { setSortKey(key); setHeaderSort(scope, null); setSortNotice(null) }}
                options={sortOptions.map((option) => ({ value: option.key, label: option.label }))}
              />
            ) : null}
            <LCButton size="sm" variant={activeFilterCount > 0 ? 'secondary' : 'quiet'} icon="filter" onClick={() => setFiltersOpen(true)}>
              {activeFilterCount > 0 ? `Filter · ${activeFilterCount}` : 'Filter'}
            </LCButton>
            <LCIconButton
              size="sm"
              icon="check-double"
              selected={selectionMode}
              label={selectionMode ? 'Exit selection' : 'Select records'}
              onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
            />
          </>
        ) : (
          <>
        {scope === 'contact_methods' ? (
          <button
            type="button"
            className={cls('egm-tool', 'egm-hit')}
            onClick={() => setContactSubtype((c) => (c === 'phone' ? 'email' : 'phone'))}
            aria-label={contactSubtype === 'phone' ? 'Showing phones. Tap for emails.' : 'Showing emails. Tap for phones.'}
          >
            <Icon name={contactSubtype === 'phone' ? 'phone' : 'mail'} />
          </button>
        ) : null}

        {sortOptions.length > 1 ? (
          <button
            type="button"
            className={cls('egm-tool', 'egm-hit')}
            onClick={() => {
              const index = sortOptions.findIndex((s) => s.key === activeSort.key)
              setSortKey(sortOptions[(index + 1) % sortOptions.length].key)
              setHeaderSort(scope, null)
            }}
            aria-label={`Sort: ${activeSort.label}. Tap to change.`}
          >
            <Icon name="trending-up" />
            {activeSort.label}
          </button>
        ) : null}

        <button
          type="button"
          className={cls('egm-tool', 'egm-hit', activeFilterCount > 0 && 'is-on')}
          onClick={() => setFiltersOpen(true)}
        >
          <Icon name="filter" />
          Filter
          {activeFilterCount > 0 ? <span className="egm-tool__badge">{activeFilterCount}</span> : null}
        </button>

        <button
          type="button"
          className={cls('egm-tool', 'egm-hit', selectionMode && 'is-on')}
          onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
          aria-label={selectionMode ? 'Exit selection' : 'Select records'}
        >
          <Icon name="check-double" />
        </button>
          </>
        )}
      </div>

        {loading && results.length === 0 ? (
          <div className="egm-skeleton">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="egm-skeleton__row" />)}
          </div>
        ) : null}

        {!loading && loadError ? (
          <div className="egm-empty">
            <strong>Could not load {scope.replace(/_/g, ' ')}</strong>
            <span>{loadError}</span>
            <div className="egm-empty__actions">
              <button type="button" className="egm-btn" onClick={() => setCursor(0)}>Retry</button>
            </div>
          </div>
        ) : null}

        {!loading && !loadError && results.length === 0 ? (
          <div className="egm-empty">
            <strong>No {scopeNoun(scope, 2)} match</strong>
            <span>
              {searching
                ? `Nothing in ${scope.replace(/_/g, ' ')} matches “${debouncedQuery}”. Search runs inside the selected scope — try another scope.`
                : activeFilterCount > 0
                  ? 'Every record was filtered out. Reset the filters to see the full universe.'
                  : 'This scope has no live records.'}
            </span>
            {activeFilterCount > 0 ? (
              <div className="egm-empty__actions">
                <button
                  type="button"
                  className="egm-btn"
                  onClick={() => {
                    setFilters({ ...EMPTY_ENTITY_GRAPH_FILTERS })
                    setFieldFilters([])
                  }}
                >
                  Reset filters
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {listStatus && displayRows.length > 0 && viewMode !== 'graph' ? <div className="egt-status" role="status">{listStatus}</div> : null}

        {viewMode === 'cards' ? displayRows.map((result) => (
          <EntityGraphMobileRow
            key={resultKey(result)}
            scope={scope}
            result={result}
            selectionMode={selectionMode}
            selected={selectedKeys.has(resultKey(result))}
            active={openResult?.entityId === result.entityId}
            onOpen={() => openRecord(result)}
            onToggleSelect={() => toggleSelect(result)}
            onEnterSelection={() => enterSelection(result)}
          />
        )) : null}

        {viewMode === 'table' && results.length > 0 ? (
          <EntityGraphMobileTable
            scope={scope}
            results={tableRows}
            visibleColumns={scopeColumns}
            headerSort={headerSort}
            fallbackSortBy={headerSort ? null : activeSort.sortBy}
            fallbackAscending={activeSort.ascending}
            selectionMode={selectionMode}
            selectedKeys={selectedKeys}
            activeId={openResult?.entityId ?? null}
            onSort={(key) => { setHeaderSort(scope, nextHeaderSort(headerSort, key)); setSortNotice(null) }}
            onOpen={openRecord}
            onToggleSelect={toggleSelect}
          />
        ) : null}

        {viewMode === 'graph' ? (
          <EntityGraphMobileGraph
            scope={scope}
            anchor={graphAnchor}
            initialNodes={graphDossier?.graph?.nodes ?? []}
            initialEdges={graphDossier?.graph?.edges ?? []}
            loading={graphLoading || (loading && !graphAnchor)}
            fullscreen={graphFullscreen}
            onToggleFullscreen={() => setGraphFullscreen((f) => !f)}
            onInspect={handleOpenEntity}
          />
        ) : null}

        {results.length > 0 && viewMode !== 'graph' ? (
          <div className="egm-more">
            {hasMore ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => setCursor(results.length)}
              >
                {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </button>
            ) : null}
            <small>
              {hasMore && total !== null
                ? `Showing ${results.length.toLocaleString()} of ${total.toLocaleString()}${countQualifier}`
                : `End of results — ${results.length.toLocaleString()} ${scopeNoun(scope, results.length)}`}
            </small>
          </div>
        ) : null}
      </div>,
      ) : null}

      {selectionMode ? (
        <EntityGraphMobileSelectionDock
          count={selectedCount}
          scope={scope}
          pageCount={results.length}
          allPageSelected={allPageSelected || Boolean(activeCohortSelection)}
          cohortTotal={scope === 'properties' ? total : null}
          cohortSelected={Boolean(activeCohortSelection)}
          selectingAll={selectingAll}
          onSelectAllMatching={scope === 'properties' ? selectAllMatching : undefined}
          onSelectPage={() => { setCohortSelection(null); handleSelectPage() }}
          onClear={() => { setCohortSelection(null); exitSelection() }}
          onAction={handleBulkAction}
        />
      ) : null}

      {toast ? <div className="egm-toast" role="status">{toast}</div> : null}

      <EntityGraphMobileFilterSheet
        open={filtersOpen}
        scope={scope}
        filters={filters}
        fieldFilters={fieldFilters}
        appliedTotal={total}
        scopeTotal={scopeTotal}
        onClose={() => setFiltersOpen(false)}
        onApply={(next, nextFieldFilters) => {
          setFilters(next)
          setFieldFilters(nextFieldFilters)
          setFiltersOpen(false)
        }}
        onRestoreSegment={(segment) => { setPendingSegment(segment); setToast(`Restored “${segment.name}”.`) }}
      />

      <EntityGraphCampaignSheet
        open={campaignOpen}
        scope={scope}
        filters={filters}
        fieldFilters={fieldFilters}
        query={debouncedQuery}
        cohortTotal={lensTotalForCampaign}
        selected={campaignSelection}
        onClose={() => setCampaignOpen(false)}
        onDone={(message) => { setToast(message); setCohortSelection(null); exitSelection() }}
      />

      <EntityGraphColumnSheet
        open={columnsOpen}
        scope={scope}
        visible={scopeColumns}
        onClose={() => setColumnsOpen(false)}
        onChange={(next) => setScopeColumns(scope, next)}
      />

      {/* On a desk with the list showing, the inspector docks inside the body. */}
      {isModernDesktop && (!universeAll || debouncedQuery) ? null : detailSheet}
    </section>
  )
}

/** Client-side CSV of what is already loaded — no backend export exists. */
function exportCsv(scope: EntityScope, rows: EntitySearchResult[]) {
  const header = ['id', 'name', 'detail', 'market', 'value', 'score', 'contacts']
  const escape = (value: unknown) => {
    const s = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const lines = rows.map((row) => {
    const identity = resolveIdentity(scope, row)
    const d = row.details ?? {}
    return [
      row.entityId,
      identity.primary,
      identity.secondary ?? '',
      d.marketLabel ?? '',
      d.value ?? d.portfolioValue ?? '',
      d.acquisitionScore ?? row.score ?? '',
      row.linkedCounts.reachableContacts ?? row.linkedCounts.contacts ?? '',
    ].map(escape).join(',')
  })

  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `entity-graph-${scope}-${rows.length}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
