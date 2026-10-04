/**
 * EMAIL ENQUEUE — the one way an AUTOMATED producer asks for an email.
 *
 * Producers (workflow steps, the seller follow-up lane, a future campaign
 * email channel) never call a provider and never write email_queue rows by
 * hand. They call enqueueAutomatedEmail(); the email dispatcher
 * (email-dispatch.js) is the only thing that sends, and it re-checks
 * everything at dispatch time against fresh state.
 *
 * What this guarantees at enqueue time:
 *   - IDEMPOTENT: queue_key is required and deterministic (the logical
 *     communication id). The same key twice → one row, reported duplicate.
 *   - SUPPRESSION FIRST: a suppressed address (bounce / unsubscribe /
 *     complaint) is refused before anything is written.
 *   - LINEAGE: every row is on an email_threads conversation (business
 *     lineage key, e.g. seller:<owner>:<property>), so replies thread and the
 *     Inbox can show it beside SMS.
 *   - REVALIDATED SOURCE: the source must have a dispatch-time revalidator
 *     registered, otherwise the dispatcher could never decide whether the
 *     message is still wanted.
 *   - ORIGIN = automation, lane explicit, template_id stamped (KPI join).
 *
 * What this does NOT do: decide whether email is ON. Enqueueing is allowed
 * while sending is off (the dispatcher holds the row); whether a producer may
 * enqueue at all is its lane gate (readEmailLaneGate).
 */
import { ensureThread, isValidEmail } from './email-identity.js'
import { hasEmailRevalidator } from './email-dispatch.js'
import './email-revalidators.js' // registers the seller + workflow revalidators
import { recordEmailEvent } from './email-telemetry.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const truthy = (v) => ['1', 'true', 'yes', 'on', 'enabled'].includes(lower(v))

export const AUTOMATED_SOURCES = Object.freeze(new Set(['seller', 'workflow', 'campaign']))
const LANES = new Set(['acquisition', 'seller_conversation', 'transactional', 'closing', 'buyer', 'system'])

/**
 * Lane gates. Each automated producer has its own system_control switch,
 * DEFAULT OFF: missing, unreadable or any value other than enabled/true ⇒
 * the producer does not enqueue. email_automation_enabled is the umbrella.
 * These gate ENQUEUE; sending is separately gated by email_enabled +
 * EMAIL_SEND_ENABLED in the dispatcher.
 */
export const LANE_GATE_KEYS = Object.freeze({
  seller_followup: 'email_lane_seller_followup',
  workflow: 'email_lane_workflow',
  campaign: 'email_lane_campaign',
})

export async function readEmailLaneGate(db, lane) {
  const key = LANE_GATE_KEYS[lane]
  if (!key) return { enabled: false, reason: `unknown_lane:${lane}` }
  if (!db) return { enabled: false, reason: 'no_client' }
  try {
    const { data, error } = await db.from('system_control').select('key, value').in('key', ['email_automation_enabled', key])
    if (error) return { enabled: false, reason: 'gate_unreadable' }
    const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
    if (m.email_automation_enabled !== undefined && !truthy(m.email_automation_enabled)) return { enabled: false, reason: 'email_automation_disabled' }
    if (!truthy(m[key])) return { enabled: false, reason: `${key}_off` }
    return { enabled: true, reason: 'enabled' }
  } catch {
    return { enabled: false, reason: 'gate_unreadable' }
  }
}

async function suppressionOf(db, email) {
  const { data, error } = await db.from('email_suppression').select('reason, suppression_status, is_active, expires_at').eq('email_address', lower(email)).maybeSingle()
  if (error) return { ok: false }
  if (data && data.is_active !== false && !(data.expires_at && Date.parse(data.expires_at) < Date.now())) return { ok: true, suppressed: true, reason: data.reason || data.suppression_status || 'suppressed' }
  return { ok: true, suppressed: false }
}

/**
 * @param {object} db supabase client
 * @param {object} spec
 *   source        'seller' | 'workflow' | 'campaign' (must have a revalidator)
 *   queue_key     deterministic logical id (REQUIRED)
 *   to_email, subject, html_body, text_body
 *   thread        { thread_key, category, master_owner_id, property_id, prospect_id, sms_thread_key, brand_key, counterparty_name }
 *   scheduled_for ISO; future → 'scheduled', else 'pending_send'
 *   template_id, template_version, action_key, sequence, lane, source_ref,
 *   campaign_id, campaign_target_id, sequence_id, sequence_step, reason, metadata, requested_by
 */
