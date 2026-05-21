import { useMemo, useState, type KeyboardEvent } from 'react'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { MapLibreMiniMap } from '../home/MapLibreMiniMap'
import { getLinkedRecord, getRecordRelationships } from '../../lib/data/acquisitionData'
import type {
  AcquisitionRecordSummary,
  AcquisitionRecordType,
  AcquisitionWorkspaceModel,
} from './acquisition.types'

interface AcquisitionPageProps {
  data: AcquisitionWorkspaceModel
}

type AcquisitionTab =
  | 'command'
  | 'owners'
  | 'properties'
  | 'prospects'
  | 'contacts'
  | 'inbox'
  | 'queue'
  | 'offers'
  | 'underwriting'
  | 'ai-brain'
  | 'map'
  | 'automations'

const tabs: Array<{ id: AcquisitionTab; label: string; icon: React.ComponentProps<typeof Icon>['name'] }> = [
  { id: 'command', label: 'Command', icon: 'command' },
  { id: 'owners', label: 'Owners', icon: 'users' },
  { id: 'properties', label: 'Properties', icon: 'layers' },
  { id: 'prospects', label: 'Prospects', icon: 'target' },
  { id: 'contacts', label: 'Contacts', icon: 'message' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'queue', label: 'Queue', icon: 'list' },
  { id: 'offers', label: 'Offers', icon: 'file-text' },
  { id: 'underwriting', label: 'Underwriting', icon: 'stats' },
  { id: 'ai-brain', label: 'AI Brain', icon: 'brain' },
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'automations', label: 'Automations', icon: 'bolt' },
]

const kpiIconMap: Record<string, React.ComponentProps<typeof Icon>['name']> = {
  hot_sellers: 'users',
  new_replies: 'message',
  ready_queue: 'send',
  failed_sends: 'alert',
  offers_ready: 'file-text',
  contracts_pending: 'calendar',
  avg_motivation: 'spark',
  pipeline_value: 'trending-up',
  contact_rate: 'activity',
  reply_rate: 'inbox',
}

const chipTypeClass = (type: AcquisitionRecordType) => {
  if (type === 'owner') return 'is-owner'
  if (type === 'property') return 'is-property'
  if (type === 'prospect') return 'is-prospect'
  if (type === 'phone' || type === 'email') return 'is-contact'
  if (type === 'offer' || type === 'contract') return 'is-offer'
  if (type === 'queue_item') return 'is-queue'
  return 'is-message'
}

const kpiToneClass = (tone?: string) => {
  if (tone === 'good') return 'is-good'
  if (tone === 'warn') return 'is-warn'
  if (tone === 'critical') return 'is-critical'
  return 'is-neutral'
}

const statusClass = (value: string) => {
  const normalized = value.toLowerCase()
  if (normalized.includes('critical') || normalized.includes('failed') || normalized.includes('blocked')) {
    return 'is-critical'
  }
  if (normalized.includes('watch') || normalized.includes('pending') || normalized.includes('review')) {
    return 'is-warn'
  }
  if (normalized.includes('healthy') || normalized.includes('ready') || normalized.includes('active')) {
    return 'is-good'
  }
  return 'is-neutral'
}

const severityClass = (severity: 'info' | 'warning' | 'critical') => {
  if (severity === 'critical') return 'is-critical'
  if (severity === 'warning') return 'is-warning'
  return 'is-info'
}

const currency = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)

