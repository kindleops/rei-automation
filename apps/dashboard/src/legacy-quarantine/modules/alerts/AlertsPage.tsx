import { useState } from 'react'
import type { AlertsModel, AlertItem } from './alerts.adapter'
import { Icon } from '../../shared/icons'

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const severityClass: Record<AlertItem['severity'], string> = {
  critical: 'is-critical',
  warning: 'is-warning',
  info: 'is-info',
}

const severityIcon: Record<AlertItem['severity'], string> = {
  critical: 'alert',
  warning: 'alert',
  info: 'activity',
}

export const AlertsPage = ({ data }: { data: AlertsModel }) => {
  const [filterSeverity, setFilterSeverity] = useState<string>('all')
  const [acknowledgedIds, setAcknowledgedIds] = useState<string[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filtered = data.alerts
    .filter((a) => filterSeverity === 'all' || a.severity === filterSeverity)
    .filter((a) => !acknowledgedIds.includes(a.id))

  return (
    <div className="nx-alerts">
      <header className="nx-surface-header">
        <div className="nx-surface-header__title">
          <Icon className="nx-surface-icon" name="alert" />
          <h1>Alerts</h1>
        </div>
        <div className="nx-surface-header__stats">
          <span className="nx-badge nx-badge--danger nx-badge--pulse">{data.criticalCount} critical</span>
          <span className="nx-badge nx-badge--warning">{data.warningCount} warning</span>
          <span className="nx-badge nx-badge--muted">{data.infoCount} info</span>
          <span className="nx-badge nx-badge--muted">{acknowledgedIds.length} ack'd</span>
        </div>
      </header>

      <div className="nx-alerts__filters">
        {['all', 'critical', 'warning', 'info'].map((sev) => (
          <button
            key={sev}
            type="button"
            className={classes('nx-filter-pill', filterSeverity === sev && 'is-active')}
            onClick={() => setFilterSeverity(sev)}
          >
            {sev === 'all' ? `All (${data.alerts.filter(a => !acknowledgedIds.includes(a.id)).length})` : `${sev.charAt(0).toUpperCase() + sev.slice(1)} (${data.alerts.filter(a => a.severity === sev && !acknowledgedIds.includes(a.id)).length})`}
          </button>
        ))}
      </div>

      <div className="nx-alerts__grid">
        {filtered.map((alert) => (
          <article
            key={alert.id}
            className={classes('nx-alert-card', severityClass[alert.severity], expandedId === alert.id && 'is-expanded')}
            onClick={() => setExpandedId(expandedId === alert.id ? null : alert.id)}
          >
            <div className="nx-alert-card__header">
              <div className="nx-alert-card__lead">
                <Icon name={severityIcon[alert.severity] as Parameters<typeof Icon>[0]['name']} className={classes('nx-alert-card__sev-icon', severityClass[alert.severity])} />
                <span className={classes('nx-severity-badge', severityClass[alert.severity])}>
                  {alert.priority}
                </span>
                <span className="nx-alert-card__market">{alert.marketLabel}</span>
              </div>
              <div className="nx-alert-card__header-right">
                <span className="nx-alert-card__time">{alert.timestampLabel}</span>
                <button
                  className="nx-inline-button nx-inline-button--ack"
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setAcknowledgedIds((ids) => [...ids, alert.id]) }}
                >
                  Ack
                </button>
              </div>
            </div>
            <h3 className="nx-alert-card__title">{alert.title}</h3>
            <p className="nx-alert-card__detail">{alert.detail}</p>
            <div className="nx-alert-card__footer">
              <span className="nx-alert-card__metric">
                <span className="nx-alert-card__metric-label">{alert.metricLabel}</span>
                <strong className="nx-alert-card__metric-value">{alert.metricValue}</strong>
              </span>
              {expandedId === alert.id && (
                <div className="nx-alert-card__expanded">
                  <button className="nx-action-button" type="button" onClick={(e) => e.stopPropagation()}>
                    <Icon className="nx-action-button__icon" name="target" />
                    Investigate
                  </button>
                  <button className="nx-action-button nx-action-button--muted" type="button" onClick={(e) => { e.stopPropagation(); setAcknowledgedIds((ids) => [...ids, alert.id]) }}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
        {filtered.length === 0 && (
          <div className="nx-empty-state">
            <Icon className="nx-empty-icon" name="check" />
            <p>All clear — no active alerts.</p>
          </div>
        )}
      </div>

      <section className="nx-alerts__affected">
        <h3>Affected Markets</h3>
        <div className="nx-tag-row">
          {data.affectedMarkets.map((market) => (
            <span key={market} className="nx-tag nx-tag--interactive">{market}</span>
          ))}
        </div>
      </section>
    </div>
  )
}
