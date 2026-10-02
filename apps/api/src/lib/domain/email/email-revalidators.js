/**
 * DISPATCH-TIME REVALIDATORS for automated email sources.
 *
 * The dispatcher refuses (defers) any automated row whose source has no
 * revalidator, so every producer source must register one here. Kept free of
 * seller-flow imports so producers on the SMS path can load it cheaply.
 *
 *   seller   — the seller answered by SMS after this was planned, opted out,
 *              or the conversation closed → do not send.
 *   workflow — a workflow email to a seller follows the seller rules; any
 *              other workflow email is still wanted unless the dispatcher's
 *              own gates (suppression, takeover, stale, counterparty replied)
 *              say otherwise.
 *   scheduling — an appointment reminder is dropped when the appointment was
 *              cancelled, rescheduled or moved (scheduling-reminders.js).
 */
import { registerEmailRevalidator } from './email-dispatch.js'
import { revalidateSchedulingEmail } from '@/lib/domain/scheduling/scheduling-reminders.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

export const BLOCKING_CONTACTABILITY = Object.freeze(new Set(['opted_out', 'dnc', 'do_not_text', 'do_not_contact', 'suppressed', 'litigator']))
// Owner rule: "not interested" is a nurture, never terminal — nurture is NOT here.
const TERMINAL_STAGES = new Set(['closed', 'dead', 'suppressed', 'lost'])

/**
 * Dispatch-time revalidation for source='seller'. The seller may have answered
 * on SMS after this email was planned; the conversation may have been closed
 * or opted out; the deal may have moved past automation's stages.
 */
export async function revalidateSellerEmail(db, row, { thread } = {}) {
  const smsKey = clean(thread?.sms_thread_key) || clean(row.reason?.sms_thread_key) || clean(row.metadata?.sms_thread_key)
  if (smsKey) {
    const { data: conv } = await db.from('inbox_thread_state').select('last_inbound_at, contactability_status, is_suppressed, lifecycle_stage').eq('thread_key', smsKey).maybeSingle()
    if (conv) {
      // inbox_thread_state.last_inbound_at is stamped by SMS ingestion only
      // (email inbound never writes it), so a value newer than this email's
      // creation is a seller TEXT that arrived after we planned the email.
      const planned = Date.parse(row.created_at)
      const smsReply = Date.parse(conv.last_inbound_at)
      if (Number.isFinite(smsReply) && Number.isFinite(planned) && smsReply > planned) return { state: 'satisfied', reason: 'seller_replied_sms' }
      if ((BLOCKING_CONTACTABILITY.has(lower(conv.contactability_status)) || conv.is_suppressed === true) && thread?.contact_preference !== 'email') return { state: 'cancelled', reason: 'seller_opted_out' }
      if (TERMINAL_STAGES.has(lower(conv.lifecycle_stage))) return { state: 'cancelled', reason: 'conversation_closed' }
    }
  }
  return { state: 'still_needed' }
}

registerEmailRevalidator('seller', revalidateSellerEmail)

export async function revalidateWorkflowEmail(db, row, ctx = {}) {
  const sellerLineage = clean(row.master_owner_id) || clean(ctx.thread?.sms_thread_key) || clean(row.metadata?.sms_thread_key) || ctx.thread?.category === 'seller'
  if (sellerLineage) return revalidateSellerEmail(db, row, ctx)
  return { state: 'still_needed' }
}

registerEmailRevalidator('workflow', revalidateWorkflowEmail)
registerEmailRevalidator('scheduling', revalidateSchedulingEmail)
