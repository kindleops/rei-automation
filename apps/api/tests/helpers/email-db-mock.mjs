/**
 * In-memory Supabase for Email Command tests. Extends the closing mock with the
 * production email rules from 20260929120000_email_communication_plane.sql:
 * unique keys, queue status/approval/cancel CHECKs, attachment routing CHECK,
 * the thread-touch triggers, and the claim / reap RPCs.
 */
import { makeClosingDb } from './closing-db-mock.mjs'

const STATUSES = new Set(['draft', 'awaiting_approval', 'scheduled', 'pending_send', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'cancelled', 'superseded', 'no_send', 'skipped'])

const UNIQUE = {
  email_threads: [['thread_key'], ['reply_token']],
  email_queue: [['queue_key'], ['message_id_header']],
  email_inbound_messages: [['dedupe_key']],
  email_attachments: [['attachment_key']],
  email_events: [['event_key']],
  email_suppression: [['email_address']],
  email_senders: [['sender_key']],
  email_links: [['token'], ['queue_id', 'link_index']],
  system_control: [['key']],
}

function check(table, row, old) {
  if (table === 'email_events' && old) {
    const strip = (r) => { const { raw_payload, ...rest } = r; return JSON.stringify(rest) }
    if (strip(row) !== strip(old)) return { code: 'P0001', message: 'EMAIL_EVENTS_APPEND_ONLY' }
  }
  if (table === 'email_queue') {
    if (row.queue_status && !STATUSES.has(row.queue_status)) return { code: '23514', message: `email_queue_status_check ${row.queue_status}` }
    if (['required', 'rejected'].includes(row.approval_status) && !['draft', 'awaiting_approval', 'cancelled', 'superseded'].includes(row.queue_status)) return { code: '23514', message: 'email_queue_approval_gate' }
    if (['cancelled', 'superseded'].includes(row.queue_status) && !row.cancel_reason) return { code: '23514', message: 'email_queue_cancel_has_reason' }
  }
  if (table === 'email_attachments' && row.routed_entity_id && !['auto_classified', 'reviewed'].includes(row.review_state)) return { code: '23514', message: 'email_attachments_routing_trusted' }
  if (table === 'email_threads') {
    if (row.automation_state === 'taken_over' && !(row.taken_over_by && row.taken_over_at)) return { code: '23514', message: 'email_threads_takeover_has_actor' }
    if (row.needs_operator && !(row.needs_code && row.needs_since)) return { code: '23514', message: 'email_threads_needs_has_reason' }
  }
  return null
}

const epoch = (v) => (v ? Date.parse(v) : 0)

function afterWrite(table, row, before, state) {
  if (table === 'email_threads' && !before) {
    Object.assign(row, { automation_state: row.automation_state || 'active', resolution_status: row.resolution_status || 'resolved', needs_operator: row.needs_operator || false, inbound_count: 0, outbound_count: 0, attachment_count: 0 })
  }
  if (table === 'email_queue') {
    row.approval_status = row.approval_status || 'not_required'
    if (!row.thread_id) return
    const entering = ['sent', 'delivered'].includes(row.queue_status) && (!before || !['sent', 'delivered'].includes(before.queue_status))
    if (!entering) return
    const t = state.email_threads.find((x) => x.id === row.thread_id)
    if (!t) return
    const at = row.sent_at || new Date().toISOString()
    const newer = epoch(at) >= epoch(t.last_message_at)
    Object.assign(t, {
      last_outbound_at: epoch(at) > epoch(t.last_outbound_at) ? at : t.last_outbound_at,
      last_message_at: newer ? at : t.last_message_at,
      last_message_direction: newer ? 'outbound' : t.last_message_direction,
      last_message_preview: newer ? String(row.text_body || row.email_body || '').replace(/\s+/g, ' ').slice(0, 200) : t.last_message_preview,
      outbound_count: (t.outbound_count || 0) + 1,
      root_message_id: t.root_message_id || row.message_id_header || null,
    })
  }
  if (table === 'email_inbound_messages') {
    if (!row.thread_id || (before && before.thread_id === row.thread_id)) return
    const t = state.email_threads.find((x) => x.id === row.thread_id)
    if (!t) return
    const at = row.received_at || new Date().toISOString()
    const newer = epoch(at) >= epoch(t.last_message_at)
    Object.assign(t, {
      last_inbound_at: epoch(at) > epoch(t.last_inbound_at) ? at : t.last_inbound_at,
      last_message_at: newer ? at : t.last_message_at,
      last_message_direction: newer ? 'inbound' : t.last_message_direction,
      last_message_preview: newer ? String(row.reply_text || row.text_body || '').replace(/\s+/g, ' ').slice(0, 200) : t.last_message_preview,
      inbound_count: (t.inbound_count || 0) + 1,
      attachment_count: (t.attachment_count || 0) + (row.attachment_count || 0),
    })
  }
}

