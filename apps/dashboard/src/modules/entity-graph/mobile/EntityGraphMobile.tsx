import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { buildEntityGraphActions } from '../../../domain/entity-graph/entity-graph-actions'
import {
  fetchEntityGraphDossier,
  fetchEntityGraphLens,
  fetchEntityGraphList,
  fetchEntityGraphTabCounts,
  type EntityGraphLens,
} from '../../../domain/entity-graph/entity-graph-api'
import type {
  EntityGraphAction,
  EntityGraphDossier,
  EntityGraphFilters,
  EntityGraphTabCounts,
  EntitySearchResult,
  UniversalEntityContext,
} from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_ENTITY_GRAPH_FILTERS } from '../../../domain/entity-graph/entity-graph.types'
import { filtersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import {
  selectedEntityFromResult,
  selectedEntityToContext,
  dossierApiType,
} from '../../../domain/entity-graph/selected-entity'
import { EntityGraphMobileRow } from './EntityGraphMobileRow'
import { EntityGraphMobileTable } from './EntityGraphMobileTable'
import { defaultVisibleColumns } from './entity-graph-table-columns'
import { EntityGraphColumnSheet } from './EntityGraphColumnSheet'
import { EntityGraphMobileGraph } from './EntityGraphMobileGraph'
import { EntityGraphUniverseLens } from './EntityGraphUniverseLens'
import { EntityGraphCampaignSheet } from './EntityGraphCampaignSheet'
import { EntityGraphCompareSheet, type CohortSnapshot } from './EntityGraphCompareSheet'
import { cohortLabelFor } from './entity-graph-cohort'
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
  tabForScope,
  type EntityScope,
} from './entity-graph-mobile-format'
import './entity-graph-mobile.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const PAGE_SIZE = 25

const SEARCH_PLACEHOLDER = 'Address, owner, person, phone, email, entity…'

/** Lens bucket keys → the browse filter values they correspond to. */
const ASSET_BUCKET_TO_FILTER: Record<string, string> = {
  sfr: 'SFR',
  multifamily: 'Multifamily',
  apartment: 'Apartment',
  land: 'Land',
  other: 'Other',
}

const SCORE_BUCKET_TO_RANGE: Record<string, { min: string; max: string }> = {
  elite: { min: '80', max: '' },
  strong: { min: '65', max: '79' },
  moderate: { min: '50', max: '64' },
  low: { min: '', max: '49' },
}

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
  error: string | null
}

const EMPTY_LIST_STATE: ListState = {
  signature: '',
  cursor: 0,
  results: EMPTY_RESULTS,
  total: null,
  hasMore: false,
  notes: EMPTY_NOTES,
  error: null,
}

type DossierState = { key: string; data: EntityGraphDossier | null }

