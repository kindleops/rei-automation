/**
 * CAMPAIGN COCKPIT — the live-execution read behind Campaign Command's desktop
 * operating room.
 *
 * READ-ONLY BY CONSTRUCTION. Every call below is a select, a head count, or a
 * read-only aggregate RPC. Nothing is written, claimed, recomputed or
 * "synced" into the campaign row — the progress recompute path writes
 * counters, so it is deliberately not used here.
 *
 * WHY IT EXISTS. The campaign list and detail read models answer "how many",
 * not "is it moving": they do not expose the live queue's due / overdue rows,
 * why the processor last released a row, which numbers are carrying the
 * campaign today, the contact window in the campaign's own zone, the feeder's
 * heartbeat and the operational event timeline. The operating room needs
 * exactly those, for one campaign, in one bounded request.
 *
 * NOTHING IS RE-DECIDED HERE. Pacing comes from the feeder's own exported
 * `resolveFeedLimit`, the day boundary from its `campaignDayStart`, the
 * contact window from the canonical `contactWindowState`, exceptions from the
 * canonical failure classifier, replies from the canonical responses read. A
 * section that cannot be read is reported in `unavailable` — never as zero.
 *
 * BOUNDED. Every scan is paged with an exact count and a page ceiling, and
 * reports `truncated` when the ceiling is reached (PostgREST silently caps a
 * response at its max-rows, so an unpaged `.limit()` above it would lie).
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { contactWindowState } from '@/lib/domain/map/map-world-service.js'
import {
  FEEDER_BUFFER_TARGET,
  FEEDER_HYDRATION_CHUNK,
  campaignDayStart,
  resolveFeedLimit,
} from '@/lib/domain/campaigns/run-campaign-outbound-feeder.js'
import { fetchCampaignSendStateCounts } from '@/lib/domain/campaigns/campaign-recipient-metrics.js'
import { fetchCampaignResponses } from '@/lib/domain/campaigns/campaign-responses.js'
import { fetchCampaignFailureRows } from '@/lib/domain/campaigns/campaign-failures.js'
import { describeCampaignLineage, explicitPropertyIds } from '@/lib/domain/campaigns/campaign-lineage.js'
import {
  ACTIVE_QUEUE_STATUSES,
  OVERDUE_GRACE_MS,
  isProofQueueRow,
  summarizeActiveQueue,
} from '@/lib/domain/campaigns/campaign-live-queue.js'

export { ACTIVE_QUEUE_STATUSES, OVERDUE_GRACE_MS, isProofQueueRow, summarizeActiveQueue }

/**
 * The ONLY system_control keys this read touches. That table also holds
 * credentials (the queue engine's shared secret among them); a `select('*')`
 * here would hand them to a browser. Allowlisted, and pinned by a test.
 */
export const COCKPIT_CONTROL_KEYS = Object.freeze([
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
])


const PAGE = 1000
const ACTIVE_MAX_PAGES = 5
const GEO_MAX_PAGES = 5
const TIMELINE_LIMIT = 40
const REFILL_LIMIT = 20
const RECENT_SENDER_SAMPLE = 300
const LATEST_REPLIES = 20
const FEEDER_DAY_FALLBACK_TZ = 'America/New_York' // the feeder's own fallback

const CAMPAIGN_COLUMNS = [
  'id', 'name', 'status', 'daily_cap', 'total_cap', 'batch_max', 'market_cap', 'per_sender_cap',
  'send_interval_seconds', 'contact_window_start', 'contact_window_end', 'auto_queue_enabled',
  'auto_send_enabled', 'auto_reply_mode', 'emergency_stop_at', 'scheduled_for', 'activated_at',
  'paused_at', 'resumed_at', 'completed_at', 'execution_heartbeat_at', 'created_at', 'updated_at',
  'last_transition_reason', 'last_transition_at', 'metadata',
].join(',')

const ACTIVE_ROW_SELECT = [
  'id', 'queue_status', 'scheduled_for', 'scheduled_for_utc', 'from_phone_number', 'updated_at',
  'skip_reason:metadata->>skip_reason',
  'no_send:metadata->>no_send',
  'proof_no_send:metadata->>proof_no_send',
  'launch_mode:metadata->>launch_mode',
  'spam_retry_generation:metadata->>spam_retry_generation',
  'processing_started_at:metadata->>processing_started_at',
  'finalized_at:metadata->>finalized_at',
].join(',')

