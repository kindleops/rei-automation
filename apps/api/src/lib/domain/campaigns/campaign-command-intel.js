/**
 * CAMPAIGN COMMAND 3.0 — the war room's read models.
 *
 * READ-ONLY BY CONSTRUCTION: selects, head counts and the two read-only
 * aggregate RPCs the campaign list already uses. Nothing is written, claimed,
 * recomputed or "synced". Every section is guarded: a section that cannot be
 * read is named in `unavailable` and returned as null — never as zero.
 *
 * THREE READS
 *   book   every campaign's execution posture in one bounded request — the
 *          mission rail and the header. The campaign list is a 30 s read
 *          (recipient metrics, execution proofs …) and its reply counts are
 *          derived from target statuses that never occur in production, so it
 *          cannot answer "which campaigns are moving and what came back".
 *   intel  one campaign, deep: delivery funnel in provider semantics, the
 *          execution series, feeder batches with their outcomes, the sender
 *          fleet with the router's own eligibility, template performance,
 *          retry lineage, reply composition and attributable outcomes.
 *   geo    one campaign's targets as points with their execution state.
 *
 * NOTHING IS RE-DECIDED HERE
 *   · send disposition: the Analytics Lab classifier (classifySend) with the
 *     carrier's own failure bucket — content filter, hard bounce, provider
 *     refusal and guard holds stay distinct;
 *   · sender eligibility: the router's evaluateOutboundNumberEligibility on
 *     the raw fleet row, plus the operator blocklist;
 *   · replies: the campaign-responses definition (inbound from the seller to
 *     the number that messaged them, after it did; one seller once);
 *   · the contact window: the canonical contactWindowState.
 *
 * UNITS ARE NEVER MIXED. Sellers (campaign targets) and messages are counted
 * apart: a carrier-filtered first text retried on another template is two
 * messages and one seller; an automatic reply that inherited the campaign id
 * is a conversation message, not a campaign text.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { contactWindowState } from '@/lib/domain/map/map-world-service.js'
import { campaignWindowZones, multiZoneWindowState, resolveCampaignScheduleTimezones } from '@/lib/domain/campaigns/campaign-market-identity.js'
import { campaignDayStart, FEEDER_BUFFER_TARGET, FEEDER_HYDRATION_CHUNK } from '@/lib/domain/campaigns/run-campaign-outbound-feeder.js'
import { fetchCampaignResponses } from '@/lib/domain/campaigns/campaign-responses.js'
import { describeCampaignLineage } from '@/lib/domain/campaigns/campaign-lineage.js'
import { ACTIVE_QUEUE_STATUSES, OVERDUE_GRACE_MS, isProofQueueRow } from '@/lib/domain/campaigns/campaign-live-queue.js'
import { classifySend } from '@/lib/domain/analytics/lab/fact-classifiers.js'
import { evaluateOutboundNumberEligibility } from '@/lib/supabase/sms-engine.js'

/* ── shared ─────────────────────────────────────────────────────────────── */

const PAGE = 1000
const clean = (value) => String(value ?? '').trim()
const lower = (value) => clean(value).toLowerCase()
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const truthy = (value) => ['true', '1', 'yes', 'on'].includes(lower(value))
const posInt = (value) => {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}
const hhmm = (value) => (/^\d{1,2}:\d{2}$/.test(clean(value)) ? clean(value).padStart(5, '0') : null)
const ms = (value) => {
  const t = Date.parse(clean(value))
  return Number.isFinite(t) ? t : null
}
const iso = (value) => {
  const t = ms(value)
  return t === null ? null : new Date(t).toISOString()
}
const normalizePhone = (value) => {
  const digits = clean(value).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return clean(value) || null
}
const splitList = (value) => clean(value).split(',').map((v) => clean(v)).filter(Boolean)
const inc = (bag, key, n = 1) => { bag[key] = (bag[key] || 0) + n }

/**
 * The ONLY system_control keys these reads touch (the table also holds
 * credentials; a `select('*')` would hand them to a browser).
 */
export const COMMAND_CONTROL_KEYS = Object.freeze([
  'queue_processor_mode',
  'queue_execution_mode',
  'queue_auto_send_enabled',
  'queue_auto_enqueue_enabled',
  'outbound_sms_enabled',
  'queue_emergency_stop_at',
  'queue_processor_heartbeat_at',
  'queue_processor_last_claimed_at',
  'campaign_feeder_heartbeat_at',
  'campaign_feeder_last_batch_at',
  'queue_per_number_cap',
  'queue_contact_window_start',
  'queue_contact_window_end',
  'sms_blocked_sender_numbers',
  'sms_blocked_template_ids',
])

/** Read every row a query matches, a page at a time, with an exact count. */
async function scanAll(build, maxPages) {
  const rows = []
  let total = null
  for (let page = 0; page < maxPages; page += 1) {
    const from = rows.length
    const { data, error, count } = await build(page === 0).range(from, from + PAGE - 1)
    if (error) throw error
    const batch = Array.isArray(data) ? data : []
    if (page === 0 && Number.isFinite(count)) total = count
    rows.push(...batch)
    if (!batch.length) break
    if (total !== null ? rows.length >= total : batch.length < PAGE) break
  }
  return { rows, total: total ?? rows.length, truncated: total !== null ? rows.length < total : false }
}

async function readControls(supabase) {
  const { data, error } = await supabase.from('system_control').select('key,value').in('key', [...COMMAND_CONTROL_KEYS])
  if (error) throw error
  const out = {}
  for (const row of data || []) if (COMMAND_CONTROL_KEYS.includes(row.key)) out[row.key] = row.value
  return out
}

/** Run async work over items, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function systemOf(controls) {
  return {
    processor: {
      mode: clean(controls.queue_processor_mode) || null,
      execution_mode: clean(controls.queue_execution_mode) || null,
      auto_send: controls.queue_auto_send_enabled === undefined ? null : truthy(controls.queue_auto_send_enabled),
      auto_enqueue: controls.queue_auto_enqueue_enabled === undefined ? null : truthy(controls.queue_auto_enqueue_enabled),
      outbound_sms: controls.outbound_sms_enabled === undefined ? null : truthy(controls.outbound_sms_enabled),
      emergency_stop_at: iso(controls.queue_emergency_stop_at),
      heartbeat_at: iso(controls.queue_processor_heartbeat_at),
      last_claimed_at: iso(controls.queue_processor_last_claimed_at),
    },
    feeder: {
      heartbeat_at: iso(controls.campaign_feeder_heartbeat_at),
      last_batch_at: iso(controls.campaign_feeder_last_batch_at),
      // The Worker cron that runs CAMPAIGN_FEED and CAMPAIGN_ACTIVATE_DUE
      // (infra/cloudflare/worker/index.ts PRODUCTION_CRON_JOBS "*/5 * * * *").
      cadence_minutes: 5,
    },
    per_number_cap: posInt(controls.queue_per_number_cap),
    blocked_sender_count: splitList(controls.sms_blocked_sender_numbers).length,
    blocked_template_count: splitList(controls.sms_blocked_template_ids).length,
  }
}

/** A single campaign zone, or null when there is none or the cohort spans several. */
function campaignZone(campaign) {
  const zones = campaignWindowZones(campaign)
  return zones.length === 1 ? clean(zones[0]) || null : null
}

function windowOf(campaign, controls, nowMs) {
  const zones = campaignWindowZones(campaign)
  const spec = {
    start: hhmm(campaign.contact_window_start) || hhmm(controls.queue_contact_window_start),
    end: hhmm(campaign.contact_window_end) || hhmm(controls.queue_contact_window_end),
  }
  const source = hhmm(campaign.contact_window_start) && hhmm(campaign.contact_window_end) ? 'campaign' : 'operator'
  if (!zones.length) return { open: null, timezone: null, source, reason: 'campaign_timezone_unset' }
  if (!spec.start || !spec.end) return { open: null, timezone: zones[0], source, reason: 'window_unset' }
  // One state per recipient zone; open when any recipient's window is open.
  const state = multiZoneWindowState(nowMs, zones, spec, contactWindowState)
  return state ? { ...state, source } : { open: null, timezone: zones[0], source, reason: 'window_unreadable' }
}

