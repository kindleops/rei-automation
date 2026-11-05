// rc-8.5.21 FINAL directive, phase 4 — COMPETING SOURCES on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL;
// skipped — reported, never vacuous — without it). ONE database carries both automated sources of a thread
// (competing-sources-pg.mjs): a 30-day nurture follow-up that becomes DUE while the seller's new inbound is
// being answered by the AI turn runtime. Everything real: the lifecycle writer + materializer, the inbound
// takeover (cancelSupabasePendingOutbound, inbound_takeover), the AI turn route → job → canonical decider →
// R3 → canonical queue, the runner item path with the follow-up dispatch gate, the §11 ledger. The provider
// is SIMULATED; fetch and TextGrid credentials are trapped.
//
// Exactly ONE coherent outcome in every interleaving: the inbound SUPERSEDES the follow-up (intent
// superseded, row cancelled with a superseded reason — never failed, never sent), the seller gets exactly
// ONE text (the AI reply) and no second text within 24 h; every blocked action ends in a documented
// terminal state.
//   A  the follow-up is scheduled when the inbound lands: the takeover cancels it; the AI reply sends once
//   B  the follow-up is already CLAIMED (in flight) when the inbound lands: the takeover cannot touch it;
//      R3 WAITS (bounded retry: outbound_in_flight_on_thread) instead of holding; the dispatch gate
//      supersedes the follow-up; the retried turn sends the AI reply once
//   C  B as a true race (the follow-up dispatch and the AI tick concurrently), repeated
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { combinedDb, registryHoldResolver } from '../helpers/competing-sources-pg.mjs'
import { harness, SWITCHES, ENV } from '../helpers/conversation-e2e-pg.mjs'
import { seedWorld, planNurture, materialize, claimRow, dispatchRow, itemDeps, simProvider, trapTransport, intentsOf, sel, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } from '../../src/lib/domain/queue/cancel-supabase-pending-outbound.js'
import { lookupAiGeneratedMessageByQueueKey, recordAiRowProviderOutcome } from '../../src/lib/domain/messages/ai-generated-message.js'
import { loadNewerInboundsForRow } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { normalizeSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { CONVERSATION_TURN_KIND } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setAutomationHoldResolverForTests(null)
__setSenderContinuityResolverForTests(null)
const skip = pgAvailable() ? false : skipReason
const SELLER = '+13125550101'

/** The thread: our ownership question (3 days ago, delivered, unanswered) ⇒ a silence follow-up due NOW. */
async function world() {
  const env = await combinedDb()
  __setAutomationHoldResolverForTests(registryHoldResolver(env.sb))
  await seedWorld(env.pool)
  const ids = { o0: crypto.randomUUID(), i1: crypto.randomUUID() }
  await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, prospect_id, language)
    values ($1, 'SMo0', 'outbound', $2::text, $3::text, $2::text, 'Hi Dana, this is Helen. Do you still own the house on Oak St?', now() - interval '3 days', now() - interval '3 days', 'p1', 'pr1', 'en')`, [ids.o0, SELLER, OURS])
  await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, seller_first_name, property_id, property_address, created_at, sent_at, delivered_at, type, metadata)
    values ('seed:o0', 'delivered', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', $1::text, $2::text, $1::text, 'ownership_check', 'Helen', 'Dana', 'p1', '12 Oak St', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', 'outbound', '{}'::jsonb)`, [SELLER, OURS])
  await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, stage, lifecycle_stage, our_number)
    values ($1::text, $1::text, 'p1', 'm1', 'pr1', 'ownership_check', 'ownership_check', $2)`, [SELLER, OURS])
  for (const [k, v] of Object.entries(SWITCHES)) await env.pool.query(`insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v])
  // the silence follow-up: planned by the REAL writer, due now; materialized into ONE ready row from the thread sender
  const planned = await planNurture(env.sb, SELLER, { intent: 'unclear', dueAt: new Date(Date.now() - 60_000).toISOString(), extra: { language: 'English' } })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const m = await materialize(env)
  assert.equal(m.counts.materialized, 1, JSON.stringify(m))
  const fu = (await sel(env.pool, `select * from public.send_queue where thread_key = $1 and type = 'followup'`, [SELLER]))[0]
  assert.equal(fu.from_phone_number, OURS)
  return { env, ids, fu }
}

