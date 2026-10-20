// ─── enqueue-contact-restrictions.js ─────────────────────────────────────────
// rc-8.5.21 v3 P0-C (RT-47: a campaign row for a phone already on the opt-out list was ACCEPTED by
// the queue writer; dispatch did not run, but the writer must refuse). The CANONICAL QUEUE WRITER
// (sms-engine insertSupabaseSendQueueRow, and the campaign plan's bulk insert) refuses a SENDABLE row
// when the contact or the property × contact is restricted:
//   • sms_suppression_list active, automation_suppressions active (incl. precautionary_no_contact),
//     the thread suppressed / opted out, an opt-out reply, a wrong number (phone-scoped);
//   • property denial / declined-unverified / property do-not-contact for THIS property × contact;
//   • an ownership thread hold (unresolved / multi-property ambiguity) and the automation-hold registry;
//   • an unsolicited follow-up on a hostile thread.
// The SAME pure evaluator the dispatcher runs (send-time-contact-guard, restrictions scope: contact
// history / content stay the dispatcher's), so the writer and the dispatcher agree — and each refuses
// independently.
// FAIL CLOSED: no client, or any read error ⇒ refused (reason enqueue_contact_restriction_read_failed).
//
// Test runtime: the ~800 legacy suites insert through bespoke fakes that cannot answer these reads;
// under NODE_ENV=test a non-production client skips the check unless a suite ENFORCES it
// (__setEnqueueContactRestrictionsModeForTests('enforce') — the PG proofs do). Production always runs it.

export const ENQUEUE_RESTRICTION_READ_FAILED = 'enqueue_contact_restriction_read_failed'
export const ENQUEUE_RESTRICTION_PREFIX = 'enqueue_contact_restricted'

let MODE = null // null = default; 'enforce' | 'skip' (tests only)
let RESOLVER = null
/** Test seam: 'enforce' runs the real check on any client; 'skip' disables; null restores the default. */
export function __setEnqueueContactRestrictionsModeForTests(mode = null) { MODE = mode }
/** Test seam: replace the check entirely ((row, client) => verdict). */
export function __setEnqueueContactRestrictionsResolverForTests(fn = null) { RESOLVER = typeof fn === 'function' ? fn : null }

const clean = (v) => String(v ?? '').trim()

async function realClient() {
  try { return (await import('@/lib/supabase/client.js')).supabase } catch { return null }
}

/** Should the check run for this client? Production: always. Test runtime: only when enforced. */
export async function enqueueRestrictionsApply(client) {
  if (MODE === 'enforce') return true
  if (MODE === 'skip') return false
  if (process.env.NODE_ENV !== 'test') return true
  const real = await realClient()
  return Boolean(client) && client === real
}

/**
 * @param {object} row  the normalized send_queue row about to be written
 * @param {{ supabase?: object|null, now?: number|string }} [opts]
 * @returns {Promise<{ refused: boolean, reason: string|null, guard_reason?: string|null, detail?: object }>}
 */
export async function evaluateEnqueueContactRestrictions(row = {}, { supabase = null, now = Date.now() } = {}) {
  if (RESOLVER) return RESOLVER(row, supabase)
  if (!(await enqueueRestrictionsApply(supabase))) return { refused: false, reason: null, skipped: 'test_runtime_fake_client' }
  if (!supabase?.from) return { refused: true, reason: ENQUEUE_RESTRICTION_READ_FAILED, guard_reason: null, detail: { error: 'no_client' } }
  const { loadSendTimeContactFacts, evaluateSendTimeContactGuard, SEND_TIME_GUARD_REASONS } = await import('@/lib/domain/queue/send-time-contact-guard.js')
  let facts
  try {
    facts = await loadSendTimeContactFacts(supabase, row, { restrictionsOnly: true })
  } catch (error) {
    return { refused: true, reason: ENQUEUE_RESTRICTION_READ_FAILED, guard_reason: SEND_TIME_GUARD_REASONS.READ_FAILED, detail: { error: clean(error?.message || error).slice(0, 200) } }
  }
  // the automation hold is the writer's own registry check (a manual send carries its audited override
  // there); here a fail-closed hold read still refuses
  const hold = facts?.automation_hold
  const factsForEval = hold && hold.held === true && hold.fail_closed !== true && hold.hold_type !== 'lookup_error' && row?.metadata?.automation_hold_override ? { ...facts, automation_hold: null } : facts
  const verdict = evaluateSendTimeContactGuard(row, factsForEval, { now, restrictionsOnly: true })
  if (!verdict?.blocked) return { refused: false, reason: null }
  return { refused: true, reason: `${ENQUEUE_RESTRICTION_PREFIX}:${verdict.reason}`, guard_reason: verdict.reason, detail: verdict.detail || {} }
}

/**
 * Bulk writers (the campaign plan's 500-row chunks): the SAME restriction facts read in batches by
 * phone (every stored phone shape), then each row judged by the same pure evaluator on ITS phone's
 * facts. The automation hold is the bulk writer's own registry match (not repeated here). Throws on
 * any read error — the caller aborts the batch (fail closed), never enqueues around it.
 * @returns {Promise<{ kept: object[], refused: Array<{ row: object, reason: string, guard_reason: string }> , skipped?: string }>}
 */
