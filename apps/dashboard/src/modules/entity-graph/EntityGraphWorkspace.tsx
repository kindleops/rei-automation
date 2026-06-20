import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import { buildEntityGraphActions } from '../../domain/entity-graph/entity-graph-actions'
import { fetchEntityGraphDossier, fetchEntityGraphList, fetchEntityGraphTabCounts } from '../../domain/entity-graph/entity-graph-api'
import type {
  ContactLadderEntry,
  EntityGraphAction,
  EntityGraphDossier,
  EntityGraphTab,
  EntityGraphTabCounts,
  EntityGraphVisualMode,
  EntitySearchResult,
  UniversalEntityContext,
} from '../../domain/entity-graph/entity-graph.types'
import {
  readEntityGraphWorkspaceState,
  replaceEntityGraphWorkspaceQuery,
} from '../../domain/entity-graph/entity-graph-workspace-state'
import {
  mergeUniversalContexts,
  syncUniversalContextToUrl,
  universalContextFromSearchResult,
} from '../../domain/entity-graph/universal-entity-context'
import { EntityGraphDossierPanel } from './EntityGraphDossierPanel'
import { EntityGraphRelationshipGraph } from './EntityGraphRelationshipGraph'
import './entity-graph.css'

type LayoutMode = 'peek' | 'explorer' | 'workspace' | 'command'

const TAB_OPTIONS: Array<{ key: EntityGraphTab; label: string; countKey: keyof EntityGraphTabCounts }> = [
  { key: 'properties', label: 'Properties', countKey: 'properties' },
  { key: 'master_owners', label: 'Master Owners', countKey: 'master_owners' },
  { key: 'people', label: 'People', countKey: 'people' },
  { key: 'organizations', label: 'Ownership Entities', countKey: 'organizations' },
  { key: 'contact_methods', label: 'Contact Methods', countKey: 'contact_methods' },
  { key: 'markets', label: 'Markets', countKey: 'markets' },
  { key: 'zips', label: 'ZIPs', countKey: 'zips' },
]

const TABLE_COLUMNS: Record<EntityGraphTab, Array<{ key: string; label: string }>> = {
  properties: [
    { key: 'title', label: 'Address' },
    { key: 'subtitle', label: 'Location' },
    { key: 'badges', label: 'Market' },
  ],
  master_owners: [
    { key: 'title', label: 'Owner' },
    { key: 'subtitle', label: 'Portfolio' },
    { key: 'badges', label: 'Type' },
  ],
  people: [
    { key: 'title', label: 'Person' },
    { key: 'subtitle', label: 'Occupation' },
    { key: 'badges', label: 'Signals' },
  ],
  organizations: [
    { key: 'title', label: 'Entity Name' },
    { key: 'subtitle', label: 'Entity Type' },
    { key: 'mailing', label: 'Mailing Address' },
    { key: 'linked', label: 'Properties' },
    { key: 'prospects', label: 'Linked People' },
    { key: 'contacts', label: 'Contact Coverage' },
  ],
  contact_methods: [
    { key: 'title', label: 'Contact' },
    { key: 'subtitle', label: 'Owner' },
    { key: 'badges', label: 'Status' },
  ],
  markets: [
    { key: 'title', label: 'Operating Market' },
    { key: 'locality', label: 'City / Locality' },
    { key: 'county', label: 'County' },
    { key: 'state', label: 'State' },
    { key: 'linked', label: 'Properties' },
  ],
  zips: [
    { key: 'title', label: 'ZIP' },
    { key: 'market', label: 'Canonical Market' },
    { key: 'linked', label: 'Properties' },
    { key: 'owners', label: 'Master Owners' },
    { key: 'prospects', label: 'People' },
    { key: 'contacts', label: 'Reachable Contacts' },
    { key: 'coverage', label: 'Contact Coverage' },
    { key: 'score', label: 'Avg Acquisition Score' },
  ],
}

export type EntityGraphWorkspaceProps = {
  paneWidth?: '25' | '50' | '75' | '100'
  themeMode?: 'dark' | 'light'
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

function entityTypeLabel(type: string): string {
  return type.replace(/_/g, ' ')
}

function formatCount(value?: number): string {
  if (value === undefined || value === null) return '…'
  return value.toLocaleString()
}

function formatCell(value?: number | string | null): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'number') return value.toLocaleString()
  return value
}

