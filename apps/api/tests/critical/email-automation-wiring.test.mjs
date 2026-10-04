/**
 * Email automation wiring — every automated producer enqueues ONLY into
 * email_queue, the one dispatcher sends, and nothing leaves while gated.
 *
 *   A. no send while gated (email_enabled=false, EMAIL_SEND_ENABLED unset)
 *   B. deterministic queue keys: replays are duplicates, never second emails
 *   C. suppression + one-click unsubscribe honoured
 *   D. a seller inbound cancels pending seller email
 *   E. seller follow-up email lane (contact_preference, disposition, approved copy)
 *   F. workflow producers (V2 + orchestrator) → email_queue, never send_queue
 *   G. legacy SMTP path fenced
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEmailDb, BRAND_SENDER, makeTransport } from '../helpers/email-db-mock.mjs'
import { runEmailDispatch } from '@/lib/domain/email/email-dispatch.js'
import { enqueueAutomatedEmail, readEmailLaneGate } from '@/lib/domain/email/email-enqueue.js'
import { recordUnsubscribe } from '@/lib/domain/email/email-compliance.js'
import { cancelPendingSellerEmails } from '@/lib/domain/email/email-seller-cancel.js'
import { routeSellerFollowUpToEmail } from '@/lib/domain/email/email-seller-followup-lane.js'
import { renderTemplate, COPY_NOT_APPROVED } from '@/lib/domain/email/email-templates.js'
import { enqueueWorkflowEmail } from '@/lib/domain/workflow-v2/queue-adapter.js'
import { CAPABILITIES } from '@/lib/domain/workflow-studio/orchestrator/capabilities.js'
import { sendEmail } from '@/lib/providers/email.js'

const D = 864e5
const COMPLIANT_SENDER = Object.freeze({
  ...BRAND_SENDER,
  sender_key: 'prominent', sender_name: 'Prominent Cash Offer', from_email: 'offers@mail.example-brand.test', domain: 'mail.example-brand.test',
  provider_api_key_name: 'BREVO_PROMINENT_API_KEY',
  metadata: { inbound_domain: 'reply.example-brand.test', unsubscribe_base_url: 'https://track.example-brand.test', postal_address: '100 Test Street, Testville, TX 75001' },
})
const ENV_ON = Object.freeze({ EMAIL_SEND_ENABLED: 'true', BREVO_PROMINENT_API_KEY: 'test-key' })

const sellerSpec = (over = {}) => ({
  source: 'seller',
  queue_key: 'seller_followup:email:t:nudge:2026-10-05',
  to_email: 'Seller@Example.com',
  subject: 'Re: 12 Oak St',
  text_body: 'Checking back on 12 Oak St.',
  html_body: '<p>Checking back on 12 Oak St.</p>',
  template_id: 'seller.followup',
  thread: { thread_key: 'seller:mo-1:prop-1', category: 'seller', master_owner_id: 'mo-1', property_id: 'prop-1', sms_thread_key: '+15550001111' },
  ...over,
})

const dispatch = (db, tx, env, now = Date.now() + 1000) => runEmailDispatch({ now, worker: 'test' }, { supabase: db, send: tx.send, notify: async () => ({ ok: true }), env })

// ── A. gated ────────────────────────────────────────────────────────────────
test('A1 email_enabled=false: a queued seller email is held, transport never called', async () => {
  const db = makeEmailDb({ system_control: [{ key: 'email_enabled', value: 'false' }], email_senders: [{ ...COMPLIANT_SENDER }] })
  const q = await enqueueAutomatedEmail(db, sellerSpec())
  assert.equal(q.ok, true)
  const tx = makeTransport()
  const s = await dispatch(db, tx, ENV_ON)
  assert.equal(tx.calls.length, 0)
  assert.equal(s.send_enabled, false)
  assert.equal(s.disabled_reason, 'system_control.email_enabled')
  assert.equal(s.waiting, 1)
  assert.equal(db.state.email_queue[0].queue_status, 'pending_send')
})

test('A2 EMAIL_SEND_ENABLED unset: held even with the DB switch on', async () => {
  const db = makeEmailDb({ system_control: [{ key: 'email_enabled', value: 'true' }], email_senders: [{ ...COMPLIANT_SENDER }] })
  await enqueueAutomatedEmail(db, sellerSpec())
  const tx = makeTransport()
  const s = await dispatch(db, tx, { BREVO_PROMINENT_API_KEY: 'test-key' })
  assert.equal(tx.calls.length, 0)
  assert.equal(s.disabled_reason, 'EMAIL_SEND_ENABLED')
})

test('A3 lane gates default OFF (missing / unreadable / any non-enabled value)', async () => {
  assert.equal((await readEmailLaneGate(makeEmailDb({ system_control: [] }), 'seller_followup')).enabled, false)
  assert.equal((await readEmailLaneGate(makeEmailDb({ system_control: [{ key: 'email_lane_workflow', value: 'maybe' }] }), 'workflow')).enabled, false)
  assert.equal((await readEmailLaneGate({ from() { throw new Error('down') } }, 'workflow')).enabled, false)
  assert.equal((await readEmailLaneGate(makeEmailDb({ system_control: [{ key: 'email_lane_workflow', value: 'enabled' }, { key: 'email_automation_enabled', value: 'false' }] }), 'workflow')).enabled, false)
  assert.equal((await readEmailLaneGate(makeEmailDb({ system_control: [{ key: 'email_lane_workflow', value: 'enabled' }] }), 'workflow')).enabled, true)
})

// ── B. idempotency ─────────────────────────────────────────────────────────
test('B1 same queue_key twice → one row; second reported duplicate', async () => {
  const db = makeEmailDb({})
  const a = await enqueueAutomatedEmail(db, sellerSpec())
  const b = await enqueueAutomatedEmail(db, sellerSpec())
  assert.equal(a.ok && a.queued, true)
  assert.equal(b.ok && b.duplicate, true)
  assert.equal(b.queue_row_id, a.queue_row_id)
  assert.equal(db.state.email_queue.length, 1)
  const row = db.state.email_queue[0]
  assert.equal(row.origin, 'automation')
  assert.equal(row.lane, 'seller_conversation')
  assert.equal(row.template_id, 'seller.followup')
  assert.equal(row.to_email, 'seller@example.com')
  assert.equal(db.state.email_threads.length, 1)
  assert.equal(db.state.email_threads[0].sms_thread_key, '+15550001111')
})

test('B2 refusals: no queue key, unregistered source, manual source, invalid recipient, no thread', async () => {
  const db = makeEmailDb({})
  assert.equal((await enqueueAutomatedEmail(db, sellerSpec({ queue_key: '' }))).code, 'queue_key_required')
  assert.equal((await enqueueAutomatedEmail(db, sellerSpec({ source: 'campaign' }))).code, 'no_revalidator:campaign')
  assert.equal((await enqueueAutomatedEmail(db, sellerSpec({ source: 'manual' }))).code, 'source_not_automated:manual')
  assert.equal((await enqueueAutomatedEmail(db, sellerSpec({ to_email: 'not-an-email' }))).code, 'recipient_invalid')
  assert.equal((await enqueueAutomatedEmail(db, sellerSpec({ thread: {} }))).code, 'thread_unlinked')
  assert.equal(db.state.email_queue.length, 0)
})

// ── C. suppression + unsubscribe ───────────────────────────────────────────
test('C1 suppressed address refused at enqueue (nothing written)', async () => {
  const db = makeEmailDb({ email_suppression: [{ email_address: 'seller@example.com', reason: 'hard_bounce', is_active: true }] })
  const r = await enqueueAutomatedEmail(db, sellerSpec())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'recipient_suppressed')
  assert.equal(db.state.email_queue.length, 0)
})

test('C2 suppressed after enqueue → dispatcher cancels; transport never called', async () => {
  const db = makeEmailDb({ system_control: [{ key: 'email_enabled', value: 'true' }], email_senders: [{ ...COMPLIANT_SENDER }] })
  await enqueueAutomatedEmail(db, sellerSpec())
  db.state.email_suppression.push({ email_address: 'seller@example.com', reason: 'unsubscribe', is_active: true })
  const tx = makeTransport()
  const s = await dispatch(db, tx, ENV_ON)
  assert.equal(tx.calls.length, 0)
  assert.equal(s.cancelled, 1)
  assert.equal(db.state.email_queue[0].cancel_reason, 'recipient_suppressed')
})

test('C3 seller email carries one-click List-Unsubscribe + postal footer; unsubscribe suppresses that address', async () => {
  const db = makeEmailDb({ system_control: [{ key: 'email_enabled', value: 'true' }], email_senders: [{ ...COMPLIANT_SENDER }] })
  await enqueueAutomatedEmail(db, sellerSpec())
  await enqueueAutomatedEmail(db, sellerSpec({ queue_key: 'seller_followup:email:t:nudge:2026-11-05', scheduled_for: new Date(Date.now() + 30 * D).toISOString() }))
  const tx = makeTransport()
  const s = await dispatch(db, tx, ENV_ON)
  assert.equal(s.sent, 1)
  const p = tx.calls[0].payload
  const m = /^<(https:\/\/track\.example-brand\.test\/u\/([A-Za-z0-9_-]+))>$/.exec(p.headers['List-Unsubscribe'])
  assert.ok(m, 'List-Unsubscribe header is an https one-click URL')
  assert.equal(p.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.match(p.htmlContent, /100 Test Street, Testville, TX 75001/)
  assert.ok(p.htmlContent.includes(m[1]), 'unsubscribe link in the body is the raw URL, not a click redirect')
  assert.match(p.textContent, /Unsubscribe: https:\/\/track\.example-brand\.test\/u\//)

  const u1 = await recordUnsubscribe(db, m[2])
  assert.equal(u1.ok, true)
  const sup = db.state.email_suppression.find((r) => r.email_address === 'seller@example.com')
  assert.equal(sup?.reason, 'unsubscribe')
  assert.equal(sup?.is_active, true)
  const future = db.state.email_queue.find((r) => r.queue_key.endsWith('2026-11-05'))
  assert.equal(future.queue_status, 'superseded')
  assert.equal(future.cancel_reason, 'recipient_unsubscribed')
  const u2 = await recordUnsubscribe(db, m[2])
  assert.equal(u2.ok, true)
  assert.equal(u2.recorded, false, 'second one-click records nothing new')
  assert.equal(db.state.email_events.filter((e) => e.event_type === 'unsubscribed').length, 1)
  assert.equal((await recordUnsubscribe(db, 'x'.repeat(24))).reason, 'unknown_token')
})

test('C4 sender without postal address / unsubscribe base → deferred, never sent', async () => {
  const bare = { ...COMPLIANT_SENDER, metadata: { inbound_domain: 'reply.example-brand.test' } }
  const db = makeEmailDb({ system_control: [{ key: 'email_enabled', value: 'true' }], email_senders: [bare] })
  await enqueueAutomatedEmail(db, sellerSpec())
  const tx = makeTransport()
  const s = await dispatch(db, tx, ENV_ON)
  assert.equal(tx.calls.length, 0)
  assert.equal(s.deferred, 1)
  assert.equal(db.state.email_queue[0].failed_reason, 'sender_compliance_incomplete')
})

// ── D. seller inbound cancels pending seller email ─────────────────────────
test('D1 seller inbound supersedes pending seller email for that owner/property', async () => {
  const db = makeEmailDb({})
  await enqueueAutomatedEmail(db, sellerSpec())
  await enqueueAutomatedEmail(db, sellerSpec({ queue_key: 'other-seller', thread: { thread_key: 'seller:mo-2:prop-2', category: 'seller', master_owner_id: 'mo-2', property_id: 'prop-2' } }))
  const r = await cancelPendingSellerEmails({ master_owner_id: 'mo-1', property_id: 'prop-1', reason: 'seller_replied_sms', supabase: db })
  assert.equal(r.cancelled, 1)
  const [mine, other] = db.state.email_queue
  assert.equal(mine.queue_status, 'superseded')
  assert.equal(mine.cancel_reason, 'seller_replied_sms')
  assert.equal(other.queue_status, 'pending_send')
})

test('D2 seller texted after the email was planned → dispatcher supersedes it (revalidator)', async () => {
  const db = makeEmailDb({ system_control: [{ key: 'email_enabled', value: 'true' }], email_senders: [{ ...COMPLIANT_SENDER }] })
  await enqueueAutomatedEmail(db, sellerSpec())
  db.state.inbox_thread_state.push({ thread_key: '+15550001111', last_inbound_at: new Date(Date.now() + 500).toISOString(), contactability_status: 'contactable', lifecycle_stage: 'S2' })
  const tx = makeTransport()
  const s = await dispatch(db, tx, ENV_ON, Date.now() + 2000)
  assert.equal(tx.calls.length, 0)
  assert.equal(s.superseded, 1)
  assert.equal(db.state.email_queue[0].cancel_reason, 'seller_replied_sms')
})

// ── E. seller follow-up lane ───────────────────────────────────────────────
const APPROVED_NURTURE = { template_id: 'seller.nurture', is_active: true, version: 2, subject: 'Re: {{property_address}}', template_body: 'Hi {{first_name}}, owner-approved test copy for {{property_address}}. {{sender_name}}' }
function laneDb(over = {}) {
  return makeEmailDb({
    system_control: [{ key: 'email_lane_seller_followup', value: 'enabled' }],
    email_senders: [{ ...COMPLIANT_SENDER }],
    email_templates: [APPROVED_NURTURE],
    email_threads: [{ id: 'th-1', thread_key: 'seller:mo-1:prop-1', category: 'seller', sms_thread_key: '+15550001111', contact_preference: 'email', counterparty_email: 'seller@example.com', master_owner_id: 'mo-1', property_id: 'prop-1', brand_key: 'prominent', reply_token: 'abc123abc123', automation_state: 'active', resolution_status: 'resolved' }],
    inbox_thread_state: [{ thread_key: '+15550001111', contactability_status: 'contactable', seller_display_name: 'jane doe' }],
    properties: [{ property_id: 'prop-1', property_address_full: '12 Oak St, Dallas, TX' }],
    ...over,
  })
}
const nurtureAt = new Date(Date.now() + 30 * D).toISOString()
const nurtureReq = { thread_key: '+15550001111', intent: 'not_interested', use_case_template: 'nurture_not_interested', scheduled_for: nurtureAt, master_owner_id: 'mo-1', property_id: 'prop-1' }

test('E1 not interested + email preference → 30-day nurture EMAIL from approved copy (never suppressed)', async () => {
  const db = laneDb()
  const r = await routeSellerFollowUpToEmail(nurtureReq, { supabase: db })
  assert.equal(r.handled, true, r.reason)
  const row = db.state.email_queue[0]
  assert.equal(row.queue_status, 'scheduled')
  assert.equal(row.scheduled_for, nurtureAt)
  assert.equal(row.template_id, 'seller.nurture')
  assert.equal(row.template_version, 'db:2')
  assert.equal(row.source, 'seller')
  assert.match(row.text_body, /Hi Jane, owner-approved test copy for 12 Oak St, Dallas, TX\. Prominent Cash Offer/)
  assert.equal(db.state.email_suppression.length, 0)
  const again = await routeSellerFollowUpToEmail(nurtureReq, { supabase: db })
  assert.equal(again.handled && again.duplicate, true)
  assert.equal(db.state.email_queue.length, 1)
})

test('E2 lane refuses → SMS keeps the follow-up (gate off, no preference, sms preference, opted out, opt-out intent)', async () => {
  const cases = [
    [laneDb({ system_control: [] }), nurtureReq, 'email_lane_seller_followup_off'],
    [laneDb({ email_threads: [] }), nurtureReq, 'no_seller_email_thread'],
    [laneDb({ email_threads: [{ ...laneDb().state.email_threads[0], contact_preference: 'sms' }] }), nurtureReq, 'no_email_preference'],
    [laneDb({ inbox_thread_state: [{ thread_key: '+15550001111', contactability_status: 'opted_out' }] }), nurtureReq, 'seller_opted_out'],
    [laneDb(), { ...nurtureReq, intent: 'opt_out' }, 'intent_never_emailed'],
  ]
  for (const [db, req, reason] of cases) {
    const r = await routeSellerFollowUpToEmail(req, { supabase: db })
    assert.equal(r.handled, false)
    assert.equal(r.reason, reason)
    assert.equal(db.state.email_queue.length, 0)
  }
})

test('E3 copy not approved (no row / inactive / COPY NOT APPROVED placeholder) → nothing queued', async () => {
  for (const tpl of [[], [{ ...APPROVED_NURTURE, is_active: false }], [{ ...APPROVED_NURTURE, template_body: `[${COPY_NOT_APPROVED}]` }]]) {
    const db = laneDb({ email_templates: tpl })
    const r = await routeSellerFollowUpToEmail(nurtureReq, { supabase: db })
    assert.equal(r.handled, false)
    assert.equal(r.reason, 'template_copy_not_approved')
    assert.equal(db.state.email_queue.length, 0)
  }
  assert.equal(renderTemplate('seller.followup', { sender_name: 'x', property_address: 'y' }).code, 'template_copy_not_approved')
  assert.equal(renderTemplate('closing.title_open', { sender_name: 'x', property_address: 'y' }).ok, true, 'closing copy unaffected')
})

test('E4 scheduleFollowUp routes an email-preferring seller to email_queue and writes NO send_queue row', async () => {
  const { scheduleFollowUp } = await import('@/lib/domain/seller-flow/seller-followup-scheduler.js')
  const db = laneDb()
  const r = await scheduleFollowUp('not_interested', '+15550001111', { master_owner_id: 'mo-1', property_id: 'prop-1' }, db)
  assert.equal(r.ok, true)
  assert.equal(r.channel, 'email')
  assert.equal(db.state.email_queue.length, 1)
  assert.equal(db.state.email_queue[0].template_id, 'seller.nurture')
  assert.equal((db.state.send_queue || []).length, 0)
  const days = (Date.parse(db.state.email_queue[0].scheduled_for) - Date.now()) / D
  assert.ok(days > 29 && days < 31, `nurture is ~30 days out (got ${days})`)
})

// ── F. workflow producers ──────────────────────────────────────────────────
test('F1 Workflow V2 email step → email_queue (not send_queue); lane off → skipped; replay → duplicate', async () => {
  const off = makeEmailDb({})
  const r0 = await enqueueWorkflowEmail({ enrollment_id: 'en-1', node_id: 'n-1', to_email: 'a@b.co', subject: 's', message_body: 'b' }, { supabase: off })
  assert.equal(r0.ok, false)
  assert.equal(r0.skipped, true)
  assert.equal(off.state.email_queue.length, 0)

  const db = makeEmailDb({ system_control: [{ key: 'email_lane_workflow', value: 'enabled' }] })
  const input = { enrollment_id: 'en-1', node_id: 'n-1', workflow_definition_id: 'wf-1', master_owner_id: 'mo-1', property_id: 'prop-1', to_email: 'a@b.co', subject: 'Subject', message_body: 'Body' }
  const r1 = await enqueueWorkflowEmail(input, { supabase: db })
  const r2 = await enqueueWorkflowEmail(input, { supabase: db })
  assert.equal(r1.ok, true)
  assert.equal(r1.queue, 'email_queue')
  assert.equal(r1.live_send_blocked, true)
  assert.equal(r2.duplicate, true)
  assert.equal(db.state.email_queue.length, 1)
  assert.equal(db.state.email_queue[0].source, 'workflow')
  assert.equal(db.state.email_queue[0].queue_key, 'wfv2:email:en-1:n-1')
  assert.equal(db.state.email_threads[0].thread_key, 'seller:mo-1:prop-1')
  assert.equal((db.state.send_queue || []).length, 0)
})

test('F2 orchestrator email.send → automated email_queue row keyed by run+node; lane off → BLOCKED', async () => {
  const cap = CAPABILITIES['email.send']
  const ctx = (db) => ({ runId: 'run-1', nodeId: 'node-1', workflowKey: 'wk', version: 3, deps: { supabase: db } })
  const inputs = { recipient: { email: 'title@co.test' }, subject: 'Hello', body: 'Body text' }
  const off = makeEmailDb({})
  const b = await cap.invoke(inputs, ctx(off))
  assert.equal(b.status, 'BLOCKED')
  assert.equal(off.state.email_queue.length, 0)

  const db = makeEmailDb({ system_control: [{ key: 'email_lane_workflow', value: 'true' }] })
  const a1 = await cap.invoke(inputs, ctx(db))
  const a2 = await cap.invoke(inputs, ctx(db))
  assert.equal(a1.status, 'SUCCESS')
  assert.equal(a2.status, 'SUCCESS')
  assert.equal(a2.reason, 'duplicate_idempotent')
  assert.equal(db.state.email_queue.length, 1)
  const row = db.state.email_queue[0]
  assert.equal(row.queue_key, 'wf:run-1:node-1:email')
  assert.equal(row.source, 'workflow')
  assert.equal(row.origin, 'automation')
})

// ── G. legacy SMTP ─────────────────────────────────────────────────────────
test('G1 direct SMTP send is fenced for anything but internal alerts', async () => {
  const prev = process.env.EMAIL_LEGACY_SMTP_ENABLED
  delete process.env.EMAIL_LEGACY_SMTP_ENABLED
  try {
    const r = await sendEmail({ to: 'seller@example.com', subject: 's', text: 't' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'legacy_smtp_fenced_use_email_queue')
    const dry = await sendEmail({ to: 'seller@example.com', subject: 's', text: 't', dry_run: true })
    assert.equal(dry.ok, true)
  } finally {
    if (prev !== undefined) process.env.EMAIL_LEGACY_SMTP_ENABLED = prev
  }
})



// ── H. sender daily counter ────────────────────────────────────────────────
test('H1 a sender at daily_limit YESTERDAY sends today; at limit today it defers', async () => {
  const yesterday = new Date(Date.now() - D).toISOString()
  const mk = (last) => makeEmailDb({ system_control: [{ key: 'email_enabled', value: 'true' }], email_senders: [{ ...COMPLIANT_SENDER, daily_limit: 50, messages_sent_today: 50, last_sent_at: last }] })
  const dbOld = mk(yesterday)
  await enqueueAutomatedEmail(dbOld, sellerSpec())
  const tx = makeTransport()
  assert.equal((await dispatch(dbOld, tx, ENV_ON)).sent, 1)
  assert.equal(dbOld.state.email_senders[0].messages_sent_today, 1, 'counter restarts on a new UTC day')
  const dbToday = mk(new Date().toISOString())
  await enqueueAutomatedEmail(dbToday, sellerSpec())
  const tx2 = makeTransport()
  const s = await dispatch(dbToday, tx2, ENV_ON)
  assert.equal(tx2.calls.length, 0)
  assert.equal(s.deferred, 1)
})

// ── I. Inbox timeline read model ───────────────────────────────────────────
test('I1 email timeline for an SMS thread key: outbound + inbound, time-ordered, statuses as stored', async () => {
  const { getSellerEmailTimeline } = await import('@/lib/domain/email/email-inbox-timeline.js')
  const db = makeEmailDb({})
  await enqueueAutomatedEmail(db, sellerSpec())
  const threadId = db.state.email_queue[0].thread_id
  db.state.email_inbound_messages.push({ id: 'in-1', thread_id: threadId, subject: 'Re: 12 Oak St', reply_text: 'Email me the offer', from_email: 'seller@example.com', received_at: new Date(Date.now() + 60e3).toISOString(), processing_status: 'handled' })
  const r = await getSellerEmailTimeline({ thread_key: '+15550001111' }, { supabase: db })
  assert.equal(r.ok, true)
  assert.equal(r.email_present, true)
  assert.deepEqual(r.items.map((i) => [i.direction, i.status]), [['outbound', 'pending_send'], ['inbound', 'handled']])
  const none = await getSellerEmailTimeline({ thread_key: '+15559999999' }, { supabase: db })
  assert.equal(none.email_present, false)
  assert.equal((await getSellerEmailTimeline({}, { supabase: db })).status, 400)
})

// ── J. manual send resolves the default brand sender ───────────────────────
test('J1 manual send with no explicit sender uses the default active email_senders row (not BREVO_SENDER_EMAIL)', async () => {
  const { sendManualEmail, __setEmailServiceDeps, __resetEmailServiceDeps } = await import('@/lib/domain/email/email-service.js')
  const db = makeEmailDb({ email_senders: [{ ...COMPLIANT_SENDER }] })
  const prev = process.env.BREVO_SENDER_EMAIL
  delete process.env.BREVO_SENDER_EMAIL
  __setEmailServiceDeps({ supabase_override: db })
  try {
    const r = await sendManualEmail({ to: 'owner@example.com', subject: 'Seed test', text_body: 'hello' }, { actor: 'test' })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.queued, true)
    assert.equal(db.state.email_queue[0].from_email, 'offers@mail.example-brand.test')
  } finally {
    __resetEmailServiceDeps()
    if (prev !== undefined) process.env.BREVO_SENDER_EMAIL = prev
  }
})
