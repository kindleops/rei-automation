import type { CalendarScopeMode } from '../../lib/data/calendarData'
import type { CalendarTimezoneMode } from '../../lib/calendar/calendar-timezone'
import { Icon } from '../../shared/icons'
import { CalendarDatePicker } from './components/CalendarDatePicker'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export type CalendarRefreshState = 'live' | 'updating' | 'updated' | 'error'

type CalendarHeaderProps = {
  rangeLabel: string
  scopeMode: CalendarScopeMode
  selectedEnabled: boolean
  refreshState: CalendarRefreshState
  anchorDate: string
  railOpen: boolean
  showRailToggle: boolean
  timezoneMode: CalendarTimezoneMode
  onToday: () => void
  onPrev: () => void
  onNext: () => void
  onRefresh: () => void
  onDateChange: (value: string) => void
  onScopeChange: (value: CalendarScopeMode) => void
  onToggleRail: () => void
  onTimezoneModeChange: (value: CalendarTimezoneMode) => void
  onNewEvent: () => void
  lastSyncedLabel: string
  errorMessage?: string | null
}

export function CalendarHeader({
  rangeLabel,
  scopeMode,
  selectedEnabled,
  refreshState,
  anchorDate,
  railOpen,
  showRailToggle,
  timezoneMode,
  onToday,
  onPrev,
  onNext,
  onRefresh,
  onDateChange,
  onScopeChange,
  onToggleRail,
  onTimezoneModeChange,
  onNewEvent,
  lastSyncedLabel,
  errorMessage,
}: CalendarHeaderProps) {
  const liveLabel = (() => {
    if (refreshState === 'updating') return 'Updating'
    if (refreshState === 'error') return 'Error'
    if (refreshState === 'updated') return `Updated ${lastSyncedLabel}`
    return 'Live'
  })()

  return (
    <header className="calendar-command__header nx-cal__header">
      <div className="calendar-command__header-copy nx-cal__header-copy">
        <span className="calendar-command__eyebrow nx-cal__eyebrow">Execution Calendar</span>
        <div className="calendar-command__header-title-row nx-cal__header-title-row">
          <h2>Temporal Command Center</h2>
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
            title={!selectedEnabled ? 'Select a seller in global entity context to enable' : undefined}
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
          <CalendarDatePicker value={anchorDate} onChange={onDateChange} />
          <select
            className="nx-cal__timezone-select"
            value={timezoneMode}
            onChange={(e) => onTimezoneModeChange(e.target.value as CalendarTimezoneMode)}
            aria-label="Timezone display mode"
          >
            <option value="operator">Operator Time</option>
            <option value="property">Property Local Time</option>
            <option value="recipient">Recipient Local Time</option>
          </select>
          <button type="button" className="calendar-command__nav-btn nx-cal__nav-btn" onClick={onNewEvent}>New Event</button>
          <button type="button" className="calendar-command__nav-btn nx-cal__nav-btn" onClick={onRefresh} disabled={refreshState === 'updating'}>
            <Icon name="refresh-cw" />
            <span>{refreshState === 'updating' ? 'Updating' : refreshState === 'error' ? 'Retry' : 'Refresh'}</span>
          </button>
          {showRailToggle ? (
            <button type="button" className={cls('calendar-command__nav-btn', 'nx-cal__nav-btn', railOpen && 'is-active')} onClick={onToggleRail}>
              <Icon name="layout-split" />
              <span>{railOpen ? 'Hide Rail' : 'Show Rail'}</span>
            </button>
          ) : null}
          <span className={cls('calendar-command__live', 'nx-cal__live', refreshState === 'error' && 'is-error', refreshState === 'updating' && 'is-updating')}>
            <span className="calendar-command__live-dot" aria-hidden="true" />
            {liveLabel}
          </span>
          {errorMessage ? <span className="nx-cal__live-error">{errorMessage}</span> : null}
        </div>
      </div>
    </header>
  )
}