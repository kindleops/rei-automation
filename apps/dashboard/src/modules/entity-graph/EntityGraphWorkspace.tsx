import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildEntityGraphActions } from '../../domain/entity-graph/entity-graph-actions'
import { fetchEntityGraphDossier, fetchEntityGraphList, fetchEntityGraphTabCounts } from '../../domain/entity-graph/entity-graph-api'
import type {
  ContactLadderEntry,
  EntityGraphAction,
  EntityGraphDossier,
  EntityGraphFilters,
  EntityGraphTab,
  EntityGraphTabCounts,
  EntityGraphVisualMode,
  EntitySearchResult,
  UniversalEntityContext,
} from '../../domain/entity-graph/entity-graph.types'
import { EMPTY_ENTITY_GRAPH_FILTERS } from '../../domain/entity-graph/entity-graph.types'
import {
  filtersToApiParams,
  readEntityGraphWorkspaceState,
  replaceEntityGraphWorkspaceQuery,
} from '../../domain/entity-graph/entity-graph-workspace-state'
import {
  mergeUniversalContexts,
  syncUniversalContextToUrl,
  universalContextFromSearchResult,
} from '../../domain/entity-graph/universal-entity-context'
import { EntityGraphCardsView } from './EntityGraphCardsView'
import { EntityGraphFiltersPanel } from './EntityGraphFilters'
import { EntityGraphHeader } from './EntityGraphHeader'
import { EntityGraphInspector } from './EntityGraphInspector'
import { EntityGraphRelationshipGraph } from './EntityGraphRelationshipGraph'
import { EntityGraphTableView } from './EntityGraphTableView'
import './entity-graph.css'

type LayoutMode = 'peek' | 'explorer' | 'workspace' | 'command'

export type EntityGraphWorkspaceProps = {
  paneWidth?: '25' | '50' | '75' | '100'
  themeMode?: 'dark' | 'light' | 'red_ops' | string
  universalContext: UniversalEntityContext
  onUniversalContextChange: (context: UniversalEntityContext, options?: { pushHistory?: boolean }) => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  onSelectThreadKey?: (threadKey: string) => void
}

function resolveLayoutMode(paneWidth?: string): LayoutMode {
  if (paneWidth === '25') return 'peek'
  if (paneWidth === '50') return 'explorer'
  if (paneWidth === '75') return 'workspace'
  return 'command'
}

function countActiveFilters(filters: EntityGraphFilters): number {
  return Object.entries(filters).filter(([key, value]) => {
    if (key === 'reachable') return value === true
    return Boolean(value)
  }).length
}

function ResultSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="eg-skeleton-list">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="eg-skeleton-card" />
      ))}
    </div>
  )
}

