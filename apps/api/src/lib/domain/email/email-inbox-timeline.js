/**
 * SELLER EMAIL TIMELINE for the Inbox — email beside SMS, same seller lineage.
 *
 * Read-only. Given the Inbox's SMS thread key (and/or owner+property), returns
 * every email thread of that seller and its messages as one time-ordered list
 * the Inbox can interleave with SMS. Lineage, not address: a seller thread is
 * keyed seller:<owner>:<property> and linked by email_threads.sms_thread_key.
 *
 * Bounded: at most 5 threads × 100 messages per direction. Status words come
 * from the outbox row as stored (never inferred delivery): an email is
 * 'sent' only after provider acceptance, 'delivered' only after a provider
 * delivery event.
 */
const clean = (v) => String(v ?? '').trim()

const preview = (s) => clean(s).replace(/\s+/g, ' ').slice(0, 240)

export async function getSellerEmailTimeline({ thread_key = null, master_owner_id = null, property_id = null } = {}, { supabase: db } = {}) {
  if (!db) return { ok: false, error: 'no_client' }
  const key = clean(thread_key)
  const owner = clean(master_owner_id)
  if (!key && !owner) return { ok: false, error: 'thread_key_or_owner_required', status: 400 }

  const found = new Map()
  if (key) {
    const { data, error } = await db.from('email_threads').select('id, thread_key, category, counterparty_email, subject, contact_preference, automation_state, needs_operator, needs_code, last_message_at, sms_thread_key').eq('sms_thread_key', key).limit(5)
    if (error) return { ok: false, error: 'email_threads_read_failed', message: error.message }
    for (const t of data || []) found.set(t.id, t)
  }
  if (owner) {
    const { data, error } = await db.from('email_threads').select('id, thread_key, category, counterparty_email, subject, contact_preference, automation_state, needs_operator, needs_code, last_message_at, sms_thread_key').eq('thread_key', `seller:${owner}:${clean(property_id) || 'any'}`).limit(1)
    if (error) return { ok: false, error: 'email_threads_read_failed', message: error.message }
    for (const t of data || []) found.set(t.id, t)
  }
  const threads = [...found.values()].slice(0, 5)
  if (!threads.length) return { ok: true, threads: [], items: [], email_present: false }

  const ids = threads.map((t) => t.id)
  const [out, inb] = await Promise.all([
    db.from('email_queue').select('id, thread_id, queue_status, subject, text_body, to_email, from_email, scheduled_for, sent_at, delivered_at, created_at, source, action_key, template_id, cancel_reason, failed_reason').in('thread_id', ids).order('created_at', { ascending: false }).limit(100),
    db.from('email_inbound_messages').select('id, thread_id, subject, reply_text, text_body, from_email, received_at, processing_status').in('thread_id', ids).order('received_at', { ascending: false }).limit(100),
  ])
  if (out.error || inb.error) return { ok: false, error: 'email_messages_read_failed', message: (out.error || inb.error).message }

  const items = [
    ...(out.data || []).map((q) => ({
      kind: 'email', direction: 'outbound', id: q.id, thread_id: q.thread_id,
      at: q.sent_at || q.scheduled_for || q.created_at,
      status: q.queue_status, // draft|awaiting_approval|scheduled|pending_send|sending|sent|delivered|bounced|failed|cancelled|superseded
      subject: q.subject || null, preview: preview(q.text_body),
      to: q.to_email, from: q.from_email || null, origin_source: q.source, action_key: q.action_key || null,
      template_id: q.template_id || null, delivered_at: q.delivered_at || null,
      stop_reason: q.cancel_reason || q.failed_reason || null,
    })),
    ...(inb.data || []).map((m) => ({
      kind: 'email', direction: 'inbound', id: m.id, thread_id: m.thread_id,
      at: m.received_at, status: m.processing_status || 'received',
      subject: m.subject || null, preview: preview(m.reply_text || m.text_body), from: m.from_email,
    })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)))

  return { ok: true, email_present: true, threads, items }
}
