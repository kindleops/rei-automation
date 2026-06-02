import { type FC } from 'react'
import type { QueueItem } from '../../../queue/queue.types'

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + '…' : s

interface DiagnosticBadge {
  key: string
  label: string
  tone: 'amber' | 'red' | 'muted'
}

const getDiagnosticBadges = (item: QueueItem): DiagnosticBadge[] => {
  return item.diagnosticFlags.map(flag => {
    let tone: 'red' | 'amber' = 'amber'
    if (flag === 'MISSING_OWNER' || flag === 'MISSING_MESSAGE_EVENT' || flag === 'MISSING_PROVIDER_ID' || flag === 'MISSING_TEXTGRID_NUMBER') tone = 'red'
    return { key: flag, label: flag.replace(/_/g, ' '), tone }
  })
}

const deliveryTone = (status: string) => {
  if (status === 'delivered') return 'green'
  if (status === 'sent')      return 'blue'
  if (status === 'failed' || status === 'bounced' || status === 'rejected') return 'red'
  return 'muted'
}

const statusTone = (status: string) => {
  if (status === 'ready')     return 'cyan'
  if (status === 'scheduled' || status === 'queued' || status === 'sending') return 'blue'
  if (status === 'sent' || status === 'delivered') return 'green'
  if (status === 'failed' || status === 'retry' || status === 'blocked')    return 'red'
  return 'muted'
}

const failureTone = (group: string | null) => {
  if (!group) return 'muted'
  if (group === 'Carrier' || group === 'Compliance' || group === 'Routing') return 'red'
  return 'amber'
}

interface QueueRowInspectorProps {
  items: QueueItem[]
  totalItems: number
  searchQuery: string
  statusFilter: string
  marketFilter: string
  allMarkets: string[]
  failureFilter: string | null
  hasFilters: boolean
  selectedQueueId?: string | null
  onSelectItem?: (item: QueueItem) => void
  onSearchChange: (q: string) => void
  onStatusChange: (s: string) => void
  onMarketChange: (m: string) => void
  onClearFilters: () => void
}