const clean = (value) => String(value ?? '').trim()
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const truthy = (value) => ['true', '1', 'yes', 'on'].includes(clean(value).toLowerCase())
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null)
const posInt = (value) => {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}
const hhmm = (value) => (/^\d{1,2}:\d{2}$/.test(clean(value)) ? clean(value).padStart(5, '0') : null)
const iso = (value) => {
  const t = Date.parse(clean(value))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

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

async function headCount(query) {
  const { count, error } = await query
  if (error) throw error
  return Number(count || 0)
}

/** The canonical sent/delivered/failed triple (campaign list semantics). */
function resolveSendTruth(bucket) {
  if (!bucket) return null
  const n = (key) => Number(bucket[key] || 0)
  return { sent: n('sent') + n('delivered'), delivered: n('delivered'), failed: n('failed') + n('failed_transport') }
}

function controlMap(rows = []) {
  const out = {}
  for (const row of rows) {
    if (COCKPIT_CONTROL_KEYS.includes(row.key)) out[row.key] = row.value
  }
  return out
}

function splitList(value) {
  return clean(value).split(',').map((v) => clean(v)).filter(Boolean)
}

/** Infinity (no cap) is not JSON; it is reported as null with the cap itself. */
function feedView(feed) {
  return {
    limit: feed.limit,
    bound: feed.bound,
    buffer_need: feed.buffer_need,
    daily_remaining: finiteOrNull(feed.daily_remaining),
    total_remaining: finiteOrNull(feed.total_remaining),
    buffer_target: FEEDER_BUFFER_TARGET,
    chunk: FEEDER_HYDRATION_CHUNK,
  }
}

function eventView(row) {
  const blockers = Array.isArray(row.blockers) ? row.blockers.map((b) => clean(typeof b === 'string' ? b : b?.code || b?.reason)).filter(Boolean).slice(0, 5) : []
  const rows = Number(row.rows_created)
  return {
    id: row.id,
    type: clean(row.event_type) || 'event',
    severity: clean(row.severity) || 'info',
    title: clean(row.title) || null,
    description: clean(row.description) || null,
    at: row.created_at,
    rows_created: Number.isFinite(rows) ? rows : null,
    blockers,
  }
}

/**
 * Target counts by status, and block reasons BY STATUS.
 *
 * `campaign_target_status_counts` groups by (status, block_reason), and the
 * shared helper folds every reason into one bag regardless of status. That
 * reads 395 Minneapolis targets as "held for template rotation" when they are
 * planned and queued — the reason is an advisory left on the row, not a hold.
 * Here a reason only counts as a HOLD on a `blocked` target; on any other
 * status it is reported separately as an advisory.
 */
async function loadTargetBreakdown(supabase, campaignId) {
  let rows = null
  if (typeof supabase?.rpc === 'function') {
    const { data, error } = await supabase.rpc('campaign_target_status_counts', { p_campaign_ids: [campaignId] })
    if (!error && Array.isArray(data)) rows = data
    else if (error) {
      const message = String(error.message || '').toLowerCase()
      const missing = error.code === 'PGRST202' || message.includes('does not exist') || message.includes('not find')
      if (!missing) throw error
    }
  }
  if (!rows) {
    // No aggregate available: count from the rows themselves, paged exactly.
    const scan = await scanAll((withCount) => supabase.from('campaign_targets')
      .select('target_status,block_reason', withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true }), 25)
    rows = scan.rows.map((r) => ({ target_status: r.target_status, block_reason: r.block_reason, row_count: 1 }))
  }
  const statuses = {}
  const heldByReason = {}
  const advisories = {}
  let total = 0
  for (const row of rows) {
    const n = Number(row.row_count || 0)
    const status = clean(row.target_status) || 'unknown'
    const reason = clean(row.block_reason)
    total += n
    statuses[status] = (statuses[status] || 0) + n
    if (!reason) continue
    if (status === 'blocked') heldByReason[reason] = (heldByReason[reason] || 0) + n
    else {
      const bucket = advisories[status] || (advisories[status] = {})
      bucket[reason] = (bucket[reason] || 0) + n
    }
  }
  return { statuses, held_by_reason: heldByReason, advisories, total }
}

/**
 * @param {string} campaignId
 * @param {{ supabase?: object, now?: string|number|Date,
 *           fetchResponses?: Function, fetchFailures?: Function }} deps
 */
