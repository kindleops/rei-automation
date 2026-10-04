/**
 * SELLER EMAIL — one conversation brain, two transports.
 *
 * A seller email is processed by the SAME orchestrator as a seller SMS
 * (processSellerInboundMessage), called with the seller's SMS thread key:
 *   same classifier · same fact store (opportunity seller_facts, keyed owner+
 *   property) · same stage resolver · same next-question selection · same
 *   lead-state writer · same notifications · same autopilot switches.
 * Only transport differs: the reply is handed back here and queued as email,
 * a follow-up is scheduled as email, suppression is answered for the email
 * address. Pending SMS follow-ups are cancelled by the orchestrator's own
 * inbound-takeover step (it receives the SMS thread key); pending seller
 * email is cancelled on every seller inbound (email-seller-cancel.js).
 *
 * Channel policy (deliberately conservative):
 *   - A seller who opted out of SMS is NOT automatically emailed. Email
 *     automation is permitted after an SMS opt-out only when the seller
 *     explicitly asked for email ("email me instead").
 *   - An opt-out that arrives BY EMAIL suppresses that email address, and the
 *     orchestrator applies the same compliance to the SMS thread.
 *   - Suppressed / bounced address → no email; the operator sees it.
 */
import { processSellerInboundMessage } from '@/lib/domain/seller-flow/process-seller-inbound-message.js'
import { renderTemplate, renderStoredTemplate, textToHtml } from './email-templates.js'
import './email-revalidators.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const H = 3600e3

