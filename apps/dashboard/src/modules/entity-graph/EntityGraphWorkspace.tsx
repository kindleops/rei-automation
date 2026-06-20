import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
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
  mergeUniversalContexts,
  syncUniversalContextToUrl,
  universalContextFromSearchResult,
} from '../../domain/entity-graph/universal-entity-context'
import { EntityGraphDossierPanel } from './EntityGraphDossierPanel'
import './entity-graph.css'

type LayoutMode = 'peek' | 'explorer' | 'workspace' | 'command'

const TAB_OPTIONS: Array<{ key: EntityGraphTab; label: string; countKey: keyof EntityGraphTabCounts }> = [
  { key: 'properties', label: 'Properties', countKey: 'properties' },
  { key: 'master_owners', label: 'Master Owners', countKey: 'master_owners' },
  { key: 'people', label: 'People', countKey: 'people' },
  { key: 'organizations', label: 'Organizations', countKey: 'organizations' },
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
    { key: 'title', label: 'Organization' },
    { key: 'subtitle', label: 'Role' },
    { key: 'badges', label: 'Type' },
  ],
  contact_methods: [
    { key: 'title', label: 'Contact' },
    { key: 'subtitle', label: 'Owner' },
    { key: 'badges', label: 'Status' },
  ],
  markets: [
    { key: 'title', label: 'Market' },
    { key: 'linked', label: 'Properties' },
    { key: 'badges', label: 'Type' },
  ],
  zips: [
    { key: 'title', label: 'ZIP' },
    { key: 'subtitle', label: 'Market' },
    { key: 'linked', label: 'Properties' },
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

function RelationshipGraphView({
  dossier,
  onNodeSelect,
}: {
  dossier: EntityGraphDossier | null
  onNodeSelect: (nodeId: string, nodeType: string, entityId: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  const graph = dossier?.graph
  if (!graph || graph.nodes.length === 0) {
    return <div className="nx-entity-graph__empty">Select an entity to render its local relationship network.</div>
  }

  const width = 640
  const height = 420
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.32

  const positioned = graph.nodes.map((node, index) => {
    const isCenter = Boolean(node.meta?.active)
    if (isCenter) return { ...node, x: centerX, y: centerY }
    const angle = ((index - 1) / Math.max(graph.nodes.length - 2, 1)) * Math.PI * 2
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    }
  })
  const byId = new Map(positioned.map((node) => [node.id, node]))

  return (
    <div
      className="nx-entity-graph__graph-canvas is-interactive"
      style={{ height: '100%', minHeight: 280 }}
      onWheel={(event) => {
        event.preventDefault()
        setZoom((current) => Math.min(2, Math.max(0.5, current + (event.deltaY < 0 ? 0.08 : -0.08))))
      }}
      onMouseDown={(event) => {
        dragRef.current = { x: event.clientX - offset.x, y: event.clientY - offset.y }
      }}
      onMouseMove={(event) => {
        if (!dragRef.current) return
        setOffset({ x: event.clientX - dragRef.current.x, y: event.clientY - dragRef.current.y })
      }}
      onMouseUp={() => { dragRef.current = null }}
      onMouseLeave={() => { dragRef.current = null }}
    >
      <div
        className="nx-entity-graph__graph-stage"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="nx-entity-graph__graph-svg">
          {graph.edges.map((edge) => {
            const from = byId.get(edge.from)
            const to = byId.get(edge.to)
            if (!from || !to) return null
            const midX = (from.x + to.x) / 2
            const midY = (from.y + to.y) / 2
            return (
              <g key={`${edge.from}-${edge.to}`}>
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(255,255,255,0.14)" />
                <text x={midX} y={midY} fill="rgba(255,255,255,0.45)" fontSize="9" textAnchor="middle">{edge.label}</text>
              </g>
            )
          })}
        </svg>
        {positioned.map((node) => {
          const [, entityId] = node.id.includes(':') ? node.id.split(':') : [node.type, node.id]
          return (
            <button
              key={node.id}
              type="button"
              className={`nx-entity-graph__graph-node${node.meta?.active ? ' is-active' : ''}`}
              data-type={node.type}
              style={{ left: node.x, top: node.y }}
              onClick={() => onNodeSelect(node.id, node.type, entityId)}
              title={node.label}
            >
              {node.label}
            </button>
          )
        })}
      </div>
    </div>
  )
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
  const [activeTab, setActiveTab] = useState<EntityGraphTab>('properties')
  const [contactSubtype, setContactSubtype] = useState<'phone' | 'email'>('phone')
  const [visualMode, setVisualMode] = useState<EntityGraphVisualMode>(layoutMode === 'peek' ? 'cards' : 'table')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [results, setResults] = useState<EntitySearchResult[]>([])
  const [cursor, setCursor] = useState(0)
  const [pagination, setPagination] = useState({ cursor: 0, pageSize: 25, total: 0, hasMore: false, nextCursor: null as number | null, previousCursor: null as number | null })
  const [tabCounts, setTabCounts] = useState<EntityGraphTabCounts | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [dossier, setDossier] = useState<EntityGraphDossier | null>(null)
  const [dossierLoading, setDossierLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const listAbortRef = useRef<AbortController | null>(null)
  const dossierAbortRef = useRef<AbortController | null>(null)

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

  useEffect(() => {
    setCursor(0)
  }, [activeTab, debouncedQuery, contactSubtype])

  useEffect(() => {
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
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
        if (controller.signal.aborted) return
        setResults(response.results)
        setPagination({
          ...response.pagination,
          previousCursor: response.pagination.previousCursor ?? null,
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResults([])
          setPagination((current) => ({ ...current, total: 0, hasMore: false, nextCursor: null }))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false)
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

  const actions = useMemo(() => {
    const ctx = universalContext
    const list: Array<{ key: EntityGraphAction; label: string; disabled?: boolean }> = []
    if (ctx.threadKey) list.push({ key: 'open_thread', label: 'Open Existing Thread' })
    else list.push({ key: 'create_manual_draft', label: 'Create Manual Draft' })
    if (ctx.propertyId || ctx.entityType === 'property') {
      list.push({ key: 'open_deal_intelligence', label: 'Open Deal Intelligence' })
      list.push({ key: 'open_in_map', label: 'Open in Map' })
      list.push({ key: 'open_comp_intelligence', label: 'Open Comp Intelligence' })
      list.push({ key: 'open_buyer_match', label: 'Open Buyer Match' })
    }
    if (ctx.masterOwnerId || ctx.entityType === 'master_owner') {
      list.push({ key: 'open_in_map', label: 'Open Portfolio in Map' })
      list.push({ key: 'contact_owner', label: 'Contact Owner' })
    }
    if (ctx.entityType === 'market' || ctx.entityType === 'zip') {
      list.push({ key: 'open_in_map', label: 'Open in Map' })
    }
    if (ctx.prospectId) list.push({ key: 'contact_person', label: 'Contact This Person' })
    if (ctx.contactMethodType === 'email') list.push({ key: 'email', label: 'Email' })
    return list
  }, [universalContext])

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
          {results.map((result) => (
            <tr
              key={`${result.entityType}:${result.entityId}`}
              className={selectedType === result.entityType && selectedId === result.entityId ? 'is-selected' : ''}
              onClick={() => handleSelectResult(result)}
            >
              <td>
                <div className="nx-entity-graph__result-title">{result.title}</div>
                {columnHasSubtitle(result) && <div className="nx-entity-graph__result-sub">{result.subtitle}</div>}
              </td>
              <td>{result.subtitle || result.linkedCounts.properties || '—'}</td>
              <td>{result.badges.join(', ') || entityTypeLabel(result.entityType)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  function columnHasSubtitle(result: EntitySearchResult) {
    return Boolean(result.subtitle)
  }

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
      <div className="nx-entity-graph__panel-body">
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
            onClick={() => setActiveTab(tab.key)}
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
              <RelationshipGraphView dossier={dossier} onNodeSelect={handleGraphNodeSelect} />
            ) : (
              <div className="nx-entity-graph__empty">Select an entity to explore its relationship neighborhood.</div>
            )}
          </div>
        )}

        {showGraph && layoutMode !== 'command' && (
          <div className="nx-entity-graph__graph-panel">
            <div className="nx-entity-graph__panel-header">Relationship Graph</div>
            <RelationshipGraphView dossier={dossier} onNodeSelect={handleGraphNodeSelect} />
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
            <button type="button" className="nx-entity-graph__drawer-close" onClick={() => setDrawerOpen(false)}>Close</button>
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