import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'
import { pushRoutePath } from '../../app/router'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import type { GroupedNotification } from '../../domain/notifications/notification-contract'
import { useBreakpoint } from '../mobile/useBreakpoint'
import { MobileSheet } from '../mobile/MobileSheet'
import { useOperationsActivity } from './useOperationsActivity'
import { useOperationsSummary } from './useOperationsSummary'
import { humanizeEntityName, humanizeQueueStatus } from './ops-humanize'
import { useSessionEvents } from './session-event-bridge'
import type { OpsReason } from './ops-status'
import './operations-center.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

// ── Public contract (Lane A mounts this) ─────────────────────────────────

export type OperationsSection = 'attention' | 'activity' | 'sending' | 'notifications' | 'system'

export const OPERATIONS_SECTIONS: Array<{ id: OperationsSection; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'attention', label: 'Attention', icon: 'flag' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'sending', label: 'Sending', icon: 'send' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'system', label: 'System', icon: 'shield' },
]

export interface OperationsCenterProps {
  /** Controlled visibility. */
  open: boolean
  onClose: () => void
  /**
   * How the panel presents itself.
   *   'popover' — anchored to a top-rail trigger (default on desktop)
   *   'sheet'   — bottom sheet (default on mobile)
   *   'inline'  — rendered in place, no portal, no backdrop
   */
  presentation?: 'popover' | 'sheet' | 'inline'
  /** Which section opens first. The rail's two entry points use this. */
  initialSection?: OperationsSection
  /** Distance from the viewport top when presented as a popover. */
  anchorTop?: number
  /** Scope the Activity feed to one thread. */
  threadKey?: string
  /** Route change closes the panel (R11.10). Pass the current path. */
  routePath?: string
  /** Defaults to the app router's push. */
  onNavigate?: (href: string) => void
  /** Restore focus to the invoking trigger on close (R11.3). */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

// ── Small shared pieces ──────────────────────────────────────────────────

const ToneDot = ({ tone }: { tone: string }) => (
  <span className={cls('opsc-dot', `is-${tone}`)} aria-hidden="true" />
)

const SectionEmpty = ({
  kind,
  title,
  body,
  actionLabel,
  onAction,
}: {
  kind: 'good' | 'first-run' | 'filtered' | 'unavailable'
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}) => (
  <div className={cls('opsc-empty', `is-${kind}`)}>
    <span className="opsc-empty__icon" aria-hidden="true">
      <Icon name={kind === 'good' ? 'check' : kind === 'unavailable' ? 'alert' : 'radar'} size={16} />
    </span>
    <div className="opsc-empty__text">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
    {actionLabel && onAction ? (
      <button type="button" className="opsc-btn is-ghost" onClick={onAction}>{actionLabel}</button>
    ) : null}
  </div>
)

const SectionError = ({
  title,
  impact,
  detail,
  onRetry,
  retrying,
}: {
  title: string
  impact: string
  detail?: string
  onRetry: () => void
  retrying?: boolean
}) => {
  const [showDetail, setShowDetail] = useState(false)
  return (
    <div className="opsc-error" role="alert">
      <span className="opsc-error__icon" aria-hidden="true"><Icon name="alert" size={16} /></span>
      <div className="opsc-error__text">
        <strong>{title}</strong>
        <p>{impact}</p>
        <div className="opsc-error__actions">
          <button type="button" className="opsc-btn is-primary" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
          {detail ? (
            <button
              type="button"
              className="opsc-btn is-ghost"
              onClick={() => setShowDetail((v) => !v)}
              aria-expanded={showDetail}
            >
              {showDetail ? 'Hide detail' : 'Technical detail'}
            </button>
          ) : null}
        </div>
        {showDetail && detail ? <code className="opsc-error__detail">{detail}</code> : null}
      </div>
    </div>
  )
}

const ReasonRow = ({ reason }: { reason: OpsReason }) => (
  <div className={cls('opsc-reason', `is-${reason.tone}`, `is-${reason.severity}`)}>
    <ToneDot tone={reason.tone} />
    <div className="opsc-reason__text">
      <strong>{reason.label}</strong>
      <span>{reason.detail}</span>
    </div>
    {reason.count != null ? <b className="opsc-reason__count">{reason.count.toLocaleString()}</b> : null}
  </div>
)

// ── Notification card (shared by Attention + Notifications) ──────────────

const NotificationRow = ({
  item,
  onOpen,
  onDismiss,
  onSnooze,
  onMarkRead,
}: {
  item: GroupedNotification
  onOpen: () => void
  onDismiss: () => void
  onSnooze: () => void
  onMarkRead: () => void
}) => {
  const isUnread = item.status === 'unread'
  const count = item.groupMemberIds.length
  return (
    <article
      className={cls('opsc-notif', `is-${item.severity}`, isUnread && 'is-unread')}
      /* Titles repeat across rows ("New message" x21), so identity — not text —
       * is what proves a dismissal removed *this* card and that it stayed gone
       * across a reload. */
      data-notification-id={item.id}
      data-notification-status={item.status}
    >
      <ToneDot tone={item.severity === 'positive' ? 'positive' : item.severity === 'neutral' ? 'neutral' : item.severity} />
      <button type="button" className="opsc-notif__main" onClick={onOpen}>
        <span className="opsc-notif__head">
          {/* Sanitised title — never a raw phone number or event code. */}
          <strong className="opsc-notif__title">{item.title}</strong>
          {count > 1 ? <span className="opsc-notif__dup" title={`${count} duplicate events collapsed`}>{count}×</span> : null}
          <time className="opsc-notif__time">{formatRelativeTime(item.createdAt)}</time>
        </span>
        {item.subject ? <span className="opsc-notif__subject">{item.subject}</span> : null}
        <span className="opsc-notif__body">{item.body}</span>
      </button>
      <div className="opsc-notif__actions">
        {isUnread ? (
          <button type="button" className="opsc-icon-btn" onClick={onMarkRead} aria-label={`Mark "${item.title}" as read`} title="Mark read">
            <Icon name="check" size={12} />
          </button>
        ) : null}
        <button type="button" className="opsc-icon-btn" onClick={onSnooze} aria-label={`Snooze "${item.title}" for 1 hour`} title="Snooze 1 hour">
          <Icon name="clock" size={12} />
        </button>
        {/* Present at every breakpoint — the old card hid this on mobile. */}
        <button type="button" className="opsc-icon-btn" onClick={onDismiss} aria-label={`Dismiss "${item.title}"`} title="Dismiss">
          <Icon name="close" size={12} />
        </button>
      </div>
    </article>
  )
}

// ── Main component ───────────────────────────────────────────────────────

export function OperationsCenter({
  open,
  onClose,
  presentation,
  initialSection = 'attention',
  anchorTop = 58,
  threadKey,
  routePath,
  onNavigate,
  returnFocusRef,
}: OperationsCenterProps) {
  const { isMobile } = useBreakpoint()
  const mode = presentation ?? (isMobile ? 'sheet' : 'popover')

  const [section, setSection] = useState<OperationsSection>(initialSection)
  const panelRef = useRef<HTMLElement | null>(null)
  const firstTabRef = useRef<HTMLButtonElement | null>(null)

  const summary = useOperationsSummary()
  const activity = useOperationsActivity(threadKey)
  const sessionEvents = useSessionEvents()
  const {
    notifications,
    duplicatesCollapsed,
    loading: notificationsLoading,
    error: notificationsError,
    patch,
    refresh: refreshNotifications,
  } = useNotificationIntelligence()

  const navigate = useCallback((href: string) => {
    if (onNavigate) onNavigate(href)
    else pushRoutePath(href)
    onClose()
  }, [onNavigate, onClose])

  useEffect(() => { if (open) setSection(initialSection) }, [open, initialSection])

  // R11.10 — close on route change.
  const initialRouteRef = useRef(routePath)
  useEffect(() => {
    if (!open) { initialRouteRef.current = routePath; return }
    if (routePath && initialRouteRef.current && routePath !== initialRouteRef.current) onClose()
  }, [routePath, open, onClose])

  // R11.3 — Esc closes, outside click closes, focus returns to the trigger.
  useEffect(() => {
    if (!open || mode === 'inline') return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    const handleDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleDown)
    return () => {
      window.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleDown)
    }
  }, [open, onClose, mode])

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => firstTabRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(id)
      returnFocusRef?.current?.focus?.()
    }
  }, [open, returnFocusRef])

  // ── Derived section data ───────────────────────────────────────────────

  const blockers = useMemo(
    () => summary.status.reasons.filter((r) => r.severity === 'blocker'),
    [summary.status.reasons],
  )
  const degradations = useMemo(
    () => summary.status.reasons.filter((r) => r.severity === 'degrade'),
    [summary.status.reasons],
  )
  const watchItems = useMemo(
    () => summary.status.reasons.filter((r) => r.severity === 'watch'),
    [summary.status.reasons],
  )

  const attentionNotifications = useMemo(
    () => notifications
      .filter((n) => n.status === 'unread' && (n.severity === 'critical' || n.severity === 'warning'))
      .slice(0, 8),
    [notifications],
  )

  const sectionCounts: Record<OperationsSection, number> = {
    attention: blockers.length + attentionNotifications.length,
    activity: activity.events.length,
    sending: degradations.length,
    notifications: notifications.filter((n) => n.status === 'unread').length,
    system: summary.status.healthUnavailable ? 1 : 0,
  }

  // Grouped cards act on every member id, so dismissing a collapsed pair
  // removes both rows rather than leaving the twin behind.
  const dismissNotification = useCallback((item: GroupedNotification) => {
    if (item.groupMemberIds.length > 1) {
      void patch(item.id, 'bulk_dismiss', { ids: item.groupMemberIds })
    } else {
      void patch(item.id, 'dismiss')
    }
  }, [patch])

  const snoozeNotification = useCallback((item: GroupedNotification) => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    void patch(item.id, 'snooze', { snoozeUntil: until })
  }, [patch])

  const openNotification = useCallback((item: GroupedNotification) => {
    void patch(item.id, 'mark_read')
    const primary = item.actions.find((a) => a.primary) ?? item.actions[0]
    const href = primary?.href
      ?? (item.threadKey ? `/inbox?thread=${encodeURIComponent(item.threadKey)}` : null)
      ?? (item.propertyId ? `/deal-intelligence?property=${encodeURIComponent(item.propertyId)}` : null)
      ?? (item.queueId ? '/queue' : null)
      ?? (item.campaignId ? '/campaign-command' : null)
    if (href) navigate(href)
  }, [patch, navigate])

  if (!open) return null

  // ── Sections ───────────────────────────────────────────────────────────

  const renderAttention = () => {
    const nothing = blockers.length === 0 && attentionNotifications.length === 0
    if (nothing) {
      return (
        <SectionEmpty
          kind="good"
          title="Nothing is waiting on you"
          body="No blockers on the queue and no unread warnings. Sending posture is shown under Sending."
          actionLabel="Review sending"
          onAction={() => setSection('sending')}
        />
      )
    }
    return (
      <>
        {blockers.length ? (
          <div className="opsc-block">
            <h3 className="opsc-block__label">Blocking sending</h3>
            {blockers.map((reason) => <ReasonRow key={reason.key} reason={reason} />)}
            <button type="button" className="opsc-btn is-ghost opsc-block__cta" onClick={() => navigate('/queue')}>
              Open queue
            </button>
          </div>
        ) : null}
        {attentionNotifications.length ? (
          <div className="opsc-block">
            <h3 className="opsc-block__label">Needs a decision</h3>
            {attentionNotifications.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                onOpen={() => openNotification(item)}
                onDismiss={() => dismissNotification(item)}
                onSnooze={() => snoozeNotification(item)}
                onMarkRead={() => void patch(item.id, 'mark_read')}
              />
            ))}
          </div>
        ) : null}
      </>
    )
  }

  const renderActivity = () => {
    if (activity.phase === 'loading') {
      return (
        <div className="opsc-skeleton" aria-busy="true" aria-live="polite">
          <p className="opsc-skeleton__label">Loading live activity…</p>
          {[0, 1, 2, 3].map((i) => <div key={i} className="opsc-skeleton__row" />)}
        </div>
      )
    }

    if (activity.phase === 'error' && activity.error) {
      return (
        <SectionError
          title={
            activity.error.kind === 'feed_not_provisioned' ? 'Activity feed is not provisioned'
              : activity.error.kind === 'env_missing' ? 'Live activity is not configured'
                : 'Live activity could not be read'
          }
          impact={activity.error.message}
          detail={activity.error.detail}
          onRetry={activity.retry}
          retrying={activity.refreshing}
        />
      )
    }

    const rows = [...sessionEvents, ...activity.events.map((event) => ({
      id: event.id,
      at: event.created_at,
      title: event.title || humanizeQueueStatus(event.event_type),
      body: event.description,
      actor: humanizeEntityName(event.actor, 'System'),
      tone: event.event_type === 'message_failed' ? 'critical'
        : event.event_type === 'message_sent' ? 'positive' : 'neutral',
      threadKey: event.thread_key,
      source: 'feed' as const,
    }))].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

    if (!rows.length) {
      return (
        <SectionEmpty
          kind="first-run"
          title="No activity recorded yet"
          body="Queue sends, replies, and automation decisions appear here as they happen. The feed was read successfully — it is genuinely quiet."
          actionLabel="Refresh"
          onAction={activity.retry}
        />
      )
    }

    return (
      <>
        {activity.error ? (
          <p className="opsc-stale" role="status">
            Showing the last successful read{activity.lastLoadedAt ? ` from ${formatRelativeTime(activity.lastLoadedAt)}` : ''} — the latest refresh failed.
          </p>
        ) : null}
        <div className="opsc-activity">
          {rows.map((row) => (
            <article key={row.id} className={cls('opsc-activity__row', `is-${row.tone}`)}>
              <ToneDot tone={row.tone} />
              <div className="opsc-activity__text">
                <span className="opsc-activity__head">
                  <strong>{row.title}</strong>
                  <time>{formatRelativeTime(row.at)}</time>
                </span>
                {row.body ? <p>{row.body}</p> : null}
                <span className="opsc-activity__actor">{row.actor}</span>
              </div>
              {row.source === 'feed' && row.threadKey ? (
                <button
                  type="button"
                  className="opsc-btn is-ghost is-xs"
                  onClick={() => navigate(`/inbox?thread=${encodeURIComponent(row.threadKey!)}`)}
                >
                  Open
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </>
    )
  }

  const renderSending = () => {
    const { status, health } = summary
    return (
      <>
        <div className={cls('opsc-status-card', `is-${status.tone}`)}>
          <div className="opsc-status-card__head">
            <span className={cls('opsc-status-card__badge', `is-${status.tone}`)}>
              <Icon name={status.icon} size={12} />
              {status.label}
            </span>
            {status.checkedAt ? (
              <span className="opsc-status-card__checked">Checked {formatRelativeTime(status.checkedAt)}</span>
            ) : null}
          </div>
          <p className="opsc-status-card__headline">{status.headline}</p>
          <dl className="opsc-status-card__facts">
            <div><dt>Execution mode</dt><dd>{
              status.executionMode.source === 'absent' ? 'Not reported'
                : status.executionMode.source === 'unknown_fail_closed' ? `Unrecognised — failing closed`
                  : status.executionMode.mode === 'normal' ? 'Normal'
                    : status.executionMode.mode === 'stopped' ? 'Stopped'
                      : 'Canary only'
            }</dd></div>
            <div><dt>Queued</dt><dd>{(health?.queuedCount ?? 0).toLocaleString()}</dd></div>
            <div><dt>Sent today</dt><dd>{(health?.sentTodayCount ?? 0).toLocaleString()}</dd></div>
            <div><dt>Failed today</dt><dd>{(health?.failedTodayCount ?? 0).toLocaleString()}</dd></div>
          </dl>
        </div>

        {degradations.length ? (
          <div className="opsc-block">
            <h3 className="opsc-block__label">Degrading throughput</h3>
            {degradations.map((reason) => <ReasonRow key={reason.key} reason={reason} />)}
          </div>
        ) : null}

        {watchItems.length ? (
          <div className="opsc-block">
            <h3 className="opsc-block__label">Worth watching</h3>
            {watchItems.map((reason) => <ReasonRow key={reason.key} reason={reason} />)}
          </div>
        ) : null}

        {!degradations.length && !watchItems.length && !blockers.length ? (
          <SectionEmpty
            kind="good"
            title="No queue faults"
            body="No blocked routing, no stale rows, no failure spike. That is a real zero, not missing data."
          />
        ) : null}

        <div className="opsc-block opsc-block--actions">
          <button type="button" className="opsc-btn is-primary" onClick={() => navigate('/queue')}>Open queue</button>
          <button type="button" className="opsc-btn is-ghost" onClick={() => navigate('/campaign-command')}>Open campaigns</button>
          <button type="button" className="opsc-btn is-ghost" onClick={summary.refresh}>Refresh</button>
        </div>
      </>
    )
  }

  const renderNotifications = () => {
    if (notificationsLoading && !notifications.length) {
      return (
        <div className="opsc-skeleton" aria-busy="true">
          <p className="opsc-skeleton__label">Loading notifications…</p>
          {[0, 1, 2, 3].map((i) => <div key={i} className="opsc-skeleton__row" />)}
        </div>
      )
    }
    if (notificationsError && !notifications.length) {
      return (
        <SectionError
          title="Notification feed unavailable"
          impact="Operational signals are not reaching you right now. Queue and inbox work is unaffected."
          detail={notificationsError}
          onRetry={() => void refreshNotifications()}
        />
      )
    }
    if (!notifications.length) {
      return (
        <SectionEmpty
          kind="good"
          title="All clear"
          body="No open notifications. Dismissed and snoozed items stay hidden until they are due."
        />
      )
    }
    return (
      <>
        {duplicatesCollapsed > 0 ? (
          <p className="opsc-note">
            {duplicatesCollapsed} duplicate event{duplicatesCollapsed === 1 ? '' : 's'} collapsed into the cards below.
          </p>
        ) : null}
        <div className="opsc-block">
          {notifications.slice(0, 40).map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              onOpen={() => openNotification(item)}
              onDismiss={() => dismissNotification(item)}
              onSnooze={() => snoozeNotification(item)}
              onMarkRead={() => void patch(item.id, 'mark_read')}
            />
          ))}
        </div>
      </>
    )
  }

  const renderSystem = () => {
    const { health, status, healthError } = summary
    const services = [
      {
        name: 'Queue processor',
        ok: health?.processorHealthy === true,
        unknown: !health,
        detail: health?.processorHealthy
          ? 'Picking up queued rows.'
          : 'Not reporting healthy — queued rows may not be picked up.',
      },
      {
        name: 'Delivery webhooks',
        ok: health?.webhookHealthy === true,
        unknown: !health,
        detail: health?.webhookHealthy
          ? 'Delivery receipts are current.'
          : 'No recent receipt — delivered counts are unreliable.',
      },
      {
        name: 'Execution gate',
        ok: status.executionMode.mode === 'normal',
        unknown: status.executionMode.source === 'absent',
        detail: status.executionMode.mode === 'normal'
          ? 'Sending is permitted.'
          : 'Sending is held by the execution gate.',
      },
    ]

    return (
      <>
        {healthError || status.healthUnavailable ? (
          <SectionError
            title="Queue health could not be read"
            impact="Status is unknown, not healthy. Do not assume autopilot is permitted while this is showing."
            detail={healthError ?? undefined}
            onRetry={summary.refresh}
            retrying={summary.loading}
          />
        ) : null}

        <div className="opsc-block">
          <h3 className="opsc-block__label">Services</h3>
          {services.map((service) => (
            <div key={service.name} className="opsc-service">
              <ToneDot tone={service.unknown ? 'neutral' : service.ok ? 'positive' : 'caution'} />
              <div className="opsc-service__text">
                <strong>{service.name}</strong>
                <span>{service.unknown ? 'Not reporting.' : service.detail}</span>
              </div>
              <span className={cls('opsc-service__state', service.unknown ? 'is-neutral' : service.ok ? 'is-positive' : 'is-caution')}>
                {service.unknown ? 'Unknown' : service.ok ? 'OK' : 'Attention'}
              </span>
            </div>
          ))}
        </div>

        <details className="opsc-disclosure">
          <summary>Diagnostics</summary>
          <dl className="opsc-disclosure__list">
            <div><dt>Reported health status</dt><dd>{status.rawHealthStatus || 'not reported'}</dd></div>
            <div><dt>Stored execution mode</dt><dd>{status.executionMode.raw || 'not reported'}</dd></div>
            <div><dt>Mode interpretation</dt><dd>{status.executionMode.source.replace(/_/g, ' ')}</dd></div>
            <div><dt>Last check</dt><dd>{status.checkedAt ? formatRelativeTime(status.checkedAt) : 'never'}</dd></div>
          </dl>
        </details>
      </>
    )
  }

  const sectionBody = section === 'attention' ? renderAttention()
    : section === 'activity' ? renderActivity()
      : section === 'sending' ? renderSending()
        : section === 'notifications' ? renderNotifications()
          : renderSystem()

  // In a sheet, MobileSheet already supplies the title and close control —
  // rendering our own produced a duplicated header and two close buttons.
  const content = (
    <>
      <header className={cls('opsc-header', mode === 'sheet' && 'is-compact')}>
        <div className="opsc-header__identity">
          {mode !== 'sheet' ? (
            <>
              <span className="opsc-eyebrow">Operations</span>
              <strong className="opsc-title">Operational Intelligence</strong>
            </>
          ) : null}
          <p className="opsc-subtitle">{summary.status.headline}</p>
        </div>
        <div className="opsc-header__actions">
          <span className={cls('opsc-header__badge', `is-${summary.status.tone}`)}>
            <Icon name={summary.status.icon} size={11} />
            {summary.status.label}
          </span>
          <button type="button" className="opsc-icon-btn" onClick={summary.refresh} aria-label="Refresh operations data">
            <Icon name="refresh-cw" size={13} />
          </button>
          {mode !== 'sheet' ? (
            <button type="button" className="opsc-icon-btn" onClick={onClose} aria-label="Close operations center">
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="opsc-tabs" role="tablist" aria-label="Operations sections">
        {OPERATIONS_SECTIONS.map((tab, index) => (
          <button
            key={tab.id}
            ref={index === 0 ? firstTabRef : undefined}
            type="button"
            role="tab"
            id={`opsc-tab-${tab.id}`}
            aria-selected={section === tab.id}
            aria-controls={`opsc-panel-${tab.id}`}
            className={cls('opsc-tab', section === tab.id && 'is-active')}
            onClick={() => setSection(tab.id)}
          >
            {/* Text only: five icon+label tabs do not fit the panel width, and
                a truncated section name ("Notifi…") is worse than no icon. */}
            <span>{tab.label}</span>
            {sectionCounts[tab.id] > 0 ? (
              <b className="opsc-tab__count">{sectionCounts[tab.id] > 99 ? '99+' : sectionCounts[tab.id]}</b>
            ) : null}
          </button>
        ))}
      </div>

      <div
        className="opsc-body"
        role="tabpanel"
        id={`opsc-panel-${section}`}
        aria-labelledby={`opsc-tab-${section}`}
      >
        {sectionBody}
      </div>
    </>
  )

  if (mode === 'inline') {
    return <section className="opsc-root is-inline" aria-label="Operations center">{content}</section>
  }

  if (mode === 'sheet') {
    return (
      <MobileSheet open title="Operational Intelligence" subtitle={summary.status.label} height="full" onClose={onClose}>
        <section ref={panelRef as React.RefObject<HTMLElement>} className="opsc-root is-sheet" aria-label="Operations center">
          {content}
        </section>
      </MobileSheet>
    )
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <section
      ref={panelRef as React.RefObject<HTMLElement>}
      className="opsc-root is-popover"
      style={{ '--opsc-anchor-top': `${anchorTop}px` } as React.CSSProperties}
      role="dialog"
      aria-modal="false"
      aria-label="Operations center"
    >
      {content}
    </section>,
    document.body,
  )
}

export default OperationsCenter
