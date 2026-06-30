import { Icon } from '../../../../shared/icons'
import { resolveAssetTypeIcon } from '../../../../shared/asset-type-icons'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import {
  EVENT_ICON,
  eventTimestamp,
  formatHourSeparator,
  isLiveEvent,
  shouldShowTimeSeparator,
  type TimelineGroupBy,
} from '../../event-timeline-stats'
import {
  resolveMessageSource,
  resolveSellerIdentity,
  resolveStatusPresentation,
  resolveTemplateLabel,
} from '../../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '—' : s.length > max ? s.slice(0, max) + '…' : s

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

interface TimelineGroup {
  key: string
  label: string
  items: QueueItem[]
}

interface EventTimelineSpineProps {
  groups: TimelineGroup[]
  groupBy: TimelineGroupBy
  selectedEventId: string | null
  density: 'comfortable' | 'compact'
  onSelect: (item: QueueItem | null) => void
}

export function EventTimelineSpine({
  groups,
  groupBy,
  selectedEventId,
  density,
  onSelect,
}: EventTimelineSpineProps) {
  return (
    <div className={cls('occ-evt-spine', `is-density-${density}`)}>
      <div className="occ-evt-spine__rail" aria-hidden="true">
        <span className="occ-evt-spine__glow" />
      </div>

      {groups.map((group) => (
        <section key={group.key} className="occ-evt-spine__group">
          {group.label && (
            <header className="occ-evt-spine__group-label">
              <span className="occ-evt-spine__group-pill">{truncate(group.label, 48)}</span>
            </header>
          )}

          {group.items.map((item, idx) => {
            const statusView = resolveStatusPresentation(item)
            const identity = resolveSellerIdentity(item)
            const asset = resolveAssetTypeIcon(item.propertyType)
            const exactTime = eventTimestamp(item)
            const prev = idx > 0 ? eventTimestamp(group.items[idx - 1]) : null
            const showSep = shouldShowTimeSeparator(exactTime, prev, groupBy)
            const live = isLiveEvent(exactTime)
            const iconName = EVENT_ICON[item.status] ?? 'zap'
            const selected = selectedEventId === item.id

            return (
              <div key={item.id} className="occ-evt-spine__entry">
                {showSep && (
                  <div className="occ-evt-spine__sep">
                    <span className="occ-evt-spine__sep-pill">{formatHourSeparator(exactTime)}</span>
                  </div>
                )}

                <button
                  type="button"
                  className={cls(
                    'occ-evt-spine__node',
                    `is-${statusView.tone}`,
                    selected && 'is-selected',
                    live && 'is-live',
                  )}
                  onClick={() => onSelect(selected ? null : item)}
                  title={new Date(exactTime).toLocaleString()}
                >
                  <span className={cls('occ-evt-spine__dot', `is-${statusView.tone}`, live && 'is-pulse')} aria-hidden="true">
                    <Icon name={iconName as 'zap'} size={11} />
                  </span>

                  <div className="occ-evt-spine__card">
                    <div className="occ-evt-spine__card-atmo" aria-hidden="true" />
                    <div className="occ-evt-spine__card-top">
                      <div className="occ-evt-spine__identity">
                        <span className="occ-asset-icon" title={asset.label}><Icon name={asset.icon} size={10} /></span>
                        <strong>{truncate(identity.primary, 28)}</strong>
                        {identity.phoneEnding && <span className="occ-contact-badge">{identity.phoneEnding}</span>}
                      </div>
                      <div className="occ-evt-spine__time-wrap">
                        {live && <span className="occ-evt-live">Live</span>}
                        <span className="occ-evt-spine__time">{relTime(exactTime)}</span>
                      </div>
                    </div>

                    <div className="occ-evt-spine__status-row">
                      <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>{statusView.primary}</span>
                      <span className="occ-evt-spine__address">{truncate(item.propertyAddress, 36)}</span>
                    </div>

                    <div className="occ-evt-spine__meta">
                      <span>{truncate(item.market, 14)}</span>
                      {item.stageLabel && <span>· {truncate(item.stageLabel, 12)} T{item.touchNumber}</span>}
                      <span>· {truncate(resolveMessageSource(item), 14)}</span>
                      <span>· {truncate(resolveTemplateLabel(item), 14)}</span>
                      {item.fromPhoneNumber && <span>· …{item.fromPhoneNumber.slice(-4)}</span>}
                    </div>

                    <p className="occ-evt-spine__expl">
                      {statusView.hasCurrentException ? statusView.blocking : item.lastEventType || 'Queue event recorded'}
                    </p>
                  </div>
                </button>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}