export async function buildCampaignCockpit(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now ? new Date(deps.now) : new Date()
  const nowMs = now.getTime()

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('id', campaignId)
    .maybeSingle()
  if (campaignError) throw campaignError
  if (!campaign) return { ok: false, status: 404, error: 'campaign_not_found' }

  const md = obj(campaign.metadata)
  const lineage = describeCampaignLineage(campaign)
  const dayTimezone = clean(md.timezone || md.launch_timezone) || FEEDER_DAY_FALLBACK_TZ
  const dayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: dayTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((p) => [p.type, p.value]))
  const dayStart = campaignDayStart(now, dayTimezone, dayParts).toISOString()
  const hourAgo = new Date(nowMs - 60 * 60 * 1000).toISOString()

  const unavailable = []
  // One failed section degrades that section only — it is named, never zeroed.
  const guard = async (name, fn) => {
    try { return await fn() } catch (error) {
      unavailable.push(name)
      if (deps.onSectionError) deps.onSectionError(name, error)
      return null
    }
  }

  const sq = () => supabase.from('send_queue')
  const [
    controlRows, targetCounts, sendStates, activeScan, sentToday, lastSent, firstSent,
    failedLastHour, events, refills, idleCount, idleLast, geoScan, responses, failures,
    emailRows, emailSenders, recentSends,
  ] = await Promise.all([
    guard('controls', async () => {
      const { data, error } = await supabase.from('system_control').select('key,value').in('key', [...COCKPIT_CONTROL_KEYS])
      if (error) throw error
      return data || []
    }),
    guard('targets', () => loadTargetBreakdown(supabase, campaignId)),
    guard('send_states', async () => {
      const map = await fetchCampaignSendStateCounts([campaignId], { supabase })
      if (!map) throw new Error('send_state_counts_unavailable')
      return map.get(campaignId) || {}
    }),
    guard('queue', () => scanAll((withCount) => sq()
      .select(ACTIVE_ROW_SELECT, withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .in('queue_status', [...ACTIVE_QUEUE_STATUSES])
      .order('scheduled_for', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true }), ACTIVE_MAX_PAGES)),
    // The feeder's own "sent today" (countSentToday): the same statuses, the
    // same local-midnight boundary, so the pacing below agrees with it.
    guard('sent_today', () => headCount(sq()
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('queue_status', ['sent', 'delivered', 'sending', 'processing'])
      .gte('updated_at', dayStart))),
    guard('last_sent', async () => {
      const { data, error } = await sq().select('sent_at').eq('campaign_id', campaignId).not('sent_at', 'is', null)
        .order('sent_at', { ascending: false }).limit(1)
      if (error) throw error
      return data?.[0]?.sent_at || null
    }),
    guard('first_sent', async () => {
      const { data, error } = await sq().select('sent_at').eq('campaign_id', campaignId).not('sent_at', 'is', null)
        .order('sent_at', { ascending: true }).limit(1)
      if (error) throw error
      return data?.[0]?.sent_at || null
    }),
    guard('failed_last_hour', () => headCount(sq()
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('queue_status', ['failed', 'failed_transport'])
      .gte('updated_at', hourAgo))),
    guard('timeline', async () => {
      const { data, error } = await supabase.from('campaign_events')
        .select('id,event_type,severity,title,description,created_at,rows_created:metadata->>send_queue_rows_created,blockers:metadata->blockers')
        .eq('campaign_id', campaignId)
        .neq('event_type', 'campaign.launch_scheduled')
        .order('created_at', { ascending: false })
        .limit(TIMELINE_LIMIT)
      if (error) throw error
      return data || []
    }),
    // Refills that placed rows are operational; the feeder's no-op checks
    // (every five minutes) are collapsed into one count below.
    guard('timeline', async () => {
      const { data, error } = await supabase.from('campaign_events')
        .select('id,event_type,severity,title,description,created_at,rows_created:metadata->>send_queue_rows_created,blockers:metadata->blockers')
        .eq('campaign_id', campaignId)
        .eq('event_type', 'campaign.launch_scheduled')
        .gt('metadata->>send_queue_rows_created', '0')
        .order('created_at', { ascending: false })
        .limit(REFILL_LIMIT)
      if (error) throw error
      return (data || []).filter((row) => Number(row.rows_created) > 0)
    }),
    guard('timeline', () => headCount(supabase.from('campaign_events')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('event_type', 'campaign.launch_scheduled')
      .eq('metadata->>send_queue_rows_created', '0'))),
    guard('timeline', async () => {
      const { data, error } = await supabase.from('campaign_events').select('created_at')
        .eq('campaign_id', campaignId)
        .eq('event_type', 'campaign.launch_scheduled')
        .eq('metadata->>send_queue_rows_created', '0')
        .order('created_at', { ascending: false })
        .limit(1)
      if (error) throw error
      return data?.[0]?.created_at || null
    }),
    guard('geography', () => scanAll((withCount) => supabase.from('campaign_targets')
      .select('market,state', withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true }), GEO_MAX_PAGES)),
    guard('responses', () => (deps.fetchResponses || fetchCampaignResponses)(campaignId, { supabase })),
    guard('exceptions', () => (deps.fetchFailures || fetchCampaignFailureRows)(campaignId, { supabase, includeRows: false })),
    guard('email', () => headCount(supabase.from('email_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId))),
    guard('email', () => headCount(supabase.from('email_senders').select('id', { count: 'exact', head: true }))),
    guard('senders', async () => {
      const { data, error } = await sq()
        .select('from_phone_number,queue_status,sent_at')
        .eq('campaign_id', campaignId)
        .not('sent_at', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(RECENT_SENDER_SAMPLE)
      if (error) throw error
      return data || []
    }),
  ])

  // A read that answered "not ok" is as unavailable as one that threw.
  if (responses && responses.ok !== true) unavailable.push('responses')
  if (failures && failures.ok !== true) unavailable.push('exceptions')

  const controls = controlMap(controlRows || [])
  // Due-ness is the processor's: scheduled_for_utc, falling back to
  // scheduled_for (shouldRunSendQueueRow). The two drift apart when rows are
  // re-spaced, and reading the wrong one invents (or hides) overdue work.
  const dueRows = activeScan ? activeScan.rows.map((row) => ({ ...row, scheduled_for: row.scheduled_for_utc || row.scheduled_for })) : null
  const queue = activeScan ? { ...summarizeActiveQueue(dueRows, nowMs), truncated: activeScan.truncated } : null

  // ── pacing: the feeder's own arithmetic, with today's real inputs ────────
  const statuses = targetCounts?.statuses || {}
  const readyRemaining = Number(statuses.ready || 0)
  const heldTargets = Number(statuses.blocked || 0)
  const totalTargets = Number(targetCounts?.total || 0)
  const committedTargets = Math.max(0, totalTargets - readyRemaining - heldTargets)
  const feed = queue && targetCounts && sentToday !== null
    ? feedView(resolveFeedLimit({ campaign, activeLiveRows: queue.live, readyRemaining, committedTargets, sentToday }))
    : null

  // ── contact window, in the campaign's own zone ───────────────────────────
  const windowSpec = {
    start: hhmm(campaign.contact_window_start) || hhmm(controls.queue_contact_window_start),
    end: hhmm(campaign.contact_window_end) || hhmm(controls.queue_contact_window_end),
  }
  const windowSource = hhmm(campaign.contact_window_start) && hhmm(campaign.contact_window_end) ? 'campaign' : 'operator'
  const windowState = lineage.timezone && windowSpec.start && windowSpec.end
    ? contactWindowState(nowMs, lineage.timezone, windowSpec)
    : null

  // ── senders: who is carrying this campaign ───────────────────────────────
  const sentTodayBySender = {}
  const lastSentBySender = {}
  for (const row of recentSends || []) {
    const phone = clean(row.from_phone_number)
    if (!phone) continue
    if (!lastSentBySender[phone]) lastSentBySender[phone] = row.sent_at
    if (clean(row.sent_at) >= dayStart) sentTodayBySender[phone] = (sentTodayBySender[phone] || 0) + 1
  }
  const markets = []
  if (geoScan) {
    const byMarket = new Map()
    for (const row of geoScan.rows) {
      const market = clean(row.market) || null
      const key = `${market || ''}|${clean(row.state)}`
      const entry = byMarket.get(key) || { market, state: clean(row.state) || null, targets: 0 }
      entry.targets += 1
      byMarket.set(key, entry)
    }
    markets.push(...[...byMarket.values()].sort((a, b) => b.targets - a.targets))
  }
  const senderPhones = [...new Set([
    ...Object.keys(queue?.by_sender || {}),
    ...Object.keys(lastSentBySender),
  ])]
  const poolMarkets = markets.map((m) => m.market).filter(Boolean).slice(0, 5)
  const [numberRows, poolRows] = await Promise.all([
    senderPhones.length
      ? guard('senders', async () => {
        const { data, error } = await supabase.from('textgrid_numbers')
          .select('phone_number,friendly_name,market,status,health_state,health_reason,cooling_until,spam_flagged_at,daily_limit,last_used_at')
          .in('phone_number', senderPhones)
        if (error) throw error
        return data || []
      })
      : [],
    poolMarkets.length
      ? guard('senders', async () => {
        const { data, error } = await supabase.from('textgrid_numbers')
          .select('phone_number,friendly_name,market,status,health_state,health_reason,cooling_until,spam_flagged_at,daily_limit,last_used_at')
          .in('market', poolMarkets)
        if (error) throw error
        return data || []
      })
      : [],
  ])
  const blockedSenders = new Set(splitList(controls.sms_blocked_sender_numbers))
  const configuredCap = posInt(controls.queue_per_number_cap)
  const campaignCap = posInt(campaign.per_sender_cap)
  const numbers = new Map()
  for (const row of [...(numberRows || []), ...(poolRows || [])]) numbers.set(clean(row.phone_number), row)
  const carrying = new Set(senderPhones)
  const senders = [...new Set([...senderPhones, ...numbers.keys()])].filter(Boolean).map((phone) => {
    const n = numbers.get(phone) || null
    return {
      phone,
      label: clean(n?.friendly_name) || null,
      market: clean(n?.market) || null,
      known: Boolean(n),
      status: clean(n?.status) || null,
      health_state: clean(n?.health_state) || null,
      health_reason: clean(n?.health_reason) || null,
      cooling_until: n?.cooling_until || null,
      spam_flagged_at: n?.spam_flagged_at || null,
      operator_blocked: blockedSenders.has(phone),
      daily_limit: posInt(n?.daily_limit),
      carrying_campaign: carrying.has(phone),
      campaign_queued: Number(queue?.by_sender?.[phone] || 0),
      campaign_sent_today: Number(sentTodayBySender[phone] || 0),
      campaign_last_sent_at: lastSentBySender[phone] || null,
      last_used_at: n?.last_used_at || null,
    }
  }).sort((a, b) => Number(b.carrying_campaign) - Number(a.carrying_campaign) || b.campaign_queued - a.campaign_queued || a.phone.localeCompare(b.phone))

  const quarantine = obj(md.quarantine)
  const feederLast = obj(md.feeder_last)

  const timeline = [
    ...(events || []).map(eventView),
    ...(refills || []).map(eventView),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  return {
    ok: true,
    campaign_id: campaign.id,
    at: now.toISOString(),
    name: campaign.name,
    status: campaign.status,
    lineage,
    lifecycle: {
      created_at: campaign.created_at,
      scheduled_for: campaign.scheduled_for,
      activated_at: campaign.activated_at,
      paused_at: campaign.paused_at,
      resumed_at: campaign.resumed_at,
      completed_at: campaign.completed_at,
      last_transition_reason: clean(campaign.last_transition_reason) || null,
      last_transition_at: campaign.last_transition_at || null,
      execution_heartbeat_at: campaign.execution_heartbeat_at || null,
      schedule_missed_for: iso(md.schedule_missed_for),
      schedule_missed_at: iso(md.schedule_missed_at),
    },
    flags: {
      auto_queue_enabled: Boolean(campaign.auto_queue_enabled),
      auto_send_enabled: Boolean(campaign.auto_send_enabled),
      auto_reply_mode: clean(campaign.auto_reply_mode) || null,
      emergency_stop_at: campaign.emergency_stop_at || null,
      production_launch: md.production_launch === true || Boolean(clean(md.converted_to_live_at)),
      quarantine: quarantine.active === true
        ? {
          reason: clean(quarantine.reason) || null,
          detail: clean(quarantine.detail) || null,
          quarantined_at: iso(quarantine.quarantined_at),
          target_rows: posInt(quarantine.target_rows),
          selected_properties: posInt(quarantine.selected_properties),
          rows_outside_selection: Number.isFinite(Number(quarantine.rows_outside_selection)) ? Number(quarantine.rows_outside_selection) : null,
        }
        : null,
    },
    caps: {
      daily_cap: posInt(campaign.daily_cap),
      total_cap: posInt(campaign.total_cap),
      market_cap: posInt(campaign.market_cap),
      per_sender_cap: campaignCap,
      configured_per_number_cap: configuredCap,
      batch_max: posInt(campaign.batch_max),
      send_interval_seconds: posInt(campaign.send_interval_seconds),
    },
    targets: targetCounts
      ? {
        total: totalTargets,
        by_status: statuses,
        held_by_reason: targetCounts.held_by_reason,
        advisories: targetCounts.advisories,
        ready: readyRemaining,
        held: heldTargets,
        committed: committedTargets,
      }
      : null,
    send_states: sendStates ? { by_status: sendStates, ...resolveSendTruth(sendStates) } : null,
    queue,
    sends: {
      sent_today: sentToday,
      day_start: dayStart,
      day_timezone: dayTimezone,
      day_timezone_basis: clean(md.timezone || md.launch_timezone) ? 'campaign' : 'feeder_default',
      last_sent_at: lastSent ?? null,
      first_sent_at: firstSent ?? null,
      failed_last_hour: failedLastHour,
    },
    feed,
    window: windowState
      ? { ...windowState, timezone: lineage.timezone, source: windowSource }
      : { open: null, timezone: lineage.timezone, source: windowSource, reason: lineage.timezone ? 'window_unreadable' : 'campaign_timezone_unset' },
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
      campaign_last: feederLast.at
        ? {
          at: iso(feederLast.at),
          inserted: Number(feederLast.inserted || 0),
          bound: clean(feederLast.bound) || null,
          reason: clean(feederLast.reason) || null,
          stalled: feederLast.stalled === true,
          ready_remaining: Number(feederLast.ready_remaining ?? 0),
          active_live_rows: Number(feederLast.active_live_rows ?? 0),
          last_refill_at: iso(feederLast.last_refill_at),
          skipped_counts_by_reason: obj(feederLast.skipped_counts_by_reason),
          skip_summary: clean(feederLast.skip_summary) || null,
          routing_blocks_by_market: obj(feederLast.routing_blocks_by_market),
        }
        : null,
    },
    senders,
    email: {
      campaign_rows: emailRows,
      sender_identities: emailSenders,
    },
    responses: responses?.ok
      ? {
        sellers_messaged: responses.sellers_messaged,
        sellers_replied: responses.sellers_replied,
        reply_messages: responses.reply_messages,
        sellers_asked_to_stop: responses.sellers_asked_to_stop,
        latest_reply_at: responses.latest_reply_at,
        truncated: responses.truncated === true,
        intents: responses.intents || {},
        latest: (responses.latest || []).slice(0, LATEST_REPLIES),
      }
      : null,
    exceptions: failures?.ok
      ? {
        run_id: failures.run_id || null,
        execution: { total: failures.execution.total, truncated: failures.execution.truncated === true, groups: failures.execution.groups },
        target_preparation: { total: failures.target_preparation.total, truncated: failures.target_preparation.truncated === true, groups: failures.target_preparation.groups },
      }
      : null,
    geography: geoScan ? { markets: markets.slice(0, 12), market_count: markets.length, total: geoScan.total, truncated: geoScan.truncated } : null,
    timeline: {
      events: timeline,
      idle_feeder_checks: idleCount === null ? null : { count: idleCount, last_at: idleLast || null },
    },
    unavailable: [...new Set(unavailable)],
  }
}

// ── targets, one page, with what happened to each ──────────────────────────

const TARGET_SELECT = [
  'id', 'property_id', 'master_owner_id', 'prospect_id', 'owner_name', 'property_address', 'market', 'state',
  'to_phone_number', 'target_status', 'block_reason', 'identity_status', 'routing_status', 'suppression_status',
  'template_status', 'priority_score', 'touch_number', 'updated_at',
].join(',')

const TARGET_QUEUE_SELECT = [
  'id', 'campaign_target_id', 'queue_status', 'scheduled_for', 'sent_at', 'delivered_at', 'failed_reason',
  'guard_reason', 'from_phone_number', 'to_phone_number', 'thread_key', 'created_at', 'updated_at',
  'skip_reason:metadata->>skip_reason',
  'no_send:metadata->>no_send',
  'proof_no_send:metadata->>proof_no_send',
  'launch_mode:metadata->>launch_mode',
].join(',')

export const TARGET_PAGE_MAX = 100
const TARGET_STATUS_FILTERS = new Map([['ready', 'ready'], ['planned', 'planned'], ['blocked', 'blocked'], ['held', 'blocked']])
const TARGET_QUEUE_CAP = 1000
const REPLY_PHONE_CHUNK = 40
const REPLY_MESSAGE_CAP = 1000
const STOP_INTENTS = new Set(['opt_out', 'stop', 'unsubscribe', 'dnc'])

/** PostgREST `or()` syntax characters are stripped: a search is words, not a filter. */
export function sanitizeTargetSearch(value) {
  return clean(value).replace(/[,()*%\\"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** A held reason is a canonical code (`entity_contact_requires_review`, `insufficient_template_rotation_pool:auto:0<2`) — nothing else passes. */
export function sanitizeBlockReason(value) {
  const v = clean(value)
  return /^[A-Za-z0-9_:.<>=-]{1,120}$/.test(v) ? v : null
}

export function clampTargetPage({ page, pageSize } = {}) {
  const p = Math.max(1, Math.trunc(Number(page)) || 1)
  const size = Math.min(TARGET_PAGE_MAX, Math.max(10, Math.trunc(Number(pageSize)) || 50))
  return { page: p, pageSize: size }
}

/**
 * @param {string} campaignId
 * @param {{ page?: number, pageSize?: number, status?: string, search?: string }} params
 * @param {{ supabase?: object }} deps
 */
export async function buildCampaignTargetPage(campaignId, params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { page, pageSize } = clampTargetPage(params)
  const status = TARGET_STATUS_FILTERS.get(clean(params.status).toLowerCase()) || null
  const search = sanitizeTargetSearch(params.search)
  const reason = sanitizeBlockReason(params.reason)

  let query = supabase.from('campaign_targets')
    .select(TARGET_SELECT, { count: 'exact' })
    .eq('campaign_id', campaignId)
  if (status) query = query.eq('target_status', status)
  if (reason) query = query.eq('block_reason', reason)
  if (search) {
    const like = `%${search}%`
    query = query.or(`owner_name.ilike.${like},property_address.ilike.${like},to_phone_number.ilike.${like},market.ilike.${like}`)
  }
  // Stable order: priority is not unique, so `id` breaks ties across pages.
  const from = (page - 1) * pageSize
  const { data: targets, error, count } = await query
    .order('priority_score', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1)
  if (error) throw error
  const rows = targets || []
  const total = Number(count || 0)
  const ids = rows.map((t) => t.id)

  // What the queue did with each target on this page. Proof rows never
  // transmitted and are counted apart; the newest live row is the state.
  let queueRows = []
  let queueTruncated = false
  if (ids.length) {
    const { data, error: qError } = await supabase.from('send_queue')
      .select(TARGET_QUEUE_SELECT)
      .eq('campaign_id', campaignId)
      .in('campaign_target_id', ids)
      .order('created_at', { ascending: false })
      .limit(TARGET_QUEUE_CAP)
    if (qError) throw qError
    queueRows = data || []
    queueTruncated = queueRows.length >= TARGET_QUEUE_CAP
  }
  const byTarget = new Map()
  for (const row of queueRows) {
    const id = clean(row.campaign_target_id)
    if (!id) continue
    const entry = byTarget.get(id) || { live: [], proof: 0 }
    if (isProofQueueRow(row)) entry.proof += 1
    else entry.live.push(row)
    byTarget.set(id, entry)
  }

  // Replies: an inbound message FROM the seller's number TO the number that
  // messaged them, after it did — the campaign-responses definition.
  const firstSent = new Map()
  for (const row of queueRows) {
    if (isProofQueueRow(row) || !row.sent_at) continue
    const key = `${clean(row.to_phone_number)}|${clean(row.from_phone_number)}`
    const prev = firstSent.get(key)
    if (!prev || Date.parse(row.sent_at) < Date.parse(prev)) firstSent.set(key, row.sent_at)
  }
  const sellerPhones = [...new Set([...firstSent.keys()].map((k) => k.split('|')[0]).filter(Boolean))]
  const replies = new Map()
  let repliesTruncated = false
  if (sellerPhones.length) {
    const earliest = [...firstSent.values()].reduce((min, at) => (Date.parse(at) < Date.parse(min) ? at : min))
    const chunks = []
    for (let i = 0; i < sellerPhones.length; i += REPLY_PHONE_CHUNK) chunks.push(sellerPhones.slice(i, i + REPLY_PHONE_CHUNK))
    const results = await Promise.all(chunks.map((chunk) => supabase.from('message_events')
      .select('from_phone_number,to_phone_number,created_at,detected_intent,is_opt_out,thread_key')
      .eq('direction', 'inbound')
      .in('from_phone_number', chunk)
      .gte('created_at', earliest)
      .order('created_at', { ascending: false })
      .limit(REPLY_MESSAGE_CAP)))
    for (const { data, error: rError } of results) {
      if (rError) throw rError
      if ((data || []).length >= REPLY_MESSAGE_CAP) repliesTruncated = true
      for (const msg of data || []) {
        const first = firstSent.get(`${clean(msg.from_phone_number)}|${clean(msg.to_phone_number)}`)
        if (!first || Date.parse(msg.created_at) <= Date.parse(first)) continue
        const seller = clean(msg.from_phone_number)
        const prev = replies.get(seller)
        const stop = msg.is_opt_out === true || STOP_INTENTS.has(clean(msg.detected_intent).toLowerCase())
        if (!prev) {
          replies.set(seller, { at: msg.created_at, intent: clean(msg.detected_intent) || null, thread_key: clean(msg.thread_key) || null, asked_to_stop: stop, messages: 1 })
        } else {
          prev.messages += 1
          prev.asked_to_stop = prev.asked_to_stop || stop
        }
      }
    }
  }

  const out = rows.map((t) => {
    const entry = byTarget.get(t.id) || { live: [], proof: 0 }
    const latest = entry.live[0] || null
    const threadKey = entry.live.map((r) => clean(r.thread_key)).find(Boolean) || null
    const reply = replies.get(clean(t.to_phone_number)) || null
    return {
      id: t.id,
      property_id: clean(t.property_id) || null,
      master_owner_id: clean(t.master_owner_id) || null,
      prospect_id: clean(t.prospect_id) || null,
      seller: clean(t.owner_name) || null,
      property: clean(t.property_address) || null,
      market: clean(t.market) || null,
      state: clean(t.state) || null,
      phone: clean(t.to_phone_number) || null,
      target_status: clean(t.target_status) || null,
      block_reason: clean(t.block_reason) || null,
      identity_status: clean(t.identity_status) || null,
      routing_status: clean(t.routing_status) || null,
      suppression_status: clean(t.suppression_status) || null,
      template_status: clean(t.template_status) || null,
      priority_score: t.priority_score === null || t.priority_score === undefined ? null : Number(t.priority_score),
      touch_number: t.touch_number ?? null,
      queue: latest
        ? {
          id: latest.id,
          status: clean(latest.queue_status) || null,
          scheduled_for: latest.scheduled_for || null,
          sent_at: latest.sent_at || null,
          delivered_at: latest.delivered_at || null,
          reason: clean(latest.failed_reason || latest.guard_reason || latest.skip_reason) || null,
          from: clean(latest.from_phone_number) || null,
          updated_at: latest.updated_at || null,
        }
        : null,
      queue_rows: entry.live.length,
      proof_rows: entry.proof,
      thread_key: reply?.thread_key || threadKey,
      reply,
    }
  })

  return {
    ok: true,
    campaign_id: campaignId,
    page,
    page_size: pageSize,
    total,
    total_pages: total ? Math.ceil(total / pageSize) : 0,
    status: status || 'all',
    search: search || null,
    reason: reason || null,
    truncated: { queue: queueTruncated, replies: repliesTruncated },
    targets: out,
  }
}

// ── the exact cohort, as map points ─────────────────────────────────────────

/** The Map's focus-set ceiling (domain/map/map-focus-set.ts). */
export const COHORT_POINT_MAX = 5000
const COHORT_ID_CHUNK = 200
const COHORT_TARGET_MAX_PAGES = 5

/**
 * The campaign's cohort as coordinates, for the Map's focus set.
 *
 * A Map-area or Entity Graph campaign pinned an exact property-id list: that
 * list IS the source cohort, and it is what is returned — never the targets
 * built from it, and never a re-query of the area. A filter campaign has no
 * pinned list; its built audience (campaign_targets.property_id) is returned
 * and labelled as the audience, not as a source. Properties without
 * coordinates are counted, never placed.
 */
export async function buildCampaignCohortPoints(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaign, error } = await supabase.from('campaigns').select('id,name,metadata').eq('id', campaignId).maybeSingle()
  if (error) throw error
  if (!campaign) return { ok: false, status: 404, error: 'campaign_not_found' }

  const lineage = describeCampaignLineage(campaign)
  let ids = explicitPropertyIds(campaign.metadata)
  let basis = 'source_cohort'
  let idsTruncated = false
  if (!ids.length) {
    basis = 'audience'
    const scan = await scanAll((withCount) => supabase.from('campaign_targets')
      .select('property_id', withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true }), COHORT_TARGET_MAX_PAGES)
    idsTruncated = scan.truncated
    ids = [...new Set(scan.rows.map((r) => clean(r.property_id)).filter(Boolean))]
  }
  const totalIds = ids.length
  if (ids.length > COHORT_POINT_MAX) { ids = ids.slice(0, COHORT_POINT_MAX); idsTruncated = true }

  const chunks = []
  for (let i = 0; i < ids.length; i += COHORT_ID_CHUNK) chunks.push(ids.slice(i, i + COHORT_ID_CHUNK))
  const results = await Promise.all(chunks.map((chunk) => supabase.from('properties')
    .select('property_id,latitude,longitude,property_address_full')
    .in('property_id', chunk)))
  const points = []
  for (const { data, error: pError } of results) {
    if (pError) throw pError
    for (const row of data || []) {
      const lat = Number(row.latitude)
      const lng = Number(row.longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 0.1) continue
      points.push({ id: clean(row.property_id), lat, lng, label: clean(row.property_address_full) || null })
    }
  }

  return {
    ok: true,
    campaign_id: campaign.id,
    basis,
    source_kind: lineage.kind,
    total_ids: totalIds,
    located: points.length,
    missing: Math.max(0, Math.min(totalIds, COHORT_POINT_MAX) - points.length),
    truncated: idsTruncated,
    area: lineage.area,
    points,
  }
}

// ── markets across the book, for the campaign navigation filter ────────────

const MARKET_INDEX_CAMPAIGN_CAP = 200
const MARKET_INDEX_MAX_PAGES = 20
const MARKET_INDEX_TOP = 3

/**
 * Which markets each campaign's audience is in, from campaign_targets.market —
 * never from the campaign's name. One paged read over the non-archived book,
 * loaded once by the navigation's market filter and search.
 */
export async function buildCampaignMarketIndex(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaigns, error } = await supabase.from('campaigns')
    .select('id')
    .neq('status', 'archived')
    .order('created_at', { ascending: false })
    .limit(MARKET_INDEX_CAMPAIGN_CAP)
  if (error) throw error
  const ids = (campaigns || []).map((c) => c.id).filter(Boolean)
  if (!ids.length) return { ok: true, campaigns: {}, markets: [], truncated: false }

  const scan = await scanAll((withCount) => supabase.from('campaign_targets')
    .select('campaign_id,market', withCount ? { count: 'exact' } : undefined)
    .in('campaign_id', ids)
    .order('id', { ascending: true }), MARKET_INDEX_MAX_PAGES)

  const perCampaign = new Map()
  const overall = new Map()
  for (const row of scan.rows) {
    const market = clean(row.market)
    if (!market) continue
    const bucket = perCampaign.get(row.campaign_id) || new Map()
    bucket.set(market, (bucket.get(market) || 0) + 1)
    perCampaign.set(row.campaign_id, bucket)
    overall.set(market, (overall.get(market) || 0) + 1)
  }
  const out = {}
  for (const [campaignId, bucket] of perCampaign) {
    const sorted = [...bucket.entries()].sort((a, b) => b[1] - a[1])
    out[campaignId] = {
      top: sorted.slice(0, MARKET_INDEX_TOP).map(([market, targets]) => ({ market, targets })),
      market_count: sorted.length,
    }
  }
  return {
    ok: true,
    campaigns: out,
    markets: [...overall.entries()].sort((a, b) => b[1] - a[1]).map(([market, targets]) => ({ market, targets })),
    truncated: scan.truncated,
  }
}
