/**
 * SELLER FOLLOW-UP EMAIL LANE.
 *
 * The seller follow-up scheduler (seller-followup-scheduler.scheduleFollowUp)
 * asks this lane first. The lane takes the follow-up ONLY when ALL hold:
 *   1. lane gate system_control.email_lane_seller_followup is enabled
 *      (default OFF — with it off nothing here runs and SMS is unchanged);
 *   2. the seller has a seller email thread (same SMS thread key, or
 *      seller:<owner>:<property>) whose contact_preference is 'email' — set
 *      only from the seller's own words ("email me instead");
 *   3. the follow-up is not an opt-out / DNC / wrong-number case (those never
 *      reach the scheduler, and are refused here again);
 *   4. the SMS conversation is not opted out / DNC (conservative: an SMS STOP
 *      is not overridden by this lane);
 *   5. owner-approved copy exists (email_templates row, not COPY NOT APPROVED);
 *   6. the address is not suppressed (enqueueAutomatedEmail refuses).
 * Otherwise it returns handled:false and the SMS follow-up proceeds as before.
 *
 * Disposition rules (owner): "not interested" / "not now" is a 30-day
 * nurture — the lane sends the nurture copy on the scheduler's date; it is
 * never treated as a suppression. Any seller inbound (SMS or email) supersedes
 * pending seller email (cancelPendingSellerEmails) and the dispatcher's seller
 * revalidator drops it if the seller texted after it was planned.
 */
import { enqueueAutomatedEmail, readEmailLaneGate } from './email-enqueue.js'
import { renderStoredTemplate } from './email-templates.js'
import { BLOCKING_CONTACTABILITY } from './email-revalidators.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

const NEVER_INTENTS = new Set(['opt_out', 'stop', 'dnc', 'do_not_contact', 'wrong_number', 'wrong_person', 'hostile_or_legal'])
const NURTURE_INTENTS = new Set(['not_interested', 'need_time', 'not_now', 'not_ready'])

export function followUpTemplateKey(intent, useCase) {
  return NURTURE_INTENTS.has(lower(intent)) || lower(useCase).startsWith('nurture_') ? 'seller.nurture' : 'seller.followup'
}

function firstName(name) {
  const n = clean(name).split(/\s+/)[0]
  return n && /^[A-Za-z][A-Za-z'-]{1,20}$/.test(n) ? n[0].toUpperCase() + n.slice(1).toLowerCase() : ''
}

async function findSellerEmailThread(db, { thread_key, master_owner_id, property_id }) {
  const key = clean(thread_key)
  if (key) {
    const { data } = await db.from('email_threads').select('*').eq('sms_thread_key', key).eq('category', 'seller').order('last_message_at', { ascending: false }).limit(1)
    if (data?.[0]) return data[0]
  }
  if (clean(master_owner_id)) {
    const { data } = await db.from('email_threads').select('*').eq('thread_key', `seller:${clean(master_owner_id)}:${clean(property_id) || 'any'}`).maybeSingle()
    if (data) return data
  }
  return null
}

/**
 * @returns {{ handled: boolean, reason: string, queue_row_id?: string, scheduled_for?: string, duplicate?: boolean }}
 */
export async function routeSellerFollowUpToEmail({ thread_key, intent, use_case_template, scheduled_for, master_owner_id = null, property_id = null } = {}, { supabase: db } = {}) {
  if (!db) return { handled: false, reason: 'no_client' }
  const gate = await readEmailLaneGate(db, 'seller_followup')
  if (!gate.enabled) return { handled: false, reason: gate.reason }
  if (NEVER_INTENTS.has(lower(intent))) return { handled: false, reason: 'intent_never_emailed' }

  const thread = await findSellerEmailThread(db, { thread_key, master_owner_id, property_id })
  if (!thread) return { handled: false, reason: 'no_seller_email_thread' }
  if (thread.contact_preference !== 'email') return { handled: false, reason: 'no_email_preference' }
  if (!clean(thread.counterparty_email)) return { handled: false, reason: 'no_email_address' }

  const smsKey = clean(thread.sms_thread_key) || clean(thread_key)
  const { data: conv } = smsKey
    ? await db.from('inbox_thread_state').select('contactability_status, is_suppressed, seller_display_name').eq('thread_key', smsKey).maybeSingle()
    : { data: null }
  if (BLOCKING_CONTACTABILITY.has(lower(conv?.contactability_status)) || conv?.is_suppressed === true) return { handled: false, reason: 'seller_opted_out' }

  const [{ data: senders }, { data: prop }] = await Promise.all([
    db.from('email_senders').select('sender_key, sender_name, is_default, is_active').eq('is_active', true),
    thread.property_id || property_id
      ? db.from('properties').select('property_address_full, property_address').eq('property_id', thread.property_id || property_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const sender = (senders || []).find((s) => thread.brand_key && lower(s.sender_key) === lower(thread.brand_key)) || (senders || []).find((s) => s.is_default)
  const templateKey = followUpTemplateKey(intent, use_case_template)
  const r = await renderStoredTemplate(db, templateKey, {
    sender_name: clean(sender?.sender_name),
    property_address: clean(prop?.property_address_full || prop?.property_address),
    first_name: firstName(conv?.seller_display_name || thread.counterparty_name),
  })
  if (!r.ok) return { handled: false, reason: r.code }

  const at = Number.isFinite(Date.parse(scheduled_for)) ? new Date(Date.parse(scheduled_for)).toISOString() : null
  if (!at) return { handled: false, reason: 'missing_scheduled_for' }
  const useCase = clean(use_case_template) || `nurture_${lower(intent) || 'followup'}`
  const out = await enqueueAutomatedEmail(db, {
    source: 'seller',
    // Same key family as the seller brain's email follow-ups, so the two can never double-book a day.
    queue_key: `seller_followup:email:${thread.id}:${lower(intent) || 'nudge'}:${at.slice(0, 10)}`,
    source_ref: `followup:${thread.id}:${lower(intent) || 'nudge'}`,
    to_email: thread.counterparty_email,
    subject: r.subject,
    html_body: r.html,
    text_body: r.text,
    template_id: r.templateId,
    template_version: r.version,
    action_key: 'seller.followup',
    sequence: 2,
    lane: 'seller_conversation',
    scheduled_for: at,
    thread: { thread_key: thread.thread_key, category: 'seller', master_owner_id: thread.master_owner_id || master_owner_id, property_id: thread.property_id || property_id, sms_thread_key: smsKey, brand_key: thread.brand_key },
    requested_by: 'seller_followup_scheduler',
    reason: { why: 'Seller asked to be contacted by email; follow-up routed to email', intent, use_case_template: useCase, follow_up_at: at, sms_thread_key: smsKey },
    metadata: { use_case_template: useCase, intent, channel_routing: 'contact_preference_email' },
  })
  if (!out.ok) return { handled: false, reason: out.code }
  return { handled: true, reason: out.duplicate ? 'duplicate_email_followup' : 'email_followup_queued', queue_row_id: out.queue_row_id, scheduled_for: at, duplicate: Boolean(out.duplicate), thread_id: out.thread_id }
}
