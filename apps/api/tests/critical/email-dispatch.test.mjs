/**
 * Email Command — dispatch, closing bridge, send safety (§31–36, §43–47, §75–76, §109).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEmailDb, BRAND_SENDER, SEND_ENV, makeTransport } from '../helpers/email-db-mock.mjs'
import { runEmailDispatch } from '@/lib/domain/email/email-dispatch.js'
import { evaluateSendSafety } from '@/lib/domain/email/email-send-safety.js'
import { renderTemplate } from '@/lib/domain/email/email-templates.js'

const T0 = Date.parse('2026-09-29T15:00:00Z')
const H = 3600e3
const CASE = 'closing:c-1'

function seed(over = {}) {
  return {
    system_control: [{ key: 'email_enabled', value: 'true' }],
    email_senders: [{ ...BRAND_SENDER }],
    closing_cases: [{
      id: 'uuid-c1', closing_case_id: CASE, opportunity_id: 'opp-1', property_id: 'prop-1', master_owner_id: 'mo-1',
      property_address: '123 Main St, Dallas, TX', title_company_name: 'West Title', title_company_email: 'orders@westtitle.com',
      contract_status: 'fully_executed', closing_status: 'title_opened', scheduled_closing_date: '2026-10-15T00:00:00Z', closing_tz: 'America/Chicago',
      brand_key: 'reivesti', ...over.case,
    }],
    closing_email_requests: over.requests || [request('title_open', 'title_open', 1)],
    ...over.extra,
  }
}

function request(action, category, sequence, extra = {}) {
  return {
    id: `req-${category}-${sequence}`, request_key: `closing_email:${CASE}:${category}:${sequence}`, closing_case_id: CASE, opportunity_id: 'opp-1', property_id: 'prop-1',
    action, category, sequence, recipient_role: 'title', recipient_email: 'orders@westtitle.com', template_key: `closing.${action}`, template_version: 'v1',
    thread_key: `closing:${CASE}:title`, status: 'pending_transport', status_reason: 'test', requested_by: 'closing_automation',
    due_at: new Date(T0 - 60e3).toISOString(), payload: { property_address: '123 Main St, Dallas, TX', title_company_name: 'West Title' }, created_at: new Date(T0 - 60e3).toISOString(),
    ...extra,
  }
}

const run = (db, transport, now = T0, env = SEND_ENV) => runEmailDispatch({ now, worker: 'test' }, { supabase: db, send: transport.send, notify: async () => ({ ok: true }), env })

test('closing request → one threaded email; request written back as sent; re-run never resends', async () => {
  const db = makeEmailDb(seed())
  const tx = makeTransport()
  const s1 = await run(db, tx)
  assert.equal(s1.bridged, 1)
  assert.equal(s1.sent, 1)
  assert.equal(tx.calls.length, 1)
  const call = tx.calls[0]
  assert.equal(call.payload.to, 'orders@westtitle.com')
  assert.match(call.payload.subject, /123 Main St/)
  assert.match(call.payload.headers['Message-Id'], /^<lc\..+@reivesti\.com>$/)
  assert.match(call.payload.replyTo.email, /^reply\+[a-f0-9]+@reply\.reivesti\.com$/)
  assert.equal(call.options.api_key, 'test-key')

  const req = db.state.closing_email_requests[0]
  assert.equal(req.status, 'sent')
  assert.ok(req.provider_message_id)
  const thread = db.state.email_threads[0]
  assert.equal(thread.thread_key, `closing:${CASE}:title`)
  assert.equal(thread.category, 'title')
  assert.equal(thread.outbound_count, 1)
  assert.equal(thread.last_message_direction, 'outbound')

  const s2 = await run(db, tx, T0 + 60e3)
  assert.equal(s2.bridged, 0)
  assert.equal(tx.calls.length, 1, 'no second send')
  assert.equal(db.state.email_queue.length, 1)
})

test('sending disabled: bridged and waiting, nothing sent, heartbeat still written', async () => {
  const db = makeEmailDb(seed())
  const tx = makeTransport()
  const s = await run(db, tx, T0, {})
  assert.equal(s.send_enabled, false)
  assert.equal(s.disabled_reason, 'EMAIL_SEND_ENABLED')
  assert.equal(s.waiting, 1)
  assert.equal(tx.calls.length, 0)
  assert.equal(db.state.email_queue[0].queue_status, 'pending_send')
  assert.ok(db.state.system_control.find((r) => r.key === 'email_dispatch_heartbeat_at'))

  const db2 = makeEmailDb(seed({ extra: { system_control: [{ key: 'email_enabled', value: 'false' }] } }))
  const s2 = await run(db2, tx)
  assert.equal(s2.disabled_reason, 'system_control.email_enabled')
  assert.equal(tx.calls.length, 0)
})

test('transport retry reuses the SAME logical message; it is not a new business email', async () => {
  const db = makeEmailDb(seed())
  const tx = makeTransport((_p, n) => (n === 1 ? { ok: false, sent: false, error: { code: 'brevo_provider_unavailable', retryable: true } } : { ok: true, sent: true, message_id: '<b2@x>' }))
  const s1 = await run(db, tx)
  assert.equal(s1.retried, 1)
  const row = db.state.email_queue[0]
  assert.equal(row.queue_status, 'pending_send')
  assert.equal(row.retry_count, 1)
  const firstId = tx.calls[0].payload.headers['Message-Id']

  const early = await run(db, tx, T0 + 60e3)
  assert.equal(early.claimed, 0, 'backoff respected')
  const s2 = await run(db, tx, T0 + 6 * 60e3)
  assert.equal(s2.sent, 1)
  assert.equal(db.state.email_queue.length, 1, 'one logical message')
  assert.equal(tx.calls[1].payload.headers['Message-Id'], firstId, 'same Message-ID across attempts')
})

test('stop condition met after planning → superseded at dispatch, no send (title acknowledged)', async () => {
  const db = makeEmailDb(seed({ requests: [request('title_followup', 'title_ack', 1)] }))
  const tx = makeTransport()
  db.state.closing_cases[0].title_acknowledged_at = new Date(T0 - 5 * 60e3).toISOString()
  const s = await run(db, tx)
  assert.equal(s.superseded, 1)
  assert.equal(tx.calls.length, 0)
  assert.equal(db.state.email_queue[0].queue_status, 'superseded')
  assert.equal(db.state.email_queue[0].cancel_reason, 'title_acknowledged')
  assert.equal(db.state.closing_email_requests[0].status, 'cancelled')
})

test('closing cancelled during queue execution → cancelled, no send', async () => {
  const db = makeEmailDb(seed())
  db.state.closing_cases[0].terminal_outcome = 'cancelled'
  const tx = makeTransport()
  const s = await run(db, tx)
  assert.equal(s.cancelled, 1)
  assert.equal(tx.calls.length, 0)
  assert.equal(db.state.email_queue[0].cancel_reason, 'closing_terminated')
})

test('operator takeover pauses automation on that thread only', async () => {
  const db = makeEmailDb(seed({ requests: [request('title_open', 'title_open', 1), { ...request('buyer_emd_reminder', 'buyer_emd', 1), recipient_role: 'buyer', recipient_email: 'buyer@fund.com', thread_key: `closing:${CASE}:buyer` }] }))
  db.state.emd_receipts = []
  db.state.buyer_offers = [{ buyer_offer_id: 'bo-1', opportunity_id: 'opp-1', status: 'committed', emd_status: 'required', emd_amount: 5000 }]
  const tx = makeTransport()
  // Pre-create the title thread as taken over.
  db.state.email_threads.push({ id: 'th-title', thread_key: `closing:${CASE}:title`, category: 'title', automation_state: 'taken_over', taken_over_by: 'op-1', taken_over_at: new Date(T0).toISOString(), resolution_status: 'resolved', reply_token: 'aaaaaaaaaaaaaaaa', inbound_count: 0, outbound_count: 0, attachment_count: 0 })
  const s = await run(db, tx)
  assert.equal(s.cancelled, 1)
  assert.equal(s.sent, 1)
  assert.equal(tx.calls.length, 1)
  assert.equal(tx.calls[0].payload.to, 'buyer@fund.com')
  assert.equal(db.state.email_queue.find((q) => q.to_email === 'orders@westtitle.com').cancel_reason, 'operator_took_over')
})

test('title replied after a reminder was planned → reminder superseded (no chase on top of a reply)', async () => {
  const db = makeEmailDb(seed({ requests: [request('title_commitment_reminder', 'title_commitment', 2)] }))
  db.state.closing_cases[0].title_acknowledged_at = new Date(T0 - 48 * H).toISOString()
  const tx = makeTransport()
  // Bridge first with sending off, then the title company replies.
  await run(db, tx, T0, {})
  const q = db.state.email_queue[0]
  const t = db.state.email_threads.find((x) => x.id === q.thread_id)
  t.last_inbound_at = new Date(Date.parse(q.created_at) + 1000).toISOString()
  const s = await run(db, tx, T0 + 2 * 60e3)
  assert.equal(s.superseded, 1)
  assert.equal(db.state.email_queue[0].cancel_reason, 'counterparty_replied')
  assert.equal(tx.calls.length, 0)
})

test('stale scheduled email (infrastructure down) escalates instead of sending', async () => {
  const db = makeEmailDb(seed({ requests: [request('title_open', 'title_open', 1, { due_at: new Date(T0 - 20 * H).toISOString() })] }))
  const tx = makeTransport()
  const s = await run(db, tx)
  assert.equal(s.escalated, 1)
  assert.equal(tx.calls.length, 0)
  const t = db.state.email_threads[0]
  assert.equal(t.needs_operator, true)
  assert.equal(t.needs_code, 'stale_scheduled_message')
})

test('bounced/suppressed address: no send, thread flagged for another channel', async () => {
  const db = makeEmailDb(seed({ extra: { email_suppression: [{ email_address: 'orders@westtitle.com', reason: 'hard_bounce', is_active: true }] } }))
  const tx = makeTransport()
  const s = await run(db, tx)
  assert.equal(s.cancelled, 1)
  assert.equal(tx.calls.length, 0)
  assert.equal(db.state.email_threads[0].needs_code, 'recipient_suppressed')
})

test('a send whose outcome is unknown is never re-sent automatically', async () => {
  const db = makeEmailDb(seed())
  const tx = makeTransport()
  await run(db, tx, T0, {}) // bridge only
  const q = db.state.email_queue[0]
  Object.assign(q, { queue_status: 'sending', attempt_started_at: new Date(Date.now() - 20 * 60e3).toISOString() })
  const s = await run(db, tx)
  assert.equal(s.reaped, 1)
  assert.equal(tx.calls.length, 0)
  assert.equal(db.state.email_queue[0].queue_status, 'failed')
  assert.equal(db.state.email_queue[0].failed_reason, 'transport_outcome_unknown')
  assert.equal(db.state.email_threads[0].needs_code, 'transport_outcome_unknown')
})

test('permanent provider rejection → failed, operator told, notification raised', async () => {
  const db = makeEmailDb(seed())
  const tx = makeTransport(() => ({ ok: false, sent: false, error: { code: 'brevo_invalid_request', retryable: false } }))
  const notes = []
  const s = await runEmailDispatch({ now: T0 }, { supabase: db, send: tx.send, notify: async (n) => { notes.push(n); return { ok: true } }, env: SEND_ENV })
  assert.equal(s.failed, 1)
  assert.equal(db.state.email_threads[0].needs_code, 'automation_failed')
  assert.equal(db.state.closing_email_requests[0].status, 'failed')
  assert.equal(notes[0].eventType, 'email_automation_failed')
})

test('follow-up #2 continues the same thread (In-Reply-To / References / Re:)', async () => {
  const db = makeEmailDb(seed())
  const tx = makeTransport()
  await run(db, tx)
  const firstId = tx.calls[0].payload.headers['Message-Id']
  db.state.closing_email_requests.push(request('title_followup', 'title_ack', 2, { due_at: new Date(T0 + H).toISOString(), created_at: new Date(T0 + H).toISOString() }))
  await run(db, tx, T0 + H + 60e3)
  assert.equal(tx.calls.length, 2)
  const h = tx.calls[1].payload.headers
  assert.equal(h['In-Reply-To'], firstId)
  assert.match(h.References, new RegExp(firstId.replace(/[.*+?^${}()|[\]\\<>]/g, '\\$&')))
  assert.match(tx.calls[1].payload.subject, /^Re: /)
  assert.equal(db.state.email_threads.length, 1, 'one conversation')
  assert.equal(db.state.email_threads[0].outbound_count, 2)
})

test('templates refuse to render with a missing required fact (never a blank price/date)', () => {
  const r = renderTemplate('closing.closing_confirmation', { property_address: '1 A St', sender_name: 'X' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'template_variables_incomplete')
  assert.deepEqual(r.missing, ['scheduled_closing_date'])
  const ok = renderTemplate('closing.title_open', { property_address: '1 A St', sender_name: 'X' })
  assert.equal(ok.ok, true)
  assert.doesNotMatch(ok.text, /\{\{|\}\}/)
})

test('send safety: identity uncertain escalates; manual send ignores automation pause', () => {
  const base = { to_email: 'a@b.com', subject: 's', text_body: 't', source: 'seller', created_at: new Date(T0).toISOString(), scheduled_for: new Date(T0).toISOString() }
  const sender = { ok: true, sender: {} }
  assert.equal(evaluateSendSafety({ row: base, thread: { automation_state: 'active', resolution_status: 'ambiguous' }, suppression: { ok: true }, sender, now: T0 }).code, 'recipient_identity_uncertain')
  assert.equal(evaluateSendSafety({ row: { ...base, source: 'manual' }, thread: { automation_state: 'taken_over' }, suppression: { ok: true }, sender, now: T0 }).decision, 'send')
  assert.equal(evaluateSendSafety({ row: base, thread: { automation_state: 'active' }, suppression: { ok: true }, sender, now: T0, alreadySent: true }).code, 'duplicate_logical_message')
})