export function EntityGraphMobile({
  themeMode = 'dark',
  universalContext,
  onUniversalContextChange,
  onAction,
}: Props) {
  const [scope, setScope] = useState<EntityScope>('properties')
  const [sortKey, setSortKey] = useState<string>(SCOPE_DEFAULT_SORT_KEY.properties)
  const [contactSubtype, setContactSubtype] = useState<'phone' | 'email'>('phone')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [filters, setFilters] = useState<EntityGraphFilters>({ ...EMPTY_ENTITY_GRAPH_FILTERS })
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
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Record<string, string[]>>({})

  // Signature-tagged, same as the list: "which cohort is this lens describing"
  // is part of the value, so a late response for an abandoned cohort can never
  // be shown and `loading` is derived rather than toggled inside an effect.
  const [lensState, setLensState] = useState<{ signature: string; fast: EntityGraphLens | null; deep: EntityGraphLens | null }>(
    { signature: '', fast: null, deep: null },
  )

  const [campaignOpen, setCampaignOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [savedCohort, setSavedCohort] = useState<CohortSnapshot | null>(null)
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

  const activeFilterCount = countActiveFilters(filters, scope)

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
  const querySignature = `${scope}|${sortKey}|${debouncedQuery}|${contactSubtype}|${JSON.stringify(filters)}`

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
  }, [querySignature])

  /* ── Universe Lens ─────────────────────────────────────────────────────── */
  // Keyed on scope + filters only. The text query is not a lens dimension: the
  // search endpoint has no facet support, so folding it in would silently show
  // composition for a cohort the operator is not looking at.
  const lensSignature = `${scope}|${contactSubtype}|${JSON.stringify(filters)}`
  const lensIsCurrent = lensState.signature === lensSignature
  const lens = lensIsCurrent ? lensState.fast : null
  const deepLens = lensIsCurrent ? lensState.deep : null
  const lensLoading = !lensIsCurrent || !lensState.fast

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const requestSignature = lensSignature

    const params = {
      tab: tabForScope(scope),
      subtype: scope === 'contact_methods' ? contactSubtype : undefined,
      ...filtersToApiParams(filters),
    }

    void fetchEntityGraphLens(params, controller.signal)
      .then((fast) => {
        if (cancelled) return
        setLensState({ signature: requestSignature, fast, deep: null })
        // The deep facets sit on unindexed columns; they arrive separately so
        // the composition bar is interactive while they resolve.
        return fetchEntityGraphLens({ ...params, part: 'deep' }, controller.signal)
      })
      .then((deep) => {
        if (cancelled || !deep) return
        setLensState((current) => (
          current.signature === requestSignature ? { ...current, deep } : current
        ))
      })
      .catch(() => {
        if (cancelled) return
        // Tag the failure so `lensLoading` resolves and the lens hides rather
        // than shimmering forever.
        setLensState((current) => (
          current.signature === requestSignature ? current : { signature: requestSignature, fast: null, deep: null }
        ))
      })

    return () => { cancelled = true; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensSignature])

  /* ── Fetch a page ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController()
    const generation = ++listGenerationRef.current
    const requestSignature = querySignature
    const requestCursor = cursor

    const sortOptions = SCOPE_SORTS[scope]
    const sort = sortOptions.find((s) => s.key === sortKey) ?? sortOptions[0]
    void fetchEntityGraphList(
      {
        tab: tabForScope(scope),
        q: debouncedQuery || undefined,
        cursor,
        page_size: PAGE_SIZE,
        subtype: scope === 'contact_methods' ? contactSubtype : undefined,
        sort_by: sort.sortBy,
        ascending: sort.ascending ? '1' : '0',
        // Property rows carry the owner + contact chain; the desktop table does
        // not need the extra round trips, so it stays opt-in.
        ...(scope === 'properties' ? { include_links: '1' } : {}),
        ...filtersToApiParams(filters),
      },
      controller.signal,
    )
      .then((response) => {
        if (generation !== listGenerationRef.current) return
        setList((current) => {
          const appending = requestCursor > 0 && current.signature === requestSignature
          const merged = appending
            ? (() => {
                const seen = new Set(current.results.map(resultKey))
                return [...current.results, ...response.results.filter((row) => !seen.has(resultKey(row)))]
              })()
            : response.results
          return {
            signature: requestSignature,
            cursor: requestCursor,
            results: merged,
            total: response.pagination.total,
            hasMore: response.pagination.hasMore,
            notes: response.pagination.notes ?? EMPTY_NOTES,
            error: null,
          }
        })
      })
      .catch((error: unknown) => {
        if (generation !== listGenerationRef.current) return
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : 'load_failed'
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
  const graphLoading = viewMode === 'graph' && Boolean(graphCandidate) && !graphIsCurrent

  useEffect(() => {
    if (viewMode !== 'graph' || !graphCandidate) return
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
  const deepLinkId = universalContext?.entityType ? universalContext.entityId : null
  if (deepLinkId && handledContextId !== deepLinkId) {
    const match = results.find((row) => row.entityId === deepLinkId)
    if (match) {
      setHandledContextId(deepLinkId)
      setOpenResult(match)
    }
  }

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
    setHandledContextId(result.entityId)
    setOpenResult(result)
    onUniversalContextChange(selectedEntityToContext(selectedEntityFromResult(result), result))
  }, [onUniversalContextChange])

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
    onAction?.(action, actionContext)
    closeRecord()
  }, [actionContext, closeRecord, onAction])

  /**
   * Which lens buckets the current filter set corresponds to, so the bar can
   * show an active state. Derived from the filters rather than tracked
   * separately — the highlight can't drift from what is actually applied.
   */
  const activeBucketKeys = useMemo(() => {
    const keys = new Set<string>()
    const assetKey = Object.entries(ASSET_BUCKET_TO_FILTER)
      .find(([, label]) => label.toLowerCase() === filters.assetType.toLowerCase())?.[0]
    if (assetKey) keys.add(assetKey)
    const scoreKey = Object.entries(SCORE_BUCKET_TO_RANGE)
      .find(([, band]) => band.min === filters.scoreMin && band.max === filters.scoreMax)?.[0]
    if (scoreKey) keys.add(scoreKey)
    if (filters.priorityTier) keys.add(filters.priorityTier)
    if (filters.language) keys.add(filters.language)
    return keys
  }, [filters])

  /* ── Lens bucket → filter ──────────────────────────────────────────────── */
  const applyLensBucket = useCallback((dimensionKey: string, bucketKey: string) => {
    if (dimensionKey === 'asset_type') {
      const label = ASSET_BUCKET_TO_FILTER[bucketKey]
      if (label) setFilters((current) => ({ ...current, assetType: current.assetType === label ? '' : label }))
      return
    }
    if (dimensionKey === 'acquisition_score') {
      const band = SCORE_BUCKET_TO_RANGE[bucketKey]
      if (!band) return
      setFilters((current) => {
        const already = current.scoreMin === band.min && current.scoreMax === band.max
        return { ...current, scoreMin: already ? '' : band.min, scoreMax: already ? '' : band.max }
      })
      return
    }
    if (dimensionKey === 'priority_tier') {
      setFilters((current) => ({ ...current, priorityTier: current.priorityTier === bucketKey ? '' : bucketKey }))
      return
    }
    if (dimensionKey === 'language') {
      setFilters((current) => ({ ...current, language: current.language === bucketKey ? '' : bucketKey }))
      return
    }
    // Equity, value and signal dimensions have no matching browse filter, so
    // tapping them explains rather than silently doing nothing.
    setToast('That dimension has no matching browse filter yet — use the cohort builder.')
  }, [])

  const currentCohort: CohortSnapshot | null = useMemo(() => (
    lens ? {
      label: cohortLabelFor(scope, filters, lens.total ?? null),
      scope,
      filters,
      savedAt: 0,
      lens,
      deepLens,
    } : null
  ), [deepLens, filters, lens, scope])

  const saveCohort = useCallback(() => {
    if (!currentCohort) return
    setSavedCohort({ ...currentCohort, savedAt: 1 })
    setToast(`Saved “${currentCohort.label}” as cohort A.`)
  }, [currentCohort])

  /* ── Bulk actions ──────────────────────────────────────────────────────── */
  const handleBulkAction = useCallback((action: BulkAction) => {
    if (action.unavailable) {
      setToast(`${action.label}: ${action.unavailable}`)
      return
    }
    const rows = selectedResults
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
      const context = selectedEntityToContext(selectedEntityFromResult(rows[0]), rows[0])
      onAction?.('open_in_map', context)
    }
  }, [onAction, scope, selectedResults])

  /* ── Render ────────────────────────────────────────────────────────────── */
  const resolvedTheme = themeMode === 'light' ? 'light' : themeMode === 'red_ops' ? 'red_ops' : 'dark'
  const searching = Boolean(debouncedQuery)
  const sortOptions = SCOPE_SORTS[scope]
  const activeSort = sortOptions.find((s) => s.key === sortKey) ?? sortOptions[0]
  const scopeColumns = visibleColumns[scope] ?? defaultVisibleColumns(scope)
  const cohortLabel = searching
    ? `matching “${debouncedQuery}”`
    : activeFilterCount > 0 ? `in cohort · ${scopeTotalNoun}` : scopeTotalNoun

  // The Lens counts the filter set, the list counts filter + search. When a
  // search is active they are different cohorts, so the Lens says so instead of
  // implying its composition describes the search results.
  const lensTotalForCampaign = searching ? null : (lens?.total ?? total)

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

  return (
    <section className={cls('egm', `is-${resolvedTheme}`)}>
      <header className="egm-header">
        <div className="egm-header__id">
          <h1>Entity Graph</h1>
          <span className="egm-header__total">
            {scopeTotal !== null
              ? `${scopeTotal.toLocaleString()} ${scopeTotalNoun}`
              : 'counting…'}
          </span>
        </div>

        <div className="egm-search">
          <span className="egm-search__icon"><Icon name="search" /></span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={SEARCH_PLACEHOLDER}
            aria-label="Search the entity universe"
            type="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="egm-search__clear egm-hit" onClick={() => setQuery('')} aria-label="Clear search">×</button>
          ) : null}
        </div>

        <div className="egm-scopes" role="tablist" aria-label="Entity scope">
          {MOBILE_SCOPES.map((entry) => {
            const count = counts?.[entry.countKey as keyof EntityGraphTabCounts] as number | undefined
            return (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={scope === entry.key}
                className={cls('egm-scope', 'egm-hit', scope === entry.key && 'is-active')}
                onClick={() => {
                  setScope(entry.key)
                  exitSelection()
                }}
              >
                <span>{entry.label}</span>
                {count !== undefined ? <span className="egm-scope__count">{compactCount(count)}</span> : null}
              </button>
            )
          })}
        </div>
      </header>

      <EntityGraphUniverseLens
        lens={lens}
        deepLens={deepLens}
        loading={lensLoading}
        cohortLabel={cohortLabel}
        filtered={activeFilterCount > 0}
        activeBucketKeys={activeBucketKeys}
        hasSavedCohort={Boolean(savedCohort)}
        // The dock is 120px. On a 720px viewport the expanded lens plus the
        // dock left the results list 4px tall and pushed the dock under the
        // pinned app dock — the selection you are acting on has to stay visible.
        forceCollapsed={selectionMode}
        savedCohortLabel={savedCohort?.label ?? null}
        onSelectBucket={applyLensBucket}
        onSaveCohort={saveCohort}
        onOpenCompare={() => setCompareOpen(true)}
        onClearSaved={() => { setSavedCohort(null); setToast('Cleared saved cohort A.') }}
      />

      <div className="egm-views" role="tablist" aria-label="View mode">
        {VIEW_MODES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={viewMode === entry.key}
            className={cls('egm-view', viewMode === entry.key && 'is-active')}
            onClick={() => setViewMode(entry.key)}
          >
            <Icon name={entry.icon} />
            {entry.label}
          </button>
        ))}
        {viewMode === 'table' ? (
          <button type="button" className="egm-view is-aux" onClick={() => setColumnsOpen(true)}>
            <Icon name="settings" />
            Columns
          </button>
        ) : null}
      </div>

      <div className="egm-toolbar">
        <span className="egm-toolbar__count">
          {loading && results.length === 0 ? (
            'Loading…'
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
      </div>

      {unrankedCount !== null && unrankedCount > 0 ? (
        <div className="egm-note">
          Score order ranks the {total?.toLocaleString()} scored properties.{' '}
          {unrankedCount.toLocaleString()} have no acquisition score and are not ranked —
          switch to A–Z to see the full {scopeTotal?.toLocaleString()}.
        </div>
      ) : null}

      <div className="egm-list" ref={listRef}>
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
                  onClick={() => setFilters({ ...EMPTY_ENTITY_GRAPH_FILTERS })}
                >
                  Reset filters
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {viewMode === 'cards' ? results.map((result) => (
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
            results={results}
            visibleColumns={scopeColumns}
            sortBy={activeSort.sortBy}
            ascending={activeSort.ascending}
            selectionMode={selectionMode}
            selectedKeys={selectedKeys}
            activeId={openResult?.entityId ?? null}
            onSort={(column) => {
              const match = sortOptions.find((option) => option.sortBy === column)
              if (match) setSortKey(match.key)
            }}
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
      </div>

      {selectionMode ? (
        <EntityGraphMobileSelectionDock
          count={selectedKeys.size}
          scope={scope}
          pageCount={results.length}
          allPageSelected={allPageSelected}
          onSelectPage={handleSelectPage}
          onClear={exitSelection}
          onAction={handleBulkAction}
        />
      ) : null}

      {toast ? <div className="egm-toast" role="status">{toast}</div> : null}

      <EntityGraphMobileFilterSheet
        open={filtersOpen}
        scope={scope}
        filters={filters}
        appliedTotal={total}
        scopeTotal={scopeTotal}
        onClose={() => setFiltersOpen(false)}
        onApply={(next) => {
          setFilters(next)
          setFiltersOpen(false)
        }}
      />

      <EntityGraphCompareSheet
        open={compareOpen}
        saved={savedCohort}
        current={currentCohort}
        onClose={() => setCompareOpen(false)}
        onSaveCurrent={() => { saveCohort(); }}
        onClearSaved={() => { setSavedCohort(null); setToast('Cleared saved cohort A.') }}
      />

      <EntityGraphCampaignSheet
        open={campaignOpen}
        scope={scope}
        filters={filters}
        query={debouncedQuery}
        cohortTotal={lensTotalForCampaign}
        selected={selectedResults}
        onClose={() => setCampaignOpen(false)}
        onDone={(message) => { setToast(message); exitSelection() }}
      />

      <EntityGraphColumnSheet
        open={columnsOpen}
        scope={scope}
        visible={scopeColumns}
        onClose={() => setColumnsOpen(false)}
        onChange={(next) => setVisibleColumns((current) => ({ ...current, [scope]: next }))}
      />

      <EntityGraphMobileDetailSheet
        open={Boolean(openResult)}
        scope={scope}
        result={openResult}
        dossier={dossier}
        loading={dossierLoading}
        actions={actions}
        onClose={closeRecord}
        onAction={handleAction}
        onOpenEntity={handleOpenEntity}
      />
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
