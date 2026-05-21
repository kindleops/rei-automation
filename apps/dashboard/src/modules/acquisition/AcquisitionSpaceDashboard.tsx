import { useMemo, useState } from 'react'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import type { AcquisitionWorkspaceModel } from './acquisition.types'
import { filterByMarket, currency, sparkline, parseNumber, kpiToneClass } from './helpers'

interface AcquisitionSpaceDashboardProps {
  data: AcquisitionWorkspaceModel
}

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

const AcquisitionApps = [
  {
    id: 'owners',
    name: 'Owner Intelligence',
    description: 'Seller inventory and motivation analysis',
    icon: 'users',
    route: '/acquisition/owners',
  },
  {
    id: 'properties',
    name: 'Property Intelligence',
    description: 'Property review and underwriting entry',
    icon: 'layers',
    route: '/properties',
  },
  {
    id: 'prospects',
    name: 'Prospect Command',
    description: 'Contact and decision maker targeting',
    icon: 'target',
    route: '/acquisition/prospects',
  },
  {
    id: 'contacts',
    name: 'Contact Stack',
    description: 'Phone and email deliverability',
    icon: 'message',
    route: '/acquisition/contacts',
  },
  {
    id: 'inbox',
    name: 'Seller Inbox',
    description: 'Hot replies and negotiations',
    icon: 'inbox',
    route: '/acquisition/inbox',
  },
  {
    id: 'queue',
    name: 'Outreach Queue',
    description: 'Campaign execution and delivery',
    icon: 'send',
    route: '/acquisition/queue',
  },
  {
    id: 'offers',
    name: 'Offer Studio',
    description: 'Deal generation and management',
    icon: 'file-text',
    route: '/acquisition/offers',
  },
  {
    id: 'underwriting',
    name: 'Underwriting',
    description: 'Valuation and deal analysis',
    icon: 'calculator',
    route: '/acquisition/underwriting',
  },
  {
    id: 'ai-brain',
    name: 'AI Brain',
    description: 'Conversation intelligence and intent',
    icon: 'brain',
    route: '/acquisition/ai-brain',
  },
  {
    id: 'map',
    name: 'Acquisition Map',
    description: 'Spatial lead analysis and clustering',
    icon: 'map',
    route: '/acquisition/map',
  },
  {
    id: 'automations',
    name: 'Automation Monitor',
    description: 'Feeder and job health monitoring',
    icon: 'bolt',
    route: '/acquisition/automations',
  },
]

