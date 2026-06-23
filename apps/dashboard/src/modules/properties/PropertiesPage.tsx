import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { evaluateContactReadiness } from './contactReadiness'
import { PiGlassSelect } from './PiGlassSelect'
import {
  DEFAULT_LIST_STATE,
  persistPropertyIntelligenceListState,
  pushPropertyDetailState,
  readPropertyIntelligenceStateFromUrl,
  restorePropertyIntelligenceListState,
  writePropertyIntelligenceStateToUrl,
  type PropertyIntelligenceListState,
} from './propertyIntelligenceState'
import {
  fetchPropertyCount,
  fetchPropertyFacetOptions,
  fetchPropertyIntelligenceModel,
  fetchPropertyMapPoints,
  fetchPropertyStats,
  formatMoney,
  type PropertyFilterClause,
  type PropertyFilters,
  type PropertyIntelligenceContext,
  type PropertyIntelligenceModel,
  type PropertyMapPoint,
  type PropertyQueryParams,
  type PropertyRecord,
  type PropertySort,
} from '../../lib/data/propertyData'
import { PropertyCard } from './PropertyCard'
import { PropertyDetail } from './PropertyDetail'
import { PropertyFilterBuilder } from './PropertyFilterBuilder'
import {
  QUICK_FILTERS,
  VIEW_LABELS,
  defaultSavedViews,
  type PropertyWorkspaceView,
  type QuickFilterKey,
  type SavedPropertyView,
} from './propertyFilters'
import type { PropertyActionHandlers } from './property.types'
import './properties.css'

interface PropertiesPageProps {
  workspaceStatus?: string
  fallbackMarketOptions?: string[]
}

const emptyContext: PropertyIntelligenceContext = {
  owner: null,
  contacts: {
    phones: [],
    emails: [],
    prospects: [],
    primaryPhone: null,
    primaryEmail: null,
    bestPhoneConfidence: null,
    bestChannel: null,
    bestContactWindow: null,
    language: null,
  },
  messages: [],
  queue: {
    items: [],
    latest: null,
    lastOutboundAt: null,
    lastInboundAt: null,
    messageCount: 0,
    deliveryState: null,
  },
  offerPathway: {
    offers: [],
    contracts: [],
    latestOffer: null,
    activeContract: null,
  },
}

const PAGE_SIZE = 50

const initialModel: PropertyIntelligenceModel = {
  properties: [],
  contextsByPropertyId: {},
  marketOptions: ['All Markets'],
  propertyTypeOptions: ['All Types'],
  ownerTypeOptions: ['All Owners'],
}

const mapPath = (property: PropertyRecord) => {
  const params = new URLSearchParams()
  if (property.lat !== null && property.lng !== null) {
    params.set('lat', String(property.lat))
    params.set('lng', String(property.lng))
  }
  params.set('propertyId', property.propertyId ?? property.id)
  return `/map?${params.toString()}`
}

const inboxPath = (property: PropertyRecord, compose = false) => {
  const params = new URLSearchParams()
  if (property.masterOwnerId) params.set('master_owner_id', property.masterOwnerId)
  if (property.propertyId) params.set('property_id', property.propertyId)
  if (compose) params.set('compose', 'sms')
  const query = params.toString()
  return query ? `/inbox?${query}` : '/inbox'
}

const saveViews = (views: SavedPropertyView[]) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('nexus:property:saved-views', JSON.stringify(views))
}

const loadViews = (): SavedPropertyView[] => {
  if (typeof window === 'undefined') return defaultSavedViews()
  try {
    const raw = window.localStorage.getItem('nexus:property:saved-views')
    if (!raw) return defaultSavedViews()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : defaultSavedViews()
  } catch {
    return defaultSavedViews()
  }
}

const sortByView = (records: PropertyRecord[], view: PropertyWorkspaceView) => {
  if (view === 'distress') return [...records].sort((a, b) => b.distressSignals.length - a.distressSignals.length)
  if (view === 'equity') return [...records].sort((a, b) => (b.equityPercent ?? 0) - (a.equityPercent ?? 0))
  if (view === 'rehab') return [...records].sort((a, b) => (b.estimatedRepairCost ?? 0) - (a.estimatedRepairCost ?? 0))
  if (view === 'multifamily') {
    return [...records].sort((a, b) => (b.units ?? 0) - (a.units ?? 0))
  }
  return records
}

