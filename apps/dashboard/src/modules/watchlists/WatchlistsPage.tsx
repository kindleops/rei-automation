import { useState } from 'react'
import type { WatchlistsModel, WatchlistItem } from './watchlists.adapter'
import { Icon } from '../../shared/icons'

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const typeIcon: Record<WatchlistItem['type'], string> = {
  market: 'map',
  lead: 'pin',
  agent: 'spark',
  zip: 'hash',
}

const typeLabel: Record<WatchlistItem['type'], string> = {
  market: 'MARKET',
  lead: 'LEAD',
  agent: 'AGENT',
  zip: 'ZIP',
}

export const WatchlistsPage = ({ data }: { data: WatchlistsModel }) => {
  const [filterType, setFilterType] = useState<string>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filtered = filterType === 'all'
    ? data.items
    : data.items.filter((i) => i.type === filterType)

  return (
    <div className="nx-watchlists">
      <header className="nx-surface-header">
        <div className="nx-surface-header__title">
          <Icon className="nx-surface-icon" name="eye" />
          <h1>Watchlists</h1>
        </div>
        <div className="nx-surface-header__stats">
          <span className="nx-badge nx-badge--primary">{data.totalCount} watching</span>
          <span className={classes('nx-badge nx-badge--warning', data.alertingCount > 0 && 'nx-badge--pulse')}>
            {data.alertingCount} alerting
          </span>
        </div>
      </header>

      <div className="nx-watchlists__filters">
        {['all', 'market', 'lead', 'agent', 'zip'].map((type) => (
          <button
            key={type}
            type="button"
            className={classes('nx-filter-pill', filterType === type && 'is-active')}
            onClick={() => setFilterType(type)}
          >
            {type === 'all' ? `All (${data.items.length})` : `${type.charAt(0).toUpperCase() + type.slice(1)}s (${data.items.filter(i => i.type === type).length})`}
          </button>
        ))}
      </div>

      <div className="nx-watchlists__grid">
        {filtered.map((item) => (
          <article
            key={item.id}
            className={classes(
              'nx-watch-card',
              item.alertOnChange && 'is-alerting',
              expandedId === item.id && 'is-expanded',
            )}
            onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
          >
            <div className="nx-watch-card__header">
              <div className="nx-watch-card__header-left">
                <Icon className="nx-watch-card__icon" name={typeIcon[item.type] as any} />
                <span className="nx-watch-card__type">{typeLabel[item.type]}</span>
              </div>
              {item.alertOnChange && (
                <span className="nx-watch-card__alert">
                  <Icon className="nx-watch-alert-icon" name="bell" />
                  Alerting
                </span>
              )}
            </div>
            <h3>{item.label}</h3>
            {item.notes && <p className="nx-watch-card__notes">{item.notes}</p>}
            <span className="nx-watch-card__added">Added {item.addedLabel}</span>

            {expandedId === item.id && (
              <div className="nx-watch-card__expanded">
                <button className="nx-action-button" type="button" onClick={(e) => e.stopPropagation()}>
                  <Icon className="nx-action-button__icon" name="eye" />
                  View Details
                </button>
                <button className="nx-action-button nx-action-button--muted" type="button" onClick={(e) => e.stopPropagation()}>
                  {item.alertOnChange ? 'Mute Alerts' : 'Enable Alerts'}
                </button>
                <button className="nx-action-button nx-action-button--danger" type="button" onClick={(e) => e.stopPropagation()}>
                  Remove
                </button>
              </div>
            )}
          </article>
        ))}
        {filtered.length === 0 && (
          <div className="nx-empty-state">
            <Icon className="nx-empty-icon" name="eye" />
            <p>No items match this filter.</p>
          </div>
        )}
      </div>
    </div>
  )
}
