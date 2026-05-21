import { useMemo, useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import { formatRelativeTime } from '../../../shared/formatters'
import type { AutonomousEngineModel } from '../autonomy-engine'
import { useWatchlist } from '../../../lib/watchlistContext'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type NotificationSeverity = 'info' | 'critical' | 'warning' | 'success' | 'neutral'
export type NotificationStatus = 'unread' | 'read' | 'dismissed'

export interface NexusNotification {
  id: string
  command_space: string
  type: string
  title: string
  body: string
  severity: NotificationSeverity
  status: NotificationStatus
  created_at: string
  read_at: string | null
  related_thread_id: string | null
  related_property_id: string | null
  related_owner_id: string | null
  related_queue_id: string | null
  related_offer_id: string | null
  related_contract_id: string | null
  source: string
  action_label: string
  action_href: string | null
}

const PRIMARY_SPACES = ['All', 'Inbox', 'Queue', 'SMS', 'AI', 'System']
const SECONDARY_SPACES = ['Offers', 'Contracts', 'Buyers', 'Properties', 'Owners', 'Title', 'Errors']

const notificationIcon = (severity: NotificationSeverity) => {
  if (severity === 'critical') return 'alert'
  if (severity === 'warning') return 'flag'
  if (severity === 'success') return 'check'
  if (severity === 'neutral') return 'shield'
  return 'bell'
}

const sourceLabel = (source: string): string => {
  const map: Record<string, string> = {
    'Inbox': 'INBOX',
    'Queue Processor': 'QUEUE',
    'Offer Engine': 'OFFERS',
    'Compliance': 'SMS',
    'Autonomy Engine': 'AI ENGINE',
    'Compliance Engine': 'COMPLIANCE',
    'Market Intelligence': 'MARKET INTEL',
    'NEXUS OS': 'SYSTEM',
  }
  return map[source] ?? source.toUpperCase()
}

export const buildInboxNotifications = ({
  unreadCount,
  selectedThread,
  queueProcessorHealth,
  autonomyModel,
}: {
  unreadCount: number
  selectedThread: InboxWorkflowThread | null
  queueProcessorHealth: QueueProcessorHealth | null
  autonomyModel: AutonomousEngineModel
}): NexusNotification[] => {
  const notifications: NexusNotification[] = []
  const selectedCreatedAt = selectedThread?.lastMessageAt || selectedThread?.lastMessageIso || queueProcessorHealth?.checkedAt || ''

  if (unreadCount > 0) {
    notifications.push({
      id: 'inbox-unread',
      command_space: 'Inbox',
      type: 'inbound_reply_received',
      title: `${unreadCount} seller replies need attention`,
      body: 'Priority Inbox has active inbound conversations ready for triage.',
      severity: 'info',
      status: 'unread',
      created_at: selectedCreatedAt,
      read_at: null,
      related_thread_id: selectedThread?.id ?? null,
      related_property_id: selectedThread?.propertyId ?? null,
      related_owner_id: selectedThread?.ownerId ?? null,
      related_queue_id: null,
      related_offer_id: null,
      related_contract_id: null,
      source: 'Inbox',
      action_label: 'Open Inbox',
      action_href: '/inbox',
    })
  }

  if (selectedThread?.conversationStage === 'offer_reveal') {
    notifications.push({
      id: `offer-needed-${selectedThread.id}`,
      command_space: 'Offers',
      type: 'offer_needs_review',
      title: 'Offer needed',
      body: `${selectedThread.ownerName || 'Seller'} is ready for pricing review.`,
      severity: 'warning',
      status: 'unread',
      created_at: selectedCreatedAt,
      read_at: null,
      related_thread_id: selectedThread.id,
      related_property_id: selectedThread.propertyId ?? null,
      related_owner_id: selectedThread.ownerId ?? null,
      related_queue_id: null,
      related_offer_id: null,
      related_contract_id: null,
      source: 'Offer Engine',
      action_label: 'Review Offer',
      action_href: '/dashboard/kpis',
    })
  }

  if (selectedThread?.isOptOut || selectedThread?.inboxStatus === 'suppressed') {
    notifications.push({
      id: `suppressed-${selectedThread.id}`,
      command_space: 'SMS',
      type: 'stop_opt_out_detected',
      title: 'Suppression logged',
      body: 'This thread is suppressed. Do not recommend or send marketing messages.',
      severity: 'critical',
      status: 'unread',
      created_at: selectedCreatedAt,
      read_at: null,
      related_thread_id: selectedThread.id,
      related_property_id: selectedThread.propertyId ?? null,
      related_owner_id: selectedThread.ownerId ?? null,
      related_queue_id: null,
      related_offer_id: null,
      related_contract_id: null,
      source: 'Compliance',
      action_label: 'View Thread',
      action_href: '/inbox',
    })
  }

  if (queueProcessorHealth?.status === 'warning' || queueProcessorHealth?.status === 'critical') {
    notifications.push({
      id: queueProcessorHealth.status === 'critical' ? 'queue-critical' : 'queue-delayed',
      command_space: 'Queue',
      type: 'queue_delayed',
      title: queueProcessorHealth.status === 'critical' ? 'Queue health critical' : 'Queue processor delayed',
      body: queueProcessorHealth.summary,
      severity: queueProcessorHealth.status === 'critical' ? 'critical' : 'warning',
      status: 'unread',
      created_at: queueProcessorHealth.checkedAt,
      read_at: null,
      related_thread_id: null,
      related_property_id: null,
      related_owner_id: null,
      related_queue_id: null,
      related_offer_id: null,
      related_contract_id: null,
      source: 'Queue Processor',
      action_label: 'Open Queue',
      action_href: '/queue',
    })
  }

  if (autonomyModel.emergencyState) {
    notifications.push({
      id: 'autonomy-emergency',
      command_space: 'AI',
      type: 'autonomy_emergency_stop',
      title: 'Autonomous engine in protective posture',
      body: autonomyModel.topDirective,
      severity: 'critical',
      status: 'unread',
      created_at: queueProcessorHealth?.checkedAt || selectedCreatedAt,
      read_at: null,
      related_thread_id: selectedThread?.id ?? null,
      related_property_id: selectedThread?.propertyId ?? null,
      related_owner_id: selectedThread?.ownerId ?? null,
      related_queue_id: null,
      related_offer_id: null,
      related_contract_id: null,
      source: 'Autonomy Engine',
      action_label: 'Review Controls',
      action_href: '/inbox',
    })
  } else if (autonomyModel.complianceRiskScore >= 65) {
    notifications.push({
      id: 'autonomy-compliance-watch',
      command_space: 'AI',
      type: 'compliance_pressure_rising',
      title: 'Compliance pressure rising',
      body: `Compliance risk ${Math.round(autonomyModel.complianceRiskScore)}/100. Shift more threads into review-safe paths.`,
      severity: 'warning',
      status: 'unread',
      created_at: queueProcessorHealth?.checkedAt || selectedCreatedAt,
      read_at: null,
      related_thread_id: selectedThread?.id ?? null,
      related_property_id: selectedThread?.propertyId ?? null,
      related_owner_id: selectedThread?.ownerId ?? null,
      related_queue_id: null,
      related_offer_id: null,
      related_contract_id: null,
      source: 'Compliance Engine',
      action_label: 'Review Threads',
      action_href: '/inbox',
    })
  }

  if (autonomyModel.marketSnapshots[0]) {
    const leadMarket = autonomyModel.marketSnapshots[0]
    notifications.push({
      id: 'market-leader',
      command_space: 'Properties',
      type: 'market_intelligence_update',
      title: `${leadMarket.market} is leading network momentum`,
      body: `${leadMarket.hotLeadCount} hot leads · ${Math.round(leadMarket.closeMomentum)}/100 close momentum · ${Math.round(leadMarket.responseRate)}% response rate.`,
      severity: 'success',
      status: 'read',
      created_at: queueProcessorHealth?.checkedAt || selectedCreatedAt,
      read_at: queueProcessorHealth?.checkedAt || selectedCreatedAt,
      related_thread_id: null,
      related_property_id: null,
      related_owner_id: null,
      related_queue_id: null,
      related_offer_id: null,
      related_contract_id: null,
      source: 'Market Intelligence',
      action_label: 'Open Inbox',
      action_href: '/inbox',
    })
  }

  notifications.push({
    id: 'system-realtime-ready',
    command_space: 'System',
    type: 'system_warning',
    title: 'Notification center ready',
    body: 'Local adapter is normalized and Supabase realtime-ready.',
    severity: 'neutral',
    status: 'read',
    created_at: queueProcessorHealth?.checkedAt || selectedCreatedAt,
    read_at: queueProcessorHealth?.checkedAt || selectedCreatedAt,
    related_thread_id: null,
    related_property_id: null,
    related_owner_id: null,
    related_queue_id: null,
    related_offer_id: null,
    related_contract_id: null,
    source: 'NEXUS OS',
    action_label: 'Review',
    action_href: null,
  })

  return notifications
}

export const NexusNotificationCenter = ({
  open,
  notifications,
  onClose,
  onOpenRecord,
}: {
  open: boolean
  notifications: NexusNotification[]
  onClose: () => void
  onOpenRecord: (notification: NexusNotification) => void
}) => {
  const DEV = Boolean(import.meta.env.DEV)
  const [activeSpace, setActiveSpace] = useState('All')
  const [showUnreadOnly, setShowUnreadOnly] = useState(false)
  const [showCriticalOnly, setShowCriticalOnly] = useState(false)
  const [showFocused, setShowFocused] = useState(false)
  const [showSecondary, setShowSecondary] = useState(false)
  const [readIds, setReadIds] = useState<string[]>([])
  const [dismissedIds, setDismissedIds] = useState<string[]>([])
  const activeIsSecondary = SECONDARY_SPACES.includes(activeSpace)
  const { isWatched } = useWatchlist()

  const isFocused = useCallback((item: NexusNotification): boolean => {
    if (item.related_thread_id && isWatched('thread', item.related_thread_id)) return true
    if (item.related_property_id && isWatched('property', item.related_property_id)) return true
    if (item.related_owner_id && isWatched('owner', item.related_owner_id)) return true
    return false
  }, [isWatched])

  useEffect(() => {
    if (open && DEV) {
      console.log(`[NexusPopover]`, { name: 'NotificationCenter', action: 'open', open: true })
    }
  }, [open, DEV])

  const handleClose = useCallback(() => {
    if (DEV) console.log(`[NexusPopover]`, { name: 'NotificationCenter', action: 'close', open: false })
    onClose()
  }, [onClose, DEV])

  const enriched = useMemo(() => (
    notifications
      .filter((item) => !dismissedIds.includes(item.id))
      .map((item) => ({
        ...item,
        status: readIds.includes(item.id) ? 'read' as const : item.status,
      }))
  ), [dismissedIds, notifications, readIds])

  const toastItems = useMemo(() => enriched.filter((item) => item.status !== 'read').slice(0, 3), [enriched])

  // Phase 2: Auto-dismiss toasts after 3 seconds
  useEffect(() => {
    const timers = toastItems.map(item => {
      return setTimeout(() => {
        setDismissedIds(prev => prev.includes(item.id) ? prev : [...prev, item.id])
      }, 3000)
    })
    return () => timers.forEach(clearTimeout)
  }, [toastItems])

  const unreadCount = enriched.filter((item) => item.status !== 'read').length
  const filtered = enriched.filter((item) => {
    if (activeSpace !== 'All' && item.command_space !== activeSpace && !(activeSpace === 'Errors' && item.severity === 'critical')) return false
    if (showUnreadOnly && item.status === 'read') return false
    if (showCriticalOnly && item.severity !== 'critical') return false
    if (showFocused && !isFocused(item)) return false
    return true
  })

  return (
    <>
      <div className="nx-toast-stack" aria-live="polite">
        {toastItems.map((item) => (
          <article key={`toast-${item.id}`} className={cls('nx-toast-card', `is-${item.severity}`)}>
            <Icon name={notificationIcon(item.severity)} />
            <div>
              <span>{item.command_space}</span>
              <strong>{item.title}</strong>
            </div>
            <button type="button" onClick={() => setDismissedIds((ids) => [...ids, item.id])} aria-label="Dismiss notification">
              <Icon name="close" />
            </button>
          </article>
        ))}
      </div>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <section className="nx-notification-center nx-liquid-panel" aria-label="Notification center">

              {/* ── Header ─────────────────────────────────────────── */}
              <header>
                <div>
                  <span>Command Space</span>
                  <strong>Notifications</strong>
                  <p className="ncc-header__subtitle">Live operational alerts from Inbox, Queue, SMS, AI, Offers, and System.</p>
                </div>
                <button type="button" onClick={handleClose} aria-label="Close notifications">
                  <Icon name="close" />
                </button>
              </header>

              {/* ── Filter tools ───────────────────────────────────── */}
              <div className="nx-notification-center__tools">
                <button
                  type="button"
                  className={showUnreadOnly ? 'is-active' : ''}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowUnreadOnly((v) => !v) }}
                >
                  <Icon name="bell" />
                  Unread{unreadCount > 0 ? ` (${unreadCount})` : ''}
                </button>
                <button
                  type="button"
                  className={showCriticalOnly ? 'is-active' : ''}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowCriticalOnly((v) => !v) }}
                >
                  <Icon name="alert" />
                  Critical
                </button>
                <button
                  type="button"
                  className={showFocused ? 'is-active' : ''}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowFocused((v) => !v) }}
                >
                  <Icon name="bell" />
                  Focused
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setReadIds(enriched.map((n) => n.id)) }}
                >
                  Mark all read
                </button>
              </div>

              {/* ── Primary space tabs ─────────────────────────────── */}
              <div className="ncc-tabs" role="tablist" aria-label="Command spaces">
                {PRIMARY_SPACES.map((space) => (
                  <button
                    key={space}
                    type="button"
                    role="tab"
                    aria-selected={activeSpace === space}
                    className={cls('ncc-tab', activeSpace === space && 'is-active')}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveSpace(space); setShowSecondary(false) }}
                  >
                    {space}
                  </button>
                ))}
                <button
                  type="button"
                  className={cls('ncc-tab is-more', (activeIsSecondary || showSecondary) && 'is-active')}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowSecondary((v) => !v) }}
                >
                  {activeIsSecondary ? activeSpace : 'More'} ▾
                </button>
              </div>

              {/* ── Secondary spaces (flyout) ──────────────────────── */}
              {showSecondary && (
                <div className="ncc-secondary-tabs">
                  {SECONDARY_SPACES.map((space) => (
                    <button
                      key={space}
                      type="button"
                      className={cls('ncc-tab is-secondary', activeSpace === space && 'is-active')}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveSpace(space); setShowSecondary(false) }}
                    >
                      {space}
                    </button>
                  ))}
                </div>
              )}

              {/* ── Notification list ──────────────────────────────── */}
              <div className="nx-notification-list">
                {filtered.map((item) => (
                  <article
                    key={item.id}
                    className={cls('ncc-card', `is-${item.severity}`, item.status === 'read' && 'is-read')}
                  >
                    <div className="ncc-card__top">
                      <span className="ncc-card__icon">
                        <Icon name={notificationIcon(item.severity)} />
                      </span>
                      <span className="ncc-card__source">{sourceLabel(item.source)}</span>
                      {isFocused(item) && <span className="ncc-watched-chip">WATCHED</span>}
                      <span className="ncc-card__time">{item.created_at ? formatRelativeTime(item.created_at) : 'Now'}</span>
                      <button
                        type="button"
                        className="ncc-card__dismiss"
                        onClick={(e) => { e.stopPropagation(); setDismissedIds((ids) => [...ids, item.id]) }}
                        aria-label="Dismiss notification"
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="ncc-card__body"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setReadIds((ids) => ids.includes(item.id) ? ids : [...ids, item.id])
                        onOpenRecord(item)
                      }}
                    >
                      <strong className="ncc-card__title">{item.title}</strong>
                      <p className="ncc-card__text">{item.body}</p>
                      {item.action_label && (
                        <span className="ncc-card__action-hint">{item.action_label} →</span>
                      )}
                    </button>
                  </article>
                ))}
                {filtered.length === 0 && (
                  <p className="nx-notification-empty">No alerts for this space.</p>
                )}
              </div>

              {/* ── Footer ─────────────────────────────────────────── */}
              <footer className="ncc-footer">
                <span>Press <kbd>⌘K</kbd> to act on alerts</span>
              </footer>

            </section>,
            document.body,
          )
        : null}
    </>
  )
}
