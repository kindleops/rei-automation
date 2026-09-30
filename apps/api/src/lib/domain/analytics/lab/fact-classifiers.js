/**
 * ANALYTICS LAB — FACT CLASSIFIERS. Pure predicates, one place each, so the
 * engine, the records endpoint and the tests all read a row the same way.
 *
 * Held-by-send-gate, transport failure and campaign hold are DIFFERENT classes
 * here and nowhere collapse into one "failed".
 */
import { INTERNAL_TEST_PHONE_SET } from '@/lib/config/internal-phones.js'
import { OPTOUT_INTENTS, POSITIVE_INTENTS } from '@/lib/domain/metrics/war-room-service.js'
import { STAGE_INDEX } from '@/lib/domain/opportunity/pipeline-command-service.js'
import { deriveTimezoneFromGeography } from '@/lib/domain/campaigns/contact-window-timezone.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const truthy = (v) => ['true', '1', 'yes'].includes(lower(v))
export { POSITIVE_INTENTS, OPTOUT_INTENTS }

/* ── canary ───────────────────────────────────────────────────────────────── */

/** Every spelling of the 5 internal test phones (E.164, digits, 10-digit). */
export function canaryPhones(set = INTERNAL_TEST_PHONE_SET) {
  const out = new Set()
  for (const p of set) {
    const d = String(p).replace(/\D/g, '')
    out.add(String(p)); out.add(d); out.add(`+${d}`)
    if (d.length === 11) out.add(d.slice(1))
  }
  return out
}
/** Same predicate as the v1 RPC (sq CTE). */
export function isCanarySend(row, canary) {
  return canary.has(clean(row.thread_key)) || canary.has(clean(row.from_phone_number)) || canary.has(clean(row.to_phone_number))
    || clean(row.source) === 'internal_canary' || truthy(row.md_internal_canary) || truthy(row.md_exclude_from_kpis)
}
export function isCanaryInbound(row, canary) {
  return canary.has(clean(row.thread_key)) || canary.has(clean(row.from_phone_number)) || canary.has(clean(row.to_phone_number)) || truthy(row.md_internal_canary)
}
/** Inbound rows that cannot belong to a seller conversation (no thread; internal proof events). */
export function isAttributableInbound(row) {
  return Boolean(clean(row.thread_key)) && !lower(row.event_type).startsWith('internal_')
}

/* ── outbound: send / delivery predicates (identical to v1) ───────────────── */

const WAITING = new Set(['scheduled', 'queued', 'pending', 'approved', 'ready', 'processing', 'sending', 'retry', 'runnable', 'held', 'approval', 'paused'])
/**
 * isSent / isDelivered / isFailedV1 are the v1 RPC predicates verbatim (the
 * reconciliation proof depends on it). The lab's classes come from
 * classifySend, which checks carrier failure BEFORE delivery.
 */
export function sendFlags(row) {
  const status = lower(row.queue_status)
  const isSent = Boolean(row.sent_at) || status === 'sent' || status === 'delivered'
  const isDelivered = Boolean(row.delivered_at) || status === 'delivered' || ['true', 'delivered', 'yes'].includes(lower(row.delivery_confirmed))
  const isTransportFailed = status === 'failed_transport' || status === 'undelivered'
  return {
    status, isSent, isDelivered, isTransportFailed,
    isFailedV1: status === 'failed' || isTransportFailed,
    isProviderRejected: status === 'failed' || status === 'paused_max_retries',
  }
}
/** The instant a message belongs to: when it was sent, else when it was queued. */
export const attemptTime = (row) => Date.parse(row.sent_at || row.created_at)

const SELLER_DRIVEN = /(not_interested|seller_explicit_decline|wrong_number|asking_price_already_known|offer_already_presented)/
const TEST_CLEANUP = /(test|proof|canary|debug|fixture|smoke|device_test)/
/**
 * One disposition + one class per queue row.
 *   disposition: delivered | sent | undelivered | rejected | blocked | held | expired | cancelled | waiting | other
 *   class:       the reason inside the disposition (carrier_spam_filter, sender_health, send_gate, ...)
 */
