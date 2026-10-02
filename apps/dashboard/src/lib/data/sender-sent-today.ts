/**
 * Sender "sent today" derived from actual sends — the client mirror of
 * apps/api/src/lib/domain/delivery/sender-sent-today.js.
 *
 * `textgrid_numbers.messages_sent_today` is never reset, so the client router's
 * `< 150` usage filter excluded every busy-in-September number forever. Truth
 * is send_queue rows with `sent_at` inside the sender's own local day (its
 * metadata.timezone, else its market's state zone, else America/New_York).
 * If the ledger cannot be read, the stored counter is kept (it is never below
 * the true count, so the fallback can only under-use a sender).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const SENDER_DEFAULT_TIMEZONE = 'America/New_York'

const STATE_TIMEZONES: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
}

interface SenderRow {
  phone_number?: string | null
  market?: string | null
  metadata?: Record<string, unknown> | null
  messages_sent_today?: number | null
}

const digits = (value: unknown) => String(value ?? '').replace(/\D+/g, '')
export const senderPhoneKey = (value: unknown): string | null => {
  const d = digits(value)
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return null
}

const isValidIana = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return Boolean(zone)
  } catch {
    return false
  }
}

export function senderOperatingTimezone(row: SenderRow): string {
  const md = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const declared = String((md as Record<string, unknown>).timezone ?? '').trim()
  if (declared && isValidIana(declared)) return declared
  const state = String(row.market ?? '').split(',').map((p) => p.trim()).pop()?.toUpperCase() ?? ''
  return STATE_TIMEZONES[state] ?? SENDER_DEFAULT_TIMEZONE
}

/** Midnight of `now`'s local day in `timezone`, as a UTC instant. */
export function senderDayStart(now: Date, timezone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second)
  const offsetMs = asUtc - Math.floor(now.getTime() / 1000) * 1000
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs)
}

/** Pure: per-phone sends at/after each sender's local midnight. */
export function countSenderSentToday(
  rows: SenderRow[],
  sends: Array<{ from_phone_number?: string | null; sent_at?: string | null }>,
  now: Date,
): Map<string, number> {
  const starts = new Map<string, number>()
  for (const row of rows) {
    const key = senderPhoneKey(row.phone_number)
    if (key && !starts.has(key)) starts.set(key, senderDayStart(now, senderOperatingTimezone(row)).getTime())
  }
  const counts = new Map<string, number>([...starts.keys()].map((k) => [k, 0]))
  for (const send of sends) {
    const key = senderPhoneKey(send.from_phone_number)
    const start = key ? starts.get(key) : undefined
    const at = Date.parse(String(send.sent_at ?? ''))
    if (key && start !== undefined && Number.isFinite(at) && at >= start) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Rows with messages_sent_today replaced by the derived count (counter kept on failure). */
export async function withDerivedSentToday<T extends SenderRow>(
  supabase: SupabaseClient,
  rows: T[],
  now: Date = new Date(),
): Promise<T[]> {
  if (!rows.length) return rows
  try {
    const phones = rows.map((r) => senderPhoneKey(r.phone_number)).filter((p): p is string => Boolean(p))
    if (!phones.length) return rows
    const earliest = Math.min(...rows.map((r) => senderDayStart(now, senderOperatingTimezone(r)).getTime()))
    const { data, error } = await supabase
      .from('send_queue')
      .select('from_phone_number,sent_at')
      .gte('sent_at', new Date(earliest).toISOString())
      .in('from_phone_number', phones)
      .limit(1000)
    // PostgREST caps a page at max-rows (1000): a full page may be truncated, and
    // an undercount would overspend a cap — keep the (never-lower) counter instead.
    if (error || !Array.isArray(data) || data.length >= 1000) return rows
    const counts = countSenderSentToday(rows, data as Array<{ from_phone_number?: string | null; sent_at?: string | null }>, now)
    return rows.map((row) => {
      const key = senderPhoneKey(row.phone_number)
      return key && counts.has(key) ? { ...row, messages_sent_today: counts.get(key) ?? 0 } : row
    })
  } catch {
    return rows
  }
}
