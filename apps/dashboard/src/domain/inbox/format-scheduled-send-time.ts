/**
 * format-scheduled-send-time.ts
 *
 * Renders the effective future send time of a scheduled follow-up.
 *
 * TWO RULES, BOTH EASY TO GET WRONG
 *
 * 1. The time shown is the SELLER'S local time, not the operator's. An
 *    operator in Chicago scheduling a Los Angeles seller for 8:00 AM must see
 *    "8:00 AM", not "10:00 AM". Every calendar comparison below is therefore
 *    made in the seller's zone -- including "is that today?", which flips at a
 *    different instant for each seller.
 *
 * 2. Nothing here computes WHEN to send. The instant is the one the server
 *    already persisted after resolving contact windows; this module only
 *    formats it. If the operator asked for 7:15 AM and canonical scheduling
 *    moved it to 8:00 AM, 8:00 AM is what arrives here and what is displayed.
 */

export interface ScheduledSendTimeDisplay {
  /** "Tomorrow · 8:00 AM" -- the compact list treatment. */
  label: string
  /** "Today" | "Tomorrow" | "Sep 10" */
  dayLabel: string
  /** "8:00 AM" */
  timeLabel: string
  /** IANA zone actually used, so detail views can disclose it. */
  timezone: string | null
  /** Untouched UTC instant, for diagnostics. */
  iso: string
}

function zonedParts(date: Date, timeZone: string | null) {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }
  if (timeZone) options.timeZone = timeZone

  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''

  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    dayPeriod: pick('dayPeriod').toUpperCase(),
  }
}

/**
 * A calendar key in the target zone. Comparing these strings answers
 * "same day for the seller?" without any UTC-offset arithmetic.
 */
function zonedDayKey(date: Date, timeZone: string | null): string {
  const p = zonedParts(date, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

export function formatScheduledSendTime(
  iso: string | null | undefined,
  timezone: string | null | undefined,
  now: Date = new Date(),
): ScheduledSendTimeDisplay | null {
  if (!iso) return null
  const target = new Date(iso)
  if (Number.isNaN(target.getTime())) return null

  // An unknown/invalid zone must degrade to the operator's local time rather
  // than throw and blank the row.
  let zone: string | null = timezone?.trim() ? timezone.trim() : null
  try {
    if (zone) new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    zone = null
  }

  const parts = zonedParts(target, zone)
  const timeLabel = `${parts.hour}:${parts.minute} ${parts.dayPeriod}`

  const todayKey = zonedDayKey(now, zone)
  const tomorrowKey = zonedDayKey(new Date(now.getTime() + 86_400_000), zone)
  const targetKey = zonedDayKey(target, zone)

  let dayLabel: string
  if (targetKey === todayKey) dayLabel = 'Today'
  else if (targetKey === tomorrowKey) dayLabel = 'Tomorrow'
  else dayLabel = `${parts.month} ${String(Number(parts.day))}`

  return {
    label: `${dayLabel} · ${timeLabel}`,
    dayLabel,
    timeLabel,
    timezone: zone,
    iso: target.toISOString(),
  }
}

/**
 * Reads the derived fields the server attaches. Kept here so no component has
 * to remember which of the six scheduling columns is the display authority.
 */
export function readScheduledSendTime(
  thread: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): ScheduledSendTimeDisplay | null {
  if (!thread) return null
  const iso = thread.next_scheduled_send_at_utc
  const tz = thread.next_scheduled_timezone
  return formatScheduledSendTime(
    typeof iso === 'string' ? iso : null,
    typeof tz === 'string' ? tz : null,
    now,
  )
}

/** The server's single derived flag. Never recomputed on the client. */
export function isScheduleSuppressedThread(thread: Record<string, unknown> | null | undefined): boolean {
  return thread?.is_schedule_suppressed === true
}

/** Count of future runnable actions, for the "2 scheduled actions" detail line. */
export function scheduledPendingCount(thread: Record<string, unknown> | null | undefined): number {
  const value = Number(thread?.scheduled_pending_count ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}
