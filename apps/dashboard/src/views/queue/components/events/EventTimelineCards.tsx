import type { CSSProperties } from 'react'
import { Icon } from '../../../../shared/icons'
import { resolveAssetTypeIcon } from '../../../../shared/asset-type-icons'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import {
  EVENT_ICON,
  eventTimestamp,
  formatHourSeparator,
  isLiveEvent,
  shouldShowTimeSeparator,
  type TimelineGroup,
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

const STATUS_ACCENT: Record<string, string> = {
  green: '#3ecf8e',
  red: '#f87171',
  amber: '#f59e0b',
  blue: '#3b82f6',
  cyan: '#22d3ee',
  muted: '#64748b',
}

interface MetricChipProps {
  label: string
  value: string
  tone?: string
}

function MetricChip({ label, value, tone }: MetricChipProps) {
  return (
    <div className={cls('occ-evt-tchip', tone && `is-${tone}`)}>
      <span className="occ-evt-tchip__lbl">{label}</span>
      <strong className="occ-evt-tchip__val">{value}</strong>
    </div>
  )
}

interface EventTimelineCardsProps {
  groups: TimelineGroup[]
  groupBy: TimelineGroupBy
  selectedEventId: string | null
  onSelect: (item: QueueItem | null) => void
  isMobileLayout?: boolean
}

function MobileEventCard({
  item,
  selected,
  onSelect,
}: {
  item: QueueItem
  selected: boolean
  onSelect: (item: QueueItem | null) => void
}) {
  const statusView = resolveStatusPresentation(item)
  const identity = resolveSellerIdentity(item)
  const exactTime = eventTimestamp(item)
  const live = isLiveEvent(exactTime)
  const accent = STATUS_ACCENT[statusView.tone] ?? STATUS_ACCENT.muted
  const iconName = EVENT_ICON[item.status] ?? 'zap'
  const market = truncate(item.market?.replace(/, [A-Z]{2}$/, ''), 18)
  const address = truncate(item.propertyAddress, 40) || 'No property linked'
  const meta = [
    statusView.primary,
    market !== '—' ? market : null,
    `T${item.touchNumber}`,
    live ? 'Live' : null,
  ].filter(Boolean).join(' · ')

  return (
    <article
      className={cls('occ-evt-card', 'occ-evt-card--mobile', `is-${statusView.tone}`, selected && 'is-selected', live && 'is-live')}
      onClick={() => onSelect(selected ? null : item)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected ? null : item) } }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      style={{ '--occ-evt-accent': accent } as CSSProperties}
    >
      <span className="occ-evt-card__accent" aria-hidden="true" />
      <div className="occ-evt-card__shell">
        <div className="occ-evt-mcard__row">
          <span className={cls('occ-evt-mcard__dot', `is-${statusView.tone}`)} aria-hidden="true">
            <Icon name={iconName as 'zap'} size={10} />
          </span>
          <div className="occ-evt-mcard__copy">
            <div className="occ-evt-mcard__title">
              <strong>{truncate(identity.primary, 28)}</strong>
              {identity.phoneEnding && !identity.primary.startsWith('+') && (
                <span className="occ-evt-mcard__phone">{identity.phoneEnding}</span>
              )}
            </div>
            <p className="occ-evt-mcard__address">{address}</p>
            <p className="occ-evt-mcard__meta">{meta}</p>
          </div>
          <div className="occ-evt-mcard__trail">
            <span className="occ-evt-mcard__time">{relTime(exactTime)}</span>
            <Icon name="chevron-right" size={14} />
          </div>
        </div>
      </div>
    </article>
  )
}