const parseNumber = (value: string) => {
  const normalized = Number(value.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(normalized) ? normalized : 0
}

const sparkline = (seed: string) => {
  const base = seed
    .split('')
    .reduce((sum, char) => sum + char.charCodeAt(0), 0)

  return Array.from({ length: 8 }, (_, index) => {
    const wave = ((base + index * 17) % 34) + 14
    return Math.min(100, Math.max(16, wave * 2))
  })
}

const filterByMarket = <T extends { market?: string; marketName?: string }>(
  rows: T[],
  selectedMarket: string,
) => {
  if (selectedMarket === 'All Markets') return rows
  return rows.filter((row) => {
    const market = row.market ?? row.marketName ?? ''
    return market.toLowerCase() === selectedMarket.toLowerCase()
  })
}

const ScoreBar = ({ value, tone = 'neutral' }: { value: number; tone?: 'good' | 'warn' | 'critical' | 'neutral' }) => (
  <div className={`acq-scorebar ${tone}`} aria-label={`Score ${Math.round(value)} percent`}>
    <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    <strong>{Math.round(value)}</strong>
  </div>
)

const StatusPill = ({ value }: { value: string }) => (
  <span className={`acq-pill ${statusClass(value)}`}>{value}</span>
)

const EmptyState = ({ title, detail }: { title: string; detail: string }) => (
  <div className="acq-empty-state">
    <Icon name="archive" />
    <h3>{title}</h3>
    <p>{detail}</p>
  </div>
)

const RelationshipChip = ({
  label,
  type,
  id,
  onOpen,
}: {
  label: string
  type: AcquisitionRecordType
  id: string
  onOpen: (type: AcquisitionRecordType, id: string) => void
}) => (
  <button
    type="button"
    className={`acq-chip ${chipTypeClass(type)}`}
    onClick={() => onOpen(type, id)}
    title={`Open ${type}`}
  >
    <span className="acq-chip__dot" />
    <span className="acq-chip__type">{type.replace('_', ' ')}</span>
    <span className="acq-chip__label">{label}</span>
  </button>
)

export const AcquisitionPage = ({ data }: AcquisitionPageProps) => {
  const [activeTab, setActiveTab] = useState<AcquisitionTab>('command')
  const [selectedMarket, setSelectedMarket] = useState<string>(data.marketOptions[0] ?? 'All Markets')
  const [query, setQuery] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [drawerRecord, setDrawerRecord] = useState<AcquisitionRecordSummary | null>(null)

  const filteredOwners = useMemo(() => {
    const byMarket = filterByMarket(data.owners, selectedMarket)
    if (!query.trim()) return byMarket
    const needle = query.toLowerCase()
    return byMarket.filter((owner) =>
      [owner.ownerName, owner.market, owner.status, owner.nextAction].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    )
  }, [data.owners, query, selectedMarket])

  const filteredProperties = useMemo(() => {
    const byMarket = filterByMarket(data.properties, selectedMarket)
    if (!query.trim()) return byMarket
    const needle = query.toLowerCase()
    return byMarket.filter((property) =>
      [property.address, property.market, property.ownerName, property.offerStatus].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    )
  }, [data.properties, query, selectedMarket])

  const filteredProspects = useMemo(() => {
    const byMarket = filterByMarket(data.prospects, selectedMarket)
    if (!query.trim()) return byMarket
    const needle = query.toLowerCase()
    return byMarket.filter((prospect) =>
      [prospect.prospectName, prospect.ownerName, prospect.market, prospect.outreachStatus].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    )
  }, [data.prospects, query, selectedMarket])

  const filteredOffers = useMemo(() => {
    if (selectedMarket === 'All Markets') return data.offers
    const allowedOwnerIds = new Set(filteredOwners.map((owner) => owner.id))
    return data.offers.filter((offer) => allowedOwnerIds.has(offer.ownerId))
  }, [data.offers, filteredOwners, selectedMarket])

  const filteredMapPoints = useMemo(
    () => filterByMarket(data.mapPoints, selectedMarket),
    [data.mapPoints, selectedMarket],
  )

  const marketSnapshots = useMemo(() => {
    return filteredMapPoints.map((point) => ({
      name: point.marketName,
      lng: point.lng,
      lat: point.lat,
      activeLeads: point.leadPulse,
      hotReplies: point.hotReplies,
      queueDepth: point.failedSends + point.highMotivation,
      pressure: Math.min(100, 40 + point.highMotivation * 8 + point.failedSends * 6),
    }))
  }, [filteredMapPoints])

  const commandCards = useMemo(() => {
    const hotReplies = data.activity.filter((item) => item.kind === 'message').slice(0, 5)
    const failedSends = data.activity.filter((item) => item.kind === 'queue' && item.severity === 'critical').slice(0, 5)
    const readyQueue = data.activity.filter((item) => item.kind === 'queue').slice(0, 5)
    const aiActions = data.aiBrain.slice(0, 6)
    const topMarkets = filteredMapPoints.slice(0, 5)
    const offerOps = filteredOffers.slice(0, 5)

    return {
      hotReplies,
      failedSends,
      readyQueue,
      aiActions,
      topMarkets,
      offerOps,
    }
  }, [data.activity, data.aiBrain, filteredMapPoints, filteredOffers])

  const operationStats = useMemo(() => {
    const activeMarketLabel = selectedMarket === 'All Markets' ? `${filteredMapPoints.length} markets` : selectedMarket
    const recordsSynced =
      filteredOwners.length +
      filteredProperties.length +
      filteredProspects.length +
      filteredOffers.length +
      data.phones.length +
      data.emails.length

    const hotSellers = filteredOwners.filter((owner) => owner.motivationScore >= 70).length
    const queueCritical = data.activity.filter((item) => item.kind === 'queue' && item.severity === 'critical').length
    const queueHealth = queueCritical > 0 ? `${queueCritical} failed` : 'Nominal'
    const lastSync = data.activity[0]?.timestamp ?? 'Moments ago'

    return [
      { label: 'Active Market', value: activeMarketLabel, icon: 'pin' as const },
      { label: 'Records Synced', value: `${recordsSynced}`, icon: 'layers' as const },
      { label: 'Hot Sellers', value: `${hotSellers}`, icon: 'spark' as const },
      { label: 'Queue Health', value: queueHealth, icon: 'send' as const },
      { label: 'Last Sync', value: lastSync, icon: 'clock' as const },
    ]
  }, [data.activity, data.emails.length, data.phones.length, filteredMapPoints.length, filteredOffers.length, filteredOwners, filteredProperties.length, filteredProspects.length, selectedMarket])

  const tabCounts = useMemo(
    () => ({
      owners: filteredOwners.length,
      properties: filteredProperties.length,
      prospects: filteredProspects.length,
      contacts: data.phones.length + data.emails.length,
      inbox: data.activity.filter((item) => item.kind === 'message').length,
      queue: data.activity.filter((item) => item.kind === 'queue').length,
      offers: filteredOffers.length,
      underwriting: data.underwriting.length,
      'ai-brain': data.aiBrain.length,
      map: filteredMapPoints.length,
      automations: data.automations.length,
      command: 0,
    }),
    [data.activity, data.aiBrain.length, data.automations.length, data.emails.length, data.phones.length, data.underwriting.length, filteredMapPoints.length, filteredOffers.length, filteredOwners.length, filteredProperties.length, filteredProspects.length],
  )

  const openRecord = async (type: AcquisitionRecordType, id: string) => {
    setDrawerOpen(true)
    setDrawerLoading(true)
    try {
      const [record, relationships] = await Promise.all([
        getLinkedRecord(type, id),
        getRecordRelationships(type, id),
      ])
      setDrawerRecord({ ...record, linkedRecords: relationships })
    } catch {
      setDrawerRecord({
        id,
        title: `${type} ${id}`,
        type,
        subtitle: 'Unable to load record details',
        keyFields: [],
        linkedRecords: [],
        recentActivity: ['Data unavailable'],
        quickActions: ['Open Full Record'],
      })
    } finally {
      setDrawerLoading(false)
    }
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const index = tabs.findIndex((tab) => tab.id === activeTab)
    if (index < 0) return
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length
    setActiveTab(tabs[next]!.id)
  }

  return (
    <section className="acq-workspace">
      <header className="acq-header">
        <div className="acq-header__hero">
          <div className="acq-header__hero-text">
            <p className="acq-header__eyebrow">Command Space</p>
            <h1>Acquisition Command</h1>
            <p>{data.subtitle}</p>
          </div>
          <span className="acq-header__live-pill">
            <span className="acq-live-dot" />
            {data.status}
          </span>
        </div>

        <div className="acq-header__controls">
          <label>
            <span>Market</span>
            <select
              value={selectedMarket}
              onChange={(event) => setSelectedMarket(event.target.value)}
            >
              {data.marketOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="acq-header__search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search owners, properties, prospects, offers"
            />
          </label>

          <span className="acq-header__hint">⌘K Command Palette</span>
        </div>

        <div className="acq-header__actions">
          <button type="button" onClick={() => pushRoutePath('/command-store')}>New Campaign</button>
          <button type="button" onClick={() => pushRoutePath('/inbox')}>Open Inbox</button>
          <button type="button" onClick={() => pushRoutePath('/queue')}>Open Queue</button>
          <button type="button" onClick={() => setActiveTab('offers')}>Generate Offer</button>
          <button type="button" onClick={() => setActiveTab('owners')}>Review Hot Sellers</button>
          <button type="button" onClick={() => setActiveTab('map')}>Open Map</button>
        </div>

        <div className="acq-op-row">
          {operationStats.map((stat) => (
            <article key={stat.label} className="acq-op-tile">
              <div>
                <Icon name={stat.icon} />
                <span>{stat.label}</span>
              </div>
              <strong>{stat.value}</strong>
            </article>
          ))}
        </div>
      </header>

      <section className="acq-kpis" aria-label="Acquisition KPIs">
        {data.kpis.map((kpi) => {
          const numeric = parseNumber(kpi.value)
          const bars = sparkline(kpi.id)
          const delta = kpi.trend ?? 'Live sync'
          const icon = kpiIconMap[kpi.id] ?? 'stats'
          const actionLabel = kpi.id.includes('queue') || kpi.id.includes('failed') ? 'Inspect Queue' : 'Open Details'

          return (
            <button
              key={kpi.id}
              type="button"
              className={`acq-kpi ${kpiToneClass(kpi.tone)}`}
              onClick={() => {
                if (kpi.id.includes('queue') || kpi.id.includes('failed')) {
                  setActiveTab('queue')
                  return
                }
                if (kpi.id.includes('reply') || kpi.id.includes('contact')) {
                  setActiveTab('inbox')
                  return
                }
                if (kpi.id.includes('offer') || kpi.id.includes('contract')) {
                  setActiveTab('offers')
                  return
                }
                setActiveTab('command')
              }}
            >
              <div className="acq-kpi__top">
                <span>
                  <Icon name={icon} />
                  {kpi.label}
                </span>
                <small>{actionLabel}</small>
              </div>
              <strong>{kpi.value}</strong>
              <div className="acq-kpi__meta">
                <em>{delta}</em>
                <span>{numeric > 0 ? '+' : ''}{Math.round((numeric % 11) + 2)}%</span>
              </div>
              <div className="acq-kpi__spark" aria-hidden="true">
                {bars.map((bar, index) => (
                  <i key={`${kpi.id}-${index}`} style={{ height: `${bar}%` }} />
                ))}
              </div>
            </button>
          )
        })}
      </section>

      <div className="acq-tabs" role="tablist" aria-label="Acquisition apps" onKeyDown={onTabKeyDown}>
        {tabs.map((tab) => {
          const count = tabCounts[tab.id]
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'is-active' : ''}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon name={tab.icon} />
              <span>{tab.label}</span>
              {count > 0 && <small>{count}</small>}
            </button>
          )
        })}
      </div>

      <div className="acq-panel">
        {activeTab === 'command' && (
          <div className="acq-bento">
            <article className="acq-card acq-zone-sellers">
              <header>
                <h2>Priority Seller Stack</h2>
                <button type="button" onClick={() => setActiveTab('owners')}>Open Owners</button>
              </header>
              <div className="acq-stack acq-stack--premium">
                {filteredOwners.slice(0, 6).map((owner) => (
                  <button
                    key={owner.id}
                    type="button"
                    className="acq-owner-row"
                    onClick={() => openRecord('owner', owner.id)}
                  >
                    <div className="acq-owner-row__head">
                      <strong>{owner.ownerName}</strong>
                      <StatusPill value={owner.status} />
                    </div>
                    <div className="acq-owner-row__meta">
                      <span>{owner.market}</span>
                      <span>{owner.portfolioCount} properties</span>
                      <span>{owner.lastActivity}</span>
                    </div>
                    <div className="acq-owner-row__scores">
                      <label>
                        Motivation
                        <ScoreBar value={owner.motivationScore} tone={owner.motivationScore >= 70 ? 'good' : owner.motivationScore <= 35 ? 'critical' : 'warn'} />
                      </label>
                      <label>
                        Contact Probability
                        <ScoreBar value={owner.contactProbability} tone={owner.contactProbability >= 70 ? 'good' : owner.contactProbability <= 35 ? 'critical' : 'warn'} />
                      </label>
                    </div>
                    <p className="acq-owner-row__next">Next Action: {owner.nextAction}</p>
                    <div className="acq-owner-row__chips">
                      <RelationshipChip label={owner.ownerName} type="owner" id={owner.id} onOpen={openRecord} />
                      <RelationshipChip label={`${owner.propertyIds.length} properties`} type="property" id={owner.propertyIds[0] ?? owner.id} onOpen={openRecord} />
                      <RelationshipChip label="Inbox" type="inbox_thread" id={owner.phoneIds[0] ?? owner.id} onOpen={openRecord} />
                      {owner.prospectIds.length > 0 && (
                        <RelationshipChip label="Offer" type="offer" id={owner.prospectIds[0] ?? owner.id} onOpen={openRecord} />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-hot-replies">
              <header>
                <h2>Hot Replies</h2>
                <button type="button" onClick={() => setActiveTab('inbox')}>Inbox</button>
              </header>
              <div className="acq-list">
                {commandCards.hotReplies.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`acq-feed-item ${severityClass(item.severity)}`}
                    onClick={() => openRecord(item.recordType ?? 'inbox_thread', item.recordId ?? item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                    <small>{item.timestamp}</small>
                  </button>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-ready-queue">
              <header>
                <h2>Ready Queue</h2>
                <button type="button" onClick={() => setActiveTab('queue')}>Queue</button>
              </header>
              <div className="acq-list">
                {commandCards.readyQueue.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`acq-feed-item ${severityClass(item.severity)}`}
                    onClick={() => openRecord(item.recordType ?? 'queue_item', item.recordId ?? item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                    <small>{item.timestamp}</small>
                  </button>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-failed-sends">
              <header>
                <h2>Failed Sends</h2>
                <button type="button" onClick={() => setActiveTab('queue')}>Recover</button>
              </header>
              <div className="acq-list">
                {commandCards.failedSends.length === 0 && (
                  <EmptyState title="No failed sends" detail="Queue delivery is stable in the current market scope." />
                )}
                {commandCards.failedSends.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`acq-feed-item ${severityClass(item.severity)}`}
                    onClick={() => openRecord(item.recordType ?? 'queue_item', item.recordId ?? item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                    <small>{item.timestamp}</small>
                  </button>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-markets">
              <header>
                <h2>Top Acquisition Markets</h2>
                <button type="button" onClick={() => setActiveTab('map')}>Open Map</button>
              </header>
              <div className="acq-market-grid">
                {commandCards.topMarkets.map((point) => (
                  <button key={point.id} type="button" className="acq-market-tile">
                    <strong>{point.marketName}</strong>
                    <span>Lead Pulse {point.leadPulse}</span>
                    <span>Hot Replies {point.hotReplies}</span>
                    <span>Failed Sends {point.failedSends}</span>
                  </button>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-ai-actions">
              <header>
                <h2>AI Recommended Next Actions</h2>
                <button type="button" onClick={() => setActiveTab('ai-brain')}>AI Brain</button>
              </header>
              <div className="acq-list">
                {commandCards.aiActions.map((item) => (
                  <div key={item.id} className="acq-inline-item">
                    <div>
                      <strong>{item.ownerName}</strong>
                      <span>{item.recommendedNextAction}</span>
                    </div>
                    <RelationshipChip
                      label={`${item.aiConfidence}%`}
                      type="owner"
                      id={item.ownerId}
                      onOpen={openRecord}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-offers">
              <header>
                <h2>Offer Opportunities</h2>
                <button type="button" onClick={() => setActiveTab('offers')}>Offer Studio</button>
              </header>
              <div className="acq-list">
                {commandCards.offerOps.map((offer) => (
                  <div key={offer.id} className="acq-inline-item">
                    <div>
                      <strong>{offer.propertyAddress}</strong>
                      <span>{offer.ownerName}</span>
                    </div>
                    <RelationshipChip
                      label={currency(offer.recommendedOffer)}
                      type="offer"
                      id={offer.id}
                      onOpen={openRecord}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-review">
              <header>
                <h2>Property Review Needed</h2>
              </header>
              <div className="acq-list">
                {filteredProperties.slice(0, 4).map((property) => (
                  <div key={property.id} className="acq-inline-item">
                    <div>
                      <strong>{property.address}</strong>
                      <span>{property.market}</span>
                    </div>
                    <RelationshipChip
                      label={`AI ${property.aiScore}`}
                      type="property"
                      id={property.id}
                      onOpen={openRecord}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-map-preview">
              <header>
                <h2>Market / Property Map Preview</h2>
              </header>
              <div className="acq-map-wrap">
                <MapLibreMiniMap
                  markets={marketSnapshots}
                  heatMode={true}
                  leadPulses={true}
                  expanded={false}
                />
              </div>
            </article>

            <article className="acq-card acq-zone-deals">
              <header>
                <h2>Recent Deals Moving Forward</h2>
                <button type="button" onClick={() => setActiveTab('offers')}>Open Offers</button>
              </header>
              <div className="acq-list">
                {filteredOffers.slice(0, 4).map((offer) => (
                  <div key={offer.id} className="acq-inline-item">
                    <div>
                      <strong>{offer.propertyAddress}</strong>
                      <span>{offer.offerStatus} • {offer.nextAction}</span>
                    </div>
                    <RelationshipChip
                      label="Open"
                      type="offer"
                      id={offer.id}
                      onOpen={openRecord}
                    />
                  </div>
                ))}
              </div>
            </article>

            <article className="acq-card acq-zone-activity">
              <header>
                <h2>Live Activity</h2>
              </header>
              <div className="acq-list">
                {data.activity.slice(0, 7).map((item) => (
                  <button
                    key={item.id}
                    className={`acq-feed-item ${severityClass(item.severity)}`}
                    type="button"
                    onClick={() => openRecord(item.recordType ?? 'queue_item', item.recordId ?? item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                    <small>{item.timestamp}</small>
                  </button>
                ))}
              </div>
            </article>
          </div>
        )}

        {activeTab === 'owners' && (
          <div className="acq-table-wrap">
            {filteredOwners.length === 0 ? (
              <EmptyState title="No owners found" detail="Adjust market or search filters to reveal owner records." />
            ) : (
              <table className="acq-table acq-table--premium">
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Market</th>
                    <th>Portfolio</th>
                    <th>Value</th>
                    <th>Motivation</th>
                    <th>Contact Probability</th>
                    <th>Status</th>
                    <th>Next Action</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOwners.map((owner) => (
                    <tr key={owner.id}>
                      <td>
                        <div className="acq-cell-stack">
                          <RelationshipChip label={owner.ownerName} type="owner" id={owner.id} onOpen={openRecord} />
                          <small>{owner.ownerType} • {owner.state}</small>
                        </div>
                      </td>
                      <td>{owner.market}</td>
                      <td><span className="acq-badge">{owner.portfolioCount}</span></td>
                      <td>{currency(owner.estimatedPortfolioValue)}</td>
                      <td><ScoreBar value={owner.motivationScore} tone={owner.motivationScore >= 70 ? 'good' : owner.motivationScore <= 35 ? 'critical' : 'warn'} /></td>
                      <td><ScoreBar value={owner.contactProbability} tone={owner.contactProbability >= 70 ? 'good' : owner.contactProbability <= 35 ? 'critical' : 'warn'} /></td>
                      <td><StatusPill value={owner.status} /></td>
                      <td>{owner.nextAction}</td>
                      <td>
                        <div className="acq-action-row">
                          <button type="button" onClick={() => openRecord('owner', owner.id)}>Open</button>
                          <button type="button" onClick={() => setActiveTab('inbox')}>Inbox</button>
                          <button type="button" onClick={() => setActiveTab('offers')}>Offer</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'properties' && (
          <div className="acq-table-wrap">
            {filteredProperties.length === 0 ? (
              <EmptyState title="No properties found" detail="Properties will appear when matching records are in scope." />
            ) : (
              <table className="acq-table acq-table--premium">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Type</th>
                    <th>Owner</th>
                    <th>Value</th>
                    <th>Equity</th>
                    <th>Distress</th>
                    <th>AI Score</th>
                    <th>Offer Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProperties.map((property) => {
                    const [isUnderwriting, setIsUnderwriting] = useState(false)
                    return (
                      <tr key={property.id}>
                        <td>
                          <div className="acq-cell-stack">
                            <RelationshipChip label={property.address} type="property" id={property.id} onOpen={openRecord} />
                            <small>{property.market} • {property.lastActivity}</small>
                          </div>
                        </td>
                        <td><span className="acq-badge">{property.propertyType}</span></td>
                        <td>
                          <RelationshipChip
                            label={property.ownerName}
                            type="owner"
                            id={property.ownerId}
                            onOpen={openRecord}
                          />
                        </td>
                        <td>{currency(property.value)}</td>
                        <td><span className="acq-badge is-emerald">{currency(property.equity)}</span></td>
                        <td>
                          <div className="acq-chip-group">
                            {property.distressTags.length === 0 && <span className="acq-tag">None</span>}
                            {property.distressTags.map((tag) => (
                              <span key={`${property.id}-${tag}`} className="acq-tag">{tag}</span>
                            ))}
                          </div>
                        </td>
                        <td><ScoreBar value={property.aiScore} tone={property.aiScore >= 70 ? 'good' : property.aiScore <= 35 ? 'critical' : 'warn'} /></td>
                        <td><StatusPill value={property.offerStatus} /></td>
                        <td>
                          <div className="acq-action-row">
                            <button type="button" onClick={() => openRecord('property', property.id)}>Open</button>
                            <button type="button" onClick={() => setActiveTab('map')}>Map</button>
                            <button 
                              type="button" 
                              disabled={isUnderwriting}
                              onClick={async () => {
                                setIsUnderwriting(true)
                                try {
                                  const res = await fetch('/api/internal/offers/underwrite', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ address: property.address, propertyType: property.propertyType })
                                  })
                                  const data = await res.json()
                                  if (data.error) throw new Error(data.error)
                                  alert(`Underwriting Complete for ${property.address}:\nARV: ${currency(data.valuation.arv_estimate)}\nMAO: ${currency(data.valuation.mao)}\nVerdict: ${data.valuation.verdict.toUpperCase()}`)
                                  setActiveTab('underwriting')
                                } catch (err) {
                                  alert('Underwriting failed: ' + (err instanceof Error ? err.message : String(err)))
                                } finally {
                                  setIsUnderwriting(false)
                                }
                              }}
                            >
                              {isUnderwriting ? '...' : 'Underwrite'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'prospects' && (
          <div className="acq-table-wrap">
            {filteredProspects.length === 0 ? (
              <EmptyState title="No prospects found" detail="Prospect relationships appear after linked owner scans complete." />
            ) : (
              <table className="acq-table acq-table--premium">
                <thead>
                  <tr>
                    <th>Prospect</th>
                    <th>Linked Owner</th>
                    <th>Market</th>
                    <th>Language</th>
                    <th>Contact Probability</th>
                    <th>Status</th>
                    <th>Last Message</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProspects.map((prospect) => (
                    <tr key={prospect.id}>
                      <td>
                        <div className="acq-cell-stack">
                          <RelationshipChip label={prospect.prospectName} type="prospect" id={prospect.id} onOpen={openRecord} />
                          <small>{prospect.relationshipType}</small>
                        </div>
                      </td>
                      <td>
                        <RelationshipChip label={prospect.ownerName} type="owner" id={prospect.ownerId} onOpen={openRecord} />
                      </td>
                      <td>{prospect.market}</td>
                      <td><span className="acq-badge">{prospect.language}</span></td>
                      <td><ScoreBar value={prospect.contactProbability} tone={prospect.contactProbability >= 70 ? 'good' : prospect.contactProbability <= 35 ? 'critical' : 'warn'} /></td>
                      <td><StatusPill value={prospect.outreachStatus} /></td>
                      <td>{prospect.lastMessage}</td>
                      <td>
                        <div className="acq-action-row">
                          <button type="button" onClick={() => openRecord('prospect', prospect.id)}>Open</button>
                          <button type="button" onClick={() => setActiveTab('inbox')}>Inbox</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="acq-contact-grid">
            <article className="acq-card">
              <header>
                <h2>Phone Numbers</h2>
              </header>
              <table className="acq-table acq-table--compact acq-table--premium">
                <thead>
                  <tr>
                    <th>Phone</th>
                    <th>Owner</th>
                    <th>Type</th>
                    <th>Score</th>
                    <th>SMS</th>
                    <th>Suppression</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.phones.map((phone) => (
                    <tr key={phone.id}>
                      <td><RelationshipChip label={phone.phoneNumber} type="phone" id={phone.id} onOpen={openRecord} /></td>
                      <td><RelationshipChip label={phone.ownerName} type="owner" id={phone.ownerId} onOpen={openRecord} /></td>
                      <td>{phone.phoneType}</td>
                      <td><ScoreBar value={phone.score} tone={phone.score >= 70 ? 'good' : phone.score <= 35 ? 'critical' : 'warn'} /></td>
                      <td><StatusPill value={phone.smsStatus} /></td>
                      <td><span className="acq-badge">{phone.suppression}</span></td>
                      <td>
                        <div className="acq-action-row">
                          <button type="button" onClick={() => openRecord('phone', phone.id)}>Open</button>
                          <button type="button" onClick={() => setActiveTab('inbox')}>Threads</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>

            <article className="acq-card">
              <header>
                <h2>Emails</h2>
              </header>
              <table className="acq-table acq-table--compact acq-table--premium">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Owner</th>
                    <th>Score</th>
                    <th>Linkage</th>
                    <th>Verification</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.emails.map((email) => (
                    <tr key={email.id}>
                      <td><RelationshipChip label={email.email} type="email" id={email.id} onOpen={openRecord} /></td>
                      <td><RelationshipChip label={email.ownerName} type="owner" id={email.ownerId} onOpen={openRecord} /></td>
                      <td><ScoreBar value={email.score} tone={email.score >= 70 ? 'good' : email.score <= 35 ? 'critical' : 'warn'} /></td>
                      <td><span className="acq-badge">{email.linkageQuality}</span></td>
                      <td><StatusPill value={email.verificationStatus} /></td>
                      <td>
                        <div className="acq-action-row">
                          <button type="button" onClick={() => openRecord('email', email.id)}>Open</button>
                          <button type="button" onClick={() => setActiveTab('owners')}>Owner</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          </div>
        )}

        {activeTab === 'inbox' && (
          <div className="acq-embedded-panel">
            <article className="acq-card acq-card--wide">
              <header>
                <h2>Inbox Intelligence</h2>
                <button type="button" onClick={() => pushRoutePath('/inbox')}>Open Full Inbox</button>
              </header>
              <div className="acq-pill-row">
                <span>Hot replies {commandCards.hotReplies.length}</span>
                <span>Needs response {Math.max(0, commandCards.hotReplies.length - 1)}</span>
                <span>AI drafts ready {data.aiBrain.length}</span>
                <span>Open threads {data.activity.filter((item) => item.kind === 'message').length}</span>
              </div>
              <div className="acq-list">
                {data.activity
                  .filter((item) => item.kind === 'message')
                  .slice(0, 8)
                  .map((item) => (
                    <button
                      key={item.id}
                      className={`acq-feed-item ${severityClass(item.severity)}`}
                      type="button"
                      onClick={() => openRecord(item.recordType ?? 'inbox_thread', item.recordId ?? item.id)}
                    >
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                      <div className="acq-feed-links">
                        <RelationshipChip label="Owner" type="owner" id={item.recordId ?? item.id} onOpen={openRecord} />
                        <RelationshipChip label="Property" type="property" id={item.recordId ?? item.id} onOpen={openRecord} />
                      </div>
                      <small>{item.timestamp}</small>
                    </button>
                  ))}
              </div>
            </article>
          </div>
        )}

        {activeTab === 'queue' && (
          <div className="acq-embedded-panel">
            <article className="acq-card acq-card--wide">
              <header>
                <h2>Queue Control Panel</h2>
                <button type="button" onClick={() => pushRoutePath('/queue')}>Open Full Queue</button>
              </header>
              <div className="acq-pill-row">
                <span>Ready now {commandCards.readyQueue.length}</span>
                <span>Scheduled {Math.max(1, data.activity.filter((item) => item.kind === 'queue').length - 2)}</span>
                <span>Approval {Math.max(0, commandCards.failedSends.length - 1)}</span>
                <span>Failed {commandCards.failedSends.length}</span>
                <span>Retry {Math.max(0, commandCards.failedSends.length - 1)}</span>
              </div>
              <div className="acq-list">
                {data.activity
                  .filter((item) => item.kind === 'queue')
                  .slice(0, 8)
                  .map((item) => (
                    <button
                      key={item.id}
                      className={`acq-feed-item ${severityClass(item.severity)}`}
                      type="button"
                      onClick={() => openRecord(item.recordType ?? 'queue_item', item.recordId ?? item.id)}
                    >
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                      <div className="acq-feed-links">
                        <RelationshipChip label="Owner" type="owner" id={item.recordId ?? item.id} onOpen={openRecord} />
                        <RelationshipChip label="Property" type="property" id={item.recordId ?? item.id} onOpen={openRecord} />
                        <RelationshipChip label="Queue" type="queue_item" id={item.recordId ?? item.id} onOpen={openRecord} />
                      </div>
                      <small>{item.timestamp}</small>
                    </button>
                  ))}
              </div>
            </article>
          </div>
        )}

        {activeTab === 'offers' && (
          <div className="acq-table-wrap">
            <div className="acq-section-actions">
              <button type="button">Generate Offer</button>
              <button type="button">Edit Offer</button>
              <button type="button">Send Offer</button>
              <button type="button">Create Contract</button>
              <button type="button" onClick={() => setActiveTab('underwriting')}>Open Underwriting</button>
            </div>
            {filteredOffers.length === 0 ? (
              <EmptyState title="No offers in scope" detail="Generate offers from underwriting recommendations to populate this view." />
            ) : (
              <table className="acq-table acq-table--premium">
                <thead>
                  <tr>
                    <th>Offer</th>
                    <th>Property</th>
                    <th>Owner</th>
                    <th>Strategy</th>
                    <th>Offer</th>
                    <th>Asking</th>
                    <th>Status</th>
                    <th>Confidence</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOffers.map((offer) => (
                    <tr key={offer.id}>
                      <td><RelationshipChip label={offer.id} type="offer" id={offer.id} onOpen={openRecord} /></td>
                      <td><RelationshipChip label={offer.propertyAddress} type="property" id={offer.propertyId} onOpen={openRecord} /></td>
                      <td><RelationshipChip label={offer.ownerName} type="owner" id={offer.ownerId} onOpen={openRecord} /></td>
                      <td><span className="acq-badge">{offer.strategy}</span></td>
                      <td>{currency(offer.recommendedOffer)}</td>
                      <td>{currency(offer.sellerAskingPrice)}</td>
                      <td><StatusPill value={offer.offerStatus} /></td>
                      <td><ScoreBar value={offer.confidence} tone={offer.confidence >= 70 ? 'good' : offer.confidence <= 35 ? 'critical' : 'warn'} /></td>
                      <td>
                        <div className="acq-action-row">
                          <button type="button" onClick={() => openRecord('offer', offer.id)}>Review</button>
                          <button type="button">Send</button>
                          <button type="button">Contract</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'underwriting' && (
          <div className="acq-underwriting-grid">
            {data.underwriting.map((item) => (
              <article key={item.id} className="acq-card acq-underwrite-card">
                <header>
                  <h2>{item.propertyAddress}</h2>
                  <RelationshipChip
                    label="Property"
                    type="property"
                    id={item.propertyId}
                    onOpen={openRecord}
                  />
                </header>
                <div className="acq-metric-grid">
                  <div><span>ARV</span><strong>{currency(item.arv)}</strong></div>
                  <div><span>Repairs</span><strong>{currency(item.repairEstimate)}</strong></div>
                  <div><span>MAO</span><strong>{currency(item.mao)}</strong></div>
                  <div><span>Cash Offer</span><strong>{currency(item.cashOffer)}</strong></div>
                  <div><span>Creative Offer</span><strong>{currency(item.creativeOffer)}</strong></div>
                  <div><span>Rent Estimate</span><strong>{currency(item.rentEstimate)}</strong></div>
                </div>
                <div className="acq-underwrite-card__confidence">
                  <p>Confidence</p>
                  <ScoreBar
                    value={item.aiValuationConfidence}
                    tone={item.aiValuationConfidence >= 70 ? 'good' : item.aiValuationConfidence <= 35 ? 'critical' : 'warn'}
                  />
                </div>
                <p className="acq-note">Risk Notes: {item.riskNotes}</p>
                <p className="acq-note">Recommended Strategy: {item.novationPath}</p>
                <div className="acq-action-row acq-action-row--stretch">
                  <button type="button" onClick={() => openRecord('property', item.propertyId)}>Open Property</button>
                  <button type="button" onClick={() => setActiveTab('offers')}>Generate Offer</button>
                  <button type="button">Create Contract</button>
                </div>
              </article>
            ))}
          </div>
        )}

        {activeTab === 'ai-brain' && (
          <div className="acq-ai-grid">
            {data.aiBrain.map((item) => (
              <article key={item.id} className="acq-card">
                <header>
                  <h2>{item.ownerName}</h2>
                  <StatusPill value={item.conversationStage} />
                </header>
                <div className="acq-pill-row">
                  <span>Intent: {item.sellerIntent}</span>
                  <span>Sentiment: {item.sentiment}</span>
                  <span>Language: {item.language}</span>
                </div>
                <div className="acq-metric-grid">
                  <div><span>Objections</span><strong>{item.objections}</strong></div>
                  <div><span>Agent</span><strong>{item.agentAssigned}</strong></div>
                  <div><span>Template</span><strong>{item.templateRecommendation}</strong></div>
                  <div><span>Follow Up</span><strong>{item.followUpTiming}</strong></div>
                </div>
                <p className="acq-note">Recommended Action: {item.recommendedNextAction}</p>
                <div className="acq-underwrite-card__confidence">
                  <p>AI Confidence</p>
                  <ScoreBar value={item.aiConfidence} tone={item.aiConfidence >= 70 ? 'good' : item.aiConfidence <= 35 ? 'critical' : 'warn'} />
                </div>
              </article>
            ))}
          </div>
        )}

        {activeTab === 'map' && (
          <div className="acq-map-layout">
            <article className="acq-card acq-card--map-large">
              <header>
                <h2>Acquisition Map</h2>
                <div className="acq-pill-row">
                  <span>Heat Mode</span>
                  <span>Lead Pulses</span>
                  <span>Distress Filter</span>
                  <span>Equity Filter</span>
                </div>
              </header>
              <div className="acq-map-wrap acq-map-wrap--large">
                <MapLibreMiniMap
                  markets={marketSnapshots}
                  heatMode={true}
                  leadPulses={true}
                  expanded={true}
                />
              </div>
              <footer>
                <button type="button" onClick={() => pushRoutePath('/dashboard/live')}>Open Full Live Map</button>
              </footer>
            </article>

            <article className="acq-card">
              <header>
                <h2>Lead Pulse List</h2>
              </header>
              <div className="acq-list">
                {filteredMapPoints.map((point) => (
                  <button key={point.id} type="button" className="acq-inline-item">
                    <div>
                      <strong>{point.marketName}</strong>
                      <span>
                        Hot {point.hotReplies} • Failed {point.failedSends} • High Motivation {point.highMotivation}
                      </span>
                    </div>
                    <span className="acq-badge">{point.equityBand}</span>
                  </button>
                ))}
              </div>
            </article>
          </div>
        )}

        {activeTab === 'automations' && (
          <div className="acq-automation-grid">
            {data.automations.map((item) => (
              <article key={item.id} className={`acq-card ${item.status === 'critical' ? 'is-critical' : item.status === 'watch' ? 'is-warn' : ''}`}>
                <header>
                  <h2>{item.name}</h2>
                  <StatusPill value={item.status} />
                </header>
                <div className="acq-metric-grid">
                  <div><span>Failed Jobs</span><strong>{item.failedJobs}</strong></div>
                  <div><span>Last Run</span><strong>{item.lastRun}</strong></div>
                </div>
                <p className="acq-note">{item.detail}</p>
              </article>
            ))}
          </div>
        )}
      </div>

      {drawerOpen && (
        <aside className="acq-drawer">
          <div className="acq-drawer__backdrop" onClick={() => setDrawerOpen(false)} />
          <div className="acq-drawer__panel">
            <header>
              <div>
                <p>{drawerRecord?.type.replace('_', ' ') ?? 'Record'}</p>
                <h2>{drawerRecord?.title ?? 'Loading record'}</h2>
                <span>{drawerRecord?.subtitle ?? ''}</span>
              </div>
              <button type="button" onClick={() => setDrawerOpen(false)}>
                <Icon name="close" />
              </button>
            </header>

            {drawerLoading && <p className="acq-drawer__loading">Loading relationships...</p>}

            {!drawerLoading && drawerRecord && (
              <>
                <section>
                  <h3>Summary</h3>
                  <div className="acq-drawer__fields">
                    {drawerRecord.keyFields.map((field) => (
                      <div key={field.label}>
                        <span>{field.label}</span>
                        <strong>{field.value}</strong>
                      </div>
                    ))}
                  </div>
                </section>

                <section>
                  <h3>Linked Records</h3>
                  <div className="acq-drawer__chips">
                    {drawerRecord.linkedRecords.length === 0 && <span>No linked records found</span>}
                    {drawerRecord.linkedRecords.map((linked) => (
                      <RelationshipChip
                        key={`${linked.type}-${linked.id}`}
                        label={linked.label}
                        type={linked.type}
                        id={linked.id}
                        onOpen={openRecord}
                      />
                    ))}
                  </div>
                </section>

                <section>
                  <h3>Recent Activity</h3>
                  <ul className="acq-drawer__list">
                    {drawerRecord.recentActivity.map((activity) => (
                      <li key={activity}>{activity}</li>
                    ))}
                  </ul>
                </section>

                <section>
                  <h3>AI Recommendation</h3>
                  <p className="acq-note">{drawerRecord.quickActions[0] ?? 'Review linked records and continue with the suggested next action.'}</p>
                </section>

                <section>
                  <h3>Quick Actions</h3>
                  <div className="acq-drawer__actions">
                    {drawerRecord.quickActions.map((action) => (
                      <button key={action} type="button">{action}</button>
                    ))}
                    <button type="button">Open Full Record</button>
                  </div>
                </section>
              </>
            )}
          </div>
        </aside>
      )}
    </section>
  )
}
