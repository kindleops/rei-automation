import { useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
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
  return `/acquisition/map?${params.toString()}`
}

const inboxPath = (property: PropertyRecord, compose = false) => {
  const params = new URLSearchParams()
  if (property.masterOwnerId) params.set('master_owner_id', property.masterOwnerId)
  if (property.propertyId) params.set('property_id', property.propertyId)
  if (compose) params.set('compose', 'sms')
  const query = params.toString()
  return query ? `/acquisition/inbox?${query}` : '/acquisition/inbox'
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

const updatePropertyQueryParam = (propertyId: string | null) => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (propertyId) url.searchParams.set('propertyId', propertyId)
  else url.searchParams.delete('propertyId')
  window.history.replaceState({}, '', `${url.pathname}${url.search}`)
}

export const PropertiesPage = ({ workspaceStatus, fallbackMarketOptions = [] }: PropertiesPageProps) => {
  const [model, setModel] = useState(initialModel)
  const [loading, setLoading] = useState(true)
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
  const [quickFilters, setQuickFilters] = useState<string[]>([])
  const [advancedFilters, setAdvancedFilters] = useState<PropertyFilterClause[]>([])
  const [savedViews, setSavedViews] = useState<SavedPropertyView[]>(loadViews)
  const [view, setView] = useState<PropertyWorkspaceView>('command')
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null)
  const [rawOpen, setRawOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sort, setSort] = useState<PropertySort>({ column: 'final_acquisition_score', ascending: false })
  const [filters, setFilters] = useState<PropertyFilters>({
    market: 'All Markets',
    propertyType: 'All Types',
    ownerType: 'All Owners',
    equity: 'all',
    taxDelinquent: 'all',
    activeLien: 'all',
    search: '',
  })

  const noticeTimerRef = useRef<number | null>(null)

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

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)

    Promise.all([
      fetchPropertyIntelligenceModel(queryParams),
      fetchPropertyCount(queryParams),
      fetchPropertyStats(queryParams),
      fetchPropertyMapPoints(queryParams),
      fetchPropertyFacetOptions(),
    ])
      .then(([nextModel, count, nextStats, nextMapPoints, facets]) => {
        if (!active) return
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
        if (!active) return
        setError(err instanceof Error ? err.message : 'Unable to load property intelligence')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [fallbackMarketOptions, queryParams])

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

  const actionHandlers = (property: PropertyRecord): PropertyActionHandlers => ({
    openInbox: () => pushRoutePath(inboxPath(property)),
    sendSms: () => pushRoutePath(inboxPath(property, true)),
    createOffer: () => pushRoutePath('/acquisition/offers'),
    generateContract: () => flashNotice('Contract flow routed from Offer Studio'),
    viewOnMap: () => pushRoutePath(mapPath(property)),
    addToCampaign: () => flashNotice('Campaign handoff is pending integration'),
    linkContact: () => flashNotice('Contact linking is pending integration'),
    markPriority: () => flashNotice('Priority marker saved for current session'),
    openRawRecord: () => setRawOpen(true),
  })

  const onOpenDetail = (property: PropertyRecord) => {
    setSelectedPropertyId(property.id)
    updatePropertyQueryParam(property.propertyId ?? property.id)
  }

  const onCloseDetail = () => {
    setRawOpen(false)
    updatePropertyQueryParam(null)
    setSelectedPropertyId(null)
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

  if (selectedProperty) {
    return (
      <section className="properties-page properties-page--workspace">
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
    <section className="properties-page">
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
          <button type="button" onClick={() => pushRoutePath('/acquisition/inbox')}>
            <Icon name="inbox" />
            Inbox
          </button>
          <button type="button" onClick={() => pushRoutePath('/acquisition/queue')}>
            <Icon name="send" />
            Queue
          </button>
          <button type="button" onClick={() => pushRoutePath('/acquisition/offers')}>
            <Icon name="trending-up" />
            Offers
          </button>
        </div>
      </header>

      <section className="pi-kpi-row" aria-label="Property KPIs">
        <article>
          <span>Total Properties</span>
          <strong>{totalCount}</strong>
          <small>{workspaceStatus ?? 'Live Sync'}</small>
        </article>
        <article>
          <span>High Equity</span>
          <strong>{stats.highEquityCount}</strong>
          <small>50%+ equity</small>
        </article>
        <article>
          <span>Distress Signals</span>
          <strong>{stats.distressCount}</strong>
          <small>Tax, lien, default, flags</small>
        </article>
        <article>
          <span>Free & Clear</span>
          <strong>{stats.freeClearCount}</strong>
          <small>Loan balance zero</small>
        </article>
        <article>
          <span>Avg Priority</span>
          <strong>{stats.avgPriorityScore}</strong>
          <small>Model weighted score</small>
        </article>
      </section>

      <section className="pi-filter-row" aria-label="Property filters">
        <label>
          <span>Market</span>
          <select
            value={filters.market}
            onChange={(event) => {
              setPage(1)
              setFilters((current) => ({ ...current, market: event.target.value }))
            }}
          >
            {model.marketOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Property Type</span>
          <select
            value={filters.propertyType}
            onChange={(event) => {
              setPage(1)
              setFilters((current) => ({ ...current, propertyType: event.target.value }))
            }}
          >
            {model.propertyTypeOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Owner Type</span>
          <select
            value={filters.ownerType}
            onChange={(event) => {
              setPage(1)
              setFilters((current) => ({ ...current, ownerType: event.target.value }))
            }}
          >
            {model.ownerTypeOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Sort</span>
          <select
            value={`${sort.column}:${sort.ascending ? 'asc' : 'desc'}`}
            onChange={(event) => {
              const [column, direction] = event.target.value.split(':')
              setSort({ column, ascending: direction === 'asc' })
            }}
          >
            <option value="final_acquisition_score:desc">Final Acquisition Score</option>
            <option value="equity_percent:desc">Equity %</option>
            <option value="equity_amount:desc">Equity Amount</option>
            <option value="estimated_value:desc">Estimated Value</option>
            <option value="updated_at:desc">Last Updated</option>
          </select>
        </label>
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

      {loading && (
        <div className="pi-loading">
          <Icon name="radar" />
          <p>Loading property intelligence...</p>
        </div>
      )}

      {!loading && error && (
        <div className="pi-empty-panel">
          <Icon name="alert" />
          <h3>Unable to load properties</h3>
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && view !== 'table' && view !== 'map' && view !== 'raw' && (
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

      {!loading && !error && view === 'table' && (
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

      {!loading && !error && view === 'map' && (
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

      {!loading && !error && view === 'raw' && (
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

      {!loading && !error && visibleRecords.length === 0 && (
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
          Page {page} · Showing {model.properties.length} of {totalCount}
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