function DesktopEventCard({
  item,
  selected,
  onSelect,
}: {
  item: QueueItem
  selected: boolean
  onSelect: (item: QueueItem | null) => void
}) {
  const statusView = resolveStatusPresentation(item)
  const identity = resolveSellerIdentity(item)
  const asset = resolveAssetTypeIcon(item.propertyType)
  const exactTime = eventTimestamp(item)
  const live = isLiveEvent(exactTime)
  const accent = STATUS_ACCENT[statusView.tone] ?? STATUS_ACCENT.muted
  const iconName = EVENT_ICON[item.status] ?? 'zap'
  const expl = statusView.hasCurrentException
    ? statusView.blocking
    : item.lastEventType || 'Queue event recorded'

  return (
    <article
      className={cls('occ-evt-card', `is-${statusView.tone}`, selected && 'is-selected', live && 'is-live')}
      onClick={() => onSelect(selected ? null : item)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected ? null : item) } }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      style={{ '--occ-evt-accent': accent } as CSSProperties}
    >
      <span className="occ-evt-card__accent" aria-hidden="true" />
      <div className="occ-evt-card__shell">
        <div className="occ-evt-card__atmo" aria-hidden="true" />

        <header className="occ-evt-card__top">
          <div className={cls('occ-evt-card__icon', `is-${statusView.tone}`)}>
            <Icon name={iconName as 'zap'} size={12} />
          </div>
          <div className="occ-evt-card__signals">
            <span className={cls('occ-evt-status', `is-${statusView.tone}`)}>{statusView.primary}</span>
            {live && <span className="occ-evt-live">Live</span>}
          </div>
          <span className="occ-evt-card__time">{relTime(exactTime)}</span>
        </header>

        <div className="occ-evt-card__identity">
          <span className="occ-asset-icon" title={asset.label}><Icon name={asset.icon} size={10} /></span>
          <strong>{truncate(identity.primary, 22)}</strong>
          {identity.phoneEnding && <span className="occ-contact-badge">{identity.phoneEnding}</span>}
        </div>

        <p className="occ-evt-card__address">{truncate(item.propertyAddress, 42)}</p>
        <p className="occ-evt-card__expl">{expl}</p>

        <div className="occ-evt-card__telemetry">
          <div className="occ-evt-card__telemetry-track" role="list">
            <MetricChip label="Market" value={truncate(item.market, 12)} />
            <MetricChip label="Stage" value={truncate(item.stageLabel ?? item.stage, 10)} tone="cyan" />
            <MetricChip label="Touch" value={`T${item.touchNumber}`} tone="muted" />
            <MetricChip label="Source" value={truncate(resolveMessageSource(item), 12)} />
            <MetricChip label="Tpl" value={truncate(resolveTemplateLabel(item), 12)} />
            {item.fromPhoneNumber && <MetricChip label="Sender" value={`…${item.fromPhoneNumber.slice(-4)}`} tone="muted" />}
            {item.campaignName && <MetricChip label="Camp" value={truncate(item.campaignName, 10)} tone="blue" />}
          </div>
        </div>

        <footer className="occ-evt-card__foot">
          <span className="occ-evt-card__foot-meta">{truncate(resolveTemplateLabel(item), 28)}</span>
          <span className="occ-evt-card__foot-cta">
            Inspect
            <Icon name="chevron-right" size={12} />
          </span>
        </footer>
      </div>
    </article>
  )
}

export function EventTimelineCards({
  groups,
  groupBy,
  selectedEventId,
  onSelect,
  isMobileLayout = false,
}: EventTimelineCardsProps) {
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  if (total === 0) {
    return <div className="occ-module-empty">No events match this filter.</div>
  }

  if (!isMobileLayout) {
    const flat = groups.flatMap((g) => g.items)
    return (
      <div className="occ-evt-card-list">
        {flat.map((item) => (
          <DesktopEventCard
            key={item.id}
            item={item}
            selected={selectedEventId === item.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="occ-evt-card-list occ-evt-card-list--mobile">
      {groups.map((group, groupIdx) => (
        <section
          key={group.key}
          className={cls('occ-evt-mgroup', group.label && 'has-label', groupIdx > 0 && 'has-gap')}
        >
          {group.label && (
            <header className="occ-evt-mgroup__head">
              <span className="occ-evt-mgroup__rule" aria-hidden="true" />
              <span className="occ-evt-mgroup__pill">
                {truncate(group.label, 36)}
                <span className="occ-evt-mgroup__count">{group.items.length}</span>
              </span>
              <span className="occ-evt-mgroup__rule" aria-hidden="true" />
            </header>
          )}

          <div className="occ-evt-mgroup__cards">
            {group.items.map((item, idx) => {
              const exactTime = eventTimestamp(item)
              const prev = idx > 0 ? eventTimestamp(group.items[idx - 1]) : null
              const showSep = shouldShowTimeSeparator(exactTime, prev, groupBy)

              return (
                <div key={item.id} className="occ-evt-mgroup__entry">
                  {showSep && (
                    <div className="occ-evt-mgroup__sep">
                      <span className="occ-evt-mgroup__sep-pill">{formatHourSeparator(exactTime)}</span>
                    </div>
                  )}
                  <MobileEventCard
                    item={item}
                    selected={selectedEventId === item.id}
                    onSelect={onSelect}
                  />
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}