function feederDigest(md) {
  const f = obj(md.feeder_last)
  if (!f.at) return null
  return {
    at: iso(f.at),
    inserted: Number(f.inserted || 0),
    bound: clean(f.bound) || null,
    reason: clean(f.reason) || null,
    stalled: f.stalled === true,
    ready_remaining: Number(f.ready_remaining ?? 0),
    active_live_rows: Number(f.active_live_rows ?? 0),
    sent_today: f.sent_today === undefined ? null : Number(f.sent_today),
    batch_limit: f.batch_limit === undefined ? null : Number(f.batch_limit),
    spam_retries: Number(f.spam_retries ?? 0),
    last_refill_at: iso(f.last_refill_at),
    skipped_counts_by_reason: obj(f.skipped_counts_by_reason),
    skip_summary: clean(f.skip_summary) || null,
    routing_blocks_by_market: obj(f.routing_blocks_by_market),
  }
}

/* ── what a row is ──────────────────────────────────────────────────────── */

const CAMPAIGN_TEXT_TYPES = new Set(['campaign_launch', 'campaign_recovery'])
const CONVERSATION_SOURCES = new Set(['manual_inbox', 'auto_reply'])

/** A campaign text: a message the campaign sent a target (first touch, retry, recovery). */
export function isCampaignText(row = {}) {
  const type = lower(row.type)
  const source = lower(row.source)
  if (source === 'internal_canary') return false
  if (CAMPAIGN_TEXT_TYPES.has(type)) return true
  if (source === 'enqueue_campaign_target_one') return true
  return type !== 'auto_reply' && !CONVERSATION_SOURCES.has(source) && Boolean(clean(row.campaign_target_id))
}

/** A conversation message that carries the campaign id (auto-reply, manual Inbox reply). */
export function isConversationRow(row = {}) {
  const type = lower(row.type)
  const source = lower(row.source)
  return type === 'auto_reply' || CONVERSATION_SOURCES.has(source)
}

/** The seller a row is addressed to: the campaign target when present, else the phone. */
export const sellerKey = (row = {}) => clean(row.campaign_target_id) || (clean(row.to_phone_number) ? `phone:${normalizePhone(row.to_phone_number)}` : null)

/** Dispositions that mean the message left our system (accepted, delivered, or failed in the carrier). */
export const LEFT_US = new Set(['delivered', 'sent', 'undelivered'])

/* ── replies, bucketed (canonical intents → the brief's composition) ───── */

/**
 * The classifier's intents grouped into what an operator reads. Grouping
 * never upgrades meaning: "confirmed they own it" is not "interested", "who
 * is this" is not interest, and "not now" is a not-interested (the owner's
 * rule: a 30-day nurture). Unknown codes fall to Other with their own name.
 */
export const REPLY_BUCKETS = Object.freeze({
  interested: { label: 'Interested', intents: ['interested', 'seller_interested', 'asks_offer', 'asking_price_provided', 'price_interest', 'price_anchor', 'price_request', 'callback_request', 'callback_requested', 'contract_requested', 'latent_interest'] },
  not_interested: { label: 'Not interested', intents: ['not_interested', 'need_time', 'seller_explicit_decline'] },
  wrong_number: { label: 'Wrong number', intents: ['wrong_number', 'wrong_person', 'not_owner', 'wrong_contact', 'non_owner_referral', 'former_owner_respondent'] },
  opt_out: { label: 'Opt-out', intents: ['opt_out', 'stop', 'unsubscribe', 'remove', 'dnc'] },
  ambiguous: { label: 'Ambiguous', intents: ['unclear', 'unclassified', ''] },
  other: { label: 'Other', intents: [] },
})

const INTENT_TO_BUCKET = new Map()
for (const [bucket, def] of Object.entries(REPLY_BUCKETS)) for (const intent of def.intents) INTENT_TO_BUCKET.set(intent, bucket)

export function replyBucketOf(intent, askedToStop = false) {
  if (askedToStop) return 'opt_out'
  return INTENT_TO_BUCKET.get(lower(intent)) || 'other'
}

export function bucketIntents(intents = {}) {
  const buckets = Object.fromEntries(Object.keys(REPLY_BUCKETS).map((k) => [k, 0]))
  for (const [intent, n] of Object.entries(intents || {})) buckets[replyBucketOf(intent)] += Number(n) || 0
  return buckets
}

/* ══ BOOK ═══════════════════════════════════════════════════════════════ */

const BOOK_COLUMNS = [
  'id', 'name', 'status', 'daily_cap', 'total_cap', 'contact_window_start', 'contact_window_end',
  'scheduled_for', 'activated_at', 'paused_at', 'resumed_at', 'completed_at', 'created_at', 'updated_at',
  'last_transition_reason', 'metadata',
].join(',')

const BOOK_ROW_SELECT = 'campaign_id,campaign_target_id,to_phone_number,queue_status,type,source,sent_at,delivered_at,scheduled_for,scheduled_for_utc,no_send:metadata->>no_send,proof_no_send:metadata->>proof_no_send,launch_mode:metadata->>launch_mode'
const BOOK_ROW_MAX_PAGES = 12
const BOOK_RESPONSE_CONCURRENCY = 3
const BOOK_CACHE_MS = 20_000
const REPLY_BOOK_CACHE_MS = 120_000
const BOOK_TIMEOUT_MS = 50_000

/**
 * Single-flight with a cache and a ceiling: every caller in the window shares
 * one computation, and a computation that stalls (an upstream request that
 * never answers) is abandoned after `timeoutMs` so it cannot hang every later
 * caller. An abandoned computation that finishes late still fills the cache.
 */
