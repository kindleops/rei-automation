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
 * COLD vs CONVERSATIONAL (owner rule 2026-10-05, send-class.js). The daily
 * limit (800) caps COLD sends only; replies to engaged sellers never count
 * toward it. Each ledger row is classified with the one predicate
 * (classifySend, reference = its sent_at) and the row is annotated:
 *   messages_sent_today               = COLD sends today (what the cap and
 *                                       cold least-used ordering read)
 *   messages_sent_today_conversational = conversational sends today
 *   messages_sent_today_total          = all sends today (the carrier-safety
 *                                       ceiling reads this)
 *   conversational_ceiling             = the per-number total ceiling
 *                                       (metadata.conversational_ceiling, else
 *                                       system_control
 *                                       sender_conversational_ceiling, else 2000)
 *
 * Failure mode: if the ledger cannot be read, rows keep the stored counter
 * (basis `counter_fallback`). The counter only ever grows, so it is never
 * below the true count — the fallback can under-use a sender, never overspend.
 */
import { normalizePhone } from '@/lib/utils/phones.js'
import { SEND_CLASS, classifySend, loadThreadLastInbound, sendRowThreadKey, sourceSendClass } from '@/lib/domain/delivery/send-class.js'

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

// Only the provenance fields the send-class predicate reads; metadata is
// projected key-by-key (campaign rows carry large target snapshots).
const LEDGER_METADATA_KEYS = ['source', 'type', 'message_type', 'queue_key', 'use_case_template', 'selected_use_case', 'action', 'created_from', 'unknown_inbound', 'thread_key']
const LEDGER_SELECT = [
  'id', 'from_phone_number', 'sent_at', 'source', 'type', 'message_type', 'queue_key', 'thread_key', 'use_case_template',
  ...LEDGER_METADATA_KEYS.map((key) => `md_${key}:metadata->>${key}`),
].join(',')

function slimLedgerRow(sent = {}) {
  const metadata = sent?.metadata && typeof sent.metadata === 'object' ? { ...sent.metadata } : {}
  for (const key of LEDGER_METADATA_KEYS) {
    const value = sent?.[`md_${key}`]
    if (value !== undefined && value !== null) metadata[key] = key === 'unknown_inbound' ? value === true || value === 'true' : value
  }
  return { ...sent, metadata }
}

/** Fleet default for the per-number total-sends safety ceiling (carrier safety, not a campaign cap). */
export const DEFAULT_CONVERSATIONAL_CEILING = 2000
export const CONVERSATIONAL_CEILING_CONTROL_KEY = 'sender_conversational_ceiling'

const positiveInt = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** The number's total-sends ceiling: its metadata, else the fleet setting, else 2000. Pure. */
export function resolveConversationalCeiling(row = {}, fleet_ceiling = null) {
  const md = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return positiveInt(md.conversational_ceiling) ?? positiveInt(row?.conversational_ceiling) ?? positiveInt(fleet_ceiling) ?? DEFAULT_CONVERSATIONAL_CEILING
}

/** Normalize one count entry: a bare number (legacy loaders) is treated as all-cold (conservative). */
export function sentTodaySplit(entry) {
  if (entry && typeof entry === 'object') {
    const cold = Math.max(0, Number(entry.cold) || 0)
    const conversational = Math.max(0, Number(entry.conversational) || 0)
    return { cold, conversational, total: cold + conversational }
  }
  const n = Math.max(0, Number(entry) || 0)
  return { cold: n, conversational: 0, total: n }
}

// The ledger is re-read on every dispatch (one sender at a time), and most of
// a day's rows are campaign touches needing the thread check: memoize each
// thread's latest inbound briefly. A reply newer than the memo only makes a
// send count COLD (over-counts the cap, never under-counts it).
const THREAD_MEMO_TTL_MS = 5 * 60 * 1000
const THREAD_MEMO_MAX = 50_000
const threadMemo = new Map()

async function cachedThreadLastInbound(supabase, keys, deps, now_ms) {
  if (typeof deps.loadThreadLastInbound === 'function') return loadThreadLastInbound(supabase, keys, deps).catch(() => new Map())
  const out = new Map()
  const misses = []
  for (const key of new Set(keys)) {
    const hit = threadMemo.get(key)
    if (hit && now_ms - hit.at < THREAD_MEMO_TTL_MS) out.set(key, hit.value)
    else misses.push(key)
  }
  if (!misses.length) return out
  const fresh = await loadThreadLastInbound(supabase, misses, deps).catch(() => null)
  if (!fresh) return out // unreadable => those threads are COLD, and nothing is memoized
  if (threadMemo.size > THREAD_MEMO_MAX) threadMemo.clear()
  for (const key of misses) {
    const value = fresh.get(key) || null
    threadMemo.set(key, { value, at: now_ms })
    out.set(key, value)
  }
  return out
}

/** Test seam: forget memoized thread state. */
export function resetSenderSentTodayMemo() {
  threadMemo.clear()
}

/**
 * Count provider-handed sends per sender since each sender's local midnight,
 * split COLD / CONVERSATIONAL (send-class.js; reference instant = sent_at).
 *
 * @param {object} supabase
 * @param {Array<object>} rows   textgrid_numbers rows (phone_number, market, metadata)
 * @param {{ now?: Date|string, loadThreadLastInbound?: Function }} [options]
 * @returns {Promise<Map<string, {cold:number, conversational:number, total:number}>>}
 */