const matchesView = (record: PropertyRecord, view: PropertyWorkspaceView) => {
  if (view === 'distress') return record.distressSignals.length > 0 || record.taxDelinquent || record.activeLien
  if (view === 'equity') return (record.equityPercent ?? 0) >= 40 || (record.loanBalance ?? 0) <= 0
  if (view === 'rehab') return (record.rehabLevel ?? '').length > 0 || (record.estimatedRepairCost ?? 0) > 0
  if (view === 'multifamily') return (record.propertyType ?? '').toLowerCase().includes('multi')
  return true
}

function buildInitialListState(): PropertyIntelligenceListState {
  const fromUrl = readPropertyIntelligenceStateFromUrl()
  const restored = restorePropertyIntelligenceListState()
  return {
    ...DEFAULT_LIST_STATE,
    ...restored,
    ...fromUrl,
    filters: { ...DEFAULT_LIST_STATE.filters, ...restored?.filters, ...fromUrl.filters },
  }
}

export const PropertiesPage = ({ workspaceStatus, fallbackMarketOptions = [] }: PropertiesPageProps) => {
  const initialListState = useMemo(() => buildInitialListState(), [])
  const [model, setModel] = useState(initialModel)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [stats, setStats] = useState({
    totalProperties: 0,
    highEquityCount: 0,
    distressCount: 0,
    avgPriorityScore: 0,
    taxDelinquentCount: 0,
    activeLienCount: 0,
    freeClearCount: 0,
  })
  const [mapPoints, setMapPoints] = useState<PropertyMapPoint[]>([])
  const [quickFilters, setQuickFilters] = useState<string[]>(initialListState.quickFilters)
  const [advancedFilters, setAdvancedFilters] = useState<PropertyFilterClause[]>(initialListState.advancedFilters)
  const [savedViews, setSavedViews] = useState<SavedPropertyView[]>(loadViews)
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null)
  const [rawOpen, setRawOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [page, setPage] = useState(initialListState.page)
  const [searchInput, setSearchInput] = useState(initialListState.searchInput)
  const [debouncedSearch, setDebouncedSearch] = useState(initialListState.searchInput)
  const [sort, setSort] = useState<PropertySort>(initialListState.sort)
  const [filters, setFilters] = useState<PropertyFilters>(initialListState.filters)
  const [view, setView] = useState<PropertyWorkspaceView>(initialListState.view)

  const noticeTimerRef = useRef<number | null>(null)
  const listScrollRef = useRef<HTMLElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestGenerationRef = useRef(0)
  const pendingScrollRestoreRef = useRef(initialListState.scrollTop)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 260)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = null
    }
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    }
  }, [notice])

  const flashNotice = (message: string) => {
    setNotice(message)
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200)
  }

  const queryFilters = useMemo<PropertyFilters>(
    () => ({
      ...filters,
      search: debouncedSearch,
      quickFilters,
      advanced: advancedFilters,
    }),
    [advancedFilters, debouncedSearch, filters, quickFilters],
  )

  const queryParams = useMemo<PropertyQueryParams>(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      filters: queryFilters,
      sort,
    }),
    [page, queryFilters, sort],
  )

  const currentListState = useCallback((): PropertyIntelligenceListState => ({
    page,
    searchInput,
    sort,
    filters,
    quickFilters,
    advancedFilters,
    view,
    scrollTop: listScrollRef.current?.scrollTop ?? 0,
  }), [advancedFilters, filters, page, quickFilters, searchInput, sort, view])

  useEffect(() => {
    writePropertyIntelligenceStateToUrl(currentListState(), selectedPropertyId)
  }, [currentListState, selectedPropertyId])

  useEffect(() => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const generation = ++requestGenerationRef.current
    const hasData = model.properties.length > 0
    if (hasData) setRefreshing(true)
    else setLoading(true)
    setError(null)

    Promise.all([
      fetchPropertyIntelligenceModel(queryParams),
      fetchPropertyCount(queryParams),
      fetchPropertyStats(queryParams),
      fetchPropertyMapPoints(queryParams),
      fetchPropertyFacetOptions(),
    ])
      .then(([nextModel, count, nextStats, nextMapPoints, facets]) => {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return
        setModel({
          ...nextModel,
          marketOptions:
            nextModel.marketOptions.length > 1
              ? nextModel.marketOptions
              : ['All Markets', ...fallbackMarketOptions.filter((item) => item !== 'All Markets')],
          propertyTypeOptions: facets.propertyTypeOptions,
          ownerTypeOptions: facets.ownerTypeOptions,
        })
        setTotalCount(count)
        setStats(nextStats)
        setMapPoints(nextMapPoints)
      })
      .catch((err) => {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return
        setError(err instanceof Error ? err.message : 'Unable to load property intelligence')
      })
      .finally(() => {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return
        setLoading(false)
        setRefreshing(false)
      })

    return () => controller.abort()
  }, [fallbackMarketOptions, queryParams])

  useEffect(() => {
    const onPopState = () => {
      const restored = (window.history.state?.piState as PropertyIntelligenceListState | undefined) ?? restorePropertyIntelligenceListState()
      if (restored) {
        setPage(restored.page)
        setSearchInput(restored.searchInput)
        setDebouncedSearch(restored.searchInput)
        setSort(restored.sort)
        setFilters(restored.filters)
        setQuickFilters(restored.quickFilters)
        setAdvancedFilters(restored.advancedFilters)
        setView(restored.view)
        window.requestAnimationFrame(() => {
          if (listScrollRef.current) listScrollRef.current.scrollTop = restored.scrollTop
        })
      }
      const propertyId = new URLSearchParams(window.location.search).get('propertyId')
      setSelectedPropertyId(propertyId ? model.properties.find((record) => [record.id, record.propertyId].includes(propertyId))?.id ?? null : null)
      if (!propertyId) setRawOpen(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [model.properties])

  useEffect(() => {
    const propertyId = new URLSearchParams(window.location.search).get('propertyId')
    if (!propertyId) return
    const found = model.properties.find((record) =>
      [record.id, record.propertyId, record.propertyExportId].includes(propertyId),
    )
    if (found) setSelectedPropertyId(found.id)
  }, [model.properties])

  const selectedProperty = useMemo(
    () => model.properties.find((record) => record.id === selectedPropertyId) ?? null,
    [model.properties, selectedPropertyId],
  )

  const focusStack = useMemo(() => {
    return [...model.properties]
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, 3)
  }, [model.properties])

  const visibleRecords = useMemo(() => {
    const filtered = model.properties.filter((record) => matchesView(record, view))
    return sortByView(filtered, view)
  }, [model.properties, view])

  const tableColumns: Array<{ key: string; label: string; render: (row: PropertyRecord) => string | number }> = [
    { key: 'address', label: 'Address', render: (row) => row.address },
    { key: 'owner', label: 'Owner', render: (row) => row.ownerName ?? 'Unknown' },
    { key: 'market', label: 'Market', render: (row) => row.market ?? 'N/A' },
    { key: 'type', label: 'Type', render: (row) => row.propertyType ?? 'N/A' },
    { key: 'value', label: 'Value', render: (row) => formatMoney(row.estimatedValue) },
    { key: 'equity', label: 'Equity', render: (row) => formatMoney(row.equityAmount) },
    { key: 'tax', label: 'Tax', render: (row) => (row.taxDelinquent ? 'Yes' : 'No') },
    { key: 'lien', label: 'Lien', render: (row) => (row.activeLien ? 'Yes' : 'No') },
    { key: 'score', label: 'Score', render: (row) => row.priorityScore },
    { key: 'contact', label: 'Contact', render: (row) => row.distress.contactStatus ?? 'N/A' },
  ]

  const actionHandlers = (property: PropertyRecord): PropertyActionHandlers => {
    const context = model.contextsByPropertyId[property.id] ?? emptyContext
    const readiness = evaluateContactReadiness(context)
    const offerPathway = context.offerPathway
    const offerParams = new URLSearchParams()
    if (property.propertyId) offerParams.set('property_id', property.propertyId)
    if (property.masterOwnerId) offerParams.set('master_owner_id', property.masterOwnerId)
    const closingDeskPath = offerParams.toString() ? `/closing-desk?${offerParams}` : '/closing-desk'

    return {
      openInbox: () => pushRoutePath(inboxPath(property)),
      sendSms: () => {
        if (!readiness.canSendSms) {
          flashNotice(readiness.blockReason ?? 'Link contact before outreach.')
          return
        }
        pushRoutePath(inboxPath(property, true))
      },
      createOffer: () => {
        if (!readiness.hasProspect) {
          flashNotice('Link a prospect before creating an offer.')
          return
        }
        pushRoutePath(closingDeskPath)
      },
      generateContract: () => {
        if (!offerPathway.latestOffer) {
          flashNotice('Create an offer before generating a contract.')
          return
        }
        pushRoutePath(closingDeskPath)
      },
      viewOnMap: () => pushRoutePath(mapPath(property)),
      addToCampaign: () => flashNotice('Campaign handoff is pending integration'),
      linkContact: () => flashNotice('Open Entity Graph or Inbox to link canonical contact records.'),
      markPriority: () => flashNotice('Priority marker saved for current session'),
      openRawRecord: () => setRawOpen(true),
    }
  }

  const onOpenDetail = (property: PropertyRecord) => {
    const state = currentListState()
    persistPropertyIntelligenceListState(state)
    pushPropertyDetailState(state, property.propertyId ?? property.id)
    setSelectedPropertyId(property.id)
  }

  const onCloseDetail = () => {
    setRawOpen(false)
    setSelectedPropertyId(null)
    window.history.back()
  }

  const toggleQuickFilter = (filter: QuickFilterKey) => {
    setPage(1)
    setQuickFilters((current) =>
      current.includes(filter)
        ? current.filter((item) => item !== filter)
        : [...current, filter],
    )
  }

  const onSaveView = (label: string) => {
    const next: SavedPropertyView = {
      id: `saved-${Date.now()}`,
      label,
      filters: advancedFilters,
      quickFilters,
    }
    const updated = [next, ...savedViews]
    setSavedViews(updated)
    saveViews(updated)
    flashNotice(`Saved view: ${label}`)
  }

  const onLoadView = (id: string) => {
    const saved = savedViews.find((viewEntry) => viewEntry.id === id)
    if (!saved) return
    setAdvancedFilters(saved.filters)
    setQuickFilters(saved.quickFilters)
    setPage(1)
    flashNotice(`Loaded view: ${saved.label}`)
  }

  const displayTotalCount = loading && totalCount === 0 ? '…' : totalCount.toLocaleString()
  const displayStats = refreshing || loading
    ? stats
    : stats
  const formatStat = (value: number) => (loading && value === 0 ? '…' : value.toLocaleString())

  if (selectedProperty) {
    return (
      <section className="properties-page properties-page--workspace properties-page--scrollable">
        {notice && <div className="pi-toast">{notice}</div>}
        <PropertyDetail
          property={selectedProperty}
          context={model.contextsByPropertyId[selectedProperty.id] ?? emptyContext}
          rawOpen={rawOpen}
          priorityMarked={false}
          onClose={onCloseDetail}
          onCloseRaw={() => setRawOpen(false)}
          handlers={actionHandlers(selectedProperty)}
        />
      </section>
    )
  }

  return (
    <section
      className={`properties-page properties-page--scrollable${refreshing ? ' is-refreshing' : ''}`}
      ref={listScrollRef}
      onScroll={() => {
        pendingScrollRestoreRef.current = listScrollRef.current?.scrollTop ?? 0
      }}
    >
      {notice && <div className="pi-toast">{notice}</div>}
      <header className="pi-app-header">
        <div>
          <nav className="pi-breadcrumb" aria-label="Property Intelligence breadcrumb">
            <span>LeadCommand</span>
            <span>Acquisition</span>
            <strong>Property Intelligence</strong>
          </nav>
          <h1>Property Intelligence OS</h1>
          <p>
            Full-spectrum property operating system for acquisition command. Assess asset quality,
            owner contactability, risk, and next-best action in seconds.
          </p>
        </div>
        <div className="pi-top-controls">
          <label className="pi-search">
            <Icon name="search" />
            <input
              value={searchInput}
              onChange={(event) => {
                setPage(1)
                setSearchInput(event.target.value)
              }}
              placeholder="Search address, owner, market, tags"
            />
          </label>
          <button type="button" onClick={() => pushRoutePath('/inbox')}>
            <Icon name="inbox" />
            Inbox
          </button>
          <button type="button" onClick={() => pushRoutePath('/queue')}>
            <Icon name="send" />
            Queue
          </button>
          <button type="button" onClick={() => pushRoutePath('/closing-desk')}>
            <Icon name="trending-up" />
            Offers
          </button>
        </div>
      </header>

      <section className={`pi-kpi-row${refreshing ? ' is-loading' : ''}`} aria-label="Property KPIs">
        <article>
          <span>Total Properties</span>
          <strong>{displayTotalCount}</strong>
          <small>{refreshing ? 'Refreshing…' : workspaceStatus ?? 'Live Sync'}</small>
        </article>
        <article>
          <span>High Equity</span>
          <strong>{formatStat(displayStats.highEquityCount)}</strong>
          <small>50%+ equity</small>
        </article>
        <article>
          <span>Distress Signals</span>
          <strong>{formatStat(displayStats.distressCount)}</strong>
          <small>Tax, lien, default, flags</small>
        </article>
        <article>
          <span>Free & Clear</span>
          <strong>{formatStat(displayStats.freeClearCount)}</strong>
          <small>Loan balance zero</small>
        </article>
        <article>
          <span>Avg Priority</span>
          <strong>{loading && displayStats.avgPriorityScore === 0 ? '…' : displayStats.avgPriorityScore}</strong>
          <small>Model weighted score</small>
        </article>
      </section>

      <section className="pi-filter-row" aria-label="Property filters">
        <PiGlassSelect
          label="Market"
          value={filters.market ?? 'All Markets'}
          options={model.marketOptions}
          searchable
          onChange={(value) => {
            setPage(1)
            setFilters((current) => ({ ...current, market: value }))
          }}
        />
        <PiGlassSelect
          label="Property Type"
          value={filters.propertyType ?? 'All Types'}
          options={model.propertyTypeOptions}
          onChange={(value) => {
            setPage(1)
            setFilters((current) => ({ ...current, propertyType: value }))
          }}
        />
        <PiGlassSelect
          label="Owner Type"
          value={filters.ownerType ?? 'All Owners'}
          options={model.ownerTypeOptions}
          onChange={(value) => {
            setPage(1)
            setFilters((current) => ({ ...current, ownerType: value }))
          }}
        />
        <PiGlassSelect
          label="Sort"
          value={`${sort.column}:${sort.ascending ? 'asc' : 'desc'}`}
          options={[
            'final_acquisition_score:desc',
            'equity_percent:desc',
            'equity_amount:desc',
            'estimated_value:desc',
            'updated_at:desc',
          ]}
          onChange={(value) => {
            const [column, direction] = value.split(':')
            setPage(1)
            setSort({ column, ascending: direction === 'asc' })
          }}
        />
        <div className="pi-view-toggle">
          {(Object.keys(VIEW_LABELS) as PropertyWorkspaceView[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={view === mode ? 'is-active' : ''}
              onClick={() => setView(mode)}
            >
              {VIEW_LABELS[mode]}
            </button>
          ))}
        </div>
      </section>

      <section className="pi-quick-filters" aria-label="Quick filters">
        {QUICK_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className={quickFilters.includes(filter) ? 'is-active' : ''}
            onClick={() => toggleQuickFilter(filter)}
          >
            {filter}
          </button>
        ))}
      </section>

      <PropertyFilterBuilder
        filters={advancedFilters}
        onChange={(next) => {
          setPage(1)
          setAdvancedFilters(next)
        }}
        savedViews={savedViews}
        onSaveView={onSaveView}
        onLoadView={onLoadView}
        onClear={() => {
          setPage(1)
          setAdvancedFilters([])
          setQuickFilters([])
        }}
      />

      <section className="pi-focus-stack">
        <header>
          <span>Operator Focus Stack</span>
          <strong>{focusStack.length} high-priority assets</strong>
        </header>
        <div>
          {focusStack.map((property) => (
            <button key={property.id} type="button" onClick={() => onOpenDetail(property)}>
              <span>{property.market ?? 'Unknown Market'}</span>
              <strong>{property.address}</strong>
              <small>{formatMoney(property.estimatedValue)} / {property.equityPercent ?? 0}% equity</small>
              <em>{property.priorityScore}</em>
            </button>
          ))}
        </div>
      </section>

      {loading && model.properties.length === 0 && (
        <div className="pi-loading">
          <Icon name="radar" />
          <p>Loading property intelligence...</p>
        </div>
      )}

      {refreshing && model.properties.length > 0 && (
        <div className="pi-refresh-banner" aria-live="polite">Refreshing filtered results…</div>
      )}

      {!loading && error && (
        <div className="pi-empty-panel">
          <Icon name="alert" />
          <h3>Unable to load properties</h3>
          <p>{error}</p>
        </div>
      )}

      {(!loading || model.properties.length > 0) && !error && view !== 'table' && view !== 'map' && view !== 'raw' && (
        <main className="pi-property-grid" aria-label="Properties">
          {visibleRecords.map((property) => (
            <PropertyCard
              key={property.id}
              property={property}
              context={model.contextsByPropertyId[property.id] ?? emptyContext}
              priorityMarked={false}
              onOpen={() => onOpenDetail(property)}
              onFlag={() => flashNotice('Priority marker saved for current session')}
              onInbox={() => pushRoutePath(inboxPath(property))}
              onMap={() => pushRoutePath(mapPath(property))}
            />
          ))}
        </main>
      )}

      {(!loading || model.properties.length > 0) && !error && view === 'table' && (
        <section className="pi-table-view">
          <table className="pi-table">
            <thead>
              <tr>
                {tableColumns.map((column) => <th key={column.key}>{column.label}</th>)}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRecords.map((row) => (
                <tr key={row.id}>
                  {tableColumns.map((column) => <td key={column.key}>{column.render(row)}</td>)}
                  <td>
                    <button type="button" onClick={() => onOpenDetail(row)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(!loading || model.properties.length > 0) && !error && view === 'map' && (
        <section className="pi-map-view">
          <header>
            <h3>Map Intelligence</h3>
            <p>{mapPoints.length} geocoded properties in current filter set</p>
          </header>
          <div className="pi-map-grid">
            {mapPoints.map((point) => (
              <button
                key={point.id}
                type="button"
                className="pi-map-pin-card"
                onClick={() => {
                  const target = model.properties.find((property) => property.id === point.id)
                  if (target) onOpenDetail(target)
                }}
              >
                <strong>{point.address}</strong>
                <span>{point.market ?? 'Unknown Market'}</span>
                <small>{point.lat.toFixed(4)}, {point.lng.toFixed(4)}</small>
                <em>{point.priorityScore}</em>
              </button>
            ))}
          </div>
        </section>
      )}

      {(!loading || model.properties.length > 0) && !error && view === 'raw' && (
        <section className="pi-raw-view">
          <header>
            <h3>Raw View</h3>
            <p>Paginated records from Supabase with normalized overlays.</p>
          </header>
          <table className="pi-table">
            <thead>
              <tr>
                <th>Property ID</th>
                <th>Address</th>
                <th>Owner</th>
                <th>Final Score</th>
                <th>Raw Payload</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {visibleRecords.map((row) => (
                <tr key={row.id}>
                  <td>{row.propertyId ?? row.id}</td>
                  <td>{row.address}</td>
                  <td>{row.ownerName ?? 'Unknown'}</td>
                  <td>{row.finalAcquisitionScore ?? row.priorityScore}</td>
                  <td>{row.raw.raw_payload_json ? 'JSON' : 'N/A'}</td>
                  <td>
                    <button type="button" onClick={() => onOpenDetail(row)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!loading && !refreshing && !error && visibleRecords.length === 0 && (
        <div className="pi-empty-panel">
          <Icon name="filter" />
          <h3>No properties found</h3>
          <p>No properties match the current intelligence filters.</p>
        </div>
      )}

      <footer className="pi-pagination">
        <button
          type="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span>
          Page {page} · {refreshing ? 'Updating' : 'Showing'} {model.properties.length > 0 || !loading ? model.properties.length : '…'} of {displayTotalCount}
        </span>
        <button
          type="button"
          onClick={() => setPage((current) => current + 1)}
          disabled={page * PAGE_SIZE >= totalCount}
        >
          Next
        </button>
      </footer>
    </section>
  )
}
