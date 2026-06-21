import { useEffect, useRef, useState } from 'react'
import { buildMonthGrid, formatMonthLabel, toIsoDate, type WeekStart } from '../../../lib/calendar/calendar-date-engine'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarDatePickerProps = {
  value: string
  onChange: (value: string) => void
  weekStart?: WeekStart
}

export function CalendarDatePicker({ value, onChange, weekStart = 0 }: CalendarDatePickerProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState(() => new Date(value || Date.now()))
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const grid = buildMonthGrid(anchor, { weekStart, selected: new Date(value) })
  const headers = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const orderedHeaders = [...headers.slice(weekStart), ...headers.slice(0, weekStart)]

  return (
    <div className="nx-cal__date-picker" ref={rootRef}>
      <button
        type="button"
        className="nx-cal__date-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {value || 'Select date'}
      </button>
      {open ? (
        <div className="nx-cal__date-picker-popover" role="dialog" aria-label="Choose date">
          <div className="nx-cal__date-picker-head">
            <button type="button" onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
            <strong>{formatMonthLabel(anchor)}</strong>
            <button type="button" onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))} aria-label="Next month">›</button>
          </div>
          <div className="nx-cal__date-picker-weekdays">
            {orderedHeaders.map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="nx-cal__date-picker-grid">
            {grid.map((cell) => (
              <button
                key={cell.iso}
                type="button"
                className={cls(
                  'nx-cal__date-picker-day',
                  !cell.inMonth && 'is-outside',
                  cell.isToday && 'is-today',
                  cell.isSelected && 'is-selected',
                )}
                onClick={() => {
                  onChange(cell.iso)
                  setOpen(false)
                }}
              >
                {cell.date.getDate()}
              </button>
            ))}
          </div>
          <div className="nx-cal__date-picker-actions">
            <button type="button" onClick={() => { onChange(toIsoDate(new Date())); setOpen(false) }}>Today</button>
            <button type="button" onClick={() => { onChange(''); setOpen(false) }}>Clear</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}