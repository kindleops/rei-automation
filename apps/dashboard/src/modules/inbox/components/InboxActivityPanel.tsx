import { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { formatRelativeTime } from '../../../shared/formatters'
import { fetchInboxActivity, undoInboxActivity, type InboxActivityEvent, type ActivityEventType } from '../../../lib/data/inboxActivityData'
import { useBreakpoint } from '../../mobile/useBreakpoint'
import { MobileSheet } from '../../mobile/MobileSheet'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type ActivityCategory = 'All' | 'Queue' | 'SMS' | 'AI' | 'Map' | 'Offers' | 'Buyers' | 'Errors' | 'Automation'

const CATEGORIES: ActivityCategory[] = ['All', 'Queue', 'SMS', 'AI', 'Map', 'Offers', 'Buyers', 'Errors', 'Automation']

const categoryOf = (type: ActivityEventType): ActivityCategory => {
  if (type === 'message_sent' || type === 'message_received' || type === 'message_failed') return 'SMS'
  if (type === 'ai_copilot_interaction') return 'AI'
  if (type === 'stage_change' || type === 'archive_thread' || type === 'unarchive_thread') return 'Queue'
  if (type === 'note_added') return 'Automation'
  return 'Queue'
}

type Severity = 'info' | 'success' | 'warning' | 'critical' | 'neutral'

const severityOf = (type: ActivityEventType): Severity => {
  if (type === 'message_failed') return 'critical'
  if (type === 'message_sent') return 'success'
  if (type === 'ai_copilot_interaction') return 'info'
  return 'neutral'
}

const iconOf = (type: ActivityEventType): string => {
  switch (type) {
    case 'stage_change': return 'trending-up'
    case 'archive_thread': return 'archive'
    case 'unarchive_thread': return 'archive'
    case 'star_thread': return 'star'
    case 'unstar_thread': return 'star'
    case 'pin_thread': return 'pin'
    case 'unpin_thread': return 'pin'
    case 'message_sent': return 'send'
    case 'message_received': return 'message'
    case 'message_failed': return 'alert'
    case 'note_added': return 'activity'
    case 'ai_copilot_interaction': return 'shield'
    default: return 'activity'
  }
}

const sourceLabelOf = (type: ActivityEventType): string => {
  const cat = categoryOf(type)
  if (cat === 'SMS') return 'SMS'
  if (cat === 'AI') return 'AI ENGINE'
  if (cat === 'Automation') return 'AUTOMATION'
  return 'QUEUE'
}

export const InboxActivityPanel = ({
  threadKey,
  onClose,
  onViewThread,
}: {
  threadKey?: string
  onClose: () => void
  onViewThread?: (threadKey: string) => void
}) => {
  const { isMobile } = useBreakpoint()
  const [activities, setActivities] = useState<InboxActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<ActivityCategory>('All')

  const refresh = useCallback(async () => {
    setLoading(true)
    const data = await fetchInboxActivity(threadKey)
    setActivities(data)
    setLoading(false)
  }, [threadKey])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 30_000)
    return () => window.clearInterval(interval)
  }, [refresh])

  const handleUndo = useCallback(async (id: string) => {
    const result = await undoInboxActivity(id)
    if (result.ok) void refresh()
  }, [refresh])

  const filtered = useMemo(() => activities.filter((item) => {
    if (activeCategory === 'All') return true
    if (activeCategory === 'Errors') return severityOf(item.event_type) === 'critical'
    return categoryOf(item.event_type) === activeCategory
  }), [activities, activeCategory])

  const sheetHeight = !loading && filtered.length === 0 ? 'compact' : filtered.length > 8 ? 'full' : 'half'

  const body = (
    <>
      <div className="lac-filters lac-filter-rail" role="tablist" aria-label="Activity categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            role="tab"
            aria-selected={activeCategory === cat}
            className={cls('lac-chip', activeCategory === cat && 'is-active')}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveCategory(cat) }}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="lac-list">
        {loading && <p className="lac-empty">Loading activity…</p>}

        {!loading && filtered.length === 0 && (
          <div className="lac-empty-state">
            <span className="lac-empty-state__icon">◎</span>
            <p className="lac-empty-state__text">
              No live activity in this view yet. Queue sends, replies, AI decisions, and automation logs appear here in realtime.
            </p>
          </div>
        )}

        {!loading && filtered.map((item) => {
          const severity = severityOf(item.event_type)
          const icon = iconOf(item.event_type)
          const source = sourceLabelOf(item.event_type)
          return (
            <article key={item.id} className={cls('lac-row', `is-${severity}`)}>
              <div className={cls('lac-row__icon', `is-${severity}`)}>
                <Icon name={icon as any} />
              </div>
              <div className="lac-row__main">
                <div className="lac-row__top">
                  <span className="lac-row__source">{source}</span>
                  <strong className="lac-row__title">{item.title}</strong>
                  <time className="lac-row__time">{formatRelativeTime(item.created_at)}</time>
                </div>
                {item.description ? <p className="lac-row__detail">{item.description}</p> : null}
                <div className="lac-row__footer">
                  <span className="lac-row__actor">{item.actor}</span>
                  <div className="lac-row__actions">
                    {item.undo_payload ? (
                      <button type="button" className="lac-action-btn" onClick={() => void handleUndo(item.id)}>Undo</button>
                    ) : null}
                    {onViewThread ? (
                      <button type="button" className="lac-action-btn" onClick={() => onViewThread(item.thread_key)}>View</button>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </>
  )

  if (isMobile) {
    return (
      <MobileSheet
        open
        title="Live Activity"
        subtitle="Realtime operational heartbeat"
        height={sheetHeight}
        onClose={onClose}
      >
        <div className="nx-activity-panel nx-activity-panel--sheet">{body}</div>
      </MobileSheet>
    )
  }

  const panel = (
    <aside className="nx-activity-panel nx-liquid-panel" aria-label="Live activity log">
      <header className="lac-header">
        <div className="lac-header__identity">
          <span className="lac-header__eyebrow">COMMAND SPACE</span>
          <strong className="lac-header__title">Live Activity</strong>
          <p className="lac-header__subtitle">
            System heartbeat across queue, inbox, AI, map, offers, buyers, and automation.
          </p>
        </div>
        <button type="button" className="lac-close" onClick={onClose} aria-label="Close activity log">
          <Icon name="close" />
        </button>
      </header>
      {body}
      <footer className="lac-footer">
        <span>Press <kbd>⌘K</kbd> to act on activity</span>
      </footer>
    </aside>
  )

  return typeof document !== 'undefined' ? createPortal(panel, document.body) : null
}