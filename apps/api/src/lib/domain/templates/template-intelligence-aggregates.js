import { supabase } from '@/lib/supabase/client.js'
import { chunk, unique } from '@/lib/utils/arrays.js'
import { normalizeStageCode } from './template-stage-labels.js'

const BATCH = 80

const OWNERSHIP_INTENTS = new Set(['ownership_confirmed'])
const SELLING_INTEREST_INTENTS = new Set(['seller_interested', 'qualified_lead', 'latent_interest'])
const NOT_INTERESTED_INTENTS = new Set(['not_interested'])
const PRICE_INTENTS = new Set(['asking_price_provided', 'price_anchor'])
const PRICE_OBJECTION_INTENTS = new Set(['need_more_money', 'send_offer_first'])
const CONDITION_INTENTS = new Set(['condition_disclosed'])
const OFFER_INTENTS = new Set(['asks_offer', 'wants_offer', 'offer_requested'])
const COUNTER_INTENTS = new Set(['need_more_money'])
const ACCEPTED_INTENTS = new Set(['contract_ready'])
const WRONG_PERSON_INTENTS = new Set(['wrong_number', 'not_owner'])

const STAGE_ADVANCE_INTENTS = {
  S1: SELLING_INTEREST_INTENTS,
  S1F: SELLING_INTEREST_INTENTS,
  S2: PRICE_INTENTS,
  S3: CONDITION_INTENTS,
  S4: OFFER_INTENTS,
  S5: ACCEPTED_INTENTS,
  S6: ACCEPTED_INTENTS,
}

export function windowToInterval(window) {
  const w = String(window ?? '7d').toLowerCase()
  if (w === 'today') return '1 day'
  if (w === '24h') return '24 hours'
  if (w === '7d') return '7 days'
  if (w === '30d') return '30 days'
  if (w === 'all_time') return null
  return '7 days'
}

export function priorWindowLabel(window) {
  const map = {
    today: 'vs previous 24h',
    '24h': 'vs previous 7d',
    '7d': 'vs previous 7d',
    '30d': 'vs previous 30d',
    all_time: 'vs prior all-time slice',
  }
  return map[String(window ?? '7d')] ?? 'vs previous period'
}

function emptyBucket() {
  return {
    sends: 0,
    delivered: 0,
    failed: 0,
    blocked: 0,
    queued: 0,
    selected: 0,
    retries: 0,
    cost: null,
    cost_available: false,
    replies: 0,
    positive_replies: 0,
    ownership_confirmed: 0,
    selling_interest: 0,
    price_captured: 0,
    condition_captured: 0,
    offer_presented: 0,
    counteroffer: 0,
    accepted: 0,
    stage_advanced: 0,
    opt_outs: 0,
    wrong_numbers: 0,
    not_interested: 0,
    hostile_legal: 0,
    unclear: 0,
    senders: new Map(),
    markets: new Set(),
    campaigns: new Set(),
    last_used: null,
    funnel: {},
  }
}

function bump(map, key, patch) {
  const cur = map.get(key) ?? emptyBucket()
  for (const [field, val] of Object.entries(patch)) {
    if (field === 'senders' && val && typeof val === 'object') {
      for (const [sender, count] of Object.entries(val)) {
        cur.senders.set(sender, (cur.senders.get(sender) ?? 0) + count)
      }
      continue
    }
    if (field === 'markets' && val) {
      for (const m of val) cur.markets.add(m)
      continue
    }
    if (field === 'campaigns' && val) {
      for (const c of val) cur.campaigns.add(c)
      continue
    }
    if (field === 'last_used' && val) {
      if (!cur.last_used || val > cur.last_used) cur.last_used = val
      continue
    }
    if (typeof val === 'number') cur[field] = (cur[field] ?? 0) + val
  }
  map.set(key, cur)
}