function contactCoverageLabel(result: EntitySearchResult): string {
  const coverage = result.linkedCounts.contactCoverage
  if (coverage !== undefined && coverage !== null) return `${Math.round(coverage)}%`
  const properties = result.linkedCounts.properties ?? 0
  const contacts = result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts ?? 0
  if (!properties) return '—'
  return `${Math.round((contacts / properties) * 100)}%`
}

function renderTableRowCells(tab: EntityGraphTab, result: EntitySearchResult): string[] {
  switch (tab) {
    case 'zips':
      return [
        result.title,
        result.details?.marketLabel ?? result.subtitle?.replace(/^Market:\s*/, '') ?? '—',
        formatCell(result.linkedCounts.properties),
        formatCell(result.linkedCounts.masterOwners),
        formatCell(result.linkedCounts.prospects),
        formatCell(result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts),
        contactCoverageLabel(result),
        formatCell(result.linkedCounts.avgAcquisitionScore ?? result.score),
      ]
    case 'markets':
      return [
        result.title,
        formatCell(result.details?.locality),
        formatCell(result.details?.county),
        formatCell(result.details?.state ?? result.badges.find((badge) => badge.length === 2)),
        formatCell(result.linkedCounts.properties),
      ]
    case 'organizations':
      return [
        result.title,
        result.subtitle ?? '—',
        formatCell(result.details?.mailingAddress),
        formatCell(result.linkedCounts.properties),
        formatCell(result.linkedCounts.prospects),
        contactCoverageLabel(result),
      ]
    case 'people':
      return [
        result.title,
        result.subtitle ?? '—',
        result.badges.slice(0, 2).join(' · ') || '—',
      ]
    case 'master_owners':
      return [
        result.title,
        result.subtitle ?? '—',
        result.badges.join(', ') || '—',
      ]
    case 'contact_methods':
      return [
        result.title,
        result.subtitle ?? '—',
        result.badges.join(', ') || '—',
      ]
    default:
      return [
        result.title,
        result.subtitle ?? '—',
        result.badges.join(', ') || entityTypeLabel(result.entityType),
      ]
  }
}

function ResultSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="nx-entity-graph__skeleton-list">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="nx-entity-graph__skeleton-card" />
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
  const [results, setResults] = useState<EntitySearchResult[]>([])
  const [cursor, setCursor] = useState(initialWorkspace.cursor)
  const [pagination, setPagination] = useState({ cursor: 0, pageSize: 25, total: 0, hasMore: false, nextCursor: null as number | null, previousCursor: null as number | null })
  const [tabCounts, setTabCounts] = useState<EntityGraphTabCounts | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [dossier, setDossier] = useState<EntityGraphDossier | null>(null)
  const [dossierLoading, setDossierLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const listAbortRef = useRef<AbortController | null>(null)
  const dossierAbortRef = useRef<AbortController | null>(null)
  const listPanelRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestoreRef = useRef(initialWorkspace.scrollTop)
  const listRequestGenerationRef = useRef(0)

  const pageSize = layoutMode === 'command' ? 40 : layoutMode === 'peek' ? 12 : 25

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
      scrollTop: scrollTop ?? listPanelRef.current?.scrollTop ?? pendingScrollRestoreRef.current,
    })
  }, [activeTab, contactSubtype, cursor, debouncedQuery, visualMode])

  useEffect(() => {
    syncWorkspaceToUrl()
  }, [activeTab, contactSubtype, cursor, debouncedQuery, visualMode, syncWorkspaceToUrl])

  useEffect(() => {
    const handlePopState = () => {
      const restored = readEntityGraphWorkspaceState()
      setActiveTab(restored.tab)
      setVisualMode(layoutMode === 'peek' ? 'cards' : restored.visualMode)
      setQuery(restored.query)
      setDebouncedQuery(restored.query)
      setContactSubtype(restored.contactSubtype)
      setCursor(restored.cursor)
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

  const querySignature = `${activeTab}|${debouncedQuery}|${contactSubtype}`
  const querySignatureRef = useRef(querySignature)
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
    setListLoading(true)

    void fetchEntityGraphList(
      {
        tab: activeTab,
        q: debouncedQuery || undefined,
        cursor,
        page_size: pageSize,
        subtype: activeTab === 'contact_methods' ? contactSubtype : undefined,
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted || generation !== listRequestGenerationRef.current) return
        setResults(response.results)
        setPagination({
          ...response.pagination,
          previousCursor: response.pagination.previousCursor ?? null,
        })
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== listRequestGenerationRef.current) return
        setResults([])
        setPagination((current) => ({ ...current, total: 0, hasMore: false, nextCursor: null }))
      })
      .finally(() => {
        if (controller.signal.aborted || generation !== listRequestGenerationRef.current) return
        setListLoading(false)
      })

    return () => controller.abort()
  }, [activeTab, contactSubtype, cursor, debouncedQuery, pageSize])

  const selectedType = universalContext.entityType
  const selectedId = universalContext.entityId
  const hasSelection = Boolean(selectedType && selectedId)

  useEffect(() => {
    if (!selectedType || !selectedId) {
      setDossier(null)
      setDrawerOpen(false)
      return
    }

    dossierAbortRef.current?.abort()
    const controller = new AbortController()
    dossierAbortRef.current = controller
    setDossierLoading(true)

    void fetchEntityGraphDossier(selectedType, selectedId, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) {
          setDossier(next)
          if (layoutMode === 'command' && (visualMode === 'table' || visualMode === 'cards')) {
            setDrawerOpen(true)
          }
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDossierLoading(false)
      })

    return () => controller.abort()
  }, [layoutMode, selectedId, selectedType, visualMode])

  const handleSelectResult = useCallback((result: EntitySearchResult) => {
    const next = universalContextFromSearchResult(result)
    onUniversalContextChange(next, { pushHistory: true })
    syncUniversalContextToUrl(next, 'push')
    if (layoutMode === 'command' && (visualMode === 'table' || visualMode === 'cards')) {
      setDrawerOpen(true)
    }
  }, [layoutMode, onUniversalContextChange, visualMode])

  const handleGraphNodeSelect = useCallback((_nodeId: string, nodeType: string, entityId: string) => {
    const next = mergeUniversalContexts(universalContext, {
      entityType: nodeType as UniversalEntityContext['entityType'],
      entityId,
    })
    onUniversalContextChange(next, { pushHistory: true })
    syncUniversalContextToUrl(next, 'push')
  }, [onUniversalContextChange, universalContext])

  const handleContactSelect = useCallback((entry: ContactLadderEntry) => {
    const next = mergeUniversalContexts(universalContext, {
      entityType: entry.type,
      entityId: entry.id,
      contactMethodType: entry.type,
      contactMethodId: entry.id,
      prospectId: entry.prospectId ?? universalContext.prospectId,
    })
    onUniversalContextChange(next, { pushHistory: true })
  }, [onUniversalContextChange, universalContext])

  const actions = useMemo(
    () => buildEntityGraphActions(universalContext, dossier?.threads?.length ?? 0),
    [dossier?.threads?.length, universalContext],
  )

  const effectiveVisualMode: EntityGraphVisualMode = layoutMode === 'peek' ? 'cards' : visualMode
  const showModeSwitcher = layoutMode === 'command'
  const showGraph = (layoutMode === 'workspace' && hasSelection) || (layoutMode === 'command' && visualMode === 'graph' && hasSelection)
  const showSideDossier = layoutMode === 'explorer' || layoutMode === 'workspace' || (layoutMode === 'command' && visualMode === 'graph')
  const showPeekPreview = layoutMode === 'peek' && hasSelection
  const showDrawer = layoutMode === 'command' && drawerOpen && hasSelection && (visualMode === 'table' || visualMode === 'cards')

  const columns = TABLE_COLUMNS[activeTab]

  const renderResultCards = () => (
    <div className={`nx-entity-graph__card-grid${layoutMode === 'peek' ? ' is-compact' : ''}`}>
      {results.map((result) => (
        <button
          key={`${result.entityType}:${result.entityId}`}
          type="button"
          className={`nx-entity-graph__result-card${selectedType === result.entityType && selectedId === result.entityId ? ' is-selected' : ''}`}
          data-entity-type={result.entityType}
          onClick={() => handleSelectResult(result)}
        >
          <div className="nx-entity-graph__result-title">{result.title}</div>
          {result.subtitle && <div className="nx-entity-graph__result-sub">{result.subtitle}</div>}
          <div className="nx-entity-graph__badges">
            <span className="nx-entity-graph__badge">{entityTypeLabel(result.entityType)}</span>
            {result.badges.slice(0, 2).map((badge) => (
              <span key={badge} className="nx-entity-graph__badge">{badge}</span>
            ))}
          </div>
          <div className="nx-entity-graph__result-metrics">
            {result.linkedCounts.properties !== undefined && <span>{result.linkedCounts.properties} properties</span>}
            {result.linkedCounts.prospects !== undefined && <span>{result.linkedCounts.prospects} people</span>}
            {result.linkedCounts.contacts !== undefined && <span>{result.linkedCounts.contacts} contacts</span>}
          </div>
        </button>
      ))}
    </div>
  )

  const renderResultTable = () => (
    <div className="nx-entity-graph__table-wrap">
      <table className="nx-entity-graph__table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column.key}>{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {results.map((result) => {
            const cells = renderTableRowCells(activeTab, result)
            return (
              <tr
                key={`${result.entityType}:${result.entityId}`}
                className={selectedType === result.entityType && selectedId === result.entityId ? 'is-selected' : ''}
                onClick={() => handleSelectResult(result)}
              >
                {cells.map((cell, index) => (
                  <td key={`${result.entityId}-${index}`}>
                    {index === 0 ? (
                      <>
                        <div className="nx-entity-graph__result-title">{cell}</div>
                        {activeTab === 'properties' && result.subtitle && (
                          <div className="nx-entity-graph__result-sub">{result.subtitle}</div>
                        )}
                      </>
                    ) : cell}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  const renderPagination = () => (
    <div className="nx-entity-graph__pagination">
      <span>{pagination.total.toLocaleString()} records</span>
      <span>Page {Math.floor(cursor / pageSize) + 1}</span>
      <div className="nx-entity-graph__pagination-controls">
        <button
          type="button"
          disabled={cursor <= 0 || listLoading}
          onClick={() => setCursor((current) => Math.max(current - pageSize, 0))}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!pagination.hasMore || listLoading}
          onClick={() => setCursor((current) => pagination.nextCursor ?? current + pageSize)}
        >
          Next
        </button>
      </div>
    </div>
  )

  const renderResultsPanel = () => (
    <div className="nx-entity-graph__results-panel">
      <div className="nx-entity-graph__panel-header">
        <span>{debouncedQuery ? 'Search Results' : TAB_OPTIONS.find((tab) => tab.key === activeTab)?.label}</span>
        {renderPagination()}
      </div>
      {activeTab === 'contact_methods' && (
        <div className="nx-entity-graph__subtype-switch">
          <button type="button" className={contactSubtype === 'phone' ? 'is-active' : ''} onClick={() => setContactSubtype('phone')}>Phones</button>
          <button type="button" className={contactSubtype === 'email' ? 'is-active' : ''} onClick={() => setContactSubtype('email')}>Emails</button>
        </div>
      )}
      <div
        className="nx-entity-graph__panel-body"
        ref={listPanelRef}
        onScroll={() => {
          pendingScrollRestoreRef.current = listPanelRef.current?.scrollTop ?? 0
          syncWorkspaceToUrl(pendingScrollRestoreRef.current)
        }}
      >
        {listLoading && <ResultSkeleton count={layoutMode === 'peek' ? 4 : 8} />}
        {!listLoading && results.length === 0 && (
          <div className="nx-entity-graph__empty">
            {debouncedQuery ? 'No records matched this search.' : 'No records found for this entity type.'}
          </div>
        )}
        {!listLoading && results.length > 0 && (
          effectiveVisualMode === 'table' ? renderResultTable() : renderResultCards()
        )}
      </div>
    </div>
  )

  return (
    <section className={`nx-workspace-surface nx-entity-graph is-layout-${layoutMode}${themeMode === 'light' ? ' is-light-mode' : ''}${showDrawer ? ' is-drawer-open' : ''}`}>
      <header className="nx-entity-graph__header">
        <div className="nx-entity-graph__title">
          <span className="nx-entity-graph__title-icon"><Icon name="grid" /></span>
          Entity Graph
        </div>
        <div className="nx-entity-graph__search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search address, owner, person, phone, email…"
            aria-label="Entity Graph search"
          />
        </div>
        {showModeSwitcher && (
          <div className="nx-entity-graph__mode-switch">
            {(['table', 'cards', 'graph'] as EntityGraphVisualMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`nx-entity-graph__mode-btn${visualMode === mode ? ' is-active' : ''}`}
                onClick={() => setVisualMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="nx-entity-graph__tabs" role="tablist" aria-label="Entity Graph tabs">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            className={`nx-entity-graph__tab${activeTab === tab.key ? ' is-active' : ''}`}
            onClick={() => {
              setActiveTab(tab.key)
            }}
          >
            {tab.label}
            <span className="nx-entity-graph__tab-count">{formatCount(tabCounts?.[tab.countKey])}</span>
          </button>
        ))}
      </div>

      <div className={`nx-entity-graph__body is-mode-${layoutMode === 'command' ? visualMode : effectiveVisualMode}${showGraph ? ' is-graph-visible' : ''}`}>
        {(layoutMode !== 'command' || visualMode !== 'graph') && renderResultsPanel()}

        {showSideDossier && (
          <div className="nx-entity-graph__dossier-panel">
            <div className="nx-entity-graph__panel-header">Selected Record</div>
            <EntityGraphDossierPanel
              dossier={dossier}
              loading={dossierLoading}
              universalContext={universalContext}
              actions={actions}
              onAction={onAction}
              onContactSelect={handleContactSelect}
              onSelectThreadKey={onSelectThreadKey}
            />
          </div>
        )}

        {layoutMode === 'command' && visualMode === 'graph' && (
          <div className="nx-entity-graph__graph-panel">
            {hasSelection ? (
              <EntityGraphRelationshipGraph dossier={dossier} onNodeSelect={handleGraphNodeSelect} />
            ) : (
              <div className="nx-entity-graph__empty">Select an entity to explore its relationship neighborhood.</div>
            )}
          </div>
        )}

        {showGraph && layoutMode !== 'command' && (
          <div className="nx-entity-graph__graph-panel">
            <div className="nx-entity-graph__panel-header">Relationship Graph</div>
            <EntityGraphRelationshipGraph dossier={dossier} onNodeSelect={handleGraphNodeSelect} />
          </div>
        )}

        {showPeekPreview && (
          <div className="nx-entity-graph__peek-preview">
            <EntityGraphDossierPanel
              dossier={dossier}
              loading={dossierLoading}
              universalContext={universalContext}
              actions={actions}
              onAction={onAction}
              onContactSelect={handleContactSelect}
              onSelectThreadKey={onSelectThreadKey}
              compact
            />
            <button
              type="button"
              className="nx-entity-graph__action is-primary"
              onClick={() => onAction?.('open_deal_intelligence', universalContext)}
            >
              Open Full Record
            </button>
          </div>
        )}
      </div>

      {showDrawer && (
        <aside className="nx-entity-graph__drawer" role="dialog" aria-label="Selected entity dossier">
          <header className="nx-entity-graph__drawer-header">
            <strong>Selected Record</strong>
            <button
              type="button"
              className="nx-entity-graph__drawer-close"
              onClick={() => {
                setDrawerOpen(false)
                if (typeof window !== 'undefined' && window.history.length > 1) window.history.back()
              }}
            >
              Close
            </button>
          </header>
          <EntityGraphDossierPanel
            dossier={dossier}
            loading={dossierLoading}
            universalContext={universalContext}
            actions={actions}
            onAction={onAction}
            onContactSelect={handleContactSelect}
            onSelectThreadKey={onSelectThreadKey}
          />
        </aside>
      )}
    </section>
  )
}