import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import { fetchEntityGraphDossier, searchEntityGraph } from '../../domain/entity-graph/entity-graph-api'
import type {
  ContactLadderEntry,
  EntityGraphAction,
  EntityGraphDossier,
  EntityGraphTab,
  EntityGraphVisualMode,
  EntitySearchResult,
  UniversalEntityContext,
} from '../../domain/entity-graph/entity-graph.types'
import {
  mergeUniversalContexts,
  syncUniversalContextToUrl,
  universalContextFromSearchResult,
} from '../../domain/entity-graph/universal-entity-context'
import './entity-graph.css'

type LayoutMode = 'peek' | 'explorer' | 'workspace' | 'command'

const TAB_OPTIONS: Array<{ key: EntityGraphTab; label: string }> = [
  { key: 'properties', label: 'Properties' },
  { key: 'master_owners', label: 'Master Owners' },
  { key: 'people', label: 'People' },
  { key: 'organizations', label: 'Organizations' },
  { key: 'contact_methods', label: 'Contact Methods' },
  { key: 'markets', label: 'Markets' },
  { key: 'zips', label: 'ZIPs' },
]

const LAYOUT_CLASS: Record<LayoutMode, string> = {
  peek: 'is-layout-peek',
  explorer: 'is-layout-explorer',
  workspace: 'is-layout-workspace',
  command: 'is-layout-command',
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

function renderIdentity(dossier: EntityGraphDossier | null) {
  if (!dossier?.identity) return null
  const id = dossier.identity
  return (
    <div className="nx-entity-graph__identity">
      <h3>{id.masterOwner || dossier.summary?.display_name as string || dossier.summary?.property_address_full as string || dossier.entityId}</h3>
      <div className="nx-entity-graph__identity-grid">
        {id.talkingTo && <div><span>Talking to:</span> {id.talkingTo}{id.talkingToRelationship ? ` · ${id.talkingToRelationship}` : ''}</div>}
        {id.propertyContext && <div><span>Property:</span> {id.propertyContext}</div>}
        {id.contactMethod && <div><span>Channel:</span> {id.contactMethod}</div>}
      </div>
    </div>
  )
}

function ContactLadder({
  ladder,
  onSelect,
}: {
  ladder?: { phones: ContactLadderEntry[]; emails: ContactLadderEntry[] }
  onSelect: (entry: ContactLadderEntry) => void
}) {
  if (!ladder) return null
  const items = [...ladder.phones, ...ladder.emails]
  if (items.length === 0) return null

  return (
    <div className="nx-entity-graph__ladder">
      {items.map((entry) => (
        <button
          key={`${entry.type}:${entry.id}`}
          type="button"
          className={`nx-entity-graph__ladder-item${entry.eligible ? '' : ' is-ineligible'}`}
          onClick={() => onSelect(entry)}
          disabled={!entry.eligible}
        >
          <div>{entry.value}</div>
          <div>{entry.type === 'phone' ? 'Phone' : 'Email'} · Rank {entry.rank ?? '—'}</div>
          <div>{entry.wrongNumber ? 'Wrong Number' : entry.eligible ? 'Eligible' : 'Ineligible'}</div>
        </button>
      ))}
    </div>
  )
}

function RelationshipGraphView({
  dossier,
  onNodeSelect,
}: {
  dossier: EntityGraphDossier | null
  onNodeSelect: (nodeId: string, nodeType: string, entityId: string) => void
}) {
  const graph = dossier?.graph
  if (!graph || graph.nodes.length === 0) {
    return <div className="nx-entity-graph__empty">Select an entity to render its local relationship network.</div>
  }

  const width = 420
  const height = 280
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.34

  const positioned = graph.nodes.map((node, index) => {
    const isCenter = Boolean(node.meta?.active)
    if (isCenter) return { ...node, x: centerX, y: centerY }
    const angle = (index / Math.max(graph.nodes.length - 1, 1)) * Math.PI * 2
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    }
  })

  const byId = new Map(positioned.map((node) => [node.id, node]))

  return (
    <div className="nx-entity-graph__graph-canvas" style={{ width: '100%', height }}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        {graph.edges.map((edge) => {
          const from = byId.get(edge.from)
          const to = byId.get(edge.to)
          if (!from || !to) return null
          return <line key={`${edge.from}-${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(255,255,255,0.12)" />
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
  )
}

export function EntityGraphWorkspace({
  paneWidth = '50',
  themeMode = 'dark',
  universalContext,
  onUniversalContextChange,
  onAction,
  onSelectThreadKey,
}: EntityGraphWorkspaceProps) {
  const layoutMode = resolveLayoutMode(paneWidth)
  const [activeTab, setActiveTab] = useState<EntityGraphTab>('properties')
  const [visualMode, setVisualMode] = useState<EntityGraphVisualMode>(layoutMode === 'peek' ? 'cards' : 'table')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [results, setResults] = useState<EntitySearchResult[]>([])
  const [countsByType, setCountsByType] = useState<Record<string, number>>({})
  const [searchLoading, setSearchLoading] = useState(false)
  const [dossier, setDossier] = useState<EntityGraphDossier | null>(null)
  const [dossierLoading, setDossierLoading] = useState(false)
  const searchAbortRef = useRef<AbortController | null>(null)
  const dossierAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 280)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!debouncedQuery && layoutMode === 'peek') {
      setResults([])
      return
    }

    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    setSearchLoading(true)

    void searchEntityGraph(
      { q: debouncedQuery, tab: activeTab, page_size: layoutMode === 'command' ? 40 : 20 },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return
        setResults(response.results)
        setCountsByType(response.countsByType)
      })
      .catch(() => {
        if (!controller.signal.aborted) setResults([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearchLoading(false)
      })

    return () => controller.abort()
  }, [activeTab, debouncedQuery, layoutMode])

  const selectedType = universalContext.entityType
  const selectedId = universalContext.entityId

  useEffect(() => {
    if (!selectedType || !selectedId) {
      setDossier(null)
      return
    }

    dossierAbortRef.current?.abort()
    const controller = new AbortController()
    dossierAbortRef.current = controller
    setDossierLoading(true)

    void fetchEntityGraphDossier(selectedType, selectedId, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setDossier(next)
      })
      .finally(() => {
        if (!controller.signal.aborted) setDossierLoading(false)
      })

    return () => controller.abort()
  }, [selectedId, selectedType])

  const handleSelectResult = useCallback((result: EntitySearchResult) => {
    const next = universalContextFromSearchResult(result)
    onUniversalContextChange(next, { pushHistory: true })
    syncUniversalContextToUrl(next, 'push')
  }, [onUniversalContextChange])

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
    if (ctx.propertyId) {
      list.push({ key: 'open_deal_intelligence', label: 'Open Deal Intelligence' })
      list.push({ key: 'show_on_map', label: 'Show on Map' })
      list.push({ key: 'open_comp_intelligence', label: 'Open Comp Intelligence' })
      list.push({ key: 'open_buyer_match', label: 'Open Buyer Match' })
    }
    if (ctx.masterOwnerId) list.push({ key: 'contact_owner', label: 'Contact Owner' })
    if (ctx.prospectId) list.push({ key: 'contact_person', label: 'Contact This Person' })
    if (ctx.contactMethodType === 'email') list.push({ key: 'email', label: 'Email' })
    return list
  }, [universalContext])

  const showGraphPanel = layoutMode === 'workspace' || layoutMode === 'command'
  const showResultsRail = layoutMode !== 'peek' || debouncedQuery.length > 0
  const showDossier = layoutMode !== 'peek' || Boolean(selectedId)

  return (
    <section className={`nx-workspace-surface nx-entity-graph ${LAYOUT_CLASS[layoutMode]}${themeMode === 'light' ? ' is-light-mode' : ''}`}>
      <header className="nx-entity-graph__header">
        <div className="nx-entity-graph__title">
          <span className="nx-entity-graph__title-icon"><Icon name="grid" /></span>
          Entity Graph
        </div>
        <div className="nx-entity-graph__search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search address, owner, prospect, phone, email, market, ZIP…"
            aria-label="Entity Graph search"
          />
        </div>
        {layoutMode === 'command' && (
          <div className="nx-entity-graph__mode-switch">
            {(['table', 'cards', 'graph', 'map'] as EntityGraphVisualMode[]).map((mode) => (
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
            {countsByType[tab.key] ? ` · ${countsByType[tab.key]}` : ''}
          </button>
        ))}
      </div>

      <div className="nx-entity-graph__body">
        {showResultsRail && (
          <div className="nx-entity-graph__panel">
            <div className="nx-entity-graph__panel-header">Results</div>
            <div className="nx-entity-graph__panel-body">
              {searchLoading && <div className="nx-entity-graph__loading">Searching canonical records…</div>}
              {!searchLoading && results.length === 0 && (
                <div className="nx-entity-graph__empty">Search canonical entities server-side. No client table loads.</div>
              )}
              {visualMode === 'table' && results.length > 0 && (
                <table className="nx-entity-graph__table">
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th>Type</th>
                      <th>Links</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result) => (
                      <tr key={`${result.entityType}:${result.entityId}`} onClick={() => handleSelectResult(result)} style={{ cursor: 'pointer' }}>
                        <td>
                          <div>{result.title}</div>
                          <div className="nx-entity-graph__result-sub">{result.subtitle}</div>
                        </td>
                        <td>{entityTypeLabel(result.entityType)}</td>
                        <td>{Object.values(result.linkedCounts).reduce((sum, n) => sum + (n || 0), 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {visualMode !== 'table' && results.map((result) => (
                <button
                  key={`${result.entityType}:${result.entityId}`}
                  type="button"
                  className={`nx-entity-graph__result${selectedType === result.entityType && selectedId === result.entityId ? ' is-selected' : ''}`}
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
                </button>
              ))}
            </div>
          </div>
        )}

        {showGraphPanel && (
          <div className="nx-entity-graph__panel">
            <div className="nx-entity-graph__panel-header">Relationship Graph</div>
            <div className="nx-entity-graph__panel-body">
              <RelationshipGraphView dossier={dossier} onNodeSelect={handleGraphNodeSelect} />
            </div>
          </div>
        )}

        {showDossier && (
          <div className="nx-entity-graph__panel">
            <div className="nx-entity-graph__panel-header">Selected Record</div>
            <div className="nx-entity-graph__panel-body">
              {dossierLoading && <div className="nx-entity-graph__loading">Loading dossier…</div>}
              {!dossierLoading && !dossier && <div className="nx-entity-graph__empty">Select an entity to inspect relationships and contact ladder.</div>}
              {!dossierLoading && dossier && (
                <>
                  {renderIdentity(dossier)}
                  <div className="nx-entity-graph__actions">
                    {actions.map((action) => (
                      <button
                        key={action.key}
                        type="button"
                        className="nx-entity-graph__action"
                        disabled={action.disabled}
                        onClick={() => onAction?.(action.key, universalContext)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                  <ContactLadder ladder={dossier.contactLadder} onSelect={handleContactSelect} />
                  {dossier.threads && dossier.threads.length > 0 && (
                    <div className="nx-entity-graph__ladder" style={{ marginTop: 12 }}>
                      {dossier.threads.slice(0, 6).map((thread) => (
                        <button
                          key={String(thread.thread_key)}
                          type="button"
                          className="nx-entity-graph__ladder-item"
                          onClick={() => onSelectThreadKey?.(String(thread.thread_key))}
                        >
                          <div>Thread {String(thread.thread_key).slice(-8)}</div>
                          <div>{String(thread.last_message_body || '').slice(0, 80)}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  {layoutMode === 'peek' && selectedId && (
                    <button
                      type="button"
                      className="nx-entity-graph__action"
                      style={{ marginTop: 12 }}
                      onClick={() => onAction?.('open_deal_intelligence', universalContext)}
                    >
                      Open Full Record
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}