export function classifySend(row, carrierBucket = null) {
  const f = sendFlags(row)
  const reason = lower([row.failed_reason, row.blocked_reason, row.guard_reason, row.paused_reason].filter(Boolean).join(' | '))
  const bucket = lower(carrierBucket)
  const s = f.status
  if (f.isTransportFailed) {
    const cls = bucket === 'spam' ? 'carrier_spam_filter'
      : bucket === 'hard bounce' ? 'carrier_hard_bounce'
        : bucket === 'soft bounce' ? 'carrier_soft_bounce'
          : bucket === 'dnc' ? 'carrier_dnc'
            : 'carrier_undelivered'
    return { disposition: 'undelivered', cls }
  }
  if (f.isDelivered) return { disposition: 'delivered', cls: 'delivered' }
  if (f.isProviderRejected && !f.isSent) {
    if (/21610|blacklist|\bdnc\b/.test(reason) || bucket === 'dnc' || bucket === 'provider_blacklist_pair') return { disposition: 'rejected', cls: 'provider_blacklist' }
    if (/no sid/.test(reason) || bucket === 'provider_no_sid') return { disposition: 'rejected', cls: 'provider_no_sid' }
    if (/timeout|aborted/.test(reason)) return { disposition: 'rejected', cls: 'provider_timeout' }
    return { disposition: 'rejected', cls: 'send_error' }
  }
  if (f.isSent) return { disposition: 'sent', cls: 'awaiting_receipt' }
  if (/queue_emergency_stop_active|global pause|emergency stop/.test(reason) || s === 'paused_global_lock') return { disposition: 'held', cls: 'send_gate' }
  if (s === 'blocked_by_health_guard') return { disposition: 'blocked', cls: /template/.test(reason) ? 'template_health' : 'sender_health' }
  if (s === 'blocked_sender_ineligible') return { disposition: 'blocked', cls: 'sender_health' }
  if (s === 'paused_name_missing') return { disposition: 'blocked', cls: 'content_guard' }
  if (s === 'blocked') return { disposition: 'blocked', cls: /blank|greeting|first_name|body/.test(reason) ? 'content_guard' : 'guard_other' }
  if (s === 'duplicate_blocked' || s === 'paused_duplicate') return { disposition: 'blocked', cls: 'duplicate_guard' }
  if (s === 'paused_invalid_queue_row') return { disposition: 'blocked', cls: 'invalid_row' }
  if (s === 'paused_operator_review') return { disposition: 'held', cls: 'operator_review' }
  if (s === 'expired') return { disposition: 'expired', cls: 'expired_unsent' }
  if (s === 'cancelled') {
    if (SELLER_DRIVEN.test(reason)) return { disposition: 'cancelled', cls: 'superseded_by_conversation' }
    if (/stale/.test(reason)) return { disposition: 'cancelled', cls: 'stale_unsent' }
    if (TEST_CLEANUP.test(reason)) return { disposition: 'cancelled', cls: 'test_cleanup' }
    return { disposition: 'cancelled', cls: 'operator_cancelled' }
  }
  if (WAITING.has(s) || s.startsWith('paused')) return { disposition: 'waiting', cls: 'waiting' }
  return { disposition: 'other', cls: s || 'unknown' }
}
export const DISPATCH_DISPOSITIONS = new Set(['delivered', 'sent', 'undelivered', 'rejected', 'blocked', 'held'])

