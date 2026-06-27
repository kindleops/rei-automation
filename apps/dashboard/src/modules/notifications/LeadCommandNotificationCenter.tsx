import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pushRoutePath } from '../../app/router'
import type {
  NotificationDomain,
  NotificationEvent,
  NotificationSeverity,
  NotificationTimeGroup,
} from '../../domain/notifications/notification-contract'
import {
  groupNotificationsByTime,
  NOTIFICATION_DOMAINS,
  NOTIFICATION_SEVERITIES,
} from '../../domain/notifications/notification-contract'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel'
import './notification-center.css'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  warning: 'Warning',
  critical: 'Critical',
}

const DOMAIN_LABELS: Record<NotificationDomain, string> = {
  campaigns: 'Campaigns',
  templates: 'Templates',
  numbers: 'Numbers',
  markets: 'Markets',
  inbox: 'Inbox',
  acquisition: 'Acquisition',
  closing: 'Closing',
  workflow: 'Workflow',
  platform: 'Platform',
  intelligence: 'Intelligence',
}

const TIME_GROUP_LABELS: Record<NotificationTimeGroup, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

const severityIcon = (severity: NotificationSeverity): Parameters<typeof Icon>[0]['name'] => {
  switch (severity) {
    case 'critical': return 'alert'
    case 'warning': return 'flag'
    case 'positive': return 'check'
    default: return 'bell'
  }
}

const resolveActionHref = (event: NotificationEvent): string | null => {
  const primary = event.actions.find((action) => action.primary) ?? event.actions[0]
  if (primary?.href) return primary.href
  if (event.threadKey) return `/inbox?thread=${encodeURIComponent(event.threadKey)}`
  if (event.propertyId) return `/deal-intelligence?property=${encodeURIComponent(event.propertyId)}`
  if (event.queueId) return '/queue'
  if (event.contractId) return '/closing-desk'
  if (event.campaignId) return '/campaign-command'
  return null
}

const NotificationCard = ({
  item,
  expanded,
  selected,
  onToggleSelect,
  onOpen,
  onDismiss,
  onMarkRead,
  onMarkUnread,
  onSnooze,
  onMuteSource,
  onRunAction,
}: {
  item: NotificationEvent
  expanded: boolean
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onDismiss: () => void
  onMarkRead: () => void
  onMarkUnread: () => void
  onSnooze: () => void
  onMuteSource: () => void
  onRunAction: (actionType: string) => void
}) => {
  const isUnread = item.status === 'unread'

  return (
    <article
      role="listitem"
      className={cls(
        'lcnc-card',
        `is-${item.severity}`,
        `is-domain-${item.domain}`,
        !isUnread && 'is-read',
        expanded && 'is-expanded',
        selected && 'is-selected',
      )}
    >
      <span className="lcnc-card__glow" aria-hidden="true" />
      <span className="lcnc-card__rail" aria-hidden="true" />

      <div className="lcnc-card__inner">
        <div className="lcnc-card__top">
          <label className="lcnc-card__select">
            <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label="Select notification" />
          </label>
          <span className="lcnc-card__icon-wrap">
            <Icon name={severityIcon(item.severity)} size={12} />
          </span>
          <span className="lcnc-card__domain">{DOMAIN_LABELS[item.domain]}</span>
          {item.groupedCount && item.groupedCount > 1 ? (
            <span className="lcnc-card__group-badge">{item.groupedCount}×</span>
          ) : null}
          <span className="lcnc-card__time">
            {item.createdAt ? formatRelativeTime(item.createdAt) : 'Now'}
          </span>
          {isUnread ? <span className="lcnc-card__unread-dot" aria-label="Unread" /> : null}
          <button type="button" className="lcnc-card__dismiss-btn" onClick={onDismiss} aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>

        <button type="button" className="lcnc-card__body-btn" onClick={onOpen}>
          <strong className="lcnc-card__title">{item.title}</strong>
          <p className="lcnc-card__text">{expanded ? item.body : (item.summary ?? item.body)}</p>
        </button>

        {expanded && item.metrics?.length ? (
          <div className="lcnc-card__metrics">
            {item.metrics.map((metric) => (
              <div key={`${item.id}-${metric.label}`} className="lcnc-card__metric">
                <span>{metric.label}</span>
                <strong>
                  {metric.value}
                  {metric.unit ? ` ${metric.unit}` : ''}
                </strong>
              </div>
            ))}
          </div>
        ) : null}

        <div className="lcnc-card__actions">
          {item.actions.slice(0, expanded ? 4 : 2).map((action) => (
            <button
              key={`${item.id}-${action.type}`}
              type="button"
              className={cls('lcnc-card__action-btn', action.primary && 'is-primary')}
              onClick={() => onRunAction(action.type)}
            >
              {action.label}
            </button>
          ))}
          <button type="button" className="lcnc-card__action-btn" onClick={isUnread ? onMarkRead : onMarkUnread}>
            {isUnread ? 'Mark read' : 'Mark unread'}
          </button>
          <button type="button" className="lcnc-card__action-btn" onClick={onSnooze}>Snooze 1h</button>
          <button type="button" className="lcnc-card__action-btn" onClick={onMuteSource}>Mute source</button>
        </div>
      </div>
    </article>
  )
}