function claim({ p_limit, p_worker, p_now }, state) {
  const now = Date.parse(p_now)
  const due = state.email_queue
    .filter((q) => ['pending_send', 'scheduled'].includes(q.queue_status))
    .filter((q) => epoch(q.scheduled_for || q.created_at) <= now)
    .filter((q) => !q.next_retry_at || epoch(q.next_retry_at) <= now)
    .filter((q) => ['not_required', 'approved', undefined].includes(q.approval_status))
    .sort((a, b) => epoch(a.scheduled_for || a.created_at) - epoch(b.scheduled_for || b.created_at))
    .slice(0, Math.max(1, Math.min(p_limit, 100)))
  for (const q of due) Object.assign(q, { queue_status: 'sending', is_locked: true, locked_at: p_now, lock_token: p_worker, attempt_started_at: p_now })
  return { data: due.map((q) => ({ ...q })), error: null }
}

function reap(_args, state) {
  let n = 0
  const cutoff = Date.now() - 15 * 60e3
  for (const q of state.email_queue) {
    if (q.queue_status === 'sending' && epoch(q.attempt_started_at) < cutoff) {
      Object.assign(q, { queue_status: 'failed', failed_reason: 'transport_outcome_unknown', is_locked: false })
      n++
    }
  }
  return { data: n, error: null }
}

export function makeEmailDb(seed = {}, extraRpc = {}) {
  const base = {
    email_threads: [], email_queue: [], email_inbound_messages: [], email_attachments: [], email_events: [],
    email_suppression: [], email_senders: [], email_templates: [], emails: [], inbox_thread_state: [], email_links: [],
    ...seed,
  }
  return makeClosingDb(base, {
    unique: UNIQUE,
    check,
    afterWrite,
    rpc: { email_queue_claim: claim, email_queue_reap_stuck: reap, ...extraRpc },
  })
}

export const BRAND_SENDER = Object.freeze({
  sender_key: 'reivesti', sender_name: 'Ryan · REIVESTI', from_email: 'ryan@reivesti.com', reply_to_email: 'ryan@reivesti.com',
  provider: 'brevo', provider_api_key_name: 'BREVO_REIVESTI_API_KEY', domain: 'reivesti.com', is_default: true, is_active: true,
  sender_status: 'active', messages_sent_today: 0, metadata: { inbound_domain: 'reply.reivesti.com' },
})

export const SEND_ENV = Object.freeze({ EMAIL_SEND_ENABLED: 'true', BREVO_REIVESTI_API_KEY: 'test-key' })

/** A fake Brevo transport recording every call. */
export function makeTransport(behaviour = () => ({ ok: true, sent: true, message_id: `<brevo.${Math.random().toString(36).slice(2)}@smtp-relay.mailin.fr>` })) {
  const calls = []
  const send = async (payload, options) => {
    calls.push({ payload, options })
    return behaviour(payload, calls.length)
  }
  return { calls, send }
}
