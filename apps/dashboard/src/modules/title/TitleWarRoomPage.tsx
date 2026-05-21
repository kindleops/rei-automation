import { useState } from 'react'
import type { TitleModel, TitleItem } from './title.adapter'
import { Icon } from '../../shared/icons'

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const statusClass: Record<TitleItem['status'], string> = {
  clear: 'is-clear',
  review: 'is-review',
  issue: 'is-issue',
  pending: 'is-pending',
  closed: 'is-closed',
}

const statusLabel: Record<TitleItem['status'], string> = {
  clear: 'CLEAR',
  review: 'REVIEW',
  issue: 'ISSUE',
  pending: 'PENDING',
  closed: 'CLOSED',
}

const statusIcon: Record<TitleItem['status'], string> = {
  clear: 'check',
  review: 'eye',
  issue: 'alert',
  pending: 'clock',
  closed: 'archive',
}

export const TitleWarRoomPage = ({ data }: { data: TitleModel }) => {
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filtered = filterStatus === 'all'
    ? data.items
    : data.items.filter((t) => t.status === filterStatus)

  const urgentCount = data.items.filter(t => t.status === 'issue' || (t.daysInPhase > 30 && t.status !== 'closed')).length

  return (
    <div className="nx-title">
      <header className="nx-surface-header">
        <div className="nx-surface-header__title">
          <Icon className="nx-surface-icon" name="file-text" />
          <h1>Title & Closing</h1>
        </div>
        <div className="nx-surface-header__stats">
          <span className="nx-badge nx-badge--success">{data.clearCount} clear</span>
          {data.issueCount > 0 && (
            <span className="nx-badge nx-badge--danger nx-badge--pulse">{data.issueCount} issues</span>
          )}
          {urgentCount > 0 && (
            <span className="nx-badge nx-badge--warning">{urgentCount} urgent</span>
          )}
          <span className="nx-badge nx-badge--muted">{data.pendingCount} pending</span>
          <span className="nx-badge nx-badge--muted">{data.totalValue} total</span>
        </div>
      </header>

      <div className="nx-title__filters">
        {['all', 'issue', 'review', 'pending', 'clear', 'closed'].map((status) => (
          <button
            key={status}
            type="button"
            className={classes('nx-filter-pill', filterStatus === status && 'is-active')}
            onClick={() => setFilterStatus(status)}
          >
            {status === 'all' ? `All (${data.items.length})` : `${status.charAt(0).toUpperCase() + status.slice(1)} (${data.items.filter(t => t.status === status).length})`}
          </button>
        ))}
      </div>

      <div className="nx-title__grid">
        {filtered.map((item) => (
          <article
            key={item.id}
            className={classes(
              'nx-title-card',
              statusClass[item.status],
              expandedId === item.id && 'is-expanded',
              item.daysInPhase > 30 && item.status !== 'closed' && 'is-overdue',
            )}
            onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
          >
            <div className="nx-title-card__header">
              <div className="nx-title-card__header-left">
                <Icon name={statusIcon[item.status] as any} className={classes('nx-title-card__status-icon', statusClass[item.status])} />
                <span className={classes('nx-title-status', statusClass[item.status])}>
                  {statusLabel[item.status]}
                </span>
                <span className="nx-title-card__phase">{item.closingPhaseLabel}</span>
              </div>
              <span className="nx-title-card__market">{item.marketLabel}</span>
            </div>

            <h3 className="nx-title-card__address">{item.address}</h3>
            <span className="nx-title-card__owner">{item.ownerName}</span>

            <div className="nx-title-card__kpis">
              <div className="nx-kpi-micro">
                <span>Price</span>
                <strong>{item.priceLabel}</strong>
              </div>
              <div className="nx-kpi-micro">
                <span>Earnest</span>
                <strong>{item.earnestLabel}</strong>
              </div>
              <div className="nx-kpi-micro">
                <span>Days</span>
                <strong className={item.daysInPhase > 30 ? 'nx-kpi-danger' : ''}>{item.daysInPhase}</strong>
              </div>
            </div>

            <div className="nx-title-card__company">
              <Icon className="nx-title-card__company-icon" name="shield" />
              {item.titleCompany}
            </div>

            {item.scheduledCloseLabel && (
              <div className="nx-title-card__close-date">
                <Icon className="nx-title-card__date-icon" name="calendar" />
                Close: {item.scheduledCloseLabel}
              </div>
            )}

            {item.issues.length > 0 && (
              <div className="nx-title-card__issues">
                <h4>
                  <Icon name="alert" className="nx-issue-header-icon" />
                  Issues ({item.issues.length})
                </h4>
                <ul>
                  {item.issues.map((issue) => (
                    <li key={issue}>
                      <Icon className="nx-issue-icon" name="alert" />
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {expandedId === item.id && (
              <div className="nx-title-card__expanded">
                <div className="nx-title-card__expanded-actions">
                  <button className="nx-action-button" type="button" onClick={(e) => e.stopPropagation()}>
                    <Icon className="nx-action-button__icon" name="file-text" />
                    View Title Report
                  </button>
                  <button className="nx-action-button nx-action-button--muted" type="button" onClick={(e) => e.stopPropagation()}>
                    <Icon className="nx-action-button__icon" name="message" />
                    Contact Agent
                  </button>
                  {item.status === 'issue' && (
                    <button className="nx-action-button nx-action-button--danger" type="button" onClick={(e) => e.stopPropagation()}>
                      <Icon className="nx-action-button__icon" name="alert" />
                      Escalate
                    </button>
                  )}
                </div>
              </div>
            )}

            <span className="nx-title-card__updated">Updated {item.lastUpdatedLabel}</span>
          </article>
        ))}
        {filtered.length === 0 && (
          <div className="nx-empty-state">
            <Icon className="nx-empty-icon" name="check" />
            <p>No title records match this filter.</p>
          </div>
        )}
      </div>

      <div className="nx-title__footer">
        <span>Total earnest at risk: <strong>{data.totalEarnest}</strong></span>
        <span>Total deal value: <strong>{data.totalValue}</strong></span>
      </div>
    </div>
  )
}