export const CLASS_LABELS = {
  delivered: 'Delivered', awaiting_receipt: 'Sent — no receipt yet',
  carrier_spam_filter: 'Carrier spam / content filter', carrier_hard_bounce: 'Carrier hard bounce', carrier_soft_bounce: 'Carrier soft bounce', carrier_dnc: 'Carrier DNC', carrier_undelivered: 'Carrier undelivered (unspecified)',
  provider_blacklist: 'Provider refused — recipient blocked sender (21610)', provider_no_sid: 'Provider returned no SID', provider_timeout: 'Provider timeout', send_error: 'Internal send error',
  send_gate: 'Held by send gate', operator_review: 'Held for operator review',
  sender_health: 'Sender-health guard', template_health: 'Template-health guard', content_guard: 'Pre-send content guard', duplicate_guard: 'Duplicate guard', invalid_row: 'Invalid queue row', guard_other: 'Other guard',
  expired_unsent: 'Expired unsent', superseded_by_conversation: 'Cancelled — conversation moved on', stale_unsent: 'Cancelled — stale', test_cleanup: 'Cancelled — test cleanup', operator_cancelled: 'Cancelled by operator',
  waiting: 'Waiting in queue',
}
export const DISPOSITION_LABELS = {
  delivered: 'Delivered', sent: 'Sent (no receipt)', undelivered: 'Undelivered (carrier)', rejected: 'Refused (provider)', blocked: 'Blocked (guard)', held: 'Held (gate / review)',
  expired: 'Expired unsent', cancelled: 'Cancelled', waiting: 'Waiting', other: 'Other',
}

/** Who initiated a send. Exclusive; operator sources win. Same vocabulary as v1. */
export function sendOrigin(row) {
  const src = lower(row.source)
  const type = lower(row.message_type)
  if (/(inbox|manual|map_command)/.test(src) || /manual/.test(type)) return 'operator'
  if (/(campaign|orchestrator|auto_reply|autopilot|followup|feeder)/.test(src) || /follow/.test(type)) return 'system'
  return 'unlabelled'
}
export const touchBucket = (n) => {
  const t = Number(n)
  if (!Number.isFinite(t) || t <= 0) return 'unknown'
  return t >= 4 ? '4+' : String(Math.trunc(t))
}

/* ── inbound ──────────────────────────────────────────────────────────────── */

export function inboundFlags(row) {
  const intent = lower(row.detected_intent)
  return {
    intent: intent || null,
    isPositive: POSITIVE_INTENTS.has(intent),
    isOptOut: row.is_opt_out === true || Boolean(clean(row.opt_out_keyword)) || OPTOUT_INTENTS.has(intent),
  }
}

/* ── pipeline history ─────────────────────────────────────────────────────── */

/** Pipeline's synthetic-history rule, with the null-actor trap closed (coalesce to ''). */
export function isSyntheticHistory(h) {
  return /(cert|probe|fixture|qa_|test)/i.test(clean(h.actor)) || /(certification|probe|fixture|restore test|regression)/i.test(clean(h.reason))
}
export function transitionDirection(from, to) {
  const a = STAGE_INDEX[clean(from)]
  const b = STAGE_INDEX[clean(to)]
  if (!a || !b) return 'unknown'
  return b > a ? 'forward' : b < a ? 'backward' : 'lateral'
}
export const historyActor = (h) => (/autopilot|orchestrator/i.test(`${clean(h.source)} ${clean(h.actor)} ${clean(h.reason)}`) ? 'autopilot' : 'operator')

/* ── autopilot runs ───────────────────────────────────────────────────────── */

const HUMAN = /(review|unclear|missing_context|low_confidence)/
/** executed | send_gate | auto_reply_off | human_review | policy | failed | other */
export function runClass(status, blockReason) {
  const s = lower(status)
  const r = lower(blockReason)
  if (s === 'succeeded') return 'executed'
  if (s === 'failed') return 'failed'
  if (s !== 'blocked') return 'other'
  if (r === 'execution_gated') return 'send_gate'
  if (r === 'auto_reply_mode_disabled') return 'auto_reply_off'
  if (HUMAN.test(r)) return 'human_review'
  return 'policy'
}
export const RUN_CLASS_LABELS = {
  executed: 'Executed', send_gate: 'Held by send gate (review-only mode)', auto_reply_off: 'Auto-reply off — waits for operator',
  human_review: 'Routed to a human', policy: 'Stopped by policy (opt-out, wrong number, hostile)', failed: 'Failed', other: 'Other',
}