export async function filterBulkRowsByContactRestrictions(rows = [], { supabase = null, now = Date.now(), chunk = 100 } = {}) {
  if (RESOLVER) {
    const kept = []; const refused = []
    for (const row of rows) { const v = await RESOLVER(row, supabase); if (v?.refused) refused.push({ row, reason: v.reason, guard_reason: v.guard_reason || null }); else kept.push(row) }
    return { kept, refused }
  }
  if (!(await enqueueRestrictionsApply(supabase))) return { kept: [...rows], refused: [], skipped: 'test_runtime_fake_client' }
  if (!supabase?.from) throw new Error(`${ENQUEUE_RESTRICTION_READ_FAILED}: no_client`)
  const g = await import('@/lib/domain/queue/send-time-contact-guard.js')
  const read = async (q) => { const r = await q; if (r?.error) throw new Error(`${ENQUEUE_RESTRICTION_READ_FAILED}: ${clean(r.error.message || r.error)}`); return Array.isArray(r?.data) ? r.data : [] }
  const keyOf = (r) => g.phoneKey(r?.to_phone_number || r?.thread_key)
  const byKey = new Map()
  const push = (k, field, item) => { if (!k) return; const f = byKey.get(k) || { suppressions: [], automation_suppressions: [], threads: [], phones: [], inbound_replies: [], thread_messages: [], contact_property_resolution: [] }; f[field].push(item); byKey.set(k, f) }
  const keys = [...new Set(rows.map(keyOf).filter(Boolean))]
  for (let i = 0; i < keys.length; i += chunk) {
    const variants = g.phoneVariants(keys.slice(i, i + chunk))
    const [sup1, sup2, auto, thr1, thr2, phones, replies, cpr, msgs] = await Promise.all([
      read(supabase.from('sms_suppression_list').select('phone_e164,phone_number,sender_phone_e164,is_active,suppression_type').in('phone_e164', variants).limit(5000)),
      read(supabase.from('sms_suppression_list').select('phone_e164,phone_number,sender_phone_e164,is_active,suppression_type').in('phone_number', variants).limit(5000)),
      read(supabase.from('automation_suppressions').select('phone_e164,status,suppression_type,expires_at').in('phone_e164', variants).limit(5000)),
      read(supabase.from('inbox_thread_state').select('thread_key,canonical_e164,property_id,is_suppressed,disposition,last_intent,stage,lifecycle_stage,contactability_status').in('thread_key', variants).limit(5000)),
      read(supabase.from('inbox_thread_state').select('thread_key,canonical_e164,property_id,is_suppressed,disposition,last_intent,stage,lifecycle_stage,contactability_status').in('canonical_e164', variants).limit(5000)),
      read(supabase.from('phones').select('phone_id,canonical_e164,phone,phone_raw,phone_contact_status,wrong_number_at').in('canonical_e164', variants).limit(5000)),
      read(supabase.from('message_events').select('id,from_phone_number,property_id,detected_intent,is_opt_out').eq('direction', 'inbound').in('from_phone_number', variants).in('detected_intent', g.SEND_TIME_REPLY_INTENTS).limit(10000)),
      read(supabase.from('contact_property_resolution').select('property_id,contact_phone_e164,contact_property_role,suppression_scope,rejected_at,rejection_reason,updated_at').in('contact_phone_e164', variants).limit(10000)),
      read(supabase.from('message_events').select('id,thread_key,direction,message_body,created_at,event_timestamp,property_id,detected_intent').in('thread_key', variants).order('created_at', { ascending: false }).limit(60 * chunk)),
    ])
    for (const s of [...sup1, ...sup2]) { push(g.phoneKey(s.phone_e164), 'suppressions', s); if (g.phoneKey(s.phone_number) !== g.phoneKey(s.phone_e164)) push(g.phoneKey(s.phone_number), 'suppressions', s) }
    for (const s of auto) push(g.phoneKey(s.phone_e164), 'automation_suppressions', s)
    for (const t of [...thr1, ...thr2]) { push(g.phoneKey(t.thread_key), 'threads', t); if (g.phoneKey(t.canonical_e164) !== g.phoneKey(t.thread_key)) push(g.phoneKey(t.canonical_e164), 'threads', t) }
    for (const p of phones) push(g.phoneKey(p.canonical_e164), 'phones', p)
    for (const m of replies) push(g.phoneKey(m.from_phone_number), 'inbound_replies', m)
    for (const r of cpr) push(g.phoneKey(r.contact_phone_e164), 'contact_property_resolution', r)
    for (const m of msgs) push(g.phoneKey(m.thread_key), 'thread_messages', m)
  }
  const kept = []; const refused = []
  for (const row of rows) {
    const k = keyOf(row)
    const facts = byKey.get(k) || {}
    const v = g.evaluateSendTimeContactGuard(row, { ...facts, automation_hold: null }, { now, restrictionsOnly: true })
    if (v?.blocked) refused.push({ row, reason: `${ENQUEUE_RESTRICTION_PREFIX}:${v.reason}`, guard_reason: v.reason })
    else kept.push(row)
  }
  return { kept, refused }
}
