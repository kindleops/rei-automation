/**
 * SENDER "SENT TODAY" — derived from actual sends, never from the counter.
 *
 * `textgrid_numbers.messages_sent_today` is incremented on every provider
 * acceptance and NEVER reset (prod 2026-10-01: values 1–281 dating back to
 * April). The router compared it with the daily cap and sorted by it for
 * "least used", so a number that sent 281 messages in September still ranked
 * last today, and the dashboard's client router (`< 150`) excluded every
 * Minneapolis number outright.
 *
 * Truth is the send ledger: a send_queue row the transport handed to the
 * provider has `sent_at` stamped (every such row carries a provider SID —
 * sent, delivered and failed_transport alike). "Today" is the SENDER's
 * operating day: midnight in the number's own zone (metadata.timezone, else
 * its market, else its market's state, else America/New_York — the zone whose
 * day starts first in the continental US, the conservative choice for a cap).
 *
 * Routing and caps read `messages_sent_today` from the rows this module
 * returns: the field is REPLACED with the derived count and the raw counter is
 * kept as `messages_sent_today_counter` for diagnostics. Routing policy (the
 * caps themselves, least-used ordering, eligibility rules) is unchanged — only
 * the number it reads is now true.
 *
 * Failure mode: if the ledger cannot be read, rows keep the stored counter
 * (basis `counter_fallback`). The counter only ever grows, so it is never
 * below the true count — the fallback can under-use a sender, never overspend.
 */
import { normalizePhone } from '@/lib/utils/phones.js'

const clean = (value) => (value === null || value === undefined ? '' : String(value).trim())

export const SENDER_DEFAULT_TIMEZONE = 'America/New_York'

const MARKET_TIMEZONES = {
  'miami, fl': 'America/New_York',
  'jacksonville, fl': 'America/New_York',
  'tampa, fl': 'America/New_York',
  'orlando, fl': 'America/New_York',
  'dallas, tx': 'America/Chicago',
  'houston, tx': 'America/Chicago',
  'san antonio, tx': 'America/Chicago',
  'austin, tx': 'America/Chicago',
  'los angeles, ca': 'America/Los_Angeles',
  'minneapolis, mn': 'America/Chicago',
  'charlotte, nc': 'America/New_York',
  'atlanta, ga': 'America/New_York',
}

// The state's predominant zone (a number's market label ends in its state).
const STATE_TIMEZONES = {
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

function isValidIana(zone) {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The zone whose midnight starts this number's sending day. */
export function senderOperatingTimezone(row = {}) {
  const md = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const declared = clean(md.timezone || md.operating_timezone)
  if (isValidIana(declared)) return declared
  const market = clean(row?.market || md.market).toLowerCase()
  if (MARKET_TIMEZONES[market]) return MARKET_TIMEZONES[market]
  const state = market.split(',').map((part) => part.trim()).pop()?.toUpperCase()
  if (state && STATE_TIMEZONES[state]) return STATE_TIMEZONES[state]
  return SENDER_DEFAULT_TIMEZONE
}

/** Midnight of `now`'s local day in `timezone`, as a UTC instant. */
export function senderDayStart(now, timezone) {
  const at = new Date(now)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value])
  )
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  )
  const offsetMs = asUtc - Math.floor(at.getTime() / 1000) * 1000
  const localMidnightAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  return new Date(localMidnightAsUtc - offsetMs)
}

const PAGE = 1000
const MAX_PAGES = 20

/**
 * Count provider-handed sends per sender since each sender's local midnight.
 *
 * @param {object} supabase
 * @param {Array<object>} rows   textgrid_numbers rows (phone_number, market, metadata)
 * @param {{ now?: Date|string }} [options]
 * @returns {Promise<Map<string, number>>}  normalized phone → sends today
 */
export async function loadSenderSentToday(supabase, rows = [], { now = new Date() } = {}) {
  const windows = new Map()
  for (const row of rows || []) {
    const phone = normalizePhone(row?.phone_number)
    if (!phone || windows.has(phone)) continue
    windows.set(phone, senderDayStart(now, senderOperatingTimezone(row)).getTime())
  }
  const counts = new Map([...windows.keys()].map((phone) => [phone, 0]))
  if (!windows.size) return counts

  const earliest = new Date(Math.min(...windows.values())).toISOString()
  const phones = [...windows.keys()]
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await supabase
      .from('send_queue')
      .select('id,from_phone_number,sent_at')
      .gte('sent_at', earliest)
      .in('from_phone_number', phones)
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw error
    const batch = Array.isArray(data) ? data : []
    for (const sent of batch) {
      const phone = normalizePhone(sent?.from_phone_number)
      const start = windows.get(phone)
      const at = Date.parse(sent?.sent_at)
      if (start === undefined || !Number.isFinite(at) || at < start) continue
      counts.set(phone, counts.get(phone) + 1)
    }
    if (batch.length < PAGE) return counts
  }
  // More than MAX_PAGES*PAGE sends today is beyond the whole fleet's cap; a
  // truncated count would understate usage, so refuse rather than guess.
  throw new Error('sender_sent_today_scan_truncated')
}

/** Pure: replace the counter with the derived count (raw kept for diagnostics). */
export function applyDerivedSentToday(rows = [], counts = null) {
  return (rows || []).map((row) => {
    if (!row || typeof row !== 'object') return row
    const phone = normalizePhone(row.phone_number)
    if (!counts || !phone || !counts.has(phone)) {
      return {
        ...row,
        messages_sent_today_counter: row.messages_sent_today ?? null,
        sent_today_basis: 'counter_fallback',
      }
    }
    return {
      ...row,
      messages_sent_today: counts.get(phone),
      messages_sent_today_counter: row.messages_sent_today ?? null,
      sent_today_basis: 'send_queue',
    }
  })
}

/**
 * Fleet rows with `messages_sent_today` = true sends in the sender's day.
 * `deps.loadSenderSentToday` lets tests inject the ledger read.
 */
export async function withDerivedSentToday(supabase, rows = [], deps = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return list
  const now = deps.now ? new Date(deps.now) : new Date()
  try {
    const loader = typeof deps.loadSenderSentToday === 'function' ? deps.loadSenderSentToday : loadSenderSentToday
    const counts = await loader(supabase, list, { now })
    return applyDerivedSentToday(list, counts instanceof Map ? counts : new Map(Object.entries(counts || {})))
  } catch {
    return applyDerivedSentToday(list, null)
  }
}
