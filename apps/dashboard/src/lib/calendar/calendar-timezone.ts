export type CalendarTimezoneMode = 'operator' | 'property' | 'recipient'

export function resolveOperatorTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function formatInTimezone(iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions = {}) {
  return new Date(iso).toLocaleString(undefined, { timeZone, ...opts })
}

export function convertEventInstant(iso: string, fromTz: string, toTz: string) {
  const formatted = formatInTimezone(iso, toTz, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return { iso, fromTz, toTz, formatted }
}