import type { CalendarScopeMode, CalendarViewMode } from '../../lib/data/calendarData'
import type { CalendarTimezoneMode } from '../../lib/calendar/calendar-timezone'
import type { CalendarLayerId } from '../../lib/calendar/calendar-layers'
import { Icon } from '../../shared/icons'
import { CalendarDatePicker } from './components/CalendarDatePicker'
import { CalendarLayersPopover } from './components/CalendarLayersPopover'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export type CalendarRefreshState = 'live' | 'updating' | 'updated' | 'error'

const VIEW_MODES: Array<{ key: CalendarViewMode; label: string }> = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'day', label: 'Day' },
  { key: 'agenda', label: 'Agenda' },
  { key: 'timeline', label: 'Timeline' },
]

type CalendarCommandBarProps = {
  rangeLabel: string
  viewMode: CalendarViewMode
  scopeMode: CalendarScopeMode
  selectedEnabled: boolean
  refreshState: CalendarRefreshState
  anchorDate: string
  railOpen: boolean
  showRailToggle: boolean
  timezoneMode: CalendarTimezoneMode
  layers: CalendarLayerId[]
  visibleEventCount: number
  collapsed?: boolean
  onViewChange: (mode: CalendarViewMode) => void
  onToday: () => void
  onPrev: () => void
  onNext: () => void
  onRefresh: () => void
  onDateChange: (value: string) => void
  onScopeChange: (value: CalendarScopeMode) => void
  onToggleRail: () => void
  onTimezoneModeChange: (value: CalendarTimezoneMode) => void
  onNewEvent: () => void
  onLayersChange: (layers: CalendarLayerId[]) => void
  lastSyncedLabel: string
  errorMessage?: string | null
}

export function CalendarCommandBar({
  rangeLabel,
  viewMode,
  scopeMode,
  selectedEnabled,
  refreshState,
  anchorDate,
  railOpen,
  showRailToggle,
  timezoneMode,
  layers,
  visibleEventCount,
  collapsed = false,
  onViewChange,
  onToday,
  onPrev,
  onNext,
  onRefresh,
  onDateChange,
  onScopeChange,
  onToggleRail,
  onTimezoneModeChange,
  onNewEvent,
  onLayersChange,
  lastSyncedLabel,
  errorMessage,
}: CalendarCommandBarProps) {
  const liveLabel = (() => {
    if (refreshState === 'updating') return 'Updating'
    if (refreshState === 'error') return 'Error'
    if (refreshState === 'updated') return `Updated ${lastSyncedLabel}`
    return 'Live'
  })()

  return (
    <header className={cls('nx-cal__command-bar', collapsed && 'is-collapsed')}>
      <div className="nx-cal__command-left">
        <div className="nx-cal__command-brand" aria-hidden="true">
          <Icon name="calendar" />
        </div>
        <div className="nx-cal__command-copy">
          <strong>Execution Calendar</strong>
          <span>Automation, follow-ups, milestones, and transaction timing · {rangeLabel}</span>
        </div>
      </div>

      <nav className="nx-cal__command-views" aria-label="Calendar view mode">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode.key}
            type="button"
            className={cls('nx-cal__view-tab', viewMode === mode.key && 'is-active')}
            onClick={() => onViewChange(mode.key)}
          >
            {mode.label}
          </button>
        ))}
      </nav>

      <div className="nx-cal__command-right">
        <div className="nx-cal__command-nav">
          <button type="button" className="nx-cal__icon-btn" onClick={onPrev} aria-label="Previous range">
            <span aria-hidden="true">‹</span>
          </button>
          <button type="button" className="nx-cal__cmd-btn" onClick={onToday}>Today</button>
          <button type="button" className="nx-cal__icon-btn" onClick={onNext} aria-label="Next range">
            <Icon name="chevron-right" />
          </button>
        </div>

        <CalendarDatePicker value={anchorDate} onChange={onDateChange} />

        <select
          className="nx-cal__timezone-select"
          value={timezoneMode}
          onChange={(e) => onTimezoneModeChange(e.target.value as CalendarTimezoneMode)}
          aria-label="Timezone display mode"
        >
          <option value="operator">Operator</option>
          <option value="property">Property</option>
          <option value="recipient">Recipient</option>
        </select>

        <div className="nx-cal__scope-toggle">
          <button
            type="button"
            className={cls('nx-cal__cmd-btn nx-cal__cmd-btn--sm', scopeMode === 'global' && 'is-active')}
            onClick={() => onScopeChange('global')}
          >
            Global
          </button>
          <button
            type="button"
            className={cls('nx-cal__cmd-btn nx-cal__cmd-btn--sm', scopeMode === 'selected' && 'is-active')}
            onClick={() => onScopeChange('selected')}
            disabled={!selectedEnabled}
            title={!selectedEnabled ? 'Select a seller in global entity context' : undefined}
          >
            Selected Entity
          </button>
        </div>

        <CalendarLayersPopover layers={layers} visibleCount={visibleEventCount} onChange={onLayersChange} />

        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--accent" onClick={onNewEvent} aria-label="Add task">
          <Icon name="spark" />
          <span>Add Task</span>
        </button>

        <button
          type="button"
          data-testid="calendar-refresh"
          className={cls('nx-cal__icon-btn', refreshState === 'updating' && 'is-spinning')}
          onClick={onRefresh}
          aria-label={refreshState === 'error' ? 'Retry refresh' : 'Refresh calendar'}
        >
          <Icon name="refresh-cw" />
        </button>

        <span className={cls('nx-cal__live-pill', refreshState === 'error' && 'is-error', refreshState === 'updating' && 'is-updating', refreshState === 'updated' && 'is-updated')}>
          <span className="nx-cal__live-dot" aria-hidden="true" />
          {liveLabel}
        </span>

        {showRailToggle ? (
          <button type="button" className={cls('nx-cal__icon-btn', railOpen && 'is-active')} onClick={onToggleRail} aria-label="Toggle contextual rail">
            <Icon name="layout-split" />
          </button>
        ) : null}

        {errorMessage ? <span className="nx-cal__live-error" title={errorMessage}>!</span> : null}
      </div>
    </header>
  )
}