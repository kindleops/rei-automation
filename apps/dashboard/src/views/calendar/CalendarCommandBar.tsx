import type { CalendarScopeMode, CalendarViewMode } from '../../lib/data/calendarData'
import type { CalendarTimezoneMode } from '../../lib/calendar/calendar-timezone'
import type { CalendarLayerId } from '../../lib/calendar/calendar-layers'
import { Icon } from '../../shared/icons'
import { CalendarDatePicker } from './components/CalendarDatePicker'
import { CalendarLayersPopover } from './components/CalendarLayersPopover'
import { CalendarCommandOverflow } from './components/CalendarCommandOverflow'

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
  lastSyncedLabel: _lastSyncedLabel,
  errorMessage,
}: CalendarCommandBarProps) {
  const statusLabel = (() => {
    if (refreshState === 'updating') return 'Updating'
    if (refreshState === 'error') return 'Error — retry'
    if (refreshState === 'updated') return 'Updated just now'
    return 'Live'
  })()

  return (
    <header className={cls('nx-cal__command-bar', collapsed && 'is-collapsed')}>
      <div className="nx-cal__command-priority">
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

        <div className="nx-cal__command-nav">
          <button type="button" className="nx-cal__icon-btn" onClick={onPrev} aria-label="Previous range">
            <span aria-hidden="true">‹</span>
          </button>
          <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--today" onClick={onToday}>Today</button>
          <button type="button" className="nx-cal__icon-btn" onClick={onNext} aria-label="Next range">
            <Icon name="chevron-right" />
          </button>
        </div>

        <CalendarDatePicker value={anchorDate} onChange={onDateChange} />
      </div>

      <div className="nx-cal__command-secondary">
        <select
          className="nx-cal__timezone-select nx-cal__cmd-desktop-only"
          value={timezoneMode}
          onChange={(e) => onTimezoneModeChange(e.target.value as CalendarTimezoneMode)}
          aria-label="Timezone display mode"
        >
          <option value="operator">Operator</option>
          <option value="property">Property</option>
          <option value="recipient">Recipient</option>
        </select>

        <div className="nx-cal__scope-toggle nx-cal__cmd-desktop-only">
          <button
            type="button"
            className={cls('nx-cal__cmd-btn nx-cal__cmd-btn--sm', scopeMode === 'global' && 'is-active')}
            onClick={() => onScopeChange('global')}
          >
            Global
          </button>
          <button
            type="button"
            className={cls('nx-cal__cmd-btn nx-cal__cmd-btn--sm nx-cal__scope-entity', scopeMode === 'selected' && 'is-active')}
            onClick={() => onScopeChange('selected')}
            disabled={!selectedEnabled}
            title={!selectedEnabled ? 'Select an entity in universal context' : 'Selected Entity scope'}
          >
            <Icon name="user" />
            <span className="nx-cal__scope-entity-label">Selected Entity</span>
          </button>
        </div>

        <div className="nx-cal__cmd-desktop-only">
          <CalendarLayersPopover layers={layers} visibleCount={visibleEventCount} onChange={onLayersChange} />
        </div>

        <button type="button" className="nx-cal__cmd-btn nx-cal__cmd-btn--accent nx-cal__cmd-add" onClick={onNewEvent} aria-label="Add task">
          <span className="nx-cal__cmd-add-icon" aria-hidden="true">+</span>
          <span className="nx-cal__cmd-add-label">Add Task</span>
        </button>

        <button
          type="button"
          data-testid="calendar-refresh"
          className="nx-cal__icon-btn nx-cal__cmd-refresh"
          onClick={onRefresh}
          aria-label={refreshState === 'error' ? 'Retry refresh' : 'Refresh calendar'}
          title={statusLabel}
        >
          <Icon name="refresh-cw" />
        </button>

        <span
          className={cls(
            'nx-cal__live-pill',
            refreshState === 'error' && 'is-error',
            refreshState === 'updating' && 'is-updating',
            refreshState === 'updated' && 'is-updated',
          )}
          title={errorMessage || statusLabel}
        >
          <span className="nx-cal__live-dot" aria-hidden="true" />
          <span className="nx-cal__live-label">{statusLabel}</span>
        </span>

        {showRailToggle ? (
          <button type="button" className={cls('nx-cal__icon-btn nx-cal__cmd-desktop-only', railOpen && 'is-active')} onClick={onToggleRail} aria-label="Toggle contextual rail">
            <Icon name="layout-split" />
          </button>
        ) : null}

        <CalendarCommandOverflow
          scopeMode={scopeMode}
          selectedEnabled={selectedEnabled}
          timezoneMode={timezoneMode}
          layers={layers}
          visibleEventCount={visibleEventCount}
          railOpen={railOpen}
          showRailToggle={showRailToggle}
          onScopeChange={onScopeChange}
          onTimezoneModeChange={onTimezoneModeChange}
          onLayersChange={onLayersChange}
          onToggleRail={onToggleRail}
        />
      </div>

      <div className="nx-cal__command-meta nx-cal__cmd-desktop-only" aria-hidden="true">
        <strong>Execution Calendar</strong>
        <span>{rangeLabel}</span>
      </div>
    </header>
  )
}