import { useState, useEffect } from 'react'
import type { AlertsModel } from '../alerts/alerts.adapter'
import { loadAlerts } from '../alerts/alerts.adapter'
import { Icon } from '../../shared/icons'

type SevFilter = 'all' | 'critical' | 'warning' | 'info'

const SENTRY_FEED_MOCK = [
  { id: 's1', title: 'TextGrid 21610 — Delivery Rate Drop', detail: 'SMS delivery below 85% in last 15 min on number 21610. Investigate carrier routing.', ts: '3m ago' },
  { id: 's2', title: 'Queue Stuck — No Sends for 12 min', detail: 'Queue processor has not dequeued items for 12 minutes. May be lock conflict or worker crash.', ts: '12m ago' },
  { id: 's3', title: 'Webhook Error — TextGrid inbound 502', detail: '3 consecutive 502 errors on /api/webhooks/textgrid/inbound. Check API gateway health.', ts: '25m ago' },
]

export const MobileAlertsTab = () => {
  const [model, setModel] = useState<AlertsModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [sevFilter, setSevFilter] = useState<SevFilter>('all')
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showSentry, setShowSentry] = useState(true)

  useEffect(() => {
    loadAlerts().then(data => {
      setModel(data)
    }).catch(err => {
      console.error('[MobileAlerts] load failed', err)
    }).finally(() => setLoading(false))
  }, [])

  const ack = (id: string) => setAcknowledged(prev => new Set([...prev, id]))
  const toggle = (id: string) => setExpanded(prev => prev === id ? null : id)

  const filtered = (model?.alerts || [])
    .filter(a => !acknowledged.has(a.id))
    .filter(a => sevFilter === 'all' || a.severity === sevFilter)

  if (loading) {
    return (
      <div className="nx-m-loading">
        <div className="nx-m-spinner" />
        <span>Loading alerts...</span>
      </div>
    )
  }

  return (
    <div className="nx-m-alerts">
      {/* Counts bar */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {(['all', 'critical', 'warning', 'info'] as SevFilter[]).map(sev => {
          const count = sev === 'all'
            ? (model?.totalCount || 0)
            : sev === 'critical' ? (model?.criticalCount || 0)
            : sev === 'warning' ? (model?.warningCount || 0)
            : (model?.infoCount || 0)
          return (
            <button
              key={sev}
              className={`nx-m-bucket-tab ${sevFilter === sev ? 'is-active' : ''}`}
              onClick={() => setSevFilter(sev)}
              style={{
                ...(sevFilter === sev && sev === 'critical' ? { borderColor: 'rgba(239,68,68,0.5)', color: '#f87171' } : {}),
                ...(sevFilter === sev && sev === 'warning' ? { borderColor: 'rgba(234,179,8,0.5)', color: '#facc15' } : {}),
              }}
            >
              {sev === 'all' ? 'All' : sev.charAt(0).toUpperCase() + sev.slice(1)}
              <span className="nx-m-bucket-count">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Alerts */}
      {filtered.length === 0 && (
        <div className="nx-m-empty">
          <Icon name="check" style={{ width: 40, height: 40 }} />
          <div>All clear — no active alerts</div>
        </div>
      )}

      {filtered.map(alert => (
        <div
          key={alert.id}
          className={`nx-m-alert-card is-${alert.severity}`}
          onClick={() => toggle(alert.id)}
        >
          <div className="nx-m-alert-header">
            <div className="nx-m-alert-sev-dot" />
            <div className="nx-m-alert-title">{alert.title}</div>
            <div className="nx-m-alert-time">{alert.timestampLabel}</div>
          </div>
          <div className="nx-m-alert-detail">{alert.detail}</div>
          <div className="nx-m-alert-metric">
            <span>{alert.metricLabel}:</span>
            <strong>{alert.metricValue}</strong>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>{alert.marketLabel}</span>
          </div>
          {expanded === alert.id && (
            <div className="nx-m-alert-actions">
              <button className="nx-m-alert-btn is-primary" onClick={e => e.stopPropagation()}>
                <Icon name="target" style={{ width: 12, height: 12, marginRight: 4 }} />
                Investigate
              </button>
              <button
                className="nx-m-alert-btn"
                onClick={e => { e.stopPropagation(); ack(alert.id) }}
              >
                Acknowledge
              </button>
            </div>
          )}
        </div>
      ))}

      {/* Sentry / critical system feed */}
      <div style={{ padding: '12px 16px 4px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 8 }}>
        <button
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer', padding: 0 }}
          onClick={() => setShowSentry(s => !s)}
        >
          <Icon name="alert" style={{ width: 13, height: 13, color: '#f87171' }} />
          System Alerts
          <span style={{ marginLeft: 4 }}>{showSentry ? '▲' : '▼'}</span>
        </button>
      </div>

      {showSentry && (
        <div className="nx-m-sentry-feed">
          {SENTRY_FEED_MOCK.map(e => (
            <div key={e.id} className="nx-m-sentry-entry">
              <div className="nx-m-sentry-title">{e.title}</div>
              <div>{e.detail}</div>
              <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>{e.ts}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
