import type { CSSProperties } from 'react'
import type { HourlyVelocityBucket, EventTimelineSummary } from '../../event-timeline-stats'
import { TIMELINE_TYPE_FILTERS, type TimelineGroupBy, type TimelineTypeFilter } from '../../event-timeline-stats'
import { EventTimelineFilterMenu } from './EventTimelineFilterMenu'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface KpiDef {
  key: string
  label: string
  value: string | number
  sub?: string
  tone?: string
}

const relLatest = (iso: string | null): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function buildCards(isMobileLayout: boolean, summary: EventTimelineSummary, rangeLabel: string): KpiDef[] {
  if (isMobileLayout) {
    return [
      { key: 'total', label: 'Events', value: summary.total, sub: rangeLabel },
      { key: 'live', label: 'Live', value: summary.last15m, tone: summary.last15m > 0 ? 'cyan' : 'muted' },
      { key: 'del', label: 'Delivered', value: summary.delivered, tone: 'green' },
      { key: 'fail', label: 'Failed', value: summary.failed, tone: summary.failed > 0 ? 'red' : 'muted' },
    ]
  }

  return [
    { key: 'total', label: 'Total Events', value: summary.total, sub: rangeLabel },
    { key: 'hour', label: 'Last Hour', value: summary.lastHour, tone: summary.lastHour > 0 ? 'blue' : 'muted' },
    { key: 'live', label: 'Live · 15m', value: summary.last15m, tone: summary.last15m > 0 ? 'cyan' : 'muted' },
    { key: 'delivered', label: 'Delivered', value: summary.delivered, tone: 'green' },
    { key: 'sent', label: 'Sent', value: summary.sent, sub: `${summary.delivered} confirmed` },
    { key: 'failed', label: 'Failed', value: summary.failed, tone: summary.failed > 0 ? 'red' : 'muted' },
    { key: 'blocked', label: 'Blocked', value: summary.blocked, tone: summary.blocked > 0 ? 'amber' : 'muted' },
    { key: 'workflow', label: 'Workflow', value: summary.workflow, tone: summary.workflow > 0 ? 'blue' : 'muted' },
    { key: 'receipts', label: 'Receipts', value: summary.receipts, tone: 'muted' },
    {
      key: 'latest',
      label: 'Latest',
      value: relLatest(summary.latestAt),
      sub: summary.peakHourLabel ? `Peak ${summary.peakHourLabel}` : undefined,
      tone: summary.last15m > 0 ? 'green' : 'muted',
    },
  ]
}

const GROUP_OPTIONS: Array<{ key: TimelineGroupBy; label: string }> = [
  { key: 'time', label: 'Time' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'seller', label: 'Seller' },
  { key: 'sender', label: 'Sender' },
  { key: 'market', label: 'Market' },
]

interface EventTimelineHeaderProps {
  summary: EventTimelineSummary
  velocity: HourlyVelocityBucket[]
  rangeLabel: string
  isMobileLayout?: boolean
  typeFilter: TimelineTypeFilter
  groupBy: TimelineGroupBy
  density: 'comfortable' | 'compact'
  onTypeFilter: (filter: TimelineTypeFilter) => void
  onGroupBy: (group: TimelineGroupBy) => void
  onDensityChange: (density: 'comfortable' | 'compact') => void
}

export function EventTimelineHeader({
  summary,
  velocity,
  rangeLabel,
  isMobileLayout = false,
  typeFilter,
  groupBy,
  density,
  onTypeFilter,
  onGroupBy,
  onDensityChange,
}: EventTimelineHeaderProps) {
  const cards = buildCards(isMobileLayout, summary, rangeLabel)
  const showVelocity = velocity.length > 0

  return (
    <header className={cls('occ-evt-intel-header', isMobileLayout && 'occ-evt-intel-header--mobile')}>
      <div className={cls('occ-evt-kpi-rail', isMobileLayout && 'occ-evt-kpi-rail--mobile')}>
        {cards.map((card) => (
          <div key={card.key} className={cls('occ-evt-kpi-card', card.tone && `is-${card.tone}`)}>
            <span className="occ-evt-kpi-card__label">{card.label}</span>
            <span className="occ-evt-kpi-card__value">{card.value}</span>
            {card.sub && <span className="occ-evt-kpi-card__sub">{card.sub}</span>}
          </div>
        ))}
      </div>

      {showVelocity && (
        <div
          className={cls('occ-evt-velocity', isMobileLayout && 'occ-evt-velocity--mobile')}
          aria-label={`Event velocity last ${velocity.length} hours`}
        >
          <div className="occ-evt-velocity__head">
            <span className="occ-evt-velocity__title">Velocity · {velocity.length}h</span>
            {summary.peakHourLabel && (
              <span className="occ-evt-velocity__peak">Peak {summary.peakHourLabel} · {summary.peakHourCount}</span>
            )}
          </div>
          <div
            className="occ-evt-velocity__track"
            style={{ '--occ-evt-buckets': velocity.length } as CSSProperties}
          >
            {velocity.map((b) => (
              <div
                key={b.key}
                className={cls('occ-evt-velocity__bar', `is-${b.tone}`)}
                style={{ '--occ-evt-bar-h': `${Math.max(12, (b.count / Math.max(summary.peakHourCount, 1)) * 100)}%` } as CSSProperties}
                title={`${b.label}: ${b.count} events`}
              >
                <span className="occ-evt-velocity__bar-fill" />
                <span className="occ-evt-velocity__bar-lbl">{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {isMobileLayout ? (
        <EventTimelineFilterMenu
          typeFilter={typeFilter}
          groupBy={groupBy}
          onTypeFilter={onTypeFilter}
          onGroupBy={onGroupBy}
        />
      ) : (
        <div className="occ-evt-toolbar occ-evt-liquid">
          <label className="occ-evt-filter-field">
            <span className="occ-evt-filter-field__lbl">Type</span>
            <select
              className="occ-evt-filter-select occ-evt-liquid-input"
              value={typeFilter}
              onChange={(e) => onTypeFilter(e.target.value as TimelineTypeFilter)}
              aria-label="Filter event type"
            >
              {TIMELINE_TYPE_FILTERS.map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
          </label>

          <label className="occ-evt-filter-field">
            <span className="occ-evt-filter-field__lbl">Group by</span>
            <select
              className="occ-evt-filter-select occ-evt-liquid-input"
              value={groupBy}
              onChange={(e) => onGroupBy(e.target.value as TimelineGroupBy)}
              aria-label="Group events"
            >
              {GROUP_OPTIONS.map((g) => (
                <option key={g.key} value={g.key}>{g.label}</option>
              ))}
            </select>
          </label>

          <label className="occ-evt-filter-field">
            <span className="occ-evt-filter-field__lbl">Density</span>
            <select
              className="occ-evt-filter-select occ-evt-liquid-input"
              value={density}
              onChange={(e) => onDensityChange(e.target.value as 'comfortable' | 'compact')}
              aria-label="Timeline density"
            >
              <option value="compact">Compact</option>
              <option value="comfortable">Comfort</option>
            </select>
          </label>
        </div>
      )}
    </header>
  )
}