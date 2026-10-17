// ─── opener-reply-exclusion.js ───────────────────────────────────────────────
// A seller who told us "not the owner / sold it / gave it to my daughter /
// wrong number" is never sent a campaign OPENER for that property again.
//
// Defect (2026-10-08 nurture revalidation): a 9-28 reply "Not for sale — gave
// to my daughter" was followed by a 10-06 touch-1 from a different campaign.
// The bulk planner's own "already queued" and "already contacted" gates never
// fired for it: campaign_targets.to_phone_number is stored as 10 digits while
// send_queue / message_events store E.164, and the planner looked rows up by
// the raw target phone — so neither gate ever matched a prior row. Nothing
// read the thread's not-owner disposition either.
//
// Scope is person × property: a property-scoped claim ("I don't own THAT
// one", "sold it") excludes that phone for that property only; a wrong-number
// claim is about the phone, so it excludes the phone for every property.
// Pure evaluation + one read-only loader.
// rc-8.5.21 (owner P0 2026-10-16, e767ad0d): labels alone missed every denial whose label was
// `unclear` / `not_interested`. The property-scoped store public.contact_property_resolution
// (written by the live inbound waterfall) is read too, through the SAME evaluator the dispatch-time
// send guard uses (queue/ownership-recontact-guard.js); it runs ahead of any prior-contact
// override, so suppress_previously_contacted:false can never lift it.
import { evaluateContactPropertyResolution, OWNERSHIP_UNRESOLVED_REASON } from '../queue/ownership-recontact-guard.js'

const clean = (value) => String(value ?? '').trim()
const lower = (value) => clean(value).toLowerCase()

/** Last 10 digits — the one key both phone shapes share. */
export function phoneKey(value) {
  const digits = clean(value).replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : ''
}

/** E.164 and bare 10-digit forms of every phone, for `.in()` lookups. */
export function phoneLookupVariants(phones = []) {
  const out = new Set()
  for (const phone of phones || []) {
    const raw = clean(phone)
    if (!raw) continue
    out.add(raw)
    const key = phoneKey(raw)
    if (key) {
      out.add(key)
      out.add(`+1${key}`)
    }
  }
  return [...out]
}

/** The responder is not (or no longer) the owner of THIS property. */
export const PROPERTY_SCOPED_NOT_OWNER = Object.freeze(new Set([
  'property_specific_non_owner',
  'former_owner_respondent',
  'sold_property',
  'sold',
  'tenant_respondent',
  'non_owner_referral',
  'not_owner',
]))

/** The phone does not belong to the person we meant: excluded for every property. */
export const PHONE_SCOPED_NOT_OWNER = Object.freeze(new Set(['wrong_number', 'wrong_person']))

const ALL_NOT_OWNER = new Set([...PROPERTY_SCOPED_NOT_OWNER, ...PHONE_SCOPED_NOT_OWNER])

/** The intents worth fetching from message_events. */
export const NOT_OWNER_REPLY_INTENTS = Object.freeze([...ALL_NOT_OWNER])

function signalsOf(thread = {}) {
  return [thread.disposition, thread.stage, thread.last_intent, thread.lifecycle_stage].map(lower).filter(Boolean)
}

/**
 * Pure. facts = { threads: [inbox_thread_state rows for this phone],
 *                 replies: [inbound message_events {detected_intent, property_id}] }.
 * Returns { excluded, reason, scope, signal } — excluded=false when nothing says not-owner.
 */
export function evaluateOpenerReplyExclusion({ property_id = null, threads = [], replies = [], resolutions = [] } = {}) {
  const target_property = clean(property_id)
  const store = evaluateContactPropertyResolution({ property_id, resolutions })
  if (store.excluded) return { excluded: true, ...(store.hold ? { hold: true } : {}), reason: store.reason, scope: store.scope, signal: store.role, source: store.source }
  // OWNER RULE 2 (2026-10-17): a property-scoped not-owner signal whose property (or the target's) is
  // not identified HOLDS the target for operator resolution; it never labels every property denied
  const propertyVerdict = (pid, signal, source) => {
    if (!clean(pid) || !target_property) return { excluded: true, hold: true, reason: OWNERSHIP_UNRESOLVED_REASON, scope: 'thread_hold', signal, source }
    if (clean(pid) === target_property) return { excluded: true, reason: 'prior_reply_not_owner', scope: 'person_property', signal, source }
    return null
  }

  for (const thread of threads || []) {
    for (const signal of signalsOf(thread)) {
      if (PHONE_SCOPED_NOT_OWNER.has(signal)) {
        return { excluded: true, reason: 'prior_reply_not_owner', scope: 'phone', signal, source: 'thread_state' }
      }
      if (PROPERTY_SCOPED_NOT_OWNER.has(signal)) {
        const v = propertyVerdict(thread.property_id, signal, 'thread_state')
        if (v) return v
      }
    }
  }
  for (const reply of replies || []) {
    const intent = lower(reply.detected_intent)
    if (PHONE_SCOPED_NOT_OWNER.has(intent)) {
      return { excluded: true, reason: 'prior_reply_not_owner', scope: 'phone', signal: intent, source: 'inbound_reply' }
    }
    if (PROPERTY_SCOPED_NOT_OWNER.has(intent)) {
      const v = propertyVerdict(reply.property_id, intent, 'inbound_reply')
      if (v) return v
    }
  }
  return { excluded: false, reason: null }
}

/**
 * Read-only loader keyed by phoneKey(): Map<key, { threads, replies }>.
 * A failed read throws — the planner fails closed rather than texting a
 * seller whose not-owner claim it could not check.
 */
export async function loadOpenerReplyFacts(supabase, phones = [], { chunkSize = 200 } = {}) {
  const facts = new Map()
  const e164 = [...new Set((phones || []).map(phoneKey).filter(Boolean).map((k) => `+1${k}`))]
  const slot = (phone) => {
    const key = phoneKey(phone)
    if (!key) return null
    if (!facts.has(key)) facts.set(key, { threads: [], replies: [], resolutions: [] })
    return facts.get(key)
  }
  for (let i = 0; i < e164.length; i += chunkSize) {
    const chunk = e164.slice(i, i + chunkSize)
    const [threads, replies, resolutions] = await Promise.all([
      supabase
        .from('inbox_thread_state')
        .select('thread_key,property_id,disposition,stage,last_intent,lifecycle_stage')
        .in('thread_key', chunk)
        .limit(5000),
      supabase
        .from('message_events')
        .select('from_phone_number,property_id,detected_intent')
        .eq('direction', 'inbound')
        .in('from_phone_number', chunk)
        .in('detected_intent', NOT_OWNER_REPLY_INTENTS)
        .limit(5000),
      supabase
        .from('contact_property_resolution')
        .select('property_id,contact_phone_e164,contact_property_role,suppression_scope,rejected_at')
        .in('contact_phone_e164', chunk)
        .limit(5000),
    ])
    if (threads.error) throw threads.error
    if (replies.error) throw replies.error
    if (resolutions.error) throw resolutions.error
    for (const row of threads.data || []) slot(row.thread_key)?.threads.push(row)
    for (const row of replies.data || []) slot(row.from_phone_number)?.replies.push(row)
    for (const row of resolutions.data || []) if (row.rejected_at || row.suppression_scope === 'channel_compliance' || row.contact_property_role === 'suppressed') slot(row.contact_phone_e164)?.resolutions.push(row)
  }
  return facts
}
