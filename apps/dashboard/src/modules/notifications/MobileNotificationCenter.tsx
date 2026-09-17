import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'
import {
  groupNotificationsByTime,
  type NotificationDomain,
  type NotificationEvent,
  type NotificationSeverity,
  type NotificationTimeGroup,
} from '../../domain/notifications/notification-contract'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { MobileNotificationPermission } from './MobileNotificationPermission'
import './mobile-notification-center.css'

/**
 * THE MOBILE NOTIFICATION CENTER.
 *
 * What this replaces was the desktop intelligence panel shrunk into a sheet: a
 * search field, a density toggle, a four-chip severity rail, a ten-chip domain rail
 * and a bulk-selection bar — roughly 190px of controls above the first notification
 * on a 390px screen, every chip well under a comfortable target.
 *
 * §5 asks a different question of this surface: what happened, to what, when, and
 * does it need me. So the filters collapse to three segments that answer only that
 * last question, and everything else is a row.
 *
 *   Needs Action   critical + warning that are still unread — the work
 *   All            everything the feed returned
 *   System         platform/workflow health, which is real but is not seller work
 *
 * The desktop centre is untouched: LeadCommandNotificationCenter still renders the
 * full filter matrix where there is room for it.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type Segment = 'action' | 'all' | 'system'

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'action', label: 'Needs Action' },
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System' },
]

/** Domains that describe the platform rather than a deal. */
const SYSTEM_DOMAINS = new Set<NotificationDomain>(['platform', 'workflow', 'numbers', 'templates'])

const SEVERITY_ICON: Record<NotificationSeverity, Parameters<typeof Icon>[0]['name']> = {
  critical: 'alert',
  warning: 'flag',
  positive: 'check',
  neutral: 'bell',
}

const DOMAIN_LABEL: Record<NotificationDomain, string> = {
  campaigns: 'Campaign',
  templates: 'Template',
  numbers: 'Number',
  markets: 'Market',
  inbox: 'Inbox',
  acquisition: 'Acquisition',
  closing: 'Closing',
  workflow: 'Workflow',
  platform: 'System',
  intelligence: 'Intelligence',
}

const TIME_GROUP_LABEL: Record<NotificationTimeGroup, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

/**
 * Where tapping a notification goes.
 *
 * Entity before domain, and NEVER a bare app route when an entity id is present:
 * "a seller replied" must land on that seller, not on the inbox list. The order
 * mirrors the canonical carriers — thread, property, then the operational objects.
 * Returning null is a real answer; a row with nowhere to go does not pretend.
 */
export const resolveNotificationDestination = (event: NotificationEvent): string | null => {
  const primary = event.actions.find((action) => action.primary) ?? event.actions[0]
  if (primary?.href) return primary.href
  if (event.threadKey) return `/inbox?thread=${encodeURIComponent(event.threadKey)}`
  if (event.propertyId) return `/deal-intelligence?property=${encodeURIComponent(event.propertyId)}`
  if (event.campaignId) return `/campaign-command?campaign=${encodeURIComponent(event.campaignId)}`
  if (event.contractId) return '/closing-desk'
  if (event.queueId) return '/queue'
  if (event.domain === 'workflow') return '/workflow-studio'
  if (event.domain === 'markets') return '/map'
  return null
}

/** A destination the operator can read before tapping it. */
const destinationLabel = (event: NotificationEvent): string | null => {
  const href = resolveNotificationDestination(event)
  if (!href) return null
  if (href.startsWith('/inbox')) return 'Open thread'
  if (href.startsWith('/deal-intelligence')) return 'Open property'
  if (href.startsWith('/campaign-command')) return 'Open campaign'
  if (href.startsWith('/closing-desk')) return 'Open closing'
  if (href.startsWith('/queue')) return 'Open queue'
  if (href.startsWith('/workflow-studio')) return 'Open workflow'
  if (href.startsWith('/map')) return 'Open map'
  if (href.startsWith('/buyer-match')) return 'Open buyers'
  return 'Open'
}

const needsAction = (event: NotificationEvent) =>
  event.status === 'unread' && (event.severity === 'critical' || event.severity === 'warning')

interface MobileNotificationCenterProps {
  open: boolean
  onClose: () => void
}

