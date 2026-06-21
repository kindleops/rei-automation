import type { CalendarViewMode } from '../../lib/data/calendarData'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarModeTabsProps = {
  value: CalendarViewMode
  onChange: (value: CalendarViewMode) => void
}

const MODE_OPTIONS: Array<{ key: CalendarViewMode; label: string }> = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'day', label: 'Day' },
  { key: 'agenda', label: 'Agenda' },
  { key: 'timeline', label: 'Timeline' },
]

export function CalendarModeTabs({ value, onChange }: CalendarModeTabsProps) {
  return (
    <div className="calendar-command__tabs nx-cal__mode-tabs">
      {MODE_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          className={cls('calendar-command__tab', 'nx-cal__tab', value === option.key && 'is-active')}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}