/* ── campaigns ────────────────────────────────────────────────────────────── */

const TEST_NAME = /^zz[-_ ]|synthetic|certification|\bproof\b|\bcanary\b|\bqa\b|\bprobe\b/i
/**
 * A campaign is test/synthetic when its own record says so (candidate_source
 * internal_canary, proof / canary / fixture flags, a *_proof source) or its
 * name uses a test marker. "Miami - Test Campaign" is NOT test: it carries
 * production_launch + converted_to_live_at and reached real sellers.
 */
export function campaignIntegrity(c = {}) {
  const reasons = []
  if (lower(c.candidate_source) === 'internal_canary') reasons.push('candidate_source internal_canary')
  for (const k of ['md_proof', 'md_internal_proof', 'md_internal_canary', 'md_not_business_data', 'md_canary', 'md_test_fixture', 'md_proof_probe']) {
    if (truthy(c[k])) reasons.push(k.slice(3))
  }
  if (/_proof$|proof_/.test(lower(c.md_source))) reasons.push(`source ${lower(c.md_source)}`)
  const live = truthy(c.md_production_launch)
  if (!live && TEST_NAME.test(clean(c.name))) reasons.push('name')
  return { test: reasons.length > 0, reasons, quarantined: truthy(c.md_quarantine_active) }
}
export function campaignSource(c = {}) {
  const s = lower(c.md_source)
  if (s === 'map_area') return 'map_area'
  if (s === 'entity_graph') return 'entity_graph'
  if (lower(c.candidate_source) === 'internal_canary') return 'internal_canary'
  if (lower(c.candidate_source) === 'campaign_target_graph') return 'target_graph'
  return 'filters'
}
export const CAMPAIGN_SOURCE_LABELS = { map_area: 'Map area', entity_graph: 'Entity Graph', filters: 'Builder filters / import', target_graph: 'Full target graph', internal_canary: 'Internal canary', none: 'No campaign' }

/* ── owners / properties ──────────────────────────────────────────────────── */

export function normalizeOwnerType(v) {
  const s = lower(v)
  if (!s) return null
  if (s.startsWith('individual')) return 'Individual'
  if (s.startsWith('corporate')) return 'Corporate'
  if (s.startsWith('trust')) return 'Trust / Estate'
  if (s.startsWith('government')) return 'Government'
  if (s.startsWith('hedge')) return 'Hedge fund'
  if (s.startsWith('bank')) return 'Bank / Lender'
  return clean(v)
}
export function normalizePropertyType(v) {
  const s = lower(v)
  if (!s) return null
  if (s === 'sfr' || s === 'single family') return 'Single Family'
  if (s === 'multifamily 5+' || s === 'apartment') return 'Apartment / 5+'
  if (s === 'multi-family') return 'Multi-Family (2–4)'
  return clean(v)
}

/* ── local time (seller-local, canonical geography) ───────────────────────── */

const TZ_CACHE = new Map()
export function propertyTimezone(state, zip) {
  const key = `${clean(state).toUpperCase()}|${clean(zip).slice(0, 3)}`
  if (!TZ_CACHE.has(key)) TZ_CACHE.set(key, deriveTimezoneFromGeography(state, zip)?.iana || null)
  return TZ_CACHE.get(key)
}
const LT = new Map()
export function localClock(ms, tz) {
  if (!tz || !Number.isFinite(ms)) return null
  if (!LT.has(tz)) LT.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', weekday: 'short' }))
  const p = {}
  for (const { type, value } of LT.get(tz).formatToParts(new Date(ms))) p[type] = value
  return { hour: Number(p.hour), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