const EMAIL_PREFERENCE = /\b(e-?mail me|email (is|works) (better|best)|prefer(red)? (to )?e-?mail|contact me (by|via|through) e-?mail|reach me (by|at|via) e-?mail|(send|reply) (it )?(to|by) (my )?e-?mail|use (my )?e-?mail)\b/i
const EMAIL_OPT_OUT = /\b(unsubscribe|stop e-?mailing|don'?t e-?mail|do not e-?mail|remove me from (your|this) (e-?mail|mailing)|no more e-?mails?)\b/i
const OPT_OUT_INTENTS = new Set(['opt_out', 'stop', 'do_not_contact', 'hostile_or_legal', 'wrong_person', 'wrong_number'])
const BLOCKING_CONTACTABILITY = new Set(['opted_out', 'dnc', 'do_not_text', 'do_not_contact', 'suppressed', 'litigator'])

async function senderDisplayName(db, brandKey) {
  const { data } = await db.from('email_senders').select('sender_key, sender_name, is_default, is_active').eq('is_active', true)
  const rows = data || []
  const s = rows.find((r) => brandKey && lower(r.sender_key) === lower(brandKey)) || rows.find((r) => r.is_default)
  return clean(s?.sender_name) || 'Acquisitions'
}

async function upsertEmailSuppression(db, email, reason, source, meta = {}) {
  await db.from('email_suppression').upsert({ email_address: lower(email), reason, suppression_status: reason, source, is_active: true, metadata: meta, last_event_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'email_address' })
}

/** Nurture intents (owner rule: "a not interested is a 30 day follow up") use the nurture copy. */
const NURTURE_INTENTS = new Set(['not_interested', 'need_time', 'not_now', 'not_ready'])
export function sellerFollowUpTemplateKey(intentOrUseCase) {
  const v = lower(intentOrUseCase).replace(/^nurture_/, '')
  return NURTURE_INTENTS.has(v) || lower(intentOrUseCase).startsWith('nurture_') ? 'seller.nurture' : 'seller.followup'
}

function firstName(name) {
  const n = clean(name).split(/\s+/)[0]
  return n && /^[A-Za-z][A-Za-z'-]{1,20}$/.test(n) ? n[0].toUpperCase() + n.slice(1).toLowerCase() : ''
}

/**
 * Handle one resolved seller email. `deps.processSeller` is injectable for
 * tests; production uses the real orchestrator.
 */
export async function handleSellerEmail({ inbound, thread, resolution }, deps = {}) {
  const db = deps.supabase
  const process = deps.processSeller || processSellerInboundMessage
  const now = deps.now ? deps.now() : Date.now()
  const smsThreadKey = clean(thread.sms_thread_key) || clean(resolution?.sellerConversation?.thread_key)
  const text = clean(inbound.reply_text) || clean(inbound.text_body)
  if (!smsThreadKey) return { ok: false, needsOperator: { code: 'seller_email_no_conversation', reason: 'Seller emailed but has no conversation on record — link them first' } }
  if (!text) return { ok: true, empty: true }

  // Channel preference / email opt-out, stated in this email.
  if (EMAIL_OPT_OUT.test(text)) {
    await upsertEmailSuppression(db, inbound.from_email, 'unsubscribe', 'seller_email', { inbound_id: inbound.id })
  }
  if (EMAIL_PREFERENCE.test(text) && !EMAIL_OPT_OUT.test(text) && thread.contact_preference !== 'email') {
    await db.from('email_threads').update({ contact_preference: 'email', updated_at: new Date(now).toISOString(), metadata: { ...(thread.metadata || {}), contact_preference_evidence: { inbound_id: inbound.id, at: inbound.received_at, excerpt: text.slice(0, 200) } } }).eq('id', thread.id)
    thread = { ...thread, contact_preference: 'email' }
  }

  const { data: conv } = await db.from('inbox_thread_state').select('thread_key, contactability_status, is_suppressed, seller_display_name, lifecycle_stage').eq('thread_key', smsThreadKey).maybeSingle()
  const senderName = await senderDisplayName(db, thread.brand_key)
  const { data: prop } = thread.property_id ? await db.from('properties').select('property_address_full, property_address').eq('property_id', thread.property_id).maybeSingle() : { data: null }
  const propertyAddress = clean(prop?.property_address_full || prop?.property_address || thread.subject)
  const sellerFirst = firstName(conv?.seller_display_name || thread.counterparty_name)

  const channelSuppressionCheck = async () => {
    const { data: sup } = await db.from('email_suppression').select('reason, is_active').eq('email_address', lower(inbound.from_email)).maybeSingle()
    if (sup && sup.is_active !== false) return { suppressed: true, reason: `email_${sup.reason || 'suppressed'}`, row: { suppression_reason: `email_${sup.reason || 'suppressed'}` } }
    const blocked = BLOCKING_CONTACTABILITY.has(lower(conv?.contactability_status)) || conv?.is_suppressed === true
    if (blocked && thread.contact_preference !== 'email') return { suppressed: true, reason: 'sms_opt_out_blocks_email_automation', row: { suppression_reason: 'opt_out' } }
    return { suppressed: false, reason: 'none' }
  }

  const emailReplyImpl = async ({ rendered_message_text, selected_use_case, selected_template, scheduled_for, decision, language }) => {
    const subject = /^re:/i.test(clean(inbound.subject)) ? clean(inbound.subject) : `Re: ${clean(inbound.subject) || propertyAddress || 'your property'}`
    const r = renderTemplate('seller.reply', { message: rendered_message_text, sender_name: senderName, first_name: sellerFirst, subject })
    if (!r.ok) return { ok: false, reason: r.code }
    const queueKey = `seller_reply:email:${inbound.id}`
    const row = {
      queue_key: queueKey, queue_status: 'pending_send', scheduled_for: new Date(now).toISOString(),
      to_email: lower(inbound.from_email), subject: r.subject, email_body: r.html, html_body: r.html, text_body: r.text,
      template_id: clean(selected_template?.template_id || selected_template?.id) || null,
      master_owner_id: thread.master_owner_id, prospect_id: thread.prospect_id, property_id: thread.property_id,
      thread_id: thread.id, source: 'seller', source_ref: `inbound:${inbound.id}`, action_key: `seller.reply.${selected_use_case || 'reply'}`, sequence: 1,
      brand_key: thread.brand_key || null, requested_by: 'seller_brain',
      reason: { why: 'Seller replied by email', use_case: selected_use_case, audit_reason: decision?.audit_reason || null, language, sms_thread_key: smsThreadKey, sms_scheduled_for: scheduled_for || null },
      metadata: { inbound_id: inbound.id, sms_thread_key: smsThreadKey, template_source: 'sms_templates' },
    }
    const ins = await db.from('email_queue').insert(row).select('id').maybeSingle()
    if (ins.error) {
      if (ins.error.code === '23505') return { ok: false, reason: 'duplicate_blocked' }
      return { ok: false, reason: ins.error.message }
    }
    return { ok: true, queue_row_id: ins.data?.id || null, queue_item_id: ins.data?.id || null, channel: 'email' }
  }

  const emailFollowUpImpl = async ({ intent, follow_up_at, is_suppressed }) => {
    if (is_suppressed) return { ok: true, skipped: true, reason: 'suppressed' }
    const at = Date.parse(follow_up_at) || now + 48 * H
    // Owner-approved copy only (email_templates row); a "not interested" /
    // "not now" is a 30-day nurture, never a suppression.
    const templateKey = sellerFollowUpTemplateKey(intent)
    const r = await renderStoredTemplate(db, templateKey, { sender_name: senderName, property_address: propertyAddress, first_name: sellerFirst })
    if (!r.ok) return { ok: false, skipped: true, reason: r.code }
    const day = new Date(at).toISOString().slice(0, 10)
    const ins = await db.from('email_queue').insert({
      queue_key: `seller_followup:email:${thread.id}:${intent || 'nudge'}:${day}`, queue_status: 'scheduled', scheduled_for: new Date(at).toISOString(),
      to_email: lower(inbound.from_email), subject: r.subject, email_body: r.html, html_body: r.html, text_body: r.text,
      template_id: r.templateId, template_version: r.version, origin: 'automation', lane: 'seller_conversation',
      master_owner_id: thread.master_owner_id, prospect_id: thread.prospect_id, property_id: thread.property_id,
      thread_id: thread.id, source: 'seller', source_ref: `followup:${thread.id}:${intent || 'nudge'}`, action_key: 'seller.followup', sequence: 2,
      brand_key: thread.brand_key || null, requested_by: 'seller_brain',
      reason: { why: 'Seller has not replied', intent, follow_up_at: new Date(at).toISOString(), sms_thread_key: smsThreadKey },
    }).select('id').maybeSingle()
    if (ins.error && ins.error.code !== '23505') return { ok: false, skipped: true, reason: ins.error.message }
    return { ok: true, followup_created: !ins.error, scheduled_for: new Date(at).toISOString(), channel: 'email' }
  }

  const result = await process({
    message: text,
    threadKey: smsThreadKey,
    ownerId: thread.master_owner_id,
    propertyId: thread.property_id,
    prospectId: thread.prospect_id,
    inboundEventId: `email:${inbound.id}`,
    inboundReceivedAt: inbound.received_at,
    providerMessageId: inbound.message_id_header,
    supabaseClient: db,
    channel: 'email',
    emailReplyImpl,
    emailFollowUpImpl,
    channelSuppressionCheck,
  })

  const intent = lower(result?.classification?.primary_intent)
  if (OPT_OUT_INTENTS.has(intent) && intent !== 'wrong_number') {
    // They told us to stop on the channel they used. Honour it on that channel.
    await upsertEmailSuppression(db, inbound.from_email, intent === 'hostile_or_legal' ? 'complaint' : 'opt_out', 'seller_email', { inbound_id: inbound.id })
  }
  const auto = result?.execution?.automation_decision || {}
  const review = auto.should_mark_human_review || auto.reply_mode === 'manual_review' || intent === 'hostile_or_legal'
  return {
    ok: Boolean(result?.ok),
    classification: {
      primary_intent: result?.classification?.primary_intent || null,
      facts: result?.fact_extraction?.facts || null,
      stage_after: result?.decision?.stage_after || null,
      next_use_case: result?.execution?.selected_template?.use_case || null,
      replied_by: result?.execution?.queued ? 'email' : null,
      sms_followups_cancelled: Number(result?.followup_cancellation?.cancelled) || 0,
    },
    queued: Boolean(result?.execution?.queued),
    email_cancellation: result?.email_cancellation || null,
    followup_cancellation: result?.followup_cancellation || null,
    needsOperator: review ? { code: 'seller_needs_review', reason: auto.human_review_reason ? `Seller reply needs your judgment (${String(auto.human_review_reason).replace(/_/g, ' ')})` : 'Seller reply needs your judgment' } : null,
  }
}

// Dispatch-time revalidators live in email-revalidators.js (dependency-light,
// so producers can register them without importing the seller brain).
export { revalidateSellerEmail } from './email-revalidators.js'

export const _internal = { EMAIL_PREFERENCE, EMAIL_OPT_OUT, textToHtml }