const flights = new Map()
async function singleFlight(key, ttlMs, timeoutMs, compute) {
  const slot = flights.get(key) || {}
  flights.set(key, slot)
  if (slot.value && Date.now() - slot.at < ttlMs) return slot.value
  if (!slot.inflight) {
    slot.inflight = compute()
      .then((value) => { slot.value = value; slot.at = Date.now(); return value })
      .finally(() => { slot.inflight = null })
  }
  let timer = 0
  const ceiling = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${key}_timeout`), { code: 'read_timeout' })), timeoutMs) })
  try {
    return await Promise.race([slot.inflight, ceiling])
  } finally {
    clearTimeout(timer)
  }
}

/** For tests. */
export function _resetCommandBookCache() { flights.clear() }

/**
 * Every campaign's execution posture, without the message log — the fast
 * part the rail and header need first. Cached 20 s, single-flight.
 */
export async function buildCampaignCommandBook(deps = {}) {
  if (deps.noCache) return computeBook(deps)
  return singleFlight('command_book', BOOK_CACHE_MS, deps.timeoutMs ?? BOOK_TIMEOUT_MS, () => computeBook(deps))
}

/**
 * Replies per campaign (the campaign-responses definition), for every
 * non-archived campaign that has messaged someone. The expensive part —
 * the message log is read per campaign — so it is cached for two minutes
 * and read after the book.
 */
export async function buildCampaignReplyBook(deps = {}) {
  const run = async () => {
    const book = deps.book || await buildCampaignCommandBook(deps)
    const candidates = (book.campaigns || []).filter((c) => !c.archived && (c.sends?.sellers_dispatched ?? 0) > 0)
    const fetchResponses = deps.fetchResponses || fetchCampaignResponses
    const supabase = deps.supabase || defaultSupabase
    const replies = {}
    const unavailable = []
    await mapLimit(candidates, BOOK_RESPONSE_CONCURRENCY, async (c) => {
      try {
        const r = await fetchResponses(c.id, { supabase })
        if (!r || r.ok !== true) { unavailable.push(c.id); return }
        replies[c.id] = {
          sellers_replied: r.sellers_replied,
          sellers_asked_to_stop: r.sellers_asked_to_stop,
          buckets: bucketIntents(r.intents),
          latest_reply_at: r.latest_reply_at,
          truncated: r.truncated === true,
        }
      } catch (error) {
        unavailable.push(c.id)
        if (deps.onSectionError) deps.onSectionError('responses', error)
      }
    })
    return { ok: true, at: new Date().toISOString(), replies, unavailable }
  }
  if (deps.noCache) return run()
  return singleFlight('command_reply_book', REPLY_BOOK_CACHE_MS, deps.timeoutMs ?? 55_000, run)
}

async function computeBook(deps) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now ? new Date(deps.now) : new Date()
  const nowMs = now.getTime()
  const unavailable = []
  const guard = async (name, fn) => {
    try { return await fn() } catch (error) {
      unavailable.push(name)
      if (deps.onSectionError) deps.onSectionError(name, error)
      return null
    }
  }

  const { data: campaigns, error } = await supabase.from('campaigns').select(BOOK_COLUMNS).order('created_at', { ascending: false }).limit(300)
  if (error) throw error
  const all = campaigns || []
  const open = all.filter((c) => lower(c.status) !== 'archived')
  const ids = open.map((c) => c.id)

  const [controls, targetRows, rowScan] = await Promise.all([
    guard('controls', () => readControls(supabase)),
    ids.length ? guard('targets', async () => {
      const { data, error: e } = await supabase.rpc('campaign_target_status_counts', { p_campaign_ids: ids })
      if (e) throw e
      return data || []
    }) : [],
    ids.length ? guard('sends', () => scanAll((withCount) => supabase.from('send_queue')
      .select(BOOK_ROW_SELECT, withCount ? { count: 'exact' } : undefined)
      .in('campaign_id', ids)
      .order('id', { ascending: true }), BOOK_ROW_MAX_PAGES)) : { rows: [], total: 0, truncated: false },
  ])

  const targets = new Map()
  for (const row of targetRows || []) {
    const t = targets.get(row.campaign_id) || { total: 0, ready: 0, planned: 0, held: 0, other: 0, held_by_reason: {} }
    const n = Number(row.row_count || 0)
    const status = lower(row.target_status)
    t.total += n
    if (status === 'ready') t.ready += n
    else if (status === 'planned') t.planned += n
    else if (status === 'blocked') { t.held += n; if (clean(row.block_reason)) inc(t.held_by_reason, clean(row.block_reason), n) }
    else t.other += n
    targets.set(row.campaign_id, t)
  }

  const zoneOf = new Map(open.map((c) => [c.id, resolveCampaignScheduleTimezones(c).primary]))
  const dayStartOf = new Map()
  for (const [id, tz] of zoneOf) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]))
    dayStartOf.set(id, campaignDayStart(now, tz, parts).getTime())
  }

  const sends = new Map()
  const queues = new Map()
  for (const row of rowScan?.rows || []) {
    if (isProofQueueRow(row)) continue
    const id = row.campaign_id
    const status = lower(row.queue_status)
    if (ACTIVE_QUEUE_STATUSES.includes(status)) {
      const q = queues.get(id) || { live: 0, due: 0, overdue: 0, next_at: null }
      q.live += 1
      const due = ms(row.scheduled_for_utc) ?? ms(row.scheduled_for)
      if (due !== null) {
        if (due <= nowMs) { q.due += 1; if (due <= nowMs - OVERDUE_GRACE_MS) q.overdue += 1 }
        else if (q.next_at === null || due < q.next_at) q.next_at = due
      }
      queues.set(id, q)
      continue
    }
    if (!isCampaignText(row)) continue
    const disposition = classifySend(row).disposition
    if (!LEFT_US.has(disposition)) continue
    const s = sends.get(id) || { dispatched: new Set(), delivered: new Set(), last_sent_at: null, sent_today: 0 }
    const key = sellerKey(row)
    if (key) s.dispatched.add(key)
    if (key && disposition === 'delivered') s.delivered.add(key)
    const at = ms(row.sent_at)
    if (at !== null) {
      if (s.last_sent_at === null || at > s.last_sent_at) s.last_sent_at = at
      if (at >= (dayStartOf.get(id) ?? 0)) s.sent_today += 1
    }
    sends.set(id, s)
  }

  const ctl = controls || {}
  const book = all.map((c) => {
    const status = lower(c.status)
    const md = obj(c.metadata)
    const lineage = describeCampaignLineage(c)
    if (status === 'archived') {
      return { id: c.id, name: c.name, status, archived: true, created_at: c.created_at, updated_at: c.updated_at, completed_at: c.completed_at || null, source: { kind: lineage.kind } }
    }
    const t = targets.get(c.id) || null
    const s = sends.get(c.id) || null
    const q = queues.get(c.id) || { live: 0, due: 0, overdue: 0, next_at: null }
    const quarantine = obj(md.quarantine)
    return {
      id: c.id,
      name: c.name,
      status,
      archived: false,
      created_at: c.created_at,
      updated_at: c.updated_at,
      source: {
        kind: lineage.kind,
        explicit_count: lineage.explicit_property_count,
        area_property_count: lineage.area?.property_count ?? null,
        filter_count: lineage.filters.length,
        market_values: lineage.market_values,
      },
      timezone: lineage.timezone,
      timezones: lineage.timezones,
      window: windowOf(c, ctl, nowMs),
      schedule: {
        scheduled_for: iso(c.scheduled_for),
        missed_for: iso(md.schedule_missed_for),
        activated_at: iso(c.activated_at),
        paused_at: iso(c.paused_at),
        resumed_at: iso(c.resumed_at),
        completed_at: iso(c.completed_at),
        last_transition_reason: clean(c.last_transition_reason) || null,
      },
      caps: { daily_cap: posInt(c.daily_cap), total_cap: posInt(c.total_cap) },
      targets: unavailable.includes('targets') ? null : (t || { total: 0, ready: 0, planned: 0, held: 0, other: 0, held_by_reason: {} }),
      queue: unavailable.includes('sends') ? null : { ...q, next_at: q.next_at === null ? null : new Date(q.next_at).toISOString() },
      sends: unavailable.includes('sends')
        ? null
        : {
          sellers_dispatched: s ? s.dispatched.size : 0,
          sellers_delivered: s ? s.delivered.size : 0,
          last_sent_at: s && s.last_sent_at !== null ? new Date(s.last_sent_at).toISOString() : null,
          sent_today: s ? s.sent_today : 0,
          truncated: rowScan?.truncated === true,
        },
      // replies come from the reply book (buildCampaignReplyBook) — read after this
      replies: null,
      feeder: feederDigest(md),
      quarantined: quarantine.active === true,
    }
  })

  return {
    ok: true,
    at: now.toISOString(),
    system: systemOf(ctl),
    campaigns: book,
    unavailable: [...new Set(unavailable)],
  }
}

/* ══ INTEL ══════════════════════════════════════════════════════════════ */

const INTEL_CAMPAIGN_COLUMNS = [
  'id', 'name', 'status', 'daily_cap', 'total_cap', 'batch_max', 'market_cap', 'per_sender_cap', 'send_interval_seconds',
  'contact_window_start', 'contact_window_end', 'scheduled_for', 'activated_at', 'paused_at', 'completed_at', 'created_at', 'metadata',
].join(',')

const INTEL_ROW_SELECT = [
  'id', 'campaign_target_id', 'to_phone_number', 'from_phone_number', 'queue_status', 'type', 'source', 'template_id',
  'created_at', 'updated_at', 'sent_at', 'delivered_at', 'scheduled_for', 'scheduled_for_utc',
  'provider_message_id', 'failed_reason', 'guard_reason', 'touch_number', 'thread_key',
  'spam_retry_generation:metadata->>spam_retry_generation',
  'recycled_at:metadata->>recycled_at',
  'recycle_outcome:metadata->>recycle_outcome',
  'no_send:metadata->>no_send',
  'proof_no_send:metadata->>proof_no_send',
  'launch_mode:metadata->>launch_mode',
  'skip_reason:metadata->>skip_reason',
].join(',')
const INTEL_ROW_MAX_PAGES = 6
const EVENT_ID_CHUNK = 100
const PHONE_CHUNK = 40
const ID_CHUNK = 100
const BATCH_LIMIT = 48
const FLEET_TODAY_MAX_PAGES = 4
const SERIES_HOURLY_MAX_DAYS = 5
const MIN_RATE_SAMPLE = 20

const chunk = (list, size) => {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * The carrier's verdict per queue row: the latest event's provider status and
 * the latest failure bucket (Spam = content filter, Hard Bounce = invalid
 * destination …). Only rows whose outcome depends on it are looked up.
 */
async function loadCarrierVerdicts(supabase, rowIds) {
  const verdicts = new Map()
  let truncated = false
  for (const ids of chunk(rowIds, EVENT_ID_CHUNK)) {
    const { data, error } = await supabase.from('message_events')
      .select('queue_id,failure_bucket,provider_delivery_status,delivery_status,created_at')
      .in('queue_id', ids)
      .order('created_at', { ascending: false })
      .limit(1000)
    if (error) throw error
    if ((data || []).length >= 1000) truncated = true
    for (const e of data || []) {
      const id = clean(e.queue_id)
      if (!id) continue
      const v = verdicts.get(id) || { bucket: null, receipt: null }
      if (v.receipt === null) v.receipt = lower(e.provider_delivery_status || e.delivery_status) || null
      if (v.bucket === null && clean(e.failure_bucket)) v.bucket = clean(e.failure_bucket)
      verdicts.set(id, v)
    }
  }
  return { verdicts, truncated }
}

/** One row's place in the delivery funnel (messages, not sellers). */
function funnelKey(disposition, cls) {
  if (disposition === 'delivered') return 'delivered'
  if (disposition === 'sent') return 'awaiting_receipt'
  if (disposition === 'undelivered') {
    if (cls === 'carrier_spam_filter') return 'filtered'
    if (cls === 'carrier_hard_bounce') return 'invalid_destination'
    if (cls === 'carrier_soft_bounce') return 'soft_bounce'
    if (cls === 'carrier_dnc') return 'carrier_dnc'
    return 'carrier_undelivered'
  }
  if (disposition === 'rejected') return 'provider_refused'
  if (disposition === 'blocked') return 'held_at_send'
  if (disposition === 'held') return 'held_at_send'
  if (disposition === 'expired') return 'expired_unsent'
  if (disposition === 'cancelled') return 'cancelled'
  if (disposition === 'waiting') return 'waiting'
  return 'other'
}

export const FUNNEL_KEYS = Object.freeze([
  'delivered', 'awaiting_receipt', 'filtered', 'invalid_destination', 'soft_bounce', 'carrier_dnc', 'carrier_undelivered',
  'provider_refused', 'held_at_send', 'expired_unsent', 'cancelled', 'waiting', 'other',
])

/**
 * The transport funnel in provider semantics, for campaign texts only.
 * `accepted` = the provider returned a message id; `left_us` = the message
 * left our system (accepted, delivered or failed in the carrier network).
 */
export function deliveryFunnel(rows = [], verdicts = new Map()) {
  const counts = Object.fromEntries(FUNNEL_KEYS.map((k) => [k, 0]))
  const classes = {}
  let accepted = 0
  let leftUs = 0
  let receiptLag = 0
  for (const row of rows) {
    const v = verdicts.get(clean(row.id)) || null
    const { disposition, cls } = classifySend(row, v?.bucket ?? null)
    const key = funnelKey(disposition, cls)
    counts[key] += 1
    inc(classes, cls)
    if (clean(row.provider_message_id)) accepted += 1
    if (LEFT_US.has(disposition)) leftUs += 1
    // The queue still says "sent" but the carrier already reported it undelivered.
    if (disposition === 'sent' && v && ['undelivered', 'failed'].includes(v.receipt || '')) receiptLag += 1
  }
  return { total: rows.length, left_us: leftUs, accepted, ...counts, classes, receipt_lag: receiptLag }
}

/** Hourly (≤ 5 days) or daily buckets of queued / left us / delivered / failed / replies. */
export function executionSeries(rows = [], verdicts = new Map(), replyTimes = [], { nowMs = Date.now() } = {}) {
  const stamps = []
  for (const row of rows) {
    const created = ms(row.created_at)
    if (created !== null) stamps.push(created)
  }
  if (!stamps.length) return null
  const start = Math.min(...stamps)
  const span = Math.max(1, nowMs - start)
  const grain = span <= SERIES_HOURLY_MAX_DAYS * 24 * 3600_000 ? 'hour' : 'day'
  const step = grain === 'hour' ? 3600_000 : 24 * 3600_000
  const first = Math.floor(start / step) * step
  const count = Math.min(24 * 60, Math.floor((nowMs - first) / step) + 1)
  const buckets = Array.from({ length: count }, (_, i) => ({ t: new Date(first + i * step).toISOString(), queued: 0, sent: 0, delivered: 0, failed: 0, replies: 0 }))
  const at = (t) => {
    if (t === null || t < first) return null
    const i = Math.floor((t - first) / step)
    return i >= 0 && i < buckets.length ? buckets[i] : null
  }
  for (const row of rows) {
    const b0 = at(ms(row.created_at))
    if (b0) b0.queued += 1
    const v = verdicts.get(clean(row.id)) || null
    const { disposition } = classifySend(row, v?.bucket ?? null)
    if (!LEFT_US.has(disposition)) continue
    const sentAt = ms(row.sent_at) ?? ms(row.updated_at)
    const b1 = at(sentAt)
    if (b1) b1.sent += 1
    if (disposition === 'delivered') {
      const b2 = at(ms(row.delivered_at) ?? sentAt)
      if (b2) b2.delivered += 1
    } else if (disposition === 'undelivered') {
      const b3 = at(ms(row.updated_at) ?? sentAt)
      if (b3) b3.failed += 1
    }
  }
  for (const t of replyTimes) {
    const b = at(ms(t))
    if (b) b.replies += 1
  }
  return { grain, step_ms: step, start: new Date(first).toISOString(), buckets }
}

/**
 * Feeder refill passes (campaign_runs) as batches. Rows a pass created are the
 * campaign's rows created during the pass (it holds the campaign's execution
 * lock); measured in production, the window count equals queue_rows_created.
 */
export function batchesOf(runs = [], rows = [], verdicts = new Map(), repliedSellers = new Set()) {
  const placed = runs.filter((r) => Number(r.queue_rows_created || 0) > 0)
    .sort((a, b) => (ms(a.started_at) ?? 0) - (ms(b.started_at) ?? 0))
  const byCreated = [...rows].sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0))
  const out = placed.map((r, i) => {
    const from = ms(r.started_at) ?? ms(r.created_at) ?? 0
    const to = (ms(r.finished_at) ?? from) + 2000
    const members = byCreated.filter((row) => {
      const t = ms(row.created_at)
      return t !== null && t >= from && t <= to
    })
    const outcome = { queued_now: 0, left_us: 0, delivered: 0, filtered: 0, failed: 0, held: 0, cancelled: 0, replied: 0 }
    const sellers = new Set()
    for (const row of members) {
      const v = verdicts.get(clean(row.id)) || null
      const { disposition, cls } = classifySend(row, v?.bucket ?? null)
      if (disposition === 'waiting') outcome.queued_now += 1
      if (LEFT_US.has(disposition)) outcome.left_us += 1
      if (disposition === 'delivered') outcome.delivered += 1
      if (disposition === 'undelivered') { if (cls === 'carrier_spam_filter') outcome.filtered += 1; else outcome.failed += 1 }
      if (disposition === 'rejected') outcome.failed += 1
      if (disposition === 'blocked' || disposition === 'held') outcome.held += 1
      if (disposition === 'cancelled' || disposition === 'expired') outcome.cancelled += 1
      const key = sellerKey(row)
      if (key) sellers.add(key)
    }
    for (const key of sellers) if (repliedSellers.has(key)) outcome.replied += 1
    const md = obj(r.metadata)
    return {
      n: i + 1,
      run_id: r.id,
      started_at: iso(r.started_at),
      finished_at: iso(r.finished_at),
      duration_ms: ms(r.finished_at) !== null && ms(r.started_at) !== null ? Math.max(0, ms(r.finished_at) - ms(r.started_at)) : null,
      ready: Number(r.ready_to_queue ?? 0),
      planned: Number(r.queue_rows_planned ?? 0),
      created: Number(r.queue_rows_created ?? 0),
      matched_rows: members.length,
      blocked_counts: obj(r.blocked_counts),
      senders: Array.isArray(md.sender_distribution) ? md.sender_distribution.slice(0, 6) : [],
      templates: Array.isArray(md.template_distribution) ? md.template_distribution.length : 0,
      outcome,
    }
  })
  return out.reverse().slice(0, BATCH_LIMIT)
}

/** The router's view of one fleet number, in the brief's sender states. */
export function senderStateOf(row, { blocked = new Set(), now = new Date() } = {}) {
  const phone = normalizePhone(row.phone_number)
  if (phone && blocked.has(phone)) return { state: 'blocked', reason: 'blocked_by_operator', eligible: false }
  const verdict = evaluateOutboundNumberEligibility(row, now)
  if (verdict.ok) {
    return { state: lower(row.health_state) === 'unverified' || !clean(row.health_state) ? 'unverified' : 'active', reason: null, eligible: true }
  }
  const reason = clean(verdict.reason).replace(/^outbound_number_/, '')
  if (reason === 'status_paused') return { state: 'paused', reason, eligible: false }
  if (reason === 'health_cooling' || reason === 'cooling_until') return { state: 'cooling', reason, eligible: false }
  if (reason === 'daily_limit_reached') return { state: 'cap_reached', reason, eligible: false }
  if (reason.startsWith('health_')) return { state: 'blocked', reason, eligible: false }
  return { state: 'ineligible', reason, eligible: false }
}

/**
 * @param {string} campaignId
 * @param {{ supabase?: object, now?: string|number|Date, fetchResponses?: Function, onSectionError?: Function }} deps
 */
export async function buildCampaignIntel(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now ? new Date(deps.now) : new Date()
  const nowMs = now.getTime()

  const { data: campaign, error: campaignError } = await supabase.from('campaigns').select(INTEL_CAMPAIGN_COLUMNS).eq('id', campaignId).maybeSingle()
  if (campaignError) throw campaignError
  if (!campaign) return { ok: false, status: 404, error: 'campaign_not_found' }

  const unavailable = []
  const guard = async (name, fn) => {
    try { return await fn() } catch (error) {
      unavailable.push(name)
      if (deps.onSectionError) deps.onSectionError(name, error)
      return null
    }
  }
  const tz = resolveCampaignScheduleTimezones(campaign).primary // the feeder's own "today"
  const dayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]))
  const dayStart = campaignDayStart(now, tz, dayParts)
  const fetchResponses = deps.fetchResponses || fetchCampaignResponses

  const [rowScan, controls, fleetRows, runs, emptyPasses, responses, targetScan, fleetToday] = await Promise.all([
    guard('rows', () => scanAll((withCount) => supabase.from('send_queue')
      .select(INTEL_ROW_SELECT, withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true }), INTEL_ROW_MAX_PAGES)),
    guard('controls', () => readControls(supabase)),
    guard('fleet', async () => {
      const { data, error } = await supabase.from('textgrid_numbers')
        .select('id,phone_number,friendly_name,market,status,health_state,health_reason,cooling_until,spam_flagged_at,daily_limit,messages_sent_today,last_used_at')
        .limit(200)
      if (error) throw error
      return data || []
    }),
    guard('batches', async () => {
      const { data, error } = await supabase.from('campaign_runs')
        .select('id,started_at,finished_at,created_at,status,ready_to_queue,queue_rows_planned,queue_rows_created,blocked_counts,metadata')
        .eq('campaign_id', campaignId)
        .eq('run_type', 'launch_queue_plan')
        .gt('queue_rows_created', 0)
        .order('started_at', { ascending: false })
        .limit(120)
      if (error) throw error
      return data || []
    }),
    guard('batches', async () => {
      const { count, error } = await supabase.from('campaign_runs')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('run_type', 'launch_queue_plan')
        .eq('queue_rows_created', 0)
      if (error) throw error
      return Number(count || 0)
    }),
    guard('replies', async () => {
      const r = await fetchResponses(campaignId, { supabase, includeSellers: true })
      if (!r || r.ok !== true) throw new Error('responses_unavailable')
      return r
    }),
    guard('audience', () => scanAll((withCount) => supabase.from('campaign_targets')
      .select('id,market,state,timezone,target_status,block_reason', withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true }), 6)),
    guard('fleet', () => scanAll((withCount) => supabase.from('send_queue')
      .select('from_phone_number,campaign_id', withCount ? { count: 'exact' } : undefined)
      .gte('sent_at', dayStart.toISOString())
      .not('from_phone_number', 'is', null)
      .order('id', { ascending: true }), FLEET_TODAY_MAX_PAGES)),
  ])

  const ctl = controls || {}
  const allRows = (rowScan?.rows || []).filter((row) => !isProofQueueRow(row))
  const texts = allRows.filter(isCampaignText)
  const conversation = allRows.filter(isConversationRow)

  // The carrier's verdict, only where the disposition depends on it.
  const needVerdict = texts.filter((row) => ['failed_transport', 'undelivered', 'failed', 'sent'].includes(lower(row.queue_status))).map((row) => clean(row.id)).filter(Boolean)
  const carrier = needVerdict.length ? await guard('delivery', () => loadCarrierVerdicts(supabase, needVerdict)) : { verdicts: new Map(), truncated: false }
  const verdicts = carrier?.verdicts || new Map()

  // ── sellers (targets) through transport ──────────────────────────────
  const firstLeftUs = new Map()   // seller → first time a text left us
  const sellerSender = new Map()  // seller → the number that first messaged them
  const phoneToSeller = new Map()
  const leftUs = new Set()
  const delivered = new Set()
  for (const row of texts) {
    const v = verdicts.get(clean(row.id)) || null
    const { disposition } = classifySend(row, v?.bucket ?? null)
    if (!LEFT_US.has(disposition)) continue
    const key = sellerKey(row)
    if (!key) continue
    leftUs.add(key)
    if (disposition === 'delivered') delivered.add(key)
    const at = ms(row.sent_at) ?? ms(row.updated_at)
    if (at !== null && (!firstLeftUs.has(key) || at < firstLeftUs.get(key))) {
      firstLeftUs.set(key, at)
      sellerSender.set(key, normalizePhone(row.from_phone_number))
    }
    const phone = normalizePhone(row.to_phone_number)
    if (phone) phoneToSeller.set(phone, key)
  }

  // ── replies, bucketed, mapped back to the seller ─────────────────────
  const replySellers = responses?.sellers || []
  const repliedKeys = new Set()
  const replyBuckets = Object.fromEntries(Object.keys(REPLY_BUCKETS).map((k) => [k, 0]))
  const replyList = []
  for (const s of replySellers) {
    const bucket = replyBucketOf(s.intent, s.asked_to_stop)
    replyBuckets[bucket] += 1
    const key = phoneToSeller.get(normalizePhone(s.seller_phone)) || `phone:${normalizePhone(s.seller_phone)}`
    repliedKeys.add(key)
    replyList.push({ ...s, bucket })
  }
  replyList.sort((a, b) => (ms(b.latest_reply_at) ?? 0) - (ms(a.latest_reply_at) ?? 0))

  // ── delivery funnel (messages) + retry lineage ───────────────────────
  const funnel = rowScan ? deliveryFunnel(texts, verdicts) : null
  const retries = { originals_filtered: 0, recycled: 0, no_retry: 0, retry_rows: 0, retry_delivered: 0, retry_filtered: 0, retry_failed: 0, retry_waiting: 0, no_retry_reasons: {} }
  for (const row of texts) {
    const gen = Number(row.spam_retry_generation || 0)
    const v = verdicts.get(clean(row.id)) || null
    const { disposition, cls } = classifySend(row, v?.bucket ?? null)
    if (gen > 0) {
      retries.retry_rows += 1
      if (disposition === 'delivered') retries.retry_delivered += 1
      else if (cls === 'carrier_spam_filter') retries.retry_filtered += 1
      else if (disposition === 'undelivered' || disposition === 'rejected') retries.retry_failed += 1
      else retries.retry_waiting += 1
    } else if (cls === 'carrier_spam_filter') {
      retries.originals_filtered += 1
    }
    const outcome = clean(row.recycle_outcome)
    if (outcome === 'retry_different_template') retries.recycled += 1
    else if (outcome.startsWith('no_retry')) { retries.no_retry += 1; inc(retries.no_retry_reasons, outcome.replace(/^no_retry:?/, '') || 'unspecified') }
  }

  // ── templates ────────────────────────────────────────────────────────
  const blockedTemplates = new Set(splitList(ctl.sms_blocked_template_ids))
  const templateStats = new Map()
  const sellerFirstTemplate = new Map()
  for (const row of [...texts].sort((a, b) => (ms(a.sent_at) ?? ms(a.created_at) ?? 0) - (ms(b.sent_at) ?? ms(b.created_at) ?? 0))) {
    const id = clean(row.template_id)
    if (!id) continue
    const v = verdicts.get(clean(row.id)) || null
    const { disposition, cls } = classifySend(row, v?.bucket ?? null)
    const t = templateStats.get(id) || { template_id: id, attempted: 0, delivered: 0, filtered: 0, failed: 0, sellers: new Set(), replied: 0 }
    if (LEFT_US.has(disposition)) t.attempted += 1
    if (disposition === 'delivered') {
      t.delivered += 1
      const key = sellerKey(row)
      if (key && !sellerFirstTemplate.has(key)) { sellerFirstTemplate.set(key, id); t.sellers.add(key) }
    }
    if (cls === 'carrier_spam_filter') t.filtered += 1
    else if (disposition === 'undelivered' || disposition === 'rejected') t.failed += 1
    templateStats.set(id, t)
  }
  for (const key of repliedKeys) {
    const id = sellerFirstTemplate.get(key)
    if (id && templateStats.has(id)) templateStats.get(id).replied += 1
  }
  const templateIds = [...templateStats.keys()]
  const templateMeta = templateIds.length
    ? await guard('templates', async () => {
      const out = new Map()
      for (const ids of chunk(templateIds, ID_CHUNK)) {
        const { data, error } = await supabase.from('sms_templates')
          .select('template_id,template_name,use_case,language,stage_code,is_active,quarantine_state,quarantine_reason,variant_group_key,property_type_scope')
          .in('template_id', ids)
        if (error) throw error
        for (const t of data || []) out.set(clean(t.template_id), t)
      }
      return out
    })
    : new Map()
  const templates = [...templateStats.values()].map((t) => {
    const meta = templateMeta?.get(t.template_id) || null
    const quarantine = lower(meta?.quarantine_state)
    return {
      template_id: t.template_id,
      name: clean(meta?.template_name) || null,
      use_case: clean(meta?.use_case) || null,
      language: clean(meta?.language) || null,
      stage_code: clean(meta?.stage_code) || null,
      variant_group: clean(meta?.variant_group_key) || null,
      asset_scope: clean(meta?.property_type_scope) || null,
      active: meta ? meta.is_active !== false : null,
      blocked_by_operator: blockedTemplates.has(t.template_id),
      quarantined: Boolean(quarantine && quarantine !== 'active'),
      quarantine_reason: clean(meta?.quarantine_reason) || null,
      attempted: t.attempted,
      delivered: t.delivered,
      filtered: t.filtered,
      failed: t.failed,
      sellers_first_reached: t.sellers.size,
      sellers_replied: t.replied,
      sample_ok: t.attempted >= MIN_RATE_SAMPLE,
    }
  }).sort((a, b) => b.attempted - a.attempted)

  // ── sender fleet: the router's eligibility, real usage, this campaign ─
  const blockedSenders = new Set(splitList(ctl.sms_blocked_sender_numbers).map(normalizePhone).filter(Boolean))
  const systemCap = posInt(ctl.queue_per_number_cap)
  const campaignCap = posInt(campaign.per_sender_cap)
  const todayByPhone = {}
  const todayCampaignByPhone = {}
  for (const row of fleetToday?.rows || []) {
    const phone = normalizePhone(row.from_phone_number)
    if (!phone) continue
    inc(todayByPhone, phone)
    if (row.campaign_id === campaignId) inc(todayCampaignByPhone, phone)
  }
  const queuedByPhone = {}
  const lastCampaignSend = {}
  const perSender = {}
  for (const row of texts) {
    const phone = normalizePhone(row.from_phone_number)
    if (!phone) continue
    const status = lower(row.queue_status)
    if (ACTIVE_QUEUE_STATUSES.includes(status)) inc(queuedByPhone, phone)
    const v = verdicts.get(clean(row.id)) || null
    const { disposition, cls } = classifySend(row, v?.bucket ?? null)
    const p = perSender[phone] || (perSender[phone] = { left_us: 0, delivered: 0, filtered: 0, failed: 0, sellers: new Set(), replied: 0 })
    if (LEFT_US.has(disposition)) p.left_us += 1
    if (disposition === 'delivered') p.delivered += 1
    if (cls === 'carrier_spam_filter') p.filtered += 1
    else if (disposition === 'undelivered' || disposition === 'rejected') p.failed += 1
    const at = ms(row.sent_at)
    if (at !== null && (!lastCampaignSend[phone] || at > lastCampaignSend[phone])) lastCampaignSend[phone] = at
  }
  for (const [key, phone] of sellerSender) {
    if (phone && perSender[phone]) perSender[phone].sellers.add(key)
  }
  for (const s of replySellers) {
    const phone = normalizePhone(s.sender_phone)
    if (phone && perSender[phone]) perSender[phone].replied += 1
  }

  const audienceRows = targetScan?.rows || []
  const marketDemand = {}
  const marketTargets = {}
  const zones = {}
  for (const t of audienceRows) {
    const market = clean(t.market) || null
    if (market) inc(marketTargets, market)
    if (market && lower(t.target_status) === 'ready') inc(marketDemand, market)
    inc(zones, clean(t.timezone) || 'unknown')
  }
  const campaignMarkets = new Set(Object.keys(marketTargets).map(lower))

  const fleet = fleetRows
    ? fleetRows.map((row) => {
      const phone = normalizePhone(row.phone_number)
      const state = senderStateOf(row, { blocked: blockedSenders, now })
      const limit = campaignCap ?? systemCap ?? posInt(row.daily_limit)
      const actualToday = todayByPhone[phone] || 0
      const p = perSender[phone] || null
      return {
        phone,
        label: clean(row.friendly_name) || null,
        market: clean(row.market) || null,
        in_campaign_market: campaignMarkets.has(lower(row.market)),
        status: clean(row.status) || null,
        health_state: clean(row.health_state) || null,
        health_reason: clean(row.health_reason) || null,
        cooling_until: iso(row.cooling_until),
        spam_flagged_at: iso(row.spam_flagged_at),
        state: state.state,
        state_reason: state.reason,
        eligible: state.eligible,
        daily_limit: posInt(row.daily_limit),
        limit,
        limit_basis: campaignCap ? 'campaign' : systemCap ? 'system' : row.daily_limit ? 'number' : null,
        sent_today: actualToday,
        router_counter: Number.isFinite(Number(row.messages_sent_today)) ? Number(row.messages_sent_today) : null,
        remaining_today: state.eligible && limit ? Math.max(0, limit - actualToday) : 0,
        campaign: {
          carrying: Boolean(p) || Boolean(queuedByPhone[phone]),
          queued: queuedByPhone[phone] || 0,
          sent_today: todayCampaignByPhone[phone] || 0,
          last_sent_at: lastCampaignSend[phone] ? new Date(lastCampaignSend[phone]).toISOString() : null,
          left_us: p ? p.left_us : 0,
          delivered: p ? p.delivered : 0,
          filtered: p ? p.filtered : 0,
          failed: p ? p.failed : 0,
          sellers: p ? p.sellers.size : 0,
          sellers_replied: p ? p.replied : 0,
          sample_ok: p ? p.left_us >= MIN_RATE_SAMPLE : false,
        },
        last_used_at: iso(row.last_used_at),
      }
    }).sort((a, b) => Number(b.campaign.carrying) - Number(a.campaign.carrying) || Number(b.in_campaign_market) - Number(a.in_campaign_market) || Number(b.eligible) - Number(a.eligible) || clean(a.market).localeCompare(clean(b.market)) || a.phone.localeCompare(b.phone))
    : null

  // Routing per market with sellers still to message: a first touch needs a
  // number in the seller's own market (the router's local-first rule).
  const routing = fleet
    ? Object.keys(marketTargets).sort((a, b) => (marketDemand[b] || 0) - (marketDemand[a] || 0) || marketTargets[b] - marketTargets[a]).slice(0, 12).map((market) => {
      const local = fleet.filter((s) => lower(s.market) === lower(market))
      const states = {}
      for (const s of local) inc(states, s.state)
      const eligible = local.filter((s) => s.eligible)
      return {
        market,
        targets: marketTargets[market],
        ready: marketDemand[market] || 0,
        numbers: local.length,
        eligible: eligible.length,
        by_state: states,
        remaining_today: eligible.reduce((sum, s) => sum + s.remaining_today, 0),
      }
    })
    : null

  // ── attributable outcomes ────────────────────────────────────────────
  // An opportunity counts for this campaign when its primary thread is a
  // seller who replied to this campaign's number, and it opened after this
  // campaign first messaged them. Stage moves count only after that send.
  const replierPhones = [...new Set(replySellers.map((s) => normalizePhone(s.seller_phone)).filter(Boolean))]
  const outcomes = await guard('outcomes', async () => {
    if (!replierPhones.length) {
      return { opportunities: [], stage_moves: 0, opportunities_moved: 0, offers: [], closings: [], basis: 'replied_sellers' }
    }
    const opps = []
    for (const phones of chunk(replierPhones, PHONE_CHUNK)) {
      const { data, error } = await supabase.from('acquisition_opportunities')
        .select('id,primary_thread_key,master_owner_id,primary_property_id,acquisition_stage,opportunity_status,created_at,recommended_offer,current_offer,active_offer_id,accepted_offer_id,latest_intent,seller_display_name,property_address_full,market')
        .in('primary_thread_key', phones)
      if (error) throw error
      opps.push(...(data || []))
    }
    const attributed = opps.filter((o) => {
      const key = phoneToSeller.get(normalizePhone(o.primary_thread_key))
      const first = key ? firstLeftUs.get(key) : null
      return first !== null && first !== undefined && (ms(o.created_at) ?? 0) > first
    })
    const ids = attributed.map((o) => o.id)
    let moves = []
    let offers = []
    let closings = []
    if (ids.length) {
      for (const part of chunk(ids, ID_CHUNK)) {
        const [h, so, cc] = await Promise.all([
          supabase.from('acquisition_opportunity_history').select('opportunity_id,previous_value,new_value,created_at,actor,source').in('opportunity_id', part).eq('field_name', 'acquisition_stage').order('created_at', { ascending: true }),
          supabase.from('seller_offers').select('id,opportunity_id,status,offer_type,direction,purchase_price,sent_at,accepted_at,accepted_price,created_at').in('opportunity_id', part),
          supabase.from('closing_cases').select('id,opportunity_id,contract_status,closing_status,seller_contract_price,expected_gross_revenue,confirmed_gross_revenue,revenue_status,closed_at').in('opportunity_id', part),
        ])
        if (h.error) throw h.error
        if (so.error) throw so.error
        if (cc.error) throw cc.error
        moves.push(...(h.data || []))
        offers.push(...(so.data || []))
        closings.push(...(cc.data || []))
      }
    }
    const firstByOpp = new Map(attributed.map((o) => [o.id, firstLeftUs.get(phoneToSeller.get(normalizePhone(o.primary_thread_key)))]))
    moves = moves.filter((m) => (ms(m.created_at) ?? 0) > (firstByOpp.get(m.opportunity_id) ?? Infinity))
    return {
      basis: 'replied_sellers',
      opportunities: attributed.map((o) => ({
        id: o.id,
        thread_key: clean(o.primary_thread_key) || null,
        master_owner_id: clean(o.master_owner_id) || null,
        property_id: clean(o.primary_property_id) || null,
        stage: clean(o.acquisition_stage) || null,
        status: clean(o.opportunity_status) || null,
        created_at: iso(o.created_at),
        recommended_offer: Number(o.recommended_offer) > 0 ? Number(o.recommended_offer) : null,
        current_offer: Number(o.current_offer) > 0 ? Number(o.current_offer) : null,
        latest_intent: clean(o.latest_intent) || null,
        seller: clean(o.seller_display_name) || null,
        address: clean(o.property_address_full) || null,
        moves: moves.filter((m) => m.opportunity_id === o.id).map((m) => ({ from: clean(m.previous_value) || null, to: clean(m.new_value) || null, at: iso(m.created_at), actor: clean(m.actor) || clean(m.source) || null })),
      })),
      stage_moves: moves.length,
      opportunities_moved: new Set(moves.map((m) => m.opportunity_id)).size,
      offers: offers.map((o) => ({ id: o.id, opportunity_id: o.opportunity_id, status: clean(o.status) || null, type: clean(o.offer_type) || null, direction: clean(o.direction) || null, price: Number(o.purchase_price) > 0 ? Number(o.purchase_price) : null, sent_at: iso(o.sent_at), accepted_at: iso(o.accepted_at), accepted_price: Number(o.accepted_price) > 0 ? Number(o.accepted_price) : null })),
      closings: closings.map((c) => ({ id: c.id, opportunity_id: c.opportunity_id, contract_status: clean(c.contract_status) || null, closing_status: clean(c.closing_status) || null, contract_price: Number(c.seller_contract_price) > 0 ? Number(c.seller_contract_price) : null, expected_revenue: Number(c.expected_gross_revenue) > 0 ? Number(c.expected_gross_revenue) : null, confirmed_revenue: Number(c.confirmed_gross_revenue) > 0 ? Number(c.confirmed_gross_revenue) : null, revenue_status: clean(c.revenue_status) || null, closed_at: iso(c.closed_at) })),
    }
  })

  const series = rowScan ? executionSeries(texts, verdicts, replySellers.map((s) => s.first_reply_at), { nowMs }) : null
  const batches = runs ? batchesOf(runs, texts, verdicts, repliedKeys) : null

  const md = obj(campaign.metadata)
  return {
    ok: true,
    campaign_id: campaign.id,
    at: now.toISOString(),
    timezone: campaignZone(campaign),
    timezones: campaignWindowZones(campaign),
    day_start: dayStart.toISOString(),
    rows: rowScan ? { total: rowScan.total, read: rowScan.rows.length, truncated: rowScan.truncated, campaign_texts: texts.length, conversation: conversation.length, proof: (rowScan.rows.length - allRows.length) } : null,
    sellers: rowScan ? { left_us: leftUs.size, delivered: delivered.size, replied: replySellers.length } : null,
    delivery: funnel ? { ...funnel, carrier_verdicts_truncated: carrier?.truncated === true } : null,
    retries: rowScan ? retries : null,
    series,
    batches: batches ? { list: batches, placed_passes: runs.length, empty_passes: emptyPasses, latest_pass: feederDigest(md) } : null,
    feeder: { buffer_target: FEEDER_BUFFER_TARGET, chunk: FEEDER_HYDRATION_CHUNK },
    replies: responses
      ? {
        sellers_messaged: responses.sellers_messaged,
        sellers_replied: responses.sellers_replied,
        reply_messages: responses.reply_messages,
        sellers_asked_to_stop: responses.sellers_asked_to_stop,
        truncated: responses.truncated === true,
        buckets: replyBuckets,
        intents: responses.intents || {},
        list: replyList.slice(0, 200).map((s) => ({
          seller_phone: s.seller_phone, seller_name: s.seller_name, intent: s.intent, bucket: s.bucket, asked_to_stop: s.asked_to_stop,
          thread_key: s.thread_key, message: s.message, first_reply_at: s.first_reply_at, latest_reply_at: s.latest_reply_at, messages: s.messages,
        })),
      }
      : null,
    outcomes,
    templates: rowScan ? templates : null,
    fleet: fleet ? { numbers: fleet, system_cap: systemCap, campaign_cap: campaignCap, blocked_count: blockedSenders.size, today_truncated: fleetToday?.truncated === true } : null,
    routing,
    audience: targetScan ? { total: targetScan.total, truncated: targetScan.truncated, markets: marketTargets, ready_by_market: marketDemand, zones } : null,
    caps: {
      daily_cap: posInt(campaign.daily_cap),
      total_cap: posInt(campaign.total_cap),
      market_cap: posInt(campaign.market_cap),
      batch_max: posInt(campaign.batch_max),
      per_sender_cap: campaignCap,
      system_per_number_cap: systemCap,
      send_interval_seconds: posInt(campaign.send_interval_seconds),
    },
    unavailable: [...new Set(unavailable)],
  }
}

/* ══ GEO ════════════════════════════════════════════════════════════════ */

const GEO_TARGET_MAX_PAGES = 5
const GEO_ID_CHUNK = 200
/** Point state codes (compact): the furthest the target got. */
export const GEO_STATES = Object.freeze(['held', 'ready', 'planned', 'queued', 'sent', 'delivered', 'failed', 'replied', 'opportunity'])

/**
 * The campaign's targets as points, each with how far it got, and the
 * audience by county. Bounded at 5,000 targets — beyond that the result says
 * `sampled` and the map labels itself SAMPLE.
 */
export async function buildCampaignGeo(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaign, error } = await supabase.from('campaigns').select('id').eq('id', campaignId).maybeSingle()
  if (error) throw error
  if (!campaign) return { ok: false, status: 404, error: 'campaign_not_found' }

  const [targetScan, rowScan] = await Promise.all([
    scanAll((withCount) => supabase.from('campaign_targets')
      .select('id,property_id,to_phone_number,target_status,market', withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true }), GEO_TARGET_MAX_PAGES),
    scanAll((withCount) => supabase.from('send_queue')
      .select('id,campaign_target_id,to_phone_number,queue_status,type,source,sent_at,delivered_at,failed_reason,no_send:metadata->>no_send,proof_no_send:metadata->>proof_no_send,launch_mode:metadata->>launch_mode', withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true }), 6),
  ])
  const replies = deps.replies ?? await (deps.fetchResponses || fetchCampaignResponses)(campaignId, { supabase, includeSellers: true }).catch(() => null)
  const replied = new Set((replies?.sellers || []).map((s) => normalizePhone(s.seller_phone)).filter(Boolean))

  // How far each target's texts got. A delivered retry outranks the filtered
  // original; anything that left us outranks a row still waiting.
  const PRECEDENCE = { queued: 1, failed: 2, sent: 3, delivered: 4 }
  const stateByTarget = new Map()
  const leftUsTargets = new Set()
  const firstLeftUsByPhone = new Map()
  for (const row of rowScan.rows) {
    if (isProofQueueRow(row) || !isCampaignText(row)) continue
    const id = clean(row.campaign_target_id)
    const { disposition } = classifySend(row)
    const s = disposition === 'delivered' ? 'delivered'
      : disposition === 'sent' ? 'sent'
        : disposition === 'undelivered' || disposition === 'rejected' ? 'failed'
          : disposition === 'waiting' ? 'queued' : null
    if (LEFT_US.has(disposition)) {
      if (id) leftUsTargets.add(id)
      const phone = normalizePhone(row.to_phone_number)
      const at = ms(row.sent_at)
      if (phone && at !== null && (!firstLeftUsByPhone.has(phone) || at < firstLeftUsByPhone.get(phone))) firstLeftUsByPhone.set(phone, at)
    }
    if (!s || !id) continue
    const prev = stateByTarget.get(id)
    if (!prev || PRECEDENCE[s] > PRECEDENCE[prev]) stateByTarget.set(id, s)
  }

  // Opportunities: the intel rule — a replying seller's opportunity opened
  // after this campaign first messaged them.
  const opportunityPhones = new Set()
  const replierPhones = [...replied]
  for (const phones of chunk(replierPhones, PHONE_CHUNK)) {
    const { data, error: oError } = await supabase.from('acquisition_opportunities').select('primary_thread_key,created_at').in('primary_thread_key', phones)
    if (oError) throw oError
    for (const o of data || []) {
      const phone = normalizePhone(o.primary_thread_key)
      const first = phone ? firstLeftUsByPhone.get(phone) : undefined
      if (first !== undefined && (ms(o.created_at) ?? 0) > first) opportunityPhones.add(phone)
    }
  }

  const RANK = Object.fromEntries(GEO_STATES.map((s, i) => [s, i]))
  const targets = targetScan.rows
  const ids = [...new Set(targets.map((t) => clean(t.property_id)).filter(Boolean))]
  const props = new Map()
  for (const part of chunk(ids, GEO_ID_CHUNK)) {
    const { data, error: pError } = await supabase.from('properties')
      .select('property_id,latitude,longitude,property_address_county_name,property_address_city,property_address_state,property_address_zip')
      .in('property_id', part)
    if (pError) throw pError
    for (const p of data || []) props.set(clean(p.property_id), p)
  }

  const counties = new Map()
  const points = []
  let unlocated = 0
  for (const t of targets) {
    const p = props.get(clean(t.property_id)) || null
    const status = lower(t.target_status)
    let state = status === 'blocked' ? 'held' : status === 'ready' ? 'ready' : 'planned'
    const exec = stateByTarget.get(clean(t.id))
    if (exec) state = exec
    const phone = normalizePhone(t.to_phone_number)
    if (phone && replied.has(phone)) state = 'replied'
    if (phone && opportunityPhones.has(phone)) state = 'opportunity'
    const county = clean(p?.property_address_county_name) || null
    const st = clean(p?.property_address_state) || null
    const key = `${county || '—'}|${st || ''}`
    const c = counties.get(key) || { county, state: st, targets: 0, held: 0, sent: 0, delivered: 0, replied: 0, failed: 0, opportunities: 0 }
    c.targets += 1
    if (state === 'held') c.held += 1
    if (leftUsTargets.has(clean(t.id))) c.sent += 1
    if (['delivered', 'replied', 'opportunity'].includes(state)) c.delivered += 1
    if (state === 'replied' || state === 'opportunity') c.replied += 1
    if (state === 'opportunity') c.opportunities += 1
    if (state === 'failed') c.failed += 1
    counties.set(key, c)
    const lat = Number(p?.latitude)
    const lng = Number(p?.longitude)
    if (!p || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 0.1) { unlocated += 1; continue }
    points.push([Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, RANK[state]])
  }

  return {
    ok: true,
    campaign_id: campaignId,
    states: GEO_STATES,
    total_targets: targetScan.total,
    sampled: targetScan.truncated,
    located: points.length,
    unlocated,
    rows_truncated: rowScan.truncated,
    points,
    counties: [...counties.values()].sort((a, b) => b.targets - a.targets).slice(0, 40),
    county_count: counties.size,
  }
}

/* ══ cached entry points (routes) ═══════════════════════════════════════════
   Viewers of the same campaign share one computation for a few seconds, and
   a stalled upstream read is abandoned at its ceiling (the route answers 503
   and the room keeps its last good read on screen). */

export const readCampaignIntel = (campaignId) => singleFlight(`intel:${campaignId}`, 15_000, 55_000, () => buildCampaignIntel(campaignId))
export const readCampaignGeo = (campaignId) => singleFlight(`geo:${campaignId}`, 60_000, 55_000, () => buildCampaignGeo(campaignId))