export async function loadSenderSentToday(supabase, rows = [], { now = new Date(), ...deps } = {}) {
  const windows = new Map()
  for (const row of rows || []) {
    const phone = normalizePhone(row?.phone_number)
    if (!phone || windows.has(phone)) continue
    windows.set(phone, senderDayStart(now, senderOperatingTimezone(row)).getTime())
  }
  const counts = new Map([...windows.keys()].map((phone) => [phone, { cold: 0, conversational: 0, total: 0 }]))
  if (!windows.size) return counts

  const earliest = new Date(Math.min(...windows.values())).toISOString()
  const phones = [...windows.keys()]
  const sends = []
  let complete = false
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await supabase
      .from('send_queue')
      .select(LEDGER_SELECT)
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
      sends.push({ phone, sent: slimLedgerRow(sent) })
    }
    if (batch.length < PAGE) { complete = true; break }
  }
  // More than MAX_PAGES*PAGE sends today is beyond the whole fleet's cap; a
  // truncated count would understate usage, so refuse rather than guess.
  if (!complete) throw new Error('sender_sent_today_scan_truncated')

  // Thread check only for rows whose own provenance does not already make them
  // conversational. Unreadable thread state => COLD (conservative).
  const thread_keys = sends.filter(({ sent }) => !sourceSendClass(sent)).map(({ sent }) => sendRowThreadKey(sent)).filter(Boolean)
  const last_inbound = thread_keys.length ? await cachedThreadLastInbound(supabase, thread_keys, deps, Date.parse(new Date(now).toISOString())) : new Map()
  for (const { phone, sent } of sends) {
    const key = sendRowThreadKey(sent)
    const { send_class } = classifySend(sent, { last_inbound_at: key ? last_inbound.get(key) || null : null, at: sent.sent_at })
    const c = counts.get(phone)
    if (send_class === SEND_CLASS.CONVERSATIONAL) c.conversational += 1
    else c.cold += 1
    c.total += 1
  }
  return counts
}

/** Pure: replace the counter with the derived COLD count (split + raw counter kept). */
export function applyDerivedSentToday(rows = [], counts = null, { fleet_ceiling = null } = {}) {
  return (rows || []).map((row) => {
    if (!row || typeof row !== 'object') return row
    const phone = normalizePhone(row.phone_number)
    const conversational_ceiling = resolveConversationalCeiling(row, fleet_ceiling)
    if (!counts || !phone || !counts.has(phone)) {
      // The never-reset counter is >= every true count: cold AND total use it.
      return {
        ...row,
        messages_sent_today_counter: row.messages_sent_today ?? null,
        messages_sent_today_cold: row.messages_sent_today ?? null,
        messages_sent_today_conversational: null,
        messages_sent_today_total: row.messages_sent_today ?? null,
        conversational_ceiling,
        sent_today_basis: 'counter_fallback',
      }
    }
    const split = sentTodaySplit(counts.get(phone))
    return {
      ...row,
      messages_sent_today: split.cold,
      messages_sent_today_cold: split.cold,
      messages_sent_today_conversational: split.conversational,
      messages_sent_today_total: split.total,
      messages_sent_today_counter: row.messages_sent_today ?? null,
      conversational_ceiling,
      sent_today_basis: 'send_queue',
    }
  })
}

/** system_control sender_conversational_ceiling (a positive integer), or null. Never throws. */
async function loadFleetConversationalCeiling(supabase, deps = {}) {
  try {
    if (typeof deps.loadConversationalCeiling === 'function') return positiveInt(await deps.loadConversationalCeiling())
    if (typeof deps.getSystemValue === 'function') return positiveInt(await deps.getSystemValue(CONVERSATIONAL_CEILING_CONTROL_KEY))
    if (!supabase?.from) return null
    // The cached system_control reader (30 s in-process TTL): this runs on every dispatch.
    const { getSystemValue } = await import('@/lib/system-control.js')
    const value = await getSystemValue(CONVERSATIONAL_CEILING_CONTROL_KEY, { supabase })
    return positiveInt(value && typeof value === 'object' ? value.value ?? value.ceiling : value)
  } catch {
    return null
  }
}

/**
 * Fleet rows with `messages_sent_today` = true COLD sends in the sender's day
 * (plus the conversational / total split and the total ceiling).
 * `deps.loadSenderSentToday` lets tests inject the ledger read.
 */
export async function withDerivedSentToday(supabase, rows = [], deps = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return list
  const now = deps.now ? new Date(deps.now) : new Date()
  const fleet_ceiling = await loadFleetConversationalCeiling(supabase, deps)
  try {
    const loader = typeof deps.loadSenderSentToday === 'function' ? deps.loadSenderSentToday : loadSenderSentToday
    const counts = await loader(supabase, list, { now, ...(typeof deps.loadThreadLastInbound === 'function' ? { loadThreadLastInbound: deps.loadThreadLastInbound } : {}) })
    return applyDerivedSentToday(list, counts instanceof Map ? counts : new Map(Object.entries(counts || {})), { fleet_ceiling })
  } catch {
    return applyDerivedSentToday(list, null, { fleet_ceiling })
  }
}