export async function enqueueAutomatedEmail(db, spec = {}, { now = Date.now() } = {}) {
  const source = lower(spec.source)
  if (!db) return { ok: false, code: 'no_client' }
  if (!AUTOMATED_SOURCES.has(source)) return { ok: false, code: `source_not_automated:${source || 'none'}` }
  if (!hasEmailRevalidator(source)) return { ok: false, code: `no_revalidator:${source}` }
  const queueKey = clean(spec.queue_key)
  if (!queueKey) return { ok: false, code: 'queue_key_required' }
  const to = lower(spec.to_email)
  if (!isValidEmail(to)) return { ok: false, code: 'recipient_invalid' }
  const subject = clean(spec.subject)
  const html = clean(spec.html_body)
  const text = clean(spec.text_body)
  if (!subject || !(html || text)) return { ok: false, code: 'content_missing' }
  const threadSpec = spec.thread || {}
  if (!clean(threadSpec.thread_key)) return { ok: false, code: 'thread_unlinked' }

  const sup = await suppressionOf(db, to)
  if (!sup.ok) return { ok: false, code: 'suppression_check_failed' }
  if (sup.suppressed) return { ok: false, blocked: true, code: 'recipient_suppressed', suppression_reason: sup.reason }

  let thread = await ensureThread(db, {
    ...threadSpec,
    counterparty_email: threadSpec.counterparty_email || to,
    subject: threadSpec.subject || subject,
    resolution_method: threadSpec.resolution_method || `automation:${source}`,
  })
  if (clean(threadSpec.sms_thread_key) && !clean(thread.sms_thread_key)) {
    await db.from('email_threads').update({ sms_thread_key: clean(threadSpec.sms_thread_key), updated_at: new Date(now).toISOString() }).eq('id', thread.id)
    thread = { ...thread, sms_thread_key: clean(threadSpec.sms_thread_key) }
  }
  if (thread.automation_state === 'taken_over') return { ok: false, blocked: true, code: 'operator_took_over', thread_id: thread.id }
  if (thread.automation_state === 'paused') return { ok: false, blocked: true, code: 'automation_paused', thread_id: thread.id }

  const due = Number.isFinite(Date.parse(spec.scheduled_for)) ? Date.parse(spec.scheduled_for) : now
  const lane = LANES.has(clean(spec.lane)) ? clean(spec.lane) : (source === 'campaign' ? 'acquisition' : thread.master_owner_id ? 'seller_conversation' : 'transactional')
  const row = {
    queue_key: queueKey,
    queue_status: due > now ? 'scheduled' : 'pending_send',
    scheduled_for: new Date(due).toISOString(),
    to_email: to,
    subject,
    email_body: html || null,
    html_body: html || null,
    text_body: text || null,
    template_id: clean(spec.template_id) || null,
    template_version: clean(spec.template_version) || null,
    master_owner_id: clean(threadSpec.master_owner_id) || thread.master_owner_id || null,
    prospect_id: clean(threadSpec.prospect_id) || thread.prospect_id || null,
    property_id: clean(threadSpec.property_id) || thread.property_id || null,
    thread_id: thread.id,
    source,
    source_ref: clean(spec.source_ref) || queueKey,
    action_key: clean(spec.action_key) || `${source}.email`,
    sequence: Number(spec.sequence) > 0 ? Number(spec.sequence) : 1,
    brand_key: clean(threadSpec.brand_key) || thread.brand_key || null,
    origin: 'automation',
    lane,
    campaign_id: clean(spec.campaign_id) || null,
    campaign_target_id: clean(spec.campaign_target_id) || null,
    sequence_id: clean(spec.sequence_id) || null,
    sequence_step: Number.isFinite(Number(spec.sequence_step)) && spec.sequence_step !== null && spec.sequence_step !== undefined ? Number(spec.sequence_step) : null,
    requested_by: clean(spec.requested_by) || source,
    reason: spec.reason && typeof spec.reason === 'object' ? spec.reason : { why: clean(spec.reason) || null },
    metadata: { ...(spec.metadata && typeof spec.metadata === 'object' ? spec.metadata : {}), sms_thread_key: clean(threadSpec.sms_thread_key) || thread.sms_thread_key || null },
  }
  const ins = await db.from('email_queue').insert(row).select('id, queue_status').maybeSingle()
  if (ins.error) {
    if (ins.error.code === '23505') {
      const { data: existing } = await db.from('email_queue').select('id, queue_status').eq('queue_key', queueKey).maybeSingle()
      return { ok: true, duplicate: true, queued: false, queue_row_id: existing?.id || null, status: existing?.queue_status || null, thread_id: thread.id, queue_key: queueKey }
    }
    return { ok: false, code: clean(ins.error.message) || 'email_queue_insert_failed' }
  }
  const id = ins.data?.id || null
  try {
    await recordEmailEvent(db, { type: row.queue_status === 'scheduled' ? 'scheduled' : 'queued', source: 'system', message: { ...row, id }, key: `enqueue:${row.queue_status}:${id || queueKey}` })
  } catch { /* telemetry never blocks the enqueue */ }
  return { ok: true, duplicate: false, queued: true, queue_row_id: id, status: row.queue_status, thread_id: thread.id, queue_key: queueKey, lane }
}
