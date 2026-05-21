import type { CalendarScopeMode } from '../../../lib/data/calendarData'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarHeaderProps = {
  rangeLabel: string
  scopeMode: CalendarScopeMode
  selectedEnabled: boolean
  loading: boolean
  anchorDate: string
  railOpen: boolean
  showRailToggle: boolean
  onToday: () => void
  onPrev: () => void
  onNext: () => void
  onRefresh: () => void
  onDateChange: (value: string) => void
  onScopeChange: (value: CalendarScopeMode) => void
  onToggleRail: () => void
  liveLabel: string
}

export function CalendarHeader({
  rangeLabel,
  scopeMode,
  selectedEnabled,
  loading,
  anchorDate,
  railOpen,
  showRailToggle,
  onToday,
  onPrev,
  onNext,
  onRefresh,
  onDateChange,
  onScopeChange,
  onToggleRail,
  liveLabel,
}: CalendarHeaderProps) {
  return (
    <header className="calendar-command__header nx-cal__header">
      <div className="calendar-command__header-copy nx-cal__header-copy">
        <span className="calendar-command__eyebrow nx-cal__eyebrow">Execution Calendar</span>
        <div className="calendar-command__header-title-row nx-cal__header-title-row">
          <h2>Execution Timeline Command Center</h2>
          <span className="calendar-command__range-pill nx-cal__range-pill">{rangeLabel}</span>
        </div>
      </div>

      <div className="calendar-command__header-controls nx-cal__header-controls">
        <div className="calendar-command__scope-switch nx-cal__scope-switch">
          <button
            type="button"
            className={cls('calendar-command__chip-btn', 'nx-cal__chip-btn', scopeMode === 'global' && 'is-active')}
            onClick={() => onScopeChange('global')}
          >
            Global
          </button>
          <button
            type="button"
            className={cls('calendar-command__chip-btn', 'nx-cal__chip-btn', scopeMode === 'selected' && 'is-active')}
            onClick={() => onScopeChange('selected')}
            disabled={!selectedEnabled}
          >
            Selected Seller
          </button>
        </div>

        <div className="calendar-command__nav-group nx-cal__nav-group">
          <button type="button" className="calendar-command__nav-btn nx-cal__nav-btn" onClick={onToday}>Today</button>
          <button type="button" className="calendar-command__icon-btn nx-cal__icon-btn" onClick={onPrev} aria-label="Previous range">
            <span aria-hidden="true">‹</span>
          </button>
          <button type="button" className="calendar-command__icon-btn nx-cal__icon-btn" onClick={onNext} aria-label="Next range">
            <Icon name="chevron-right" />
          </button>
          <input
            className="calendar-command__date nx-cal__date"
            type="date"
            value={anchorDate}
            onChange={(event) => onDateChange(event.target.value)}
            aria-label="Calendar date"
          />
          <button type="button" className="calendar-command__nav-btn nx-cal__nav-btn" onClick={onRefresh}>
            <Icon name="refresh-cw" />
            <span>{loading ? 'Refreshing' : 'Refresh'}</span>
          </button>
          {showRailToggle ? (
            <button type="button" className={cls('calendar-command__nav-btn', 'nx-cal__nav-btn', railOpen && 'is-active')} onClick={onToggleRail}>
              <Icon name="layout-split" />
              <span>{railOpen ? 'Hide Rail' : 'Show Rail'}</span>
            </button>
          ) : null}
          <span className="calendar-command__live nx-cal__live">
            <span className="calendar-command__live-dot" aria-hidden="true" />
            {liveLabel}
          </span>
        </div>
      </div>
    </header>
  )
}
