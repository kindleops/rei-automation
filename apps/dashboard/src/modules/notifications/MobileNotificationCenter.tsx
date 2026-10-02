/**
 * NOTIFICATIONS — a liquid-glass dropdown from the bell, not an app.
 *
 * It hangs from the command island over the blurred app (Liquid Glass
 * appearance settings drive the material), closes on a tap outside, and reads
 * like the notification centre of a device: every card carries its source
 * app's lit tile, severity is a ring and a word rather than a colour wash,
 * phone numbers read like phone numbers, grouped alerts stack like a deck,
 * unread glows, and a swipe left clears a card. Tapping a card goes exactly
 * where it says. Push enrolment lives at the top until it is on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pushRoutePath } from '../../app/router'
import { Icon, type IconName } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'
import {
  groupNotificationsByTime,
  type NotificationDomain,
  type NotificationEvent,
  type NotificationSeverity,
  type NotificationTimeGroup,
} from '../../domain/notifications/notification-contract'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { enablePush, readPushStatus, type PushStatus } from '../../domain/notifications/push-subscription'
import { resolveNotificationDestination } from './notification-destination'
import './mobile-notification-center.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type Segment = 'action' | 'all' | 'system'
const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'action', label: 'Urgent' },
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System' },
]
const SYSTEM_DOMAINS = new Set<NotificationDomain>(['platform', 'workflow', 'numbers', 'templates'])

/** Each source gets its app's own light and glyph — the card says where it came from at a glance. */
const DOMAIN_STYLE: Record<NotificationDomain, { label: string; icon: IconName; hue: string }> = {
  inbox: { label: 'Inbox', icon: 'message', hue: '#38bdf8' },
  campaigns: { label: 'Campaigns', icon: 'bolt', hue: '#22d3ee' },
  templates: { label: 'Templates', icon: 'file-text', hue: '#f472b6' },
  numbers: { label: 'Numbers', icon: 'phone', hue: '#fbbf24' },
  markets: { label: 'Markets', icon: 'map', hue: '#2dd4bf' },
  acquisition: { label: 'Acquisition', icon: 'target', hue: '#fb923c' },
  closing: { label: 'Closing', icon: 'key', hue: '#4ade80' },
  workflow: { label: 'Workflows', icon: 'layers', hue: '#c084fc' },
  platform: { label: 'System', icon: 'cpu', hue: '#94a3b8' },
  intelligence: { label: 'Intelligence', icon: 'spark', hue: '#a78bfa' },
  email: { label: 'Email', icon: 'mail', hue: '#60a5fa' },
  signals: { label: 'Signals', icon: 'radar', hue: '#22d3ee' },
}

/** The event itself picks the tile when it says what happened: a hot lead is not a message. */
function eventStyle(item: NotificationEvent): { icon: IconName; hue: string } | null {
  const t = `${item.type} ${item.title}`.toLowerCase()
  if (/hot[ _-]?lead|hot\b/.test(t)) return { icon: 'bolt', hue: '#ff5a64' }
  if (/price|offer|captured/.test(t)) return { icon: 'dollar-sign', hue: '#34e8a0' }
  if (/opt[ _-]?out|stop|unsubscrib|dnc/.test(t)) return { icon: 'slash', hue: '#94a3b8' }
  if (/fail|error|undeliver|bounce/.test(t)) return { icon: 'alert', hue: '#ff5a74' }
  if (/contract|closing|escrow/.test(t)) return { icon: 'key', hue: '#4ade80' }
  if (/campaign/.test(t)) return { icon: 'bolt', hue: '#22d3ee' }
  if (/message|reply|replied|inbound/.test(t)) return { icon: 'message', hue: '#38bdf8' }
  return null
}

const SEVERITY_WORD: Partial<Record<NotificationSeverity, string>> = { critical: 'Critical', warning: 'Needs attention' }
const TIME_GROUP_LABEL: Record<NotificationTimeGroup, string> = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' }
const PAGE = 30

export { resolveNotificationDestination }

/** "+14047518576" → "(404) 751-8576", anywhere in a string. */
const readablePhones = (text: string) =>
  text.replace(/\+?1?(\d{3})(\d{3})(\d{4})\b/g, (m, a, b, c) => (m.replace(/\D/g, '').length >= 10 ? `(${a}) ${b}-${c}` : m))

/** "Hot lead — +14047518576" → { title: "Hot lead", subject: "(404) 751-8576" } */
function splitTitle(raw: string): { title: string; subject: string | null } {
  const parts = raw.split(/\s+[—–-]\s+/)
  if (parts.length >= 2) return { title: parts[0], subject: readablePhones(parts.slice(1).join(' — ')) }
  return { title: readablePhones(raw), subject: null }
}

const needsAction = (event: NotificationEvent) =>
  event.status === 'unread' && (event.severity === 'critical' || event.severity === 'warning')