function intentFlags(intent) {
  const i = String(intent ?? '').toLowerCase()
  return {
    ownership: OWNERSHIP_INTENTS.has(i),
    selling: SELLING_INTEREST_INTENTS.has(i),
    price: PRICE_INTENTS.has(i),
    price_objection: PRICE_OBJECTION_INTENTS.has(i),
    condition: CONDITION_INTENTS.has(i),
    offer: OFFER_INTENTS.has(i),
    counter: COUNTER_INTENTS.has(i),
    accepted: ACCEPTED_INTENTS.has(i),
    wrong: WRONG_PERSON_INTENTS.has(i),
    not_interested: NOT_INTERESTED_INTENTS.has(i),
    hostile: i === 'hostile_or_legal',
    unclear: !i || i === 'unclear' || i === 'who_is_this',
    positive: ['seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'condition_disclosed', 'needs_call', 'contract_ready', 'qualified_lead'].includes(i),
    opt_out: i === 'opt_out',
  }
}

function stageAdvancedForIntent(stageCode, intent) {
  const code = normalizeStageCode(stageCode)
  if (!code) return false
  const set = STAGE_ADVANCE_INTENTS[code]
  return set ? set.has(String(intent ?? '').toLowerCase()) : false
}

export function buildStageFunnel(stageCode, bucket = {}) {
  const code = normalizeStageCode(stageCode) ?? 'S1'
  const b = bucket
  const base = [
    { key: 'delivered', label: 'Delivered', value: b.delivered ?? 0 },
    { key: 'replied', label: 'Replied', value: b.replies ?? 0 },
  ]
  const stageCols = {
    S1: [
      { key: 'ownership_confirmed', label: 'Ownership Confirmed', value: b.ownership_confirmed ?? 0 },
      { key: 'wrong_person', label: 'Wrong Person', value: b.wrong_numbers ?? 0 },
      { key: 'selling_interest', label: 'Selling Interest Captured', value: b.selling_interest ?? 0 },
      { key: 'advanced_s2', label: 'Advanced to S2', value: b.stage_advanced ?? 0 },
    ],
    S1F: [
      { key: 'ownership_confirmed', label: 'Ownership Confirmed', value: b.ownership_confirmed ?? 0 },
      { key: 'wrong_person', label: 'Wrong Person', value: b.wrong_numbers ?? 0 },
      { key: 'selling_interest', label: 'Selling Interest Captured', value: b.selling_interest ?? 0 },
      { key: 'advanced_s2', label: 'Advanced to S2', value: b.stage_advanced ?? 0 },
    ],
    S2: [
      { key: 'seller_open', label: 'Seller Open', value: b.selling_interest ?? 0 },
      { key: 'not_interested', label: 'Not Interested', value: b.not_interested ?? 0 },
      { key: 'timeline_captured', label: 'Timeline Captured', value: b.selling_interest ?? 0 },
      { key: 'advanced_s3', label: 'Advanced to S3', value: b.stage_advanced ?? 0 },
    ],
    S3: [
      { key: 'asking_price', label: 'Asking Price Captured', value: b.price_captured ?? 0 },
      { key: 'price_objection', label: 'Price Objection', value: b.price_objection ?? 0 },
      { key: 'advanced_s4', label: 'Advanced to S4', value: b.stage_advanced ?? 0 },
    ],
    S4: [
      { key: 'condition_captured', label: 'Condition Captured', value: b.condition_captured ?? 0 },
      { key: 'repairs_captured', label: 'Repairs Captured', value: b.condition_captured ?? 0 },
      { key: 'occupancy_captured', label: 'Occupancy Captured', value: 0 },
      { key: 'advanced_s5', label: 'Advanced to S5', value: b.stage_advanced ?? 0 },
    ],
    S5: [
      { key: 'offer_presented', label: 'Offer Presented', value: b.offer_presented ?? 0 },
      { key: 'counteroffer', label: 'Counteroffer', value: b.counteroffer ?? 0 },
      { key: 'accepted', label: 'Accepted', value: b.accepted ?? 0 },
      { key: 'advanced_s6', label: 'Advanced to S6', value: b.stage_advanced ?? 0 },
    ],
    S6: [
      { key: 'agreement_sent', label: 'Agreement Sent', value: b.offer_presented ?? 0 },
      { key: 'agreement_viewed', label: 'Agreement Viewed', value: 0 },
      { key: 'agreement_signed', label: 'Agreement Signed', value: b.accepted ?? 0 },
      { key: 'closing_milestone', label: 'Closing Milestone', value: 0 },
      { key: 'completed', label: 'Completed', value: b.accepted ?? 0 },
    ],
  }
  return [...base, ...(stageCols[code] ?? stageCols.S1)]
}

export function senderDiversityFromBucket(bucket) {
  const entries = [...(bucket?.senders ?? new Map()).entries()].filter(([s]) => s && s !== 'unknown')
  const total = entries.reduce((n, [, c]) => n + c, 0)
  if (!entries.length || total === 0) {
    return { distinct: 0, concentration_pct: null, dominant_sender: null, warning: false, label: '—' }
  }
  entries.sort((a, b) => b[1] - a[1])
  const [dominant, topCount] = entries[0]
  const concentration = Math.round((topCount / total) * 1000) / 10
  return {
    distinct: entries.length,
    concentration_pct: concentration,
    dominant_sender: dominant,
    warning: concentration >= 70 && entries.length > 1,
    label: `${entries.length} senders · top ${concentration}%`,
  }
}

export async function fetchAttributedReplyAggregates(templateKeys, timeWindow) {
  const map = new Map()
  if (!templateKeys.length) return map
  const interval = windowToInterval(timeWindow)
  const since = interval ? new Date(Date.now() - parseIntervalMs(interval)).toISOString() : null

  for (const batch of chunk(unique(templateKeys), BATCH)) {
    let query = supabase
      .from('performance_attributed_replies_v')
      .select('template_key, detected_reply_intent, is_positive_reply, is_opt_out_reply, is_wrong_number_reply, textgrid_number_key, market, outbound_at, current_stage')
      .in('template_key', batch)
    if (since) query = query.gte('outbound_at', since)
    const { data, error } = await query
    if (error) throw error
    for (const row of data ?? []) {
      const key = String(row.template_key ?? '')
      if (!key) continue
      const flags = intentFlags(row.detected_reply_intent)
      const advanced = stageAdvancedForIntent(row.current_stage, row.detected_reply_intent) ? 1 : 0
      const patch = {
        replies: 1,
        positive_replies: flags.positive || row.is_positive_reply ? 1 : 0,
        ownership_confirmed: flags.ownership ? 1 : 0,
        selling_interest: flags.selling ? 1 : 0,
        price_captured: flags.price ? 1 : 0,
        price_objection: flags.price_objection ? 1 : 0,
        condition_captured: flags.condition ? 1 : 0,
        offer_presented: flags.offer ? 1 : 0,
        counteroffer: flags.counter ? 1 : 0,
        accepted: flags.accepted ? 1 : 0,
        wrong_numbers: flags.wrong || row.is_wrong_number_reply ? 1 : 0,
        not_interested: flags.not_interested ? 1 : 0,
        hostile_legal: flags.hostile ? 1 : 0,
        unclear: flags.unclear ? 1 : 0,
        opt_outs: flags.opt_out || row.is_opt_out_reply ? 1 : 0,
        stage_advanced: advanced,
        senders: row.textgrid_number_key ? { [row.textgrid_number_key]: 1 } : {},
        markets: row.market ? [row.market] : [],
      }
      bump(map, key, patch)
    }
  }
  return map
}

export async function fetchQueueExecutionAggregates(templateKeys, timeWindow) {
  const map = new Map()
  if (!templateKeys.length) return map
  const interval = windowToInterval(timeWindow)
  const since = interval ? new Date(Date.now() - parseIntervalMs(interval)).toISOString() : null

  for (const batch of chunk(unique(templateKeys), BATCH)) {
    let query = supabase
      .from('send_queue')
      .select('template_id, selected_template_id, queue_status, from_phone_number, market, campaign_id, retry_count, estimated_cost, created_at, updated_at')
      .or(batch.map((k) => `template_id.eq.${k},selected_template_id.eq.${k}`).join(','))
    if (since) query = query.gte('created_at', since)
    const { data, error } = await query
    if (error) throw error
    for (const row of data ?? []) {
      const key = String(row.selected_template_id || row.template_id || '')
      if (!key) continue
      const status = String(row.queue_status ?? '').toLowerCase()
      const isSent = ['sent', 'delivered', 'sending'].includes(status)
      const isDelivered = status === 'delivered'
      const isFailed = ['failed', 'retry'].includes(status)
      const isBlocked = ['blocked', 'paused', 'cancelled', 'held'].includes(status)
      const isQueued = ['queued', 'scheduled', 'approval', 'ready'].includes(status)
      const cost = Number(row.estimated_cost)
      bump(map, key, {
        selected: 1,
        queued: isQueued ? 1 : 0,
        sends: isSent || isDelivered ? 1 : 0,
        delivered: isDelivered ? 1 : 0,
        failed: isFailed ? 1 : 0,
        blocked: isBlocked ? 1 : 0,
        retries: Number(row.retry_count) || 0,
        cost: Number.isFinite(cost) ? cost : 0,
        cost_available: Number.isFinite(cost),
        senders: row.from_phone_number ? { [row.from_phone_number]: 1 } : {},
        markets: row.market ? [row.market] : [],
        campaigns: row.campaign_id ? [String(row.campaign_id)] : [],
        last_used: row.updated_at || row.created_at,
      })
    }
  }
  return map
}

function parseIntervalMs(interval) {
  const m = String(interval).match(/(\d+)\s*(day|hour|days|hours)/i)
  if (!m) return 7 * 86400000
  const n = Number(m[1])
  return /hour/i.test(m[2]) ? n * 3600000 : n * 86400000
}

export function mergeAggregateIntoMetrics(metrics, attr, exec, stageCode) {
  const replies = attr?.replies ?? metrics.replies ?? 0
  const delivered = metrics.delivered ?? exec?.delivered ?? 0
  const sends = metrics.sends ?? exec?.sends ?? 0
  const ownership = attr?.ownership_confirmed ?? metrics.ownership_confirmed ?? 0
  const stageAdvanced = attr?.stage_advanced ?? 0
  const costAvail = exec?.cost_available ?? false
  return {
    ...metrics,
    replies: replies || metrics.replies,
    positive_replies: attr?.positive_replies ?? metrics.positive_replies,
    ownership_confirmed: ownership,
    selling_interest: attr?.selling_interest ?? 0,
    price_captured: attr?.price_captured ?? 0,
    condition_captured: attr?.condition_captured ?? 0,
    offer_presented: attr?.offer_presented ?? 0,
    stage_advanced: stageAdvanced,
    opt_outs: attr?.opt_outs ?? metrics.opt_outs,
    wrong_numbers: attr?.wrong_numbers ?? metrics.wrong_numbers,
    not_interested: attr?.not_interested ?? 0,
    retries: exec?.retries ?? metrics.retries,
    cost: costAvail ? (exec?.cost ?? 0) : null,
    cost_available: costAvail,
    rates: {
      ...metrics.rates,
      reply: { numerator: replies, denominator: delivered, value: delivered > 0 ? Math.round((replies / delivered) * 10000) / 100 : null, unit: 'percent' },
      positive_reply: { numerator: attr?.positive_replies ?? 0, denominator: replies, value: replies > 0 ? Math.round(((attr?.positive_replies ?? 0) / replies) * 10000) / 100 : null, unit: 'percent' },
      ownership_confirmation: { numerator: ownership, denominator: replies, value: replies > 0 ? Math.round((ownership / replies) * 10000) / 100 : null, unit: 'percent' },
      stage_advancement: { numerator: stageAdvanced, denominator: replies, value: replies > 0 ? Math.round((stageAdvanced / replies) * 10000) / 100 : null, unit: 'percent' },
      opt_out: { numerator: attr?.opt_outs ?? 0, denominator: delivered, value: delivered > 0 ? Math.round(((attr?.opt_outs ?? 0) / delivered) * 10000) / 100 : null, unit: 'percent' },
      delivery: { numerator: delivered, denominator: sends, value: sends > 0 ? Math.round((delivered / sends) * 10000) / 100 : null, unit: 'percent' },
      failure: metrics.rates?.failure,
    },
  }
}

export function buildIntelligenceRail(rows = []) {
  const tracked = rows.filter((r) => (r.metrics?.current?.sends ?? 0) > 0)
  const healthy = tracked.filter((r) => ['winner', 'champion', 'rising'].includes(String(r.autopilot?.rotation_state))).length
  const watch = tracked.filter((r) => r.autopilot?.rotation_state === 'watch').length
  const degraded = tracked.filter((r) => ['cooldown', 'paused'].includes(String(r.autopilot?.rotation_state))).length
  const critical = tracked.filter((r) => r.metrics?.performance_label === 'critical' || (r.metrics?.rates?.opt_out?.value ?? 0) >= 8).length
  const byCopy = [...tracked].sort((a, b) => (b.autopilot?.intelligence?.copy_score ?? 0) - (a.autopilot?.intelligence?.copy_score ?? 0))
  const byOptOut = [...tracked].sort((a, b) => (b.metrics?.rates?.opt_out?.value ?? 0) - (a.metrics?.rates?.opt_out?.value ?? 0))
  const byStage = [...tracked].sort((a, b) => (b.metrics?.current?.stage_advanced ?? 0) - (a.metrics?.current?.stage_advanced ?? 0))
  const byDeliveryDrop = [...tracked].sort((a, b) => (a.metrics?.comparison?.rates?.delivery?.delta_absolute ?? 0) - (b.metrics?.comparison?.rates?.delivery?.delta_absolute ?? 0))
  const noAttribution = tracked.filter((r) => r.data_quality?.attribution_status !== 'attributed').length
  return {
    tracked_templates: tracked.length,
    healthy,
    watch,
    degraded,
    critical,
    current_winner: byCopy[0]?.identity?.canonical_display_name ?? null,
    highest_opt_out_risk: byOptOut[0]?.identity?.canonical_display_name ?? null,
    strongest_stage_advancement: byStage[0]?.identity?.canonical_display_name ?? null,
    largest_delivery_decline: byDeliveryDrop[0]?.identity?.canonical_display_name ?? null,
    lacking_attribution: noAttribution,
    recommended_actions: [
      noAttribution > 0 ? `${noAttribution} templates lack attribution — review Data Quality` : null,
      critical > 0 ? `${critical} templates in critical/opt-out risk` : null,
      degraded > 0 ? `${degraded} templates in cooldown/paused` : null,
    ].filter(Boolean),
  }
}