import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import {
  buildEventTimelineItems,
  buildHourlyVelocity,
  eventTimestamp,
  EVENT_ICON,
  isLiveEvent,
  matchesTimelineFilter,
  summarizeEventTimeline,
  TIMELINE_TYPE_FILTERS,
  type TimelineTypeFilter,
} from '../../event-timeline-stats'
import { resolveSellerIdentity, resolveStatusPresentation } from '../../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '' : s.length > max ? `${s.slice(0, max)}…` : s

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** Filters an operator actually reaches for on a phone. */
const QUICK_FILTERS: TimelineTypeFilter[] = ['all', 'failed', 'blocked', 'delivered', 'sent', 'sending', 'retry']

interface EventsMobileFeedProps {
  items: QueueItem[]
  loading?: boolean
  rangeLabel: string
  selectedEventId: string | null
  onSelectEvent: (item: QueueItem | null) => void
}

/**
 * Feed-first Events. Counts are one line, the chart is behind Activity, and
 * the first event row is immediately reachable.
 */
export function EventsMobileFeed({
  items,
  loading = false,
  rangeLabel,
  selectedEventId,
  onSelectEvent,
}: EventsMobileFeedProps) {
  const [typeFilter, setTypeFilter] = useState<TimelineTypeFilter>('all')
  const [activityOpen, setActivityOpen] = useState(false)

  const all = useMemo(() => buildEventTimelineItems(items), [items])
  const feed = useMemo(() => all.filter((i) => matchesTimelineFilter(i, typeFilter)), [all, typeFilter])
  const summary = useMemo(() => summarizeEventTimeline(feed), [feed])
  const velocity = useMemo(() => (activityOpen ? buildHourlyVelocity(feed, 8) : []), [feed, activityOpen])

  return (
    <div className="qm-events">
      <header className="qm-events__head">
        {/* `Live` is genuinely the 15-minute window from summarizeEventTimeline —
            the window is named so it can never be read as a range total. */}
        <p className="qm-events__counts">
          <span className={cls('is-cyan', summary.last15m > 0 && 'has-value')} title="Events in the last 15 minutes">
            Live 15m {summary.last15m}
          </span>
          <em>·</em>
          <span className={cls('is-red', summary.failed > 0 && 'has-value')}>Failed {summary.failed}</span>
          <em>·</em>
          <span className="is-green">Delivered {summary.delivered}</span>
        </p>
        <p className="qm-failures__scope">
          {summary.total.toLocaleString()} event{summary.total === 1 ? '' : 's'} · {rangeLabel}
        </p>
      </header>

      <div className="qm-events__bar" role="tablist" aria-label="Filter events">
        {QUICK_FILTERS.map((key) => {
          const def = TIMELINE_TYPE_FILTERS.find((f) => f.key === key)
          if (!def) return null
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={typeFilter === key}
              className={cls('qm-chip', typeFilter === key && 'is-active')}
              onClick={() => setTypeFilter(key)}
            >
              {def.label}
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="qm-empty">Loading event stream…</div>
      ) : feed.length === 0 ? (
        <div className="qm-empty">No events for this filter in the last {rangeLabel}.</div>
      ) : (
        <div className="qm-events__feed">
          {feed.map((item) => {
            const statusView = resolveStatusPresentation(item)
            const identity = resolveSellerIdentity(item)
            const ts = eventTimestamp(item)
            const live = isLiveEvent(ts)
            const market = truncate(item.market?.replace(/,\s*[A-Z]{2}$/, ''), 18)
            return (
              <article
                key={item.id}
                className={cls('qm-evtrow', `is-${statusView.tone}`, selectedEventId === item.id && 'is-open', live && 'is-live')}
                role="button"
                tabIndex={0}
                aria-pressed={selectedEventId === item.id}
                onClick={() => onSelectEvent(item)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectEvent(item) } }}
              >
                <span className={cls('qm-evtrow__dot', `is-${statusView.tone}`)} aria-hidden="true">
                  <Icon name={(EVENT_ICON[item.status] ?? 'zap') as 'zap'} size={10} />
                </span>
                <div className="qm-evtrow__copy">
                  <div className="qm-evtrow__lead">
                    <strong>{truncate(identity.primary, 26)}</strong>
                    <span className="qm-evtrow__time">{relTime(ts)}</span>
                  </div>
                  <p className="qm-evtrow__place">{truncate(item.propertyAddress, 38) || 'No property linked'}</p>
                  <p className="qm-evtrow__meta">
                    <span className={`is-${statusView.tone}`}>{statusView.primary}</span>
                    {market && <>{' · '}{market}</>}
                  </p>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {feed.length > 0 && (
        <div className="qm-events__activity">
          <button
            type="button"
            className="qm-events__activity-toggle"
            aria-expanded={activityOpen}
            onClick={() => setActivityOpen((v) => !v)}
          >
            <span>Activity · last 8h</span>
            <Icon name={activityOpen ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          {activityOpen && velocity.length > 0 && (
            <div className="qm-velocity">
              {velocity.map((b) => (
                <div
                  key={b.key}
                  className={cls('qm-velocity__bar', `is-${b.tone}`)}
                  style={{ ['--qm-bar' as string]: `${Math.max(8, (b.count / Math.max(summary.peakHourCount, 1)) * 100)}%` }}
                  title={`${b.label}: ${b.count} events`}
                >
                  <span />
                  <em>{b.label}</em>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