function PushCard() {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void readPushStatus().then((s) => { if (live) setStatus(s) })
    return () => { live = false }
  }, [])
  if (!status || status.state === 'granted' || status.state === 'unsupported') return null
  const title = status.state === 'prompt' ? 'Get alerts on this phone'
    : status.state === 'denied' ? 'Notifications are blocked'
      : status.state === 'needs_install' ? 'Add LeadCommand to your Home Screen'
        : 'Push isn’t switched on for this deployment yet'
  const detail = status.state === 'prompt' ? 'Hot leads, failures and closings reach you even when LeadCommand is closed.'
    : status.state === 'denied' ? 'Allow notifications for this site in Settings to receive alerts.'
      : status.state === 'needs_install' ? 'iPhone delivers web push only to installed apps: Share → Add to Home Screen, then open it from there.'
        : status.detail ?? 'The server has no push keys yet.'
  return (
    <div className={cls('nx-ntf-push', `is-${status.state}`)}>
      <span className="nx-ntf-push__orb" aria-hidden="true"><Icon name="bell" /><i /><i /></span>
      <div className="nx-ntf-push__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {status.state === 'prompt' && (
        <button type="button" className="nx-ntf-push__cta" disabled={busy} onClick={async () => { setBusy(true); setStatus(await enablePush()); setBusy(false) }}>
          {busy ? 'Enabling…' : 'Turn on'}
        </button>
      )}
    </div>
  )
}

/** One card: tap opens it, swipe left clears it. */
function NotificationCard({ item, index, onOpen, onDismiss }: { item: NotificationEvent; index: number; onOpen: () => void; onDismiss: () => void }) {
  const base = DOMAIN_STYLE[item.domain] ?? DOMAIN_STYLE.platform
  const style = { ...base, ...(eventStyle(item) ?? {}) }
  const { title, subject } = splitTitle(item.title)
  const body = readablePhones(item.summary || item.body || '')
  const unread = item.status === 'unread'
  const stacked = (item.groupedCount ?? 1) > 1
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; dx: number; axis: 'x' | 'y' | null } | null>(null)
  const [dx, setDx] = useState(0)
  const [gone, setGone] = useState(false)

  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, dx: 0, axis: null } }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const mx = e.clientX - d.x
    const my = e.clientY - d.y
    if (!d.axis && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      d.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
      // Once it is a horizontal swipe, keep the pointer: without capture the
      // drag died the moment the finger/cursor left the card, snapping it back.
      if (d.axis === 'x') { try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* not capturable */ } }
    }
    if (d.axis !== 'x') return
    d.dx = Math.min(0, mx)
    setDx(d.dx)
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.axis === 'x') {
      if (d.dx < -96) { setGone(true); window.setTimeout(onDismiss, 260) } else setDx(0)
      return
    }
    if (!d.axis) onOpen()
  }

  return (
    <div className={cls('nx-ntf-card-wrap', stacked && 'is-stacked', gone && 'is-gone')} style={{ ['--i' as string]: Math.min(index, 12), ['--hue' as string]: style.hue }}>
      <span className="nx-ntf-card__clear" aria-hidden="true" style={{ opacity: Math.min(1, -dx / 90) }}><Icon name="check" />Clear</span>
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        data-notif-id={item.id}
        className={cls('nx-ntf-card', `is-${item.severity}`, unread && 'is-unread')}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: drag.current ? 'none' : undefined }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { drag.current = null; setDx(0) }}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      >
        <span className="nx-ntf-card__tile" aria-hidden="true">
          <Icon name={style.icon} />
          {item.severity === 'positive' && <b className="nx-ntf-card__badge is-good"><Icon name="check" /></b>}
          {(item.severity === 'critical' || item.severity === 'warning') && <b className={cls('nx-ntf-card__badge', `is-${item.severity}`)}>!</b>}
        </span>
        <div className="nx-ntf-card__copy">
          <div className="nx-ntf-card__top">
            <span className="nx-ntf-card__app">{style.label}{SEVERITY_WORD[item.severity] ? <em className={`is-${item.severity}`}> · {SEVERITY_WORD[item.severity]}</em> : null}</span>
            <time dateTime={item.createdAt}>{formatRelativeTime(item.createdAt)}</time>
            {unread && <i className="nx-ntf-card__dot" aria-label="Unread" />}
          </div>
          <strong className="nx-ntf-card__title">{title}{subject ? <span> {subject}</span> : null}</strong>
          {body && body !== subject ? <p className="nx-ntf-card__body">{body}</p> : null}
          {stacked && <span className="nx-ntf-card__more">+{(item.groupedCount ?? 1) - 1} more like this</span>}
        </div>
      </div>
    </div>
  )
}

interface MobileNotificationCenterProps {
  open: boolean
  onClose: () => void
}