export const QueueRowInspector: FC<QueueRowInspectorProps> = ({
  items,
  totalItems,
  searchQuery,
  statusFilter,
  marketFilter,
  allMarkets,
  failureFilter,
  hasFilters,
  selectedQueueId,
  onSelectItem,
  onSearchChange,
  onStatusChange,
  onMarketChange,
  onClearFilters,
}) => {
  return (
    <div className="sqd-section sqd-inspector">
      {/* Controls */}
      <div className="sqd-inspector__controls">
        <span className="sqd-section-eyebrow">Queue Row Inspector</span>
        <div className="sqd-inspector__filter-row">
          <input
            type="search"
            className="sqd-search"
            placeholder="Search seller, address, market, template…"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
          />
          <select className="sqd-select" value={statusFilter} onChange={e => onStatusChange(e.target.value)}>
            <option value="all">All Statuses</option>
            <option value="ready">Ready</option>
            <option value="scheduled">Scheduled</option>
            <option value="queued">Queued</option>
            <option value="sending">Sending</option>
            <option value="sent">Sent</option>
            <option value="delivered">Delivered</option>
            <option value="replied">Replied</option>
            <option value="failed">Failed / Retry</option>
            <option value="blocked">Blocked</option>
            <option value="held">Held</option>
            <option value="approval">Candidate</option>
          </select>
          <select className="sqd-select" value={marketFilter} onChange={e => onMarketChange(e.target.value)}>
            <option value="all">All Markets</option>
            {allMarkets.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          {hasFilters && <button type="button" className="sqd-clear-btn" onClick={onClearFilters}>Clear all</button>}
        </div>
        <span className="sqd-inspector__count">
          {items.length.toLocaleString()} of {totalItems.toLocaleString()} rows
          {failureFilter && ` · ${failureFilter} failures`}
        </span>
      </div>

      {/* Table */}
      <div className="sqd-table sqd-table--ops">
        <div className="sqd-table__head sqd-table__head--ops">
          <span>Seller / Property</span>
          <span>Campaign</span>
          <span>Market</span>
          <span>Template</span>
          <span>From</span>
          <span>To</span>
          <span>Scheduled</span>
          <span>Status</span>
          <span>Delivery</span>
          <span>Failure</span>
          <span>Last Event</span>
          <span>Actions</span>
        </div>
        <div className="sqd-table__body">
          {items.map(item => {
            const badges = getDiagnosticBadges(item)
            const hasBadges = badges.length > 0
            const displayName = hasBadges && (!item.sellerName || item.sellerName.toLowerCase().includes('unknown'))
              ? '— Unknown'
              : truncate(item.sellerName || '—', 20)
            const lastEventAt = item.deliveredAt ?? item.sentAt ?? item.scheduledForLocal

            return (
              <button
                key={item.id}
                type="button"
                className={[
                  'sqd-table__row sqd-table__row--ops',
                  `sqd-table__row--${item.status}`,
                  onSelectItem ? 'is-linked' : '',
                  selectedQueueId === item.queueId ? 'is-selected' : '',
                  hasBadges ? 'has-diagnostics' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onSelectItem?.(item)}
              >
                {/* Seller / Property */}
                <div className="sqd-cell sqd-cell--seller">
                  <strong className={hasBadges ? 'is-amber' : ''}>{displayName}</strong>
                  <small>{truncate(item.propertyAddress || '—', 22)}</small>
                  {hasBadges && (
                    <div className="sqd-diag-badges">
                      {badges.map(b => (
                        <span key={b.key} className={`sqd-diag-badge is-${b.tone}`}>{b.label}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Campaign */}
                <span className="sqd-cell sqd-cell--dim sqd-cell--campaign-meta">
                  <strong>{truncate(item.campaignName || item.useCase || item.currentStage || '—', 14)}</strong>
                  <small>campaign_id: {item.campaignId ? truncate(item.campaignId, 18) : '—'}</small>
                  <small>campaign_target_id: {item.campaignTargetId ? truncate(item.campaignTargetId, 18) : '—'}</small>
                </span>

                {/* Market */}
                <span className="sqd-cell">{item.market || '—'}</span>

                {/* Template */}
                <span className="sqd-cell sqd-cell--dim">
                  {truncate(item.templateName || '—', 18)}
                </span>

                {/* From */}
                <span className="sqd-cell sqd-cell--mono">
                  {item.textgridNumber ? `…${item.textgridNumber.slice(-4)}` : '—'}
                </span>

                {/* To */}
                <span className="sqd-cell sqd-cell--mono">
                  {item.phone ? `…${item.phone.slice(-4)}` : '—'}
                </span>

                {/* Scheduled */}
                <span className="sqd-cell sqd-cell--time">{relTime(item.scheduledForLocal)}</span>

                {/* Status */}
                <span className="sqd-cell">
                  <span className={`sqd-status-pill sqd-status-pill--${item.status} is-${statusTone(item.status)}`}>
                    {item.status.replace(/_/g, ' ')}
                  </span>
                </span>

                {/* Delivery */}
                <span className="sqd-cell">
                  {item.deliveryStatus && item.deliveryStatus !== 'pending' ? (
                    <span className={`sqd-status-pill is-${deliveryTone(item.deliveryStatus)}`}>
                      {item.deliveryStatus}
                    </span>
                  ) : '—'}
                </span>

                {/* Failure */}
                <span className="sqd-cell">
                  {item.failureCategory
                    ? <span className="sqd-fail-pill is-amber">{item.failureCategory.replace(/_/g, ' ')}</span>
                    : item.failureGroup
                      ? <span className={`sqd-fail-pill is-${failureTone(item.failureGroup)}`}>{item.failureGroup}</span>
                      : item.failedReason
                        ? <span className="sqd-fail-pill is-amber">{truncate(item.failedReason, 16)}</span>
                        : '—'
                  }
                </span>

                {/* Last Event */}
                <span className="sqd-cell sqd-cell--time">{relTime(lastEventAt)}</span>

                {/* Actions */}
                <div className="sqd-cell sqd-cell--actions" onClick={e => e.stopPropagation()}>
                  {(item.status === 'failed' || item.status === 'retry') && (
                    <button className="sqd-icon-action is-corrective" title="Retry" onClick={() => onSelectItem?.(item)}>↻</button>
                  )}
                  {(item.status === 'ready' || item.status === 'scheduled') && (
                    <button className="sqd-icon-action" title="Hold" onClick={() => onSelectItem?.(item)}>⏸</button>
                  )}
                  <button className="sqd-icon-action is-danger" title="Suppress" onClick={() => onSelectItem?.(item)}>✕</button>
                </div>
              </button>
            )
          })}
          {items.length === 0 && (
            <div className="sqd-table__empty">No rows match current filters.</div>
          )}
        </div>
      </div>
    </div>
  )
}