const EmptyState = ({ loading, error }: { loading: boolean; error: string | null }) => (
  <div className="lcnc-empty">
    <span className="lcnc-empty__icon"><Icon name="radar" size={18} /></span>
    <strong className="lcnc-empty__title">
      {loading ? 'Scanning intelligence…' : error ? 'Feed unavailable' : 'All clear'}
    </strong>
    <p className="lcnc-empty__text">
      {loading
        ? 'Pulling live notification intelligence from LeadCommand.'
        : error
          ? error
          : 'No notifications match your current filters.'}
    </p>
  </div>
)

export const LeadCommandNotificationCenter = ({
  open,
  onClose,
  anchorTop = 58,
}: {
  open: boolean
  onClose: () => void
  anchorTop?: number
}) => {
  const {
    notifications,
    unreadCount,
    loading,
    error,
    preferences,
    scanning,
    refresh,
    patch,
    runAction,
    savePrefs,
    scan,
    muteDomain,
  } = useNotificationIntelligence()

  const [severityFilter, setSeverityFilter] = useState<NotificationSeverity | 'all'>('all')
  const [domainFilter, setDomainFilter] = useState<NotificationDomain | 'all'>('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    void refresh({
      search: search.trim() || undefined,
      severity: severityFilter === 'all' ? undefined : severityFilter,
      domain: domainFilter === 'all' ? undefined : domainFilter,
    })
  }, [open, search, severityFilter, domainFilter, refresh])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (showSettings) setShowSettings(false)
        else onClose()
      }
    }
    const handleMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      window.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [open, onClose, showSettings])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return notifications.filter((item) => {
      if (item.status === 'dismissed') return false
      if (severityFilter !== 'all' && item.severity !== severityFilter) return false
      if (domainFilter !== 'all' && item.domain !== domainFilter) return false
      if (!query) return true
      const haystack = `${item.title} ${item.body} ${item.sourceLabel ?? ''}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [notifications, search, severityFilter, domainFilter])

  const grouped = useMemo(() => groupNotificationsByTime(filtered), [filtered])

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }, [])

  const handleOpen = useCallback(async (item: NotificationEvent) => {
    await patch(item.id, 'mark_read')
    const href = resolveActionHref(item)
    if (href) {
      onClose()
      pushRoutePath(href)
    }
  }, [onClose, patch])

  const handleRunAction = useCallback(async (item: NotificationEvent, actionType: string) => {
    const result = await runAction(item.id, actionType)
    const href = result.href ?? resolveActionHref(item)
    if (href) {
      onClose()
      pushRoutePath(href)
    }
  }, [onClose, runAction])

  const snoozeOneHour = useCallback(async (id: string) => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await patch(id, 'snooze', { snoozeUntil: until })
  }, [patch])

  const bulkMarkRead = useCallback(async () => {
    if (!selectedIds.length) return
    await patch(selectedIds[0], 'bulk_mark_read', { ids: selectedIds })
    setSelectedIds([])
  }, [patch, selectedIds])

  const bulkDismiss = useCallback(async () => {
    if (!selectedIds.length) return
    await patch(selectedIds[0], 'bulk_dismiss', { ids: selectedIds })
    setSelectedIds([])
  }, [patch, selectedIds])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <section
      ref={panelRef}
      className="lcnc-panel nx-notification-center nx-liquid-panel"
      style={{ '--lcnc-anchor-top': `${anchorTop}px` } as React.CSSProperties}
      aria-label="LeadCommand notification center"
      role="dialog"
      aria-modal="true"
    >
      <div className="lcnc-panel__sheen" aria-hidden="true" />

      <header className="lcnc-header">
        <div className="lcnc-header__left">
          <span className="lcnc-eyebrow">LEADCOMMAND</span>
          <div className="lcnc-title-row">
            <strong className="lcnc-title">Notification Intelligence</strong>
            <span className="lcnc-live-badge">
              <span className="lcnc-live-dot" />
              Live
            </span>
            {unreadCount > 0 ? (
              <span className="lcnc-count-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
            ) : null}
          </div>
          <p className="lcnc-subtitle">Real-time operational signals across inbox, campaigns, offers, and system health.</p>
        </div>
        <div className="lcnc-header__actions">
          <button
            type="button"
            className="lcnc-header-btn"
            onClick={() => void scan()}
            disabled={scanning}
            title="Trigger scan"
            aria-label="Trigger notification scan"
          >
            <Icon name="refresh-cw" size={14} />
          </button>
          <button
            type="button"
            className={cls('lcnc-header-btn', showSettings && 'is-active')}
            onClick={() => setShowSettings((v) => !v)}
            aria-label="Notification settings"
          >
            <Icon name="settings" size={14} />
          </button>
          <button type="button" className="lcnc-header-btn" onClick={onClose} aria-label="Close notifications">
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      {showSettings ? (
        <NotificationPreferencesPanel
          preferences={preferences}
          onSave={savePrefs}
          onClose={() => setShowSettings(false)}
        />
      ) : (
        <>
          <div className="lcnc-toolbar">
            <div className="lcnc-search">
              <Icon name="search" size={13} className="lcnc-search__icon" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search notifications…"
                aria-label="Search notifications"
              />
            </div>
            <button
              type="button"
              className={cls('lcnc-density-btn', expanded && 'is-active')}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Compact' : 'Expanded'}
            </button>
          </div>

          <div className="lcnc-filters" role="group" aria-label="Severity filters">
            <button
              type="button"
              className={cls('lcnc-filter-chip', severityFilter === 'all' && 'is-active')}
              onClick={() => setSeverityFilter('all')}
            >
              All
            </button>
            {NOTIFICATION_SEVERITIES.map((severity) => (
              <button
                key={severity}
                type="button"
                className={cls('lcnc-filter-chip', `is-severity-${severity}`, severityFilter === severity && 'is-active')}
                onClick={() => setSeverityFilter((current) => current === severity ? 'all' : severity)}
              >
                {SEVERITY_LABELS[severity]}
              </button>
            ))}
          </div>

          <div className="lcnc-spaces" role="tablist" aria-label="Domain filters">
            <button
              type="button"
              className={cls('lcnc-space-chip', domainFilter === 'all' && 'is-active')}
              onClick={() => setDomainFilter('all')}
            >
              All domains
            </button>
            {NOTIFICATION_DOMAINS.map((domain) => (
              <button
                key={domain}
                type="button"
                className={cls('lcnc-space-chip', domainFilter === domain && 'is-active')}
                onClick={() => setDomainFilter((current) => current === domain ? 'all' : domain)}
              >
                {DOMAIN_LABELS[domain]}
              </button>
            ))}
          </div>

          {selectedIds.length > 0 ? (
            <div className="lcnc-bulk-bar">
              <span>{selectedIds.length} selected</span>
              <button type="button" onClick={() => void bulkMarkRead()}>Mark read</button>
              <button type="button" onClick={() => void bulkDismiss()}>Dismiss</button>
              <button type="button" onClick={() => setSelectedIds([])}>Clear selection</button>
            </div>
          ) : null}

          <div className="lcnc-list nx-notification-list" role="list">
            {(['today', 'yesterday', 'earlier'] as NotificationTimeGroup[]).map((groupKey) => {
              const items = grouped[groupKey]
              if (!items.length) return null
              return (
                <section key={groupKey} className="lcnc-group">
                  <header className="lcnc-group__label">{TIME_GROUP_LABELS[groupKey]}</header>
                  {items.map((item) => (
                    <NotificationCard
                      key={item.id}
                      item={item}
                      expanded={expanded}
                      selected={selectedIds.includes(item.id)}
                      onToggleSelect={() => toggleSelected(item.id)}
                      onOpen={() => void handleOpen(item)}
                      onDismiss={() => void patch(item.id, 'dismiss')}
                      onMarkRead={() => void patch(item.id, 'mark_read')}
                      onMarkUnread={() => void patch(item.id, 'mark_unread')}
                      onSnooze={() => void snoozeOneHour(item.id)}
                      onMuteSource={() => muteDomain(item.domain, true)}
                      onRunAction={(actionType) => void handleRunAction(item, actionType)}
                    />
                  ))}
                </section>
              )
            })}

            {!filtered.length ? <EmptyState loading={loading} error={error} /> : null}
          </div>

          <footer className="lcnc-footer">
            <div className="lcnc-footer__actions">
              <button type="button" onClick={() => void patch('all', 'bulk_mark_read', { ids: filtered.map((n) => n.id) })}>
                Clear all read
              </button>
              <button type="button" onClick={() => void patch('all', 'bulk_dismiss', { ids: filtered.filter((n) => n.status === 'read').map((n) => n.id) })}>
                Clear read
              </button>
            </div>
            <span className="lcnc-footer-hint">
              <kbd>Esc</kbd> close · Polls every 30s
            </span>
          </footer>
        </>
      )}
    </section>,
    document.body,
  )
}

export const LeadCommandNotificationBell = ({
  unreadCount,
  active,
  onClick,
  className,
}: {
  unreadCount: number
  active?: boolean
  onClick: () => void
  className?: string
}) => (
  <div className={cls('nx-notification-control', className)}>
    <button
      type="button"
      className={cls('nx-notification-button', unreadCount > 0 && 'has-alerts', active && 'is-active')}
      onMouseDown={(event) => {
        // Keep document-level outside-close from firing before the toggle click.
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-expanded={active}
      title="Notifications"
    >
      <Icon name="bell" size={15} />
      {unreadCount > 0 ? <span>{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
    </button>
  </div>
)