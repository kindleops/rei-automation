// rc-8.5.21 v4 fix pass — SENDER HEALTH / BINDING recovery through the REAL turn → R3 path on a DISPOSABLE
// PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). Written from the
// defect DESCRIPTIONS (v4 report), never from the blind cases:
//   sc-02  an AI reply held blocked_sender_ineligible while its bound number was unhealthy is RELEASED after the
//          number recovers (armed by the AI send kill switch; same bound sender only, never a pool substitute)
//   sc-03  the stale held row no longer consumes the seller's daily reply slot: the newer turn supersedes it and
//          its reply is enqueued (a stale row that MAY have reached the seller still keeps the cap)
//   sc-06  an unaudited rewrite of the thread's number (no sender_thread_reassigned audit) ⇒ the next reply is a
//          REVIEW HOLD (held_sender_binding_unaudited, operator item) — never a silent send from either number
//   sc-05  an AUDITED reassignment survives the seller replying to the old number, and binds the reply
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { e2eDb, seed, harness, sel, SELLER, OURS } from '../helpers/conversation-e2e-pg.mjs'
import { trapTransport as trapFetch, applyS11Ledger } from '../helpers/followup-lifecycle-pg.mjs'
import { sealedThreadRef } from '../../src/lib/domain/messages/ai-generated-message.js'
import { upsertInboxThreadState, SENDER_BINDING_UNAUDITED_EVENT } from '../../src/lib/supabase/sms-engine.js'
import { reassignThreadSender, __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'
import { releaseSenderContinuityHolds, senderHoldReleaseArming } from '../../src/lib/domain/queue/release-sender-continuity-holds.js'
import { loadSenderBindingAudit, STALE_SELLER_DAY_SUPERSEDED_REASON } from '../../src/lib/ai/conversation-ai-r3-executor.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

__setAutomationHoldResolverForTests(async () => ({ held: false, holds: [], hold_ids: [] }))
__setSenderContinuityResolverForTests(null)
const skip = pgAvailable() ? false : skipReason
const NEW_SENDER = '+13125550166'
const ROGUE = '+13125550177'

async function world() {
  const env = await e2eDb()
  await applyS11Ledger(env.pool)  // the §11 attempt ledger (the release sweep's duplicate authority)
  // the projection writer's prod columns on the thread-state table
  await env.pool.query(`alter table public.inbox_thread_state add column if not exists seller_phone text, add column if not exists master_owner_id text, add column if not exists prospect_id text, add column if not exists market text,
    add column if not exists priority text, add column if not exists next_action text, add column if not exists automation_state text, add column if not exists latest_reply_template_id text, add column if not exists inbound_count integer,
    add column if not exists outbound_count integer, add column if not exists is_read boolean, add column if not exists updated_at timestamptz, add column if not exists last_outbound_at timestamptz`)
  return env
}
const aiRows = (env) => sel(env.pool, `select id, queue_status, from_phone_number, guard_reason, queue_key from public.send_queue where message_origin = 'ai_generated' order by created_at`)
const day = () => new Date().toISOString().slice(0, 10)
const operatorSpy = () => { const items = []; return { items, syncWorkItems: async (a) => { items.push(...(a.items || [])); return { ok: true } } } }
// the inbound projection exactly as the webhook writes it: our_number = the number the seller texted
const inboundProjection = (env, to = OURS) => upsertInboxThreadState({ thread_key: SELLER, seller_phone: SELLER, canonical_e164: SELLER, our_number: to, increment_direction: 'inbound', status: 'active' }, { supabase: env.sb })

async function staleAiRow(env, { status = 'blocked_sender_ineligible', guard = 'sender_unavailable', provider_message_id = null, minutesAgo = 20 } = {}) {
  const key = `${sealedThreadRef(SELLER)}:${day()}`
  const qk = `ai_conversation:stale-${crypto.randomUUID().slice(0, 8)}`
  const [row] = await sel(env.pool, `insert into public.send_queue (queue_key, queue_status, guard_reason, message_body, to_phone_number, from_phone_number, thread_key, source, provider_message_id, created_at, metadata)
    values ($1, $2, $3, 'Thanks. Would you consider selling it?', $4::text, $5::text, $4::text, 'ai_conversation', $6, now() - make_interval(mins => $7::int), $8::jsonb) returning *`,
  [qk, status, guard, SELLER, OURS, provider_message_id, minutesAgo, JSON.stringify({ source: 'ai_conversation', reservations: { seller_day: key } })])
  await env.pool.query(`insert into public.idempotency_ledger (scope, key, claim_token, status, summary, metadata) values ('ai_conv_seller_day', $1, gen_random_uuid(), 'completed', 'ai_conversation_seller_day', $2::jsonb)`, [key, JSON.stringify({ outcome: 'enqueued', queue_row_id: row.id })])
  return row
}
async function runTurn(env, h) {
  const routed = await h.route()
  assert.equal(routed.code, 'TURN_OPENED', JSON.stringify(routed))
  await h.makeDue()
  const t = await h.tick()
  assert.equal(t.jobs?.[0]?.outcome, 'completed', JSON.stringify(t))
  return t
}

test('sc-03 (turn → R3): the stale held reply that never reached the provider no longer consumes the seller-day slot ⇒ the newer turn supersedes it and ITS reply is enqueued (exactly one row, the bound sender)', { skip }, async () => {
  const env = await world()
  const net = trapFetch()
  try {
    const ids = await seed(env.pool)
    const stale = await staleAiRow(env)
    const h = harness(env)
    await runTurn(env, h)
    const rows = await aiRows(env)
    assert.equal(rows.length, 1, JSON.stringify({ rows, turns: await sel(env.pool, 'select * from public.conversation_reply_turns') }))
    assert.deepEqual([rows[0].queue_status, rows[0].from_phone_number, rows[0].queue_key], ['queued', OURS, `ai_conversation:${ids.i1}`])
    const after = (await sel(env.pool, 'select queue_status, guard_reason, metadata from public.send_queue where id = $1', [stale.id]))[0]
    assert.deepEqual([after.queue_status, after.guard_reason], ['cancelled', STALE_SELLER_DAY_SUPERSEDED_REASON])
    assert.equal(after.metadata.superseded_by_inbound_id, ids.i1)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.idempotency_ledger where scope = 'ai_conv_seller_day'`))[0].n, 1, 'one seller-day reservation, now this reply\'s')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('sc-03 control: a stale row that MAY have reached the seller (provider id) keeps the seller-day cap ⇒ the newer reply is held seller_daily_cap, nothing is superseded', { skip }, async () => {
  const env = await world()
  const net = trapFetch()
  try {
    await seed(env.pool)
    const stale = await staleAiRow(env, { status: 'blocked', guard: 'sender_unavailable', provider_message_id: 'SMmaybe1' })
    const ops = operatorSpy()
    const h = harness(env, { operatorItems: ops })
    await runTurn(env, h)
    assert.equal((await aiRows(env)).length, 0, 'no second reply that day')
    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [stale.id]))[0].queue_status, 'blocked')
    assert.ok(ops.items.some((i) => (i.detail?.reasons || []).includes('seller_daily_cap')), JSON.stringify(ops.items))
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('sc-06 (inbound projection → turn → R3): an UNAUDITED rewrite of the thread number, then the seller writes ⇒ the binding move is recorded and the reply is a REVIEW HOLD (held_sender_binding_unaudited + operator item); no row from either number', { skip }, async () => {
  const env = await world()
  const net = trapFetch()
  try {
    await seed(env.pool)
    await env.pool.query(`update public.inbox_thread_state set our_number = $2 where thread_key = $1`, [SELLER, ROGUE])  // unaudited
    assert.equal((await inboundProjection(env)).ok, true)
    const ev = await sel(env.pool, `select payload from public.automation_events where event_type = $1`, [SENDER_BINDING_UNAUDITED_EVENT])
    assert.equal(ev.length, 1, 'the unexplained move is audited')
    assert.deepEqual([ev[0].payload.stored_our_number, ev[0].payload.incoming_our_number], [ROGUE, OURS])
    const ops = operatorSpy()
    await runTurn(env, harness(env, { operatorItems: ops }))
    assert.deepEqual(await aiRows(env), [], 'nothing queued from either number')
    assert.ok(ops.items.some((i) => (i.detail?.reasons || []).includes('held_sender_binding_unaudited')), JSON.stringify(ops.items))
    // an operator review (or an audited reassignment) after the move resolves it
    await env.pool.query(`insert into public.automation_events (event_type, source, conversation_thread_id, payload, created_at) values ('sender_binding_reviewed', 'operator', $1, '{}'::jsonb, now() + interval '1 second')`, [SELLER])
    assert.equal((await loadSenderBindingAudit({ supabase: env.sb, threadKey: SELLER })).unaudited, false)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('sc-06 controls: a seller texting our OTHER number when the stored number is the one they saw us text from is NOT an unaudited move; the outbound projection never records one', { skip }, async () => {
  const env = await world()
  const net = trapFetch()
  try {
    await seed(env.pool)  // the seller saw us text from OURS; the stored number is OURS
    assert.equal((await inboundProjection(env, '+13125550155')).ok, true)
    assert.equal((await upsertInboxThreadState({ thread_key: SELLER, seller_phone: SELLER, our_number: '+13125550144', increment_direction: 'outbound' }, { supabase: env.sb })).ok, true)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.automation_events where event_type = $1`, [SENDER_BINDING_UNAUDITED_EVENT]))[0].n, 0)
    assert.equal((await loadSenderBindingAudit({ supabase: env.sb, threadKey: SELLER })).unaudited, false)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('sc-05 (audited reassignment): the seller replies to the OLD number ⇒ the audited binding is kept by the projection and the AI reply is enqueued FROM THE REASSIGNED number', { skip }, async () => {
  const env = await world()
  const net = trapFetch()
  try {
    const ids = await seed(env.pool)
    const moved = await reassignThreadSender({ thread_key: SELLER, to: NEW_SENDER, actor: 'op-dana', reason: 'number retired by carrier', approval_ref: 'appr-1' },
      { supabase: env.sb, loadBlockedSenders: async () => new Set(), loadFleetRow: async (p) => ({ phone_number: p, status: 'active', health_state: 'active_healthy', registration_status: 'registered', daily_limit: 500, messages_sent_today: 0 }) })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    assert.equal((await inboundProjection(env, OURS)).ok, true)
    assert.equal((await sel(env.pool, 'select our_number from public.inbox_thread_state where thread_key = $1', [SELLER]))[0].our_number, NEW_SENDER, 'an inbound to the old number never undoes an audited reassignment')
    await runTurn(env, harness(env))
    const rows = await aiRows(env)
    assert.deepEqual(rows.map((r) => [r.queue_key, r.from_phone_number]), [[`ai_conversation:${ids.i1}`, NEW_SENDER]], JSON.stringify(rows))
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('sc-02 arming (pure): the release writes AI rows once the AI send kill switch is on; every other row keeps sender_continuity_release_mode; both absent ⇒ dry run', () => {
  assert.deepEqual(senderHoldReleaseArming({}), { dry_run: true, ai_rows_only: false, armed_by: null })
  assert.deepEqual(senderHoldReleaseArming({ mode: 'off', aiKillSwitchOn: false }).dry_run, true)
  assert.deepEqual(senderHoldReleaseArming({ mode: null, aiKillSwitchOn: true }), { dry_run: false, ai_rows_only: true, armed_by: 'ai_conversation_send_enabled' })
  assert.deepEqual(senderHoldReleaseArming({ mode: ' LIVE ', aiKillSwitchOn: false }), { dry_run: false, ai_rows_only: false, armed_by: 'sender_continuity_release_mode' })
})

test('sc-02 (PG release sweep, AI-armed): the held AI reply is released once its bound sender recovers (same number), a held NON-AI row is left untouched; still unhealthy ⇒ stays held', { skip }, async () => {
  const env = await world()
  const net = trapFetch()
  try {
    await seed(env.pool)
    const [ai] = await sel(env.pool, `insert into public.send_queue (queue_key, queue_status, guard_reason, message_body, to_phone_number, from_phone_number, thread_key, source, message_origin, created_at, metadata)
      values ('ai_conversation:held1', 'blocked_sender_ineligible', 'sender_unavailable', 'x', $1::text, $2::text, $1::text, 'ai_conversation', null, now() - interval '1 minute', '{"source":"ai_conversation"}'::jsonb) returning id`, [SELLER, OURS])
    const [tpl] = await sel(env.pool, `insert into public.send_queue (queue_key, queue_status, guard_reason, message_body, to_phone_number, from_phone_number, thread_key, source, type, created_at, metadata)
      values ('inbound_auto_reply:held2', 'blocked_sender_ineligible', 'sender_unavailable', 'y', $1::text, $2::text, $1::text, 'auto_reply', 'auto_reply', now() - interval '1 minute', '{}'::jsonb) returning id`, [SELLER, OURS])
    let healthy = false
    const deps = {
      supabase: env.sb, now: new Date().toISOString(),
      loadDispatchBlockedSenders: async () => new Set(),
      loadOutboundNumberByPhone: async (p) => ({ phone_number: p, status: healthy ? 'active' : 'paused', health_state: healthy ? 'active_healthy' : 'blocked', registration_status: 'registered', daily_limit: 500, messages_sent_today: 0 }),
      holdCheck: async () => ({ held: false, reason: null }),
      runSendTimeContactGuard: async () => ({ blocked: false, reason: null }),
    }
    const held = await releaseSenderContinuityHolds({ dry_run: false, ai_rows_only: true }, deps)
    assert.equal(held.released, 0, JSON.stringify(held))
    healthy = true
    const rel = await releaseSenderContinuityHolds({ dry_run: false, ai_rows_only: true }, deps)
    assert.equal(rel.released, 1, JSON.stringify(rel))
    const after = await sel(env.pool, 'select id, queue_status, from_phone_number from public.send_queue where id in ($1, $2)', [ai.id, tpl.id])
    assert.deepEqual(after.find((r) => r.id === ai.id).queue_status, 'queued')
    assert.equal(after.find((r) => r.id === ai.id).from_phone_number, OURS, 'the same bound sender, never a substitute')
    assert.equal(after.find((r) => r.id === tpl.id).queue_status, 'blocked_sender_ineligible', 'a non-AI row needs sender_continuity_release_mode')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