export const AcquisitionSpaceDashboard = ({ data }: AcquisitionSpaceDashboardProps) => {
  const [selectedMarket, setSelectedMarket] = useState<string>(data.marketOptions[0] ?? 'All Markets')

  const filteredOwners = useMemo(
    () => filterByMarket(data.owners, selectedMarket),
    [data.owners, selectedMarket],
  )

  const filteredProperties = useMemo(
    () => filterByMarket(data.properties, selectedMarket),
    [data.properties, selectedMarket],
  )

  const filteredMapPoints = useMemo(
    () => filterByMarket(data.mapPoints, selectedMarket),
    [data.mapPoints, selectedMarket],
  )

  const operationStats = useMemo(() => {
    const activeMarketLabel = selectedMarket === 'All Markets' ? `${filteredMapPoints.length} markets` : selectedMarket
    const recordsSynced =
      filteredOwners.length +
      filteredProperties.length +
      data.prospects.length +
      data.phones.length +
      data.emails.length
    const hotSellers = filteredOwners.filter((owner) => owner.motivationScore >= 70).length
    const queueCritical = data.activity.filter((item) => item.kind === 'queue' && item.severity === 'critical').length
    const queueHealth = queueCritical > 0 ? `${queueCritical} critical` : 'Healthy'
    const lastSync = data.activity[0]?.timestamp ?? 'Moments ago'

    return [
      { label: 'Active Market', value: activeMarketLabel, icon: 'pin' as const },
      { label: 'Records Synced', value: `${recordsSynced}`, icon: 'layers' as const },
      { label: 'Hot Sellers', value: `${hotSellers}`, icon: 'spark' as const },
      { label: 'Queue Health', value: queueHealth, icon: 'send' as const },
      { label: 'Last Sync', value: lastSync, icon: 'clock' as const },
    ]
  }, [data.activity, data.emails.length, data.phones.length, data.prospects, filteredMapPoints.length, filteredOwners, filteredProperties.length, selectedMarket])

  const commandBriefing = useMemo(() => {
    const hotReplies = data.activity.filter((item) => item.kind === 'message').slice(0, 3)
    const risks = data.activity.filter((item) => item.severity === 'critical').slice(0, 2)
    const topOffers = data.offers.slice(0, 2)
    return { hotReplies, risks, topOffers }
  }, [data.activity, data.offers])

  const topAppCounts = useMemo(
    () => ({
      owners: filteredOwners.length,
      properties: filteredProperties.length,
      prospects: data.prospects.length,
      contacts: data.phones.length + data.emails.length,
      inbox: data.activity.filter((item) => item.kind === 'message').length,
      queue: data.activity.filter((item) => item.kind === 'queue').length,
      offers: data.offers.length,
    }),
    [
      data.activity,
      data.emails.length,
      data.offers.length,
      data.phones.length,
      data.prospects,
      filteredMapPoints.length,
      filteredOwners.length,
      filteredProperties.length,
    ],
  )

  return (
    <section className="acq-space-dashboard">
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
            <select value={selectedMarket} onChange={(event) => setSelectedMarket(event.target.value)}>
              {data.marketOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <span className="acq-header__hint">⌘K Command Palette</span>
        </div>

        <div className="acq-header__actions">
          <button type="button" onClick={() => pushRoutePath('/command-store')}>
            New Campaign
          </button>
          <button type="button" onClick={() => pushRoutePath('/acquisition/inbox')}>
            Open Inbox
          </button>
          <button type="button" onClick={() => pushRoutePath('/acquisition/queue')}>
            Open Queue
          </button>
          <button type="button" onClick={() => pushRoutePath('/acquisition/offers')}>
            Generate Offer
          </button>
          <button type="button" onClick={() => pushRoutePath('/acquisition/owners')}>
            Review Hot Sellers
          </button>
          <button type="button" onClick={() => pushRoutePath('/acquisition/map')}>
            Open Map
          </button>
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

          return (
            <button
              key={kpi.id}
              type="button"
              className={`acq-kpi ${kpiToneClass(kpi.tone)}`}
              onClick={() => {
                if (kpi.id.includes('queue') || kpi.id.includes('failed')) {
                  pushRoutePath('/acquisition/queue')
                  return
                }
                if (kpi.id.includes('reply') || kpi.id.includes('contact')) {
                  pushRoutePath('/acquisition/inbox')
                  return
                }
                if (kpi.id.includes('offer') || kpi.id.includes('contract')) {
                  pushRoutePath('/acquisition/offers')
                  return
                }
                pushRoutePath('/acquisition/owners')
              }}
            >
              <div className="acq-kpi__top">
                <span>
                  <Icon name={icon} />
                  {kpi.label}
                </span>
                <small>Open</small>
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

      <section className="acq-space-briefing">
        <h2>Today's Command Briefing</h2>
        <div className="acq-briefing-grid">
          <article className="acq-briefing-card">
            <h3>Hot Replies</h3>
            {commandBriefing.hotReplies.length > 0 ? (
              <ul>
                {commandBriefing.hotReplies.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="acq-empty-brief">No new replies</p>
            )}
          </article>

          <article className="acq-briefing-card">
            <h3>Operational Risks</h3>
            {commandBriefing.risks.length > 0 ? (
              <ul>
                {commandBriefing.risks.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="acq-empty-brief">No critical issues</p>
            )}
          </article>

          <article className="acq-briefing-card">
            <h3>Ready Offers</h3>
            {commandBriefing.topOffers.length > 0 ? (
              <ul>
                {commandBriefing.topOffers.map((offer) => (
                  <li key={offer.id}>
                    <strong>{offer.propertyAddress}</strong>
                    <p>{currency(offer.recommendedOffer)} offer ready</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="acq-empty-brief">No pending offers</p>
            )}
          </article>
        </div>
      </section>

      <section className="acq-space-launcher">
        <h2>Acquisition Apps</h2>
        <div className="acq-app-grid">
          {AcquisitionApps.map((app) => {
            const count = topAppCounts[app.id as keyof typeof topAppCounts] ?? 0
            return (
              <button
                key={app.id}
                type="button"
                className="acq-app-card"
                onClick={() => pushRoutePath(app.route)}
              >
                <div className="acq-app-card__icon">
                  <Icon name={app.icon as any} />
                </div>
                <h3>{app.name}</h3>
                <p>{app.description}</p>
                {count > 0 && <span className="acq-app-card__count">{count}</span>}
                <div className="acq-app-card__action">
                  <Icon name="chevron-right" />
                </div>
              </button>
            )
          })}
        </div>
      </section>

        <section className="acq-space-preview">
          <h2>Live Market Preview</h2>
          <div className="acq-preview-map">
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '2rem', textAlign: 'center' }}>
              <Icon name="map" style={{ width: '3rem', height: '3rem', opacity: 0.5 }} />
              <p>Map preview loading...</p>
            </div>
            <button type="button" onClick={() => pushRoutePath('/acquisition/map')} className="acq-preview-action">
              Open Acquisition Map
              <Icon name="chevron-right" />
            </button>
          </div>
        </section>

      <section className="acq-space-activity">
        <h2>Recent Activity</h2>
        {data.activity.length > 0 ? (
          <ul className="acq-activity-list">
            {data.activity.slice(0, 10).map((item) => (
              <li key={item.id} className={`is-${item.severity}`}>
                <Icon name={item.severity === 'critical' ? 'alert' : item.severity === 'warning' ? 'flag' : 'briefing'} />
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                  <small>{item.timestamp}</small>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="acq-empty-state">No recent activity</p>
        )}
      </section>
    </section>
  )
}