export const MobileNotificationCenter = ({ open, onClose }: MobileNotificationCenterProps) => {
  const { notifications, unreadCount, loading, error, refresh, patch } = useNotificationIntelligence()
  const [segment, setSegment] = useState<Segment>('all')
  const [limit, setLimit] = useState(PAGE)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (open) { void refresh(); setLimit(PAGE) } }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const live = useMemo(() => notifications.filter((n) => n.status !== 'dismissed'), [notifications])
  const counts = useMemo(() => ({
    action: live.filter(needsAction).length,
    all: live.length,
    system: live.filter((n) => SYSTEM_DOMAINS.has(n.domain)).length,
  }), [live])
  const filtered = useMemo(() => {
    if (segment === 'action') return live.filter(needsAction)
    if (segment === 'system') return live.filter((n) => SYSTEM_DOMAINS.has(n.domain))
    return live
  }, [live, segment])
  const shown = filtered.slice(0, limit)
  const grouped = useMemo(() => groupNotificationsByTime(shown), [shown])

  const handleOpen = useCallback((item: NotificationEvent) => {
    const href = resolveNotificationDestination(item)
    void Promise.resolve(patch(item.id, 'mark_read')).catch(() => undefined)
    if (!href) return
    onClose()
    pushRoutePath(href)
  }, [onClose, patch])

  const markAllRead = useCallback(async () => {
    const ids = filtered.filter((n) => n.status === 'unread').map((n) => n.id)
    if (ids.length) await patch(ids[0], 'bulk_mark_read', { ids })
  }, [filtered, patch])

  if (!open || typeof document === 'undefined') return null
  const segIndex = SEGMENTS.findIndex((s) => s.id === segment)
  let cardIndex = 0

  return createPortal(
    <>
      <button type="button" className="nx-ntf-scrim" aria-label="Close notifications" onClick={onClose} />
      <div ref={panelRef} className="nx-ntf" role="dialog" aria-label="Notifications">
        <span className="nx-ntf__liquid" aria-hidden="true"><i /><i /><i /></span>
        <header className="nx-ntf__head">
          <div className="nx-ntf__title">
            <strong>Notifications</strong>
            {unreadCount > 0 && <span className="nx-ntf__unread">{unreadCount > 99 ? '99+' : unreadCount} new</span>}
          </div>
          <button type="button" className="nx-ntf__icon-btn" aria-label="Mark all as read" disabled={!filtered.some((n) => n.status === 'unread')} onClick={() => void markAllRead()}>
            <Icon name="check-double" />
          </button>
        </header>

        <div className="nx-ntf__seg" role="tablist" aria-label="Filter">
          <span className="nx-ntf__glide" aria-hidden="true" style={{ ['--i' as string]: segIndex }} />
          {SEGMENTS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={segment === s.id} className={cls('nx-ntf__seg-btn', segment === s.id && 'is-on')} onClick={() => { setSegment(s.id); setLimit(PAGE) }}>
              {s.label}<b>{counts[s.id] > 99 ? '99+' : counts[s.id]}</b>
            </button>
          ))}
        </div>

        <div className="nx-ntf__body">
          <PushCard />
          {(['today', 'yesterday', 'earlier'] as NotificationTimeGroup[]).map((g) => {
            const items = grouped[g]
            if (!items.length) return null
            return (
              <section key={g} className="nx-ntf__group">
                <h3>{TIME_GROUP_LABEL[g]}</h3>
                {items.map((item) => (
                  <NotificationCard key={item.id} item={item} index={cardIndex++} onOpen={() => handleOpen(item)} onDismiss={() => void patch(item.id, 'dismiss')} />
                ))}
              </section>
            )
          })}
          {filtered.length > shown.length && (
            <button type="button" className="nx-ntf__more" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, filtered.length - shown.length)} more</button>
          )}
          {loading && filtered.length === 0 && <div className="nx-ntf__skel" aria-label="Loading"><i /><i /><i /></div>}
          {!loading && error && (
            <div className="nx-ntf__state">
              <span className="nx-ntf__state-orb is-bad" aria-hidden="true"><Icon name="alert" /></span>
              <strong>Notifications unavailable</strong>
              <span>{error}</span>
              <button type="button" onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="nx-ntf__state">
              <span className="nx-ntf__state-orb" aria-hidden="true"><Icon name="check" /></span>
              <strong>{segment === 'action' ? 'Nothing needs you' : segment === 'system' ? 'All systems quiet' : 'You’re all caught up'}</strong>
              <span>{segment === 'action' ? 'Critical and warning signals land here the moment they fire.' : 'Replies, campaigns, closings and platform health land here.'}</span>
            </div>
          )}
          {shown.length > 0 && <p className="nx-ntf__hint">Swipe left to clear · tap to open</p>}
        </div>
      </div>
    </>,
    document.body,
  )
}
