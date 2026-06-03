import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
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

type SoundMode = 'off' | 'subtle' | 'full'
type PrimaryFilter = 'all' | 'unread' | 'critical' | 'focused'

// ── Accent mapping ────────────────────────────────────────────────────────

const cardAccent = (item: NexusNotification): string => {
  if (item.severity === 'critical') return 'critical'
  if (item.source === 'Inbox') return 'inbox'
  if (item.source === 'Autonomy Engine' || item.source === 'AI Engine') return 'ai'
  if (item.source === 'Offer Engine' || item.source === 'Market Intelligence') return 'offer'
  if (item.severity === 'warning') return 'warning'
  if (item.severity === 'success') return 'success'
  return 'neutral'
}

const toastAccent = (item: NexusNotification): string => cardAccent(item)

const notificationIcon = (severity: NotificationSeverity, source: string): Parameters<typeof Icon>[0]['name'] => {
  if (source === 'Inbox') return 'inbox'
  if (source === 'Queue Processor') return 'activity'
  if (source === 'Autonomy Engine') return 'brain'
  if (source === 'Offer Engine') return 'dollar-sign'
  if (source === 'Compliance' || source === 'Compliance Engine') return 'shield'
  if (source === 'Market Intelligence') return 'trending-up'
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

// ── Notification factory ──────────────────────────────────────────────────

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

// ── Notification card component ───────────────────────────────────────────

const NotificationCard = ({
  item,
  focused,
  onDismiss,
  onOpen,
}: {
  item: NexusNotification
  focused: boolean
  onDismiss: () => void
  onOpen: () => void
}) => {
  const accent = cardAccent(item)
  const isUnread = item.status !== 'read'
  const iconName = notificationIcon(item.severity, item.source)

  return (
    <article
      role="listitem"
      className={cls(
        'nxhud-card',
        `is-${accent}`,
        !isUnread && 'is-read',
        focused && 'is-focused',
      )}
    >
      <span className="nxhud-card__rail" aria-hidden="true" />
      <div className="nxhud-card__inner">
        <div className="nxhud-card__top">
          <span className="nxhud-card__icon-wrap">
            <Icon name={iconName} />
          </span>
          <span className="nxhud-card__source">{sourceLabel(item.source)}</span>
          {focused && <span className="nxhud-card__watched-chip">WATCHED</span>}
          <span className="nxhud-card__time">
            {item.created_at ? formatRelativeTime(item.created_at) : 'Now'}
          </span>
          {isUnread && <span className="nxhud-card__unread-dot" aria-label="Unread" />}
          <button
            type="button"
            className="nxhud-card__dismiss-btn"
            onClick={(e) => { e.stopPropagation(); onDismiss() }}
            aria-label="Dismiss notification"
          >
            <Icon name="close" />
          </button>
        </div>

        <button
          type="button"
          className="nxhud-card__body-btn"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen() }}
        >
          <strong className="nxhud-card__title">{item.title}</strong>
          <p className="nxhud-card__text">{item.body}</p>
        </button>

        {item.action_label && (
          <div className="nxhud-card__actions">
            <button
              type="button"
              className="nxhud-card__action-btn"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen() }}
            >
              {item.action_label} →
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────

const EmptyState = ({ filter, space }: { filter: PrimaryFilter; space: string }) => {
  const msgs: Record<string, string> = {
    unread: 'No unread alerts right now.',
    critical: 'No critical alerts active.',
    focused: 'No watched-item alerts.',
  }
  return (
    <div className="nxhud-empty">
      <span className="nxhud-empty__icon">
        <Icon name="radar" />
      </span>
      <strong className="nxhud-empty__title">All clear</strong>
      <p className="nxhud-empty__text">
        {msgs[filter] ?? `No active alerts in ${space === 'All' ? 'this command space' : space}.`}
      </p>
    </div>
  )
}

// ── Sound settings panel ──────────────────────────────────────────────────

const SOUND_TOGGLES = [
  { label: 'New Reply', key: 'reply' },
  { label: 'Hot Seller', key: 'hotSeller' },
  { label: 'Critical Alert', key: 'critical' },
  { label: 'Offer Event', key: 'offer' },
  { label: 'System', key: 'system' },
]

const SoundSettingsPanel = ({
  soundMode,
  onSoundMode,
}: {
  soundMode: SoundMode
  onSoundMode: (m: SoundMode) => void
}) => (
  <div className="nxhud-sound-settings">
    <div className="nxhud-settings-section">
      <label className="nxhud-settings-label">SOUND MODE</label>
      <div className="nxhud-sound-mode-group">
        {(['off', 'subtle', 'full'] as SoundMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className={cls('nxhud-mode-chip', soundMode === mode && 'is-active')}
            onClick={() => onSoundMode(mode)}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
    </div>
    <div className="nxhud-settings-section">
      <label className="nxhud-settings-label">NOTIFICATION EVENTS</label>
      <div className="nxhud-sound-toggles">
        {SOUND_TOGGLES.map(({ label }) => (
          <div key={label} className="nxhud-sound-toggle-row">
            <span className="nxhud-sound-toggle-label">{label}</span>
            <span className="nxhud-sound-toggle-hint">global sound setting</span>
          </div>
        ))}
      </div>
    </div>
    <p className="nxhud-settings-note">
      Individual event sounds are managed in Settings → Sound Design.
    </p>
  </div>
)

// ── Main panel component ──────────────────────────────────────────────────

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
  const [primaryFilter, setPrimaryFilter] = useState<PrimaryFilter>('all')
  const [activeSpace, setActiveSpace] = useState('All')
  const [showSecondary, setShowSecondary] = useState(false)
  const [readIds, setReadIds] = useState<string[]>([])
  const [dismissedIds, setDismissedIds] = useState<string[]>([])
  const [showSoundSettings, setShowSoundSettings] = useState(false)
  const [soundMode, setSoundMode] = useState<SoundMode>(() => {
    try { return (localStorage.getItem('nxhud-sound-mode') as SoundMode) || 'subtle' }
    catch { return 'subtle' }
  })
  const panelRef = useRef<HTMLElement>(null)
  const { isWatched } = useWatchlist()

  const isFocused = useCallback((item: NexusNotification): boolean => {
    if (item.related_thread_id && isWatched('thread', item.related_thread_id)) return true
    if (item.related_property_id && isWatched('property', item.related_property_id)) return true
    if (item.related_owner_id && isWatched('owner', item.related_owner_id)) return true
    return false
  }, [isWatched])

  // Escape + click-outside
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    const handleMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      window.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [open, onClose])

  const enriched = useMemo(() => (
    notifications
      .filter((item) => !dismissedIds.includes(item.id))
      .map((item) => ({
        ...item,
        status: readIds.includes(item.id) ? 'read' as const : item.status,
      }))
  ), [dismissedIds, notifications, readIds])

  const toastItems = useMemo(() => enriched.filter((item) => item.status !== 'read').slice(0, 3), [enriched])

  // Critical toasts persist; normal toasts auto-dismiss after 6s
  useEffect(() => {
    const timers = toastItems
      .filter((item) => item.severity !== 'critical')
      .map((item) => setTimeout(() => {
        setDismissedIds((prev) => prev.includes(item.id) ? prev : [...prev, item.id])
      }, 6000))
    return () => timers.forEach(clearTimeout)
  }, [toastItems])

  const unreadCount = enriched.filter((item) => item.status !== 'read').length
  const criticalCount = enriched.filter((item) => item.severity === 'critical').length
  const activeIsSecondary = SECONDARY_SPACES.includes(activeSpace)

  const filtered = enriched.filter((item) => {
    if (primaryFilter === 'unread' && item.status === 'read') return false
    if (primaryFilter === 'critical' && item.severity !== 'critical') return false
    if (primaryFilter === 'focused' && !isFocused(item)) return false
    if (activeSpace !== 'All' && item.command_space !== activeSpace &&
        !(activeSpace === 'Errors' && item.severity === 'critical')) return false
    return true
  })

  const handleSoundMode = (mode: SoundMode) => {
    setSoundMode(mode)
    try { localStorage.setItem('nxhud-sound-mode', mode) } catch { /* noop */ }
  }

  return (
    <>
      {/* Toast stack — always rendered regardless of panel open state */}
      <div className="nx-toast-stack" aria-live="polite">
        {toastItems.map((item) => (
          <article
            key={`toast-${item.id}`}
            className={cls('nxhud-toast', `is-${toastAccent(item)}`)}
          >
            <span className="nxhud-toast__icon">
              <Icon name={notificationIcon(item.severity, item.source)} />
            </span>
            <div className="nxhud-toast__body">
              <span className="nxhud-toast__space">{item.command_space}</span>
              <strong className="nxhud-toast__title">{item.title}</strong>
            </div>
            <button
              type="button"
              className="nxhud-toast__dismiss"
              onClick={() => setDismissedIds((ids) => [...ids, item.id])}
              aria-label="Dismiss notification"
            >
              <Icon name="close" />
            </button>
          </article>
        ))}
      </div>

      {/* Panel — rendered via portal */}
      {open && typeof document !== 'undefined'
        ? createPortal(
          <section
            ref={panelRef}
            className="nx-notification-center nx-liquid-panel nxhud-panel"
            aria-label="Notification command center"
            role="dialog"
            aria-modal="true"
          >
            {/* ── Header ──────────────────────────────────────────── */}
            <div className="nxhud-header">
              <div className="nxhud-header__left">
                <span className="nxhud-eyebrow">COMMAND SPACE</span>
                <div className="nxhud-title-row">
                  <strong className="nxhud-title">Notifications</strong>
                  <span className="nxhud-live-badge">
                    <span className="nxhud-live-dot" />
                    Live
                  </span>
                  {unreadCount > 0 && (
                    <span className="nxhud-count-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
                  )}
                </div>
                <p className="nxhud-subtitle">
                  Live operational alerts from Inbox, Queue, SMS, AI, Offers, and System.
                </p>
              </div>
              <div className="nxhud-header__actions">
                <button
                  type="button"
                  className={cls('nxhud-header-btn', showSoundSettings && 'is-active')}
                  onClick={() => setShowSoundSettings((v) => !v)}
                  aria-label="Sound settings"
                  title="Sound settings"
                >
                  <Icon name="volume" />
                </button>
                <button
                  type="button"
                  className="nxhud-header-btn"
                  onClick={onClose}
                  aria-label="Close notifications"
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>

            {showSoundSettings ? (
              <SoundSettingsPanel soundMode={soundMode} onSoundMode={handleSoundMode} />
            ) : (
              <>
                {/* ── Primary filter chips ─────────────────────────── */}
                <div className="nxhud-filters" role="group" aria-label="Primary filters">
                  {([
                    { id: 'all' as PrimaryFilter, label: 'All' },
                    { id: 'unread' as PrimaryFilter, label: unreadCount > 0 ? `Unread · ${unreadCount}` : 'Unread' },
                    { id: 'critical' as PrimaryFilter, label: criticalCount > 0 ? `Critical · ${criticalCount}` : 'Critical' },
                    { id: 'focused' as PrimaryFilter, label: 'Focused' },
                  ]).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={cls(
                        'nxhud-filter-chip',
                        primaryFilter === f.id && 'is-active',
                        f.id === 'critical' && criticalCount > 0 && 'has-alerts',
                      )}
                      onClick={() => setPrimaryFilter(primaryFilter === f.id && f.id !== 'all' ? 'all' : f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="nxhud-filter-chip nxhud-mark-read-btn"
                    onClick={() => setReadIds(enriched.map((n) => n.id))}
                    title="Mark all notifications as read"
                  >
                    Mark all read
                  </button>
                </div>

                {/* ── Category / space chips ───────────────────────── */}
                <div className="nxhud-spaces" role="tablist" aria-label="Command spaces">
                  {PRIMARY_SPACES.map((space) => (
                    <button
                      key={space}
                      type="button"
                      role="tab"
                      aria-selected={activeSpace === space}
                      className={cls('nxhud-space-chip', activeSpace === space && 'is-active')}
                      onClick={() => { setActiveSpace(space); setShowSecondary(false) }}
                    >
                      {space}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={cls(
                      'nxhud-space-chip nxhud-space-more',
                      (activeIsSecondary || showSecondary) && 'is-active',
                    )}
                    onClick={() => setShowSecondary((v) => !v)}
                  >
                    {activeIsSecondary ? activeSpace : 'More'} ▾
                  </button>
                </div>

                {/* ── Secondary space flyout ───────────────────────── */}
                {showSecondary && (
                  <div className="nxhud-secondary-spaces">
                    {SECONDARY_SPACES.map((space) => (
                      <button
                        key={space}
                        type="button"
                        className={cls('nxhud-space-chip is-secondary', activeSpace === space && 'is-active')}
                        onClick={() => { setActiveSpace(space); setShowSecondary(false) }}
                      >
                        {space}
                      </button>
                    ))}
                  </div>
                )}

                {/* ── Notification list ────────────────────────────── */}
                <div className="nx-notification-list nxhud-list" role="list">
                  {filtered.map((item) => (
                    <NotificationCard
                      key={item.id}
                      item={item}
                      focused={isFocused(item)}
                      onDismiss={() => setDismissedIds((ids) => [...ids, item.id])}
                      onOpen={() => {
                        setReadIds((ids) => ids.includes(item.id) ? ids : [...ids, item.id])
                        onOpenRecord(item)
                      }}
                    />
                  ))}
                  {filtered.length === 0 && (
                    <EmptyState filter={primaryFilter} space={activeSpace} />
                  )}
                </div>

                {/* ── Footer ──────────────────────────────────────── */}
                <footer className="ncc-footer nxhud-footer">
                  <span className="nxhud-footer-hint">
                    <kbd>⌘K</kbd> act on alerts · <kbd>Esc</kbd> close
                  </span>
                </footer>
              </>
            )}
          </section>,
          document.body,
        )
        : null}
    </>
  )
}