export const MobileNotificationCenter = ({ open, onClose }: MobileNotificationCenterProps) => {
  const {
    notifications,
    unreadCount,
    loading,
    error,
    refresh,
    patch,
  } = useNotificationIntelligence()

  const [segment, setSegment] = useState<Segment>('all')

  useEffect(() => {
    if (!open) return
    /**
     * Filtering happens on the client here ON PURPOSE. The three segments are
     * projections of one already-fetched feed, so switching them must not refetch —
     * the desktop panel refetches on every chip and that is why its rails feel
     * laggy. The poll in the provider keeps the feed fresh.
     */
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose])

  const live = useMemo(
    () => notifications.filter((item) => item.status !== 'dismissed'),
    [notifications],
  )

  const counts = useMemo(() => ({
    action: live.filter(needsAction).length,
    all: live.length,
    system: live.filter((item) => SYSTEM_DOMAINS.has(item.domain)).length,
  }), [live])

  const filtered = useMemo(() => {
    if (segment === 'action') return live.filter(needsAction)
    if (segment === 'system') return live.filter((item) => SYSTEM_DOMAINS.has(item.domain))
    return live
  }, [live, segment])

  const grouped = useMemo(() => groupNotificationsByTime(filtered), [filtered])

  const handleOpen = useCallback(async (item: NotificationEvent) => {
    const href = resolveNotificationDestination(item)
    await patch(item.id, 'mark_read')
    if (!href) return
    onClose()
    pushRoutePath(href)
  }, [onClose, patch])

  const markAllRead = useCallback(async () => {
    const ids = filtered.filter((item) => item.status === 'unread').map((item) => item.id)
    if (!ids.length) return
    await patch(ids[0], 'bulk_mark_read', { ids })
  }, [filtered, patch])

  if (!open || typeof document === 'undefined') return null

  const layer = (
    <div className="nx-mnc" role="dialog" aria-modal="true" aria-label="Notifications">
      <header className="nx-mnc__bar">
        <div className="nx-mnc__title">
          <strong>Notifications</strong>
          {unreadCount > 0 ? <span className="nx-mnc__unread">{unreadCount > 99 ? '99+' : unreadCount} unread</span> : null}
        </div>
        <div className="nx-mnc__bar-actions">
          <button
            type="button"
            className="nx-mnc__bar-btn"
            onClick={() => void markAllRead()}
            disabled={!filtered.some((item) => item.status === 'unread')}
          >
            Mark all read
          </button>
          <button type="button" className="nx-mnc__close" aria-label="Close notifications" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      <div className="nx-mnc__segments" role="tablist" aria-label="Notification filter">
        {SEGMENTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={segment === item.id}
            className={cls('nx-mnc__segment', segment === item.id && 'is-active')}
            onClick={() => setSegment(item.id)}
          >
            {item.label}
            <b>{counts[item.id]}</b>
          </button>
        ))}
      </div>

      <div className="nx-mnc__body">
        <MobileNotificationPermission />

        {(['today', 'yesterday', 'earlier'] as NotificationTimeGroup[]).map((groupKey) => {
          const items = grouped[groupKey]
          if (!items.length) return null
          return (
            <section key={groupKey} className="nx-mnc__group">
              <header className="nx-mnc__group-head">{TIME_GROUP_LABEL[groupKey]}</header>
              {items.map((item) => {
                const target = destinationLabel(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cls(
                      'nx-mnc__row',
                      `is-${item.severity}`,
                      item.status === 'unread' && 'is-unread',
                    )}
                    onClick={() => void handleOpen(item)}
                  >
                    {/* Unread is a 6px rail, not a colour wash. §5 wants it obvious
                        without being loud, and a tinted row makes the severity
                        colour unreadable. */}
                    <span className="nx-mnc__rail" aria-hidden />
                    <span className="nx-mnc__row-icon" aria-hidden>
                      <Icon name={SEVERITY_ICON[item.severity]} size={14} strokeWidth={1.7} />
                    </span>
                    <span className="nx-mnc__row-copy">
                      <span className="nx-mnc__row-head">
                        <strong>{item.title}</strong>
                        <time dateTime={item.createdAt}>{formatRelativeTime(item.createdAt)}</time>
                      </span>
                      <small>{item.summary || item.body}</small>
                      <span className="nx-mnc__row-meta">
                        <em>{DOMAIN_LABEL[item.domain]}</em>
                        {item.sourceLabel ? <span>{item.sourceLabel}</span> : null}
                        {/* Say where the tap goes BEFORE it is taken. A row that
                            navigates somewhere unannounced is the reason operators
                            stop tapping notifications. */}
                        {target ? <span className="nx-mnc__row-target">{target}</span> : null}
                      </span>
                    </span>
                    {item.groupedCount && item.groupedCount > 1 ? (
                      <span className="nx-mnc__row-count">{item.groupedCount}</span>
                    ) : null}
                  </button>
                )
              })}
            </section>
          )
        })}

        {loading && filtered.length === 0 ? (
          <div className="nx-mnc__state" role="status">
            <span className="nx-mnc__spinner" aria-hidden />
            <span>Loading notifications…</span>
          </div>
        ) : null}

        {/* An unreachable feed and an empty feed are different facts and must not
            share a state. */}
        {!loading && error ? (
          <div className="nx-mnc__state is-error">
            <strong>Notifications unavailable</strong>
            <span>{error}</span>
            <button type="button" onClick={() => void refresh()}>Retry</button>
          </div>
        ) : null}

        {!loading && !error && filtered.length === 0 ? (
          <div className="nx-mnc__state">
            <strong>
              {segment === 'action' ? 'Nothing needs action' : segment === 'system' ? 'No system events' : 'No notifications'}
            </strong>
            <span>
              {segment === 'action'
                ? 'Critical and warning signals will appear here the moment they fire.'
                : 'Operational signals across inbox, campaigns, closings and platform health land here.'}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )

  return createPortal(layer, document.body)
}
