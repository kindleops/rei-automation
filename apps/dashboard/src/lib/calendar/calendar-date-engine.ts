export type WeekStart = 0 | 1 | 6

export type CalendarDayCell = {
  date: Date
  iso: string
  inMonth: boolean
  isToday: boolean
  isSelected: boolean
}

const pad = (n: number) => `${n}`.padStart(2, '0')

export const toIsoDate = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`

export const startOfDay = (value: Date) => {
  const next = new Date(value)
  next.setHours(0, 0, 0, 0)
  return next
}

export const endOfDay = (value: Date) => {
  const next = new Date(value)
  next.setHours(23, 59, 59, 999)
  return next
}

export const addDays = (value: Date, amount: number) => {
  const next = new Date(value)
  next.setDate(next.getDate() + amount)
  return next
}

export const addMonths = (value: Date, amount: number) => {
  const next = new Date(value)
  next.setMonth(next.getMonth() + amount)
  return next
}

export const isSameDay = (a: Date, b: Date) => toIsoDate(a) === toIsoDate(b)

export const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate()

export const weekdayHeaders = (weekStart: WeekStart = 0) => {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return [...labels.slice(weekStart), ...labels.slice(0, weekStart)]
}

export function buildMonthGrid(anchor: Date, opts: { weekStart?: WeekStart; selected?: Date | null } = {}): CalendarDayCell[] {
  const weekStart = opts.weekStart ?? 0
  const selected = opts.selected ? startOfDay(opts.selected) : null
  const today = startOfDay(new Date())
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstOfMonth = new Date(year, month, 1)
  const startOffset = (firstOfMonth.getDay() - weekStart + 7) % 7
  const gridStart = addDays(firstOfMonth, -startOffset)
  const totalCells = Math.ceil((startOffset + daysInMonth(year, month)) / 7) * 7

  return Array.from({ length: totalCells }, (_, index) => {
    const date = addDays(gridStart, index)
    return {
      date,
      iso: toIsoDate(date),
      inMonth: date.getMonth() === month,
      isToday: isSameDay(date, today),
      isSelected: selected ? isSameDay(date, selected) : false,
    }
  })
}

export function buildWeekDays(anchor: Date, weekStart: WeekStart = 0): Date[] {
  const start = startOfDay(anchor)
  const offset = (start.getDay() - weekStart + 7) % 7
  const weekStartDate = addDays(start, -offset)
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartDate, i))
}

export function eventDayKey(timestamp: string, timezone: 'operator' | 'utc' = 'operator') {
  if (timezone === 'utc') return timestamp.slice(0, 10)
  return toIsoDate(new Date(timestamp))
}

export function monthRangeIso(anchor: Date) {
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 0)
  return { startIso: startOfDay(start).toISOString(), endIso: endOfDay(end).toISOString() }
}

export function weekRangeIso(anchor: Date, weekStart: WeekStart = 0) {
  const days = buildWeekDays(anchor, weekStart)
  return {
    startIso: startOfDay(days[0]).toISOString(),
    endIso: endOfDay(days[6]).toISOString(),
  }
}

export function dayRangeIso(anchor: Date) {
  return { startIso: startOfDay(anchor).toISOString(), endIso: endOfDay(anchor).toISOString() }
}

export function formatMonthLabel(anchor: Date) {
  return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function formatRangeLabel(mode: 'day' | 'week' | 'month' | 'agenda' | 'timeline', anchor: Date, weekStart: WeekStart = 0) {
  if (mode === 'day') return toIsoDate(anchor)
  if (mode === 'month') return formatMonthLabel(anchor)
  if (mode === 'week') {
    const days = buildWeekDays(anchor, weekStart)
    return `${toIsoDate(days[0])} → ${toIsoDate(days[6])}`
  }
  if (mode === 'agenda') return 'Agenda'
  return 'Execution Timeline'
}

/** DST / midnight boundary helpers for proof harness */
export function zonedDayBoundaryProof(dateIso: string, timeZone: string) {
  const noon = new Date(`${dateIso}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(noon)
  const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
  return { dateIso, timeZone, localDay: `${map.year}-${map.month}-${map.day}`, localHour: map.hour }
}