/** The seller's NEW inbound lands (the webhook's persistence + thread sync), optionally with the takeover. */
async function inbound(env, ids, { takeover = true } = {}) {
  await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, prospect_id, language)
    values ($1, 'SMi1', 'inbound', $2::text, $2::text, $3::text, 'Yes I still own it', clock_timestamp(), clock_timestamp(), 'p1', 'pr1', 'en')`, [ids.i1, SELLER, OURS])
  await env.pool.query(`update public.inbox_thread_state set last_inbound_at = clock_timestamp(), our_number = $2 where thread_key = $1`, [SELLER, OURS])
  if (!takeover) return null
  return cancelSupabasePendingOutbound({ thread_key: SELLER, to_phone_number: SELLER, policy: CANCELLATION_POLICIES.INBOUND_TAKEOVER, reason: 'superseded_by_newer_inbound', inbound_event_id: ids.i1, inbound_received_at: new Date().toISOString(), cancelled_by: 'seller_inbound_burst' }, { supabase: env.sb })
}

/** The REAL runner item path for an AI row (record + row gate deps), persisted updates, the shared simulated provider. */
function aiDeps(env, h, provider, now) {
  return {
    ...itemDeps(env, { provider, now, store: createSellerCommunicationStore({ supabase: env.sb }) }),
    readAiConversationSwitch: h.readSwitch,
    loadAiGeneratedMessage: (k) => lookupAiGeneratedMessageByQueueKey(env.sb, k),
    loadNewerInbounds: (r) => loadNewerInboundsForRow(env.sb, r),
    recordAiRowProviderOutcome: (sb, r, o) => recordAiRowProviderOutcome(env.sb, r, o),
  }
}
const aiRows = (env) => sel(env.pool, `select * from public.send_queue where thread_key = $1 and message_origin = 'ai_generated'`, [SELLER])
const sentLast24h = async (env) => Number((await sel(env.pool, `select count(*)::int n from public.send_queue where thread_key = $1 and (sent_at > now() - interval '24 hours' or provider_message_id is not null) and queue_key <> 'seed:o0'`, [SELLER]))[0].n)
async function dispatchAi(env, h, provider) {
  for (const row of await aiRows(env)) {
    const claimed = await claimRow(env.pool, row.id)
    if (!claimed) continue
    const now = new Date().toISOString()
    await processSendQueueItem(normalizeSendQueueRow({ ...claimed.row }), { ...aiDeps(env, h, provider, now), claimedLockToken: claimed.token })
  }
}
async function turnJobs(env) {
  return sel(env.pool, `select state, last_error from agent.research_job where kind = $1 order by created_at`, [CONVERSATION_TURN_KIND])
}
/** Every outcome documented: the follow-up intent + row are superseded, the AI reply sent once. */
async function assertOneCoherentOutcome(env, fu, provider) {
  const [intent] = await intentsOf(env.pool, SELLER)
  assert.equal(intent.state, 'superseded', `the follow-up intent is SUPERSEDED: ${JSON.stringify({ state: intent.state, reason: intent.reason })}`)
  assert.ok(String(intent.reason || '').length > 0, 'with a reason')
  const row = (await sel(env.pool, 'select * from public.send_queue where id = $1', [fu.id]))[0]
  assert.equal(row.queue_status, 'cancelled', `the follow-up row is cancelled (a documented terminal state): ${row.queue_status}`)
  assert.match(String(row.guard_reason || row.failed_reason || row.metadata?.cancellation_reason || row.metadata?.skip_reason || ''), /supersed|inbound/)
  assert.equal(row.sent_at, null)
  assert.equal(provider.sent.length, 1, `exactly ONE text reached the provider: ${JSON.stringify(provider.sent.map((s) => s.body || s.message || s))}`)
  assert.ok(JSON.stringify(provider.sent[0]).includes('Good to know. Would you consider an offer on it?'), 'and it is the AI reply to the inbound')
  assert.ok(JSON.stringify(provider.sent[0]).includes(OURS.slice(-10)), 'from the thread sender')
  assert.equal(await sentLast24h(env), 1, 'no second text within 24 h')
  const turn = (await sel(env.pool, 'select state from public.conversation_reply_turns'))
  assert.ok(turn.every((t) => t.state === 'decided'), JSON.stringify(turn))
  // nothing else is claimable on the thread
  const claimable = await sel(env.pool, `select id, queue_status from public.send_queue where thread_key = $1 and queue_status in ('queued','pending','approved','ready','scheduled','processing')`, [SELLER])
  assert.deepEqual(claimable, [])
}

test('PG phase 4 (A): the follow-up is due when the inbound lands ⇒ the inbound takeover supersedes it; the AI reply is the ONE text; nothing else within 24 h', { skip }, async () => {
  const { env, ids, fu } = await world()
  const net = trapTransport()
  try {
    const provider = simProvider()
    const t = await inbound(env, ids)
    assert.ok(t?.cancelled >= 1, `the takeover cancelled the follow-up: ${JSON.stringify(t)}`)
    // the runner reaches for the follow-up: it is no longer claimable
    assert.equal(await claimRow(env.pool, fu.id), null)
    const h = harness(env)
    assert.equal((await h.route('SMi1')).code, 'TURN_OPENED')
    await h.makeDue()
    const tick = await h.tick()
    assert.equal(tick.jobs?.[0]?.outcome, 'completed', JSON.stringify(tick))
    assert.equal((await aiRows(env)).length, 1)
    await dispatchAi(env, h, provider)
    await assertOneCoherentOutcome(env, fu, provider)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG phase 4 (B): the follow-up is already IN FLIGHT when the inbound lands ⇒ R3 waits (bounded retry, never a hold), the dispatch gate supersedes the follow-up, the retried turn sends the AI reply ONCE', { skip }, async () => {
  const { env, ids, fu } = await world()
  const net = trapTransport()
  try {
    const provider = simProvider()
    const claimed = await claimRow(env.pool, fu.id)
    assert.ok(claimed, 'the runner claimed the due follow-up')
    // the takeover is best-effort (fail open on cancel errors): here it never reached the in-flight row
    await inbound(env, ids, { takeover: false })
    const h = harness(env)
    assert.equal((await h.route('SMi1')).code, 'TURN_OPENED')
    await h.makeDue()
    const first = await h.tick()
    assert.notEqual(first.jobs?.[0]?.outcome, 'completed', `the turn does not dispatch past an in-flight row: ${JSON.stringify(first)}`)
    assert.equal((await aiRows(env)).length, 0, 'no AI row while the follow-up is in flight')
    const jobs = await turnJobs(env)
    assert.ok(jobs.some((j) => j.state === 'retrying'), `the turn job retries (bounded), never a silent hold: ${JSON.stringify(jobs)}`)
    // the follow-up's own dispatch: the gate sees the newer inbound and supersedes it
    await dispatchRow(env, claimed, { provider, now: new Date().toISOString(), store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal(provider.sent.length, 0, 'the superseded follow-up never reaches the provider')
    await h.makeDue()
    const second = await h.tick()
    assert.equal(second.jobs?.[0]?.outcome, 'completed', JSON.stringify(second))
    await dispatchAi(env, h, provider)
    await assertOneCoherentOutcome(env, fu, provider)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG phase 4 (B2): the takeover DOES reach the in-flight follow-up (cancelled under the worker\'s claim) ⇒ the stale worker never sends it; the AI reply is the ONE text', { skip }, async () => {
  const { env, ids, fu } = await world()
  const net = trapTransport()
  try {
    const provider = simProvider()
    const claimed = await claimRow(env.pool, fu.id)
    const t = await inbound(env, ids)
    assert.ok(t?.cancelled >= 1, JSON.stringify(t))
    // the stale worker carries on with its (now revoked) claim
    await dispatchRow(env, claimed, { provider, now: new Date().toISOString(), store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal(provider.sent.length, 0, 'a revoked claim never reaches the provider')
    const h = harness(env)
    assert.equal((await h.route('SMi1')).code, 'TURN_OPENED')
    await h.makeDue()
    assert.equal((await h.tick()).jobs?.[0]?.outcome, 'completed')
    await dispatchAi(env, h, provider)
    await assertOneCoherentOutcome(env, fu, provider)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG phase 4 (C, race ×6): the follow-up dispatch and the AI turn run CONCURRENTLY after the inbound ⇒ always exactly one coherent outcome (one text, the follow-up superseded)', { skip, timeout: 600_000 }, async () => {
  const tally = { runs: 0, ai_first_waited: 0 }
  for (let i = 0; i < 6; i += 1) {
    const { env, ids, fu } = await world()
    const net = trapTransport()
    try {
      const provider = simProvider()
      const claimed = await claimRow(env.pool, fu.id)
      await inbound(env, ids, { takeover: i % 2 === 0 })
      const h = harness(env)
      assert.equal((await h.route('SMi1')).code, 'TURN_OPENED')
      await h.makeDue()
      const [fuOut, tickOut] = await Promise.all([
        dispatchRow(env, claimed, { provider, now: new Date().toISOString(), store: createSellerCommunicationStore({ supabase: env.sb }) }),
        h.tick(),
      ])
      void fuOut; void tickOut
      // finish: the turn (if it waited) retries until decided; then the runner dispatches whatever is queued
      for (let k = 0; k < 4 && (await aiRows(env)).length === 0; k += 1) { tally.ai_first_waited += k === 0 ? 1 : 0; await h.makeDue(); await h.tick() }
      await dispatchAi(env, h, provider)
      await assertOneCoherentOutcome(env, fu, provider)
      tally.runs += 1
      assert.deepEqual(net.hits, [])
    } finally { net.restore(); await env.db.drop() }
  }
  console.log(`phase 4 race: ${JSON.stringify(tally)}`)
  assert.equal(tally.runs, 6)
})

void ENV