export function EntityGraphWorkspace({
  paneWidth = '100',
  themeMode = 'dark',
  universalContext,
  onUniversalContextChange,
  onAction,
  onSelectThreadKey,
}: EntityGraphWorkspaceProps) {
  const layoutMode = resolveLayoutMode(paneWidth)
  const initialWorkspace = useMemo(() => readEntityGraphWorkspaceState(), [])

  const [activeTab, setActiveTab] = useState<EntityGraphTab>(initialWorkspace.tab)
  const [contactSubtype, setContactSubtype] = useState<'phone' | 'email'>(initialWorkspace.contactSubtype)
  const [visualMode, setVisualMode] = useState<EntityGraphVisualMode>(
    layoutMode === 'peek' ? 'cards' : initialWorkspace.visualMode,
  )
  const [query, setQuery] = useState(initialWorkspace.query)
  const [debouncedQuery, setDebouncedQuery] = useState(initialWorkspace.query)
  const [filters, setFilters] = useState<EntityGraphFilters>(initialWorkspace.filters)
  const [draftFilters, setDraftFilters] = useState<EntityGraphFilters>(initialWorkspace.filters)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [sortBy, setSortBy] = useState(initialWorkspace.sortBy)
  const [ascending, setAscending] = useState(initialWorkspace.ascending)
  const [inspectorOpen, setInspectorOpen] = useState(initialWorkspace.inspectorOpen)
  const [graphFocusOnly, setGraphFocusOnly] = useState(initialWorkspace.graphFocusOnly)

  const [results, setResults] = useState<EntitySearchResult[]>([])
  const [cursor, setCursor] = useState(initialWorkspace.cursor)
  const [pagination, setPagination] = useState({
    cursor: 0,
    pageSize: 25,
    total: 0,
    hasMore: false,
    nextCursor: null as number | null,
    previousCursor: null as number | null,
  })
  const [tabCounts, setTabCounts] = useState<EntityGraphTabCounts | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [dossier, setDossier] = useState<EntityGraphDossier | null>(null)
  const [dossierLoading, setDossierLoading] = useState(false)

  const listAbortRef = useRef<AbortController | null>(null)
  const dossierAbortRef = useRef<AbortController | null>(null)
  const listPanelRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestoreRef = useRef(initialWorkspace.scrollTop)
  const listRequestGenerationRef = useRef(0)
  const dossierRequestGenerationRef = useRef(0)
  const listQueryKeyRef = useRef('')

  const pageSize = layoutMode === 'command' ? 40 : layoutMode === 'peek' ? 12 : 25
  const selectedType = universalContext.entityType
  const selectedId = universalContext.entityId
  const hasSelection = Boolean(selectedType && selectedId)
  const activeFilterCount = countActiveFilters(filters)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 280)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const controller = new AbortController()
    void fetchEntityGraphTabCounts(controller.signal)
      .then(setTabCounts)
      .catch(() => setTabCounts(null))
    return () => controller.abort()
  }, [])

  const syncWorkspaceToUrl = useCallback((scrollTop?: number) => {
    replaceEntityGraphWorkspaceQuery({
      tab: activeTab,
      visualMode,
      query: debouncedQuery,
      contactSubtype,
      cursor,
      sortBy,
      ascending,
      filters,
      inspectorOpen,
      graphFocusOnly,
      scrollTop: scrollTop ?? listPanelRef.current?.scrollTop ?? pendingScrollRestoreRef.current,
    })
  }, [activeTab, ascending, contactSubtype, cursor, debouncedQuery, filters, graphFocusOnly, inspectorOpen, sortBy, visualMode])

  useEffect(() => {
    syncWorkspaceToUrl()
  }, [activeTab, ascending, contactSubtype, cursor, debouncedQuery, filters, graphFocusOnly, inspectorOpen, sortBy, syncWorkspaceToUrl, visualMode])

  useEffect(() => {
    const handlePopState = () => {
      const restored = readEntityGraphWorkspaceState()
      setActiveTab(restored.tab)
      setVisualMode(layoutMode === 'peek' ? 'cards' : restored.visualMode)
      setQuery(restored.query)
      setDebouncedQuery(restored.query)
      setContactSubtype(restored.contactSubtype)
      setCursor(restored.cursor)
      setSortBy(restored.sortBy)
      setAscending(restored.ascending)
      setFilters(restored.filters)
      setDraftFilters(restored.filters)
      setInspectorOpen(restored.inspectorOpen)
      setGraphFocusOnly(restored.graphFocusOnly)
      pendingScrollRestoreRef.current = restored.scrollTop
      window.requestAnimationFrame(() => {
        if (listPanelRef.current) listPanelRef.current.scrollTop = restored.scrollTop
      })
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [layoutMode])

  useEffect(() => {
    if (pendingScrollRestoreRef.current > 0 && listPanelRef.current) {
      listPanelRef.current.scrollTop = pendingScrollRestoreRef.current
      pendingScrollRestoreRef.current = 0
    }
  }, [results, listLoading])

  const querySignature = `${activeTab}|${debouncedQuery}|${contactSubtype}|${JSON.stringify(filters)}|${sortBy}|${ascending}`
  const querySignatureRef = useRef(querySignature)
  const listQueryKey = `${querySignature}|${cursor}|${pageSize}`
  useEffect(() => {
    if (querySignatureRef.current !== querySignature) {
      querySignatureRef.current = querySignature
      setCursor(0)
    }
  }, [querySignature])

  useEffect(() => {
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    const generation = ++listRequestGenerationRef.current
    const queryKey = listQueryKey
    listQueryKeyRef.current = queryKey
    setListLoading(true)

    void fetchEntityGraphList(
      {
        tab: activeTab,
        q: debouncedQuery || undefined,
        cursor,
        page_size: pageSize,
        subtype: activeTab === 'contact_methods' ? contactSubtype : undefined,
        sort_by: sortBy || undefined,
        ascending: ascending ? '1' : '0',
        ...filtersToApiParams(filters),
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted || generation !== listRequestGenerationRef.current) return
        if (listQueryKeyRef.current !== queryKey) return
        setResults(response.results)
        setPagination({
          ...response.pagination,
          previousCursor: response.pagination.previousCursor ?? null,
        })
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== listRequestGenerationRef.current) return
        if (listQueryKeyRef.current !== queryKey) return
        setResults([])
        setPagination((current) => ({ ...current, total: 0, hasMore: false, nextCursor: null }))
      })
      .finally(() => {
        if (controller.signal.aborted || generation !== listRequestGenerationRef.current) return
        if (listQueryKeyRef.current !== queryKey) return
        setListLoading(false)
      })

    return () => controller.abort()
  }, [activeTab, ascending, contactSubtype, cursor, debouncedQuery, filters, listQueryKey, pageSize, sortBy])

  const dossierQueryKey = `${listQueryKey}|${selectedType ?? ''}|${selectedId ?? ''}`
  useEffect(() => {
    if (!selectedType || !selectedId) {
      setDossier(null)
      setDossierLoading(false)
      return
    }

    dossierAbortRef.current?.abort()
    const controller = new AbortController()
    dossierAbortRef.current = controller
    const generation = ++dossierRequestGenerationRef.current
    const requestKey = dossierQueryKey
    setDossierLoading(true)

    void fetchEntityGraphDossier(selectedType, selectedId, { signal: controller.signal, force: true })
      .then((next) => {
        if (controller.signal.aborted || generation !== dossierRequestGenerationRef.current) return
        if (requestKey !== dossierQueryKey) return
        setDossier(next)
      })
      .finally(() => {
        if (controller.signal.aborted || generation !== dossierRequestGenerationRef.current) return
        if (requestKey !== dossierQueryKey) return
        setDossierLoading(false)
      })

    return () => controller.abort()
  }, [dossierQueryKey, selectedId, selectedType])

  useEffect(() => {
    if (querySignatureRef.current !== querySignature) {
      setDossier(null)
    }
  }, [querySignature])

  const handleSelectResult = useCallback((result: EntitySearchResult) => {
    const next = universalContextFromSearchResult(result)
    onUniversalContextChange(next, { pushHistory: false })
    syncUniversalContextToUrl(next, 'replace')
    setInspectorOpen(true)
  }, [onUniversalContextChange])

  const handleGraphNodeSelect = useCallback((_nodeId: string, nodeType: string, entityId: string) => {
    const patch: Partial<UniversalEntityContext> = {
      entityType: nodeType as UniversalEntityContext['entityType'],
      entityId,
    }
    if (nodeType === 'property') patch.propertyId = entityId
    if (nodeType === 'master_owner') patch.masterOwnerId = entityId
    if (nodeType === 'prospect') patch.prospectId = entityId
    if (nodeType === 'phone' || nodeType === 'email') {
      patch.contactMethodType = nodeType
      patch.contactMethodId = entityId
    }
    const next = mergeUniversalContexts(universalContext, patch)
    onUniversalContextChange(next, { pushHistory: false })
    syncUniversalContextToUrl(next, 'replace')
    setInspectorOpen(true)
  }, [onUniversalContextChange, universalContext])

  const handleContactSelect = useCallback((entry: ContactLadderEntry) => {
    const next = mergeUniversalContexts(universalContext, {
      entityType: entry.type,
      entityId: entry.id,
      contactMethodType: entry.type,
      contactMethodId: entry.id,
      prospectId: entry.prospectId ?? universalContext.prospectId,
    })
    onUniversalContextChange(next, { pushHistory: false })
    syncUniversalContextToUrl(next, 'replace')
  }, [onUniversalContextChange, universalContext])

  const handleSort = useCallback((column: string) => {
    setSortBy((current) => {
      if (current === column) {
        setAscending((prev) => !prev)
        return column
      }
      setAscending(true)
      return column
    })
  }, [])

  const actions = useMemo(
    () => buildEntityGraphActions(universalContext, dossier?.threads?.length ?? 0),
    [dossier?.threads?.length, universalContext],
  )

  const effectiveVisualMode: EntityGraphVisualMode = layoutMode === 'peek' ? 'cards' : visualMode
  const showGraphMain = effectiveVisualMode === 'graph'
  const showList = true
  const listCompact = showGraphMain
  const resolvedTheme = themeMode === 'light' ? 'light' : themeMode === 'red_ops' ? 'red_ops' : 'dark'

  const renderPagination = () => (
    <div className="eg-pagination">
      <span>{pagination.total.toLocaleString()} results</span>
      <span>Page {Math.floor(cursor / pageSize) + 1}</span>
      <div className="eg-pagination__controls">
        <button type="button" disabled={cursor <= 0 || listLoading} onClick={() => setCursor((c) => Math.max(c - pageSize, 0))}>
          Previous
        </button>
        <button
          type="button"
          disabled={!pagination.hasMore || listLoading}
          onClick={() => setCursor((c) => pagination.nextCursor ?? c + pageSize)}
        >
          Next
        </button>
      </div>
    </div>
  )

  return (
    <section className={`eg-app is-layout-${layoutMode} is-mode-${resolvedTheme}${inspectorOpen ? ' is-inspector-open' : ''}${showGraphMain ? ' is-graph-mode' : ''}`}>
      <EntityGraphHeader
        activeTab={activeTab}
        visualMode={effectiveVisualMode}
        query={query}
        tabCounts={tabCounts}
        resultCount={pagination.total}
        activeFilterCount={activeFilterCount}
        onTabChange={setActiveTab}
        onQueryChange={setQuery}
        onVisualModeChange={setVisualMode}
        onOpenFilters={() => {
          setDraftFilters(filters)
          setFiltersOpen(true)
        }}
      />

      <EntityGraphFiltersPanel
        open={filtersOpen}
        tab={activeTab}
        filters={draftFilters}
        onChange={setDraftFilters}
        onClose={() => setFiltersOpen(false)}
        onApply={() => {
          setFilters(draftFilters)
          setFiltersOpen(false)
        }}
        onClear={() => {
          setDraftFilters({ ...EMPTY_ENTITY_GRAPH_FILTERS })
          setFilters({ ...EMPTY_ENTITY_GRAPH_FILTERS })
          setFiltersOpen(false)
        }}
      />

      <div className="eg-main">
        {showList && (
          <div className={`eg-results nx-liquid-surface${listCompact ? ' is-compact-list' : ''}`}>
            <div className="eg-results__header">
              <span>{debouncedQuery ? 'Search results' : activeTab.replace(/_/g, ' ')}</span>
              {renderPagination()}
            </div>

            {activeTab === 'contact_methods' && (
              <div className="eg-subtype-switch">
                <button type="button" className={contactSubtype === 'phone' ? 'is-active' : ''} onClick={() => setContactSubtype('phone')}>Phones</button>
                <button type="button" className={contactSubtype === 'email' ? 'is-active' : ''} onClick={() => setContactSubtype('email')}>Emails</button>
              </div>
            )}

            <div
              className="eg-results__body"
              ref={listPanelRef}
              onScroll={() => {
                pendingScrollRestoreRef.current = listPanelRef.current?.scrollTop ?? 0
                syncWorkspaceToUrl(pendingScrollRestoreRef.current)
              }}
            >
              {listLoading && <ResultSkeleton count={layoutMode === 'peek' ? 4 : 8} />}
              {!listLoading && results.length === 0 && (
                <div className="eg-empty">
                  <strong>No records found</strong>
                  <span>{debouncedQuery || activeFilterCount > 0 ? 'Try adjusting search or filters.' : 'This entity type has no live records yet.'}</span>
                </div>
              )}
              {!listLoading && results.length > 0 && effectiveVisualMode === 'table' && (
                <EntityGraphTableView
                  tab={activeTab}
                  results={results}
                  selectedType={selectedType}
                  selectedId={selectedId}
                  sortBy={sortBy}
                  ascending={ascending}
                  onSelect={handleSelectResult}
                  onSort={handleSort}
                />
              )}
              {!listLoading && results.length > 0 && (effectiveVisualMode === 'cards' || (showGraphMain && effectiveVisualMode === 'graph')) && (
                <EntityGraphCardsView
                  tab={activeTab}
                  results={results}
                  selectedType={selectedType}
                  selectedId={selectedId}
                  compact={layoutMode === 'peek' || listCompact}
                  onSelect={handleSelectResult}
                />
              )}
            </div>
          </div>
        )}

        {showGraphMain && (
          <div className="eg-graph-panel nx-liquid-surface">
            <div className="eg-graph-panel__header">
              <span>Relationship graph</span>
              <div className="eg-graph-panel__tools">
                <label className="eg-filter-check">
                  <input type="checkbox" checked={graphFocusOnly} onChange={(e) => setGraphFocusOnly(e.target.checked)} />
                  <span>Connected only</span>
                </label>
              </div>
            </div>
            {hasSelection && dossierLoading ? (
              <div className="eg-empty is-graph">
                <strong>Loading graph…</strong>
                <span>Fetching relationships for the selected record.</span>
              </div>
            ) : hasSelection && dossier ? (
              <EntityGraphRelationshipGraph
                dossier={dossier}
                focusOnly={graphFocusOnly}
                onNodeSelect={handleGraphNodeSelect}
              />
            ) : (
              <div className="eg-empty is-graph">
                <strong>Select a record</strong>
                <span>Choose any entity to explore its relationship neighborhood.</span>
              </div>
            )}
          </div>
        )}
      </div>

      <EntityGraphInspector
        open={inspectorOpen && hasSelection}
        dossier={dossier}
        loading={dossierLoading}
        universalContext={universalContext}
        actions={actions}
        onClose={() => setInspectorOpen(false)}
        onAction={onAction}
        onContactSelect={handleContactSelect}
        onSelectThreadKey={onSelectThreadKey}
      />
    </section>
  )
}