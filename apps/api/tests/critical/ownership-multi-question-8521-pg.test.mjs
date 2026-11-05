// rc-8.5.21 P0 SAFETY (independent evaluation) — a bare "No" after TWO OR MORE SEPARATE ownership questions
// ("Do you still own 12 Oak St?" … "And how about 456 Pine St?") must behave exactly like one message naming
// both: the recorded THREAD HOLD (ownership_denial_property_unresolved), never a denial of the latest
// property, never a nurture, never a close. On a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped —
// reported, never vacuous — without it) carrying the hold registry, the follow-up lifecycle AND the AI turn
// runtime (competing-sources-pg.mjs). Everything real: the inbound path's attribution + hold writer
// (attributeOwnershipAnswer → recordOwnershipAttributionHold, as process-seller-inbound-message runs them),
// the AI turn (route → job → canonical decider → R3), the lifecycle planner + materializer. The provider
// is never reached (fetch and TextGrid credentials trapped).
//   multi-question variants (two; three; hours apart; an unrelated message between): zero intents from the
//     real paths, zero queue rows, zero sends, ONE hold, ONE operator item; a mislabelled legacy writer that
//     plans a not_interested nurture anyway is refused (held, with the reason) and nothing materializes
//   controls: one unambiguous question (and one question followed by an unrelated message) ⇒ the property
//     denial on THAT property only, no hold, no nurture
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { combinedDb, registryHoldResolver } from '../helpers/competing-sources-pg.mjs'
import { harness, SWITCHES } from '../helpers/conversation-e2e-pg.mjs'
import { seedWorld, planNurture, materialize, trapTransport, intentsOf, sel, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { attributeOwnershipAnswer } from '../../src/lib/domain/seller-flow/resolve-contact-outcome-phase.js'
import { isBareOwnershipAnswer, recordOwnershipAttributionHold } from '../../src/lib/domain/holds/ownership-attribution-hold.js'
import { resolveAutomationHold, HOLD_CAPABILITIES, __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(null)
const skip = pgAvailable() ? false : skipReason
const SELLER = '+13125550101'
const PROPS = { p1: '12 Oak St', p2: '456 Pine St', p3: '789 Elm St' }

/**
 * @param {Array<{ body: string, property: string|null, minutesAgo: number }>} outbounds our messages (oldest first)
 * @param {{ reply?: string, replyProperty?: string }} o
 */
async function world(outbounds, { reply = 'No', replyProperty = null } = {}) {
  const env = await combinedDb()
  __setAutomationHoldResolverForTests(registryHoldResolver(env.sb))
  await seedWorld(env.pool)
  await env.pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, owner_1_name)
                        values ('p2', 'SFR', 'Chicago', 'IL', '60601', '456 Pine St', 'Dana Q'), ('p3', 'SFR', 'Chicago', 'IL', '60601', '789 Elm St', 'Dana Q') on conflict do nothing`)
  await env.pool.query(`update public.properties set property_address = '12 Oak St' where property_id = 'p1'`)
  for (const [i, o] of outbounds.entries()) {
    const id = crypto.randomUUID()
    await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, prospect_id, language)
      values ($1, $2, 'outbound', $3::text, $4::text, $3::text, $5::text, now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int), $7, 'pr1', 'en')`, [id, `SMo${i}`, SELLER, OURS, o.body, o.minutesAgo, o.property])
    await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, seller_first_name, property_id, created_at, sent_at, delivered_at, type, metadata)
      values ($1, 'delivered', $2::text, $3::text, $4::text, $3::text, $5, 'Helen', 'Dana', $6, now() - make_interval(mins => $7::int), now() - make_interval(mins => $7::int), now() - make_interval(mins => $7::int), 'outbound', '{}'::jsonb)`,
    [`seed:o${i}`, o.body, SELLER, OURS, i === 0 ? 'ownership_check' : 'manual_reply', o.property, o.minutesAgo])
  }
  const lastProperty = replyProperty || [...outbounds].reverse().find((o) => o.property)?.property || 'p1'
  const inboundId = crypto.randomUUID()
  await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, prospect_id, language)
    values ($1, 'SMi1', 'inbound', $2::text, $2::text, $3::text, $4::text, now() - interval '2 minutes', now() - interval '2 minutes', $5, 'pr1', 'en')`, [inboundId, SELLER, OURS, reply, lastProperty])
  await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, stage, lifecycle_stage, last_inbound_at, our_number)
    values ($1::text, $1::text, $2, 'm1', 'pr1', 'ownership_check', 'ownership_check', now() - interval '2 minutes', $3)`, [SELLER, lastProperty, OURS])
  for (const [k, v] of Object.entries(SWITCHES)) await env.pool.query(`insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v])
  return { env, inboundId, lastProperty, reply }
}

/** The inbound path's attribution + hold writer, exactly as process-seller-inbound-message runs them. */
async function inboundPath({ env, inboundId, lastProperty, reply }) {
  if (!isBareOwnershipAnswer(reply)) return { att: null, hold: null }
  const att = await attributeOwnershipAnswer({ supabaseClient: env.sb, thread_key: SELLER, property_id: lastProperty, source_message_id: inboundId, inbound_body: reply })
  const hold = att?.ambiguous ? await recordOwnershipAttributionHold({ supabase: env.sb, thread_key: SELLER, property_ids: [lastProperty], source_message_id: inboundId, basis: att.basis }) : null
  return { att, hold }
}

/** The AI turn over the same inbound (route → due → tick); ONE operator-item writer captured. */
async function aiTurn(env) {
  const items = []
  const h = harness(env, { operatorItems: { syncWorkItems: async (a) => { items.push(...(a.items || [])); return { ok: true } } } })
  const routed = await h.route('SMi1')
  if (routed.code === 'TURN_OPENED') { await h.makeDue(); await h.tick() }
  const turns = await sel(env.pool, 'select state, result from public.conversation_reply_turns')
  return { routed, items, turns }
}

const SENT = (env) => sel(env.pool, `select count(*)::int n from public.send_queue where thread_key = $1 and queue_key not like 'seed:%'`, [SELLER])

async function assertThreadHold(env, label, { inboundId, lastProperty, reply }) {
  const net = trapTransport()
  try {
    const p = await inboundPath({ env, inboundId, lastProperty, reply })
    assert.equal(p.att?.ambiguous, true, `${label}: the bare answer is UNATTRIBUTED: ${JSON.stringify(p.att)}`)
    assert.equal(p.att.property, '')
    assert.equal(p.hold?.recorded, true, `${label}: the thread hold is recorded: ${JSON.stringify(p.hold)}`)
    const holds = await sel(env.pool, `select reason, blocked_capabilities from public.automation_holds where thread_key = $1 and released_at is null`, [SELLER])
    assert.equal(holds.length, 1, `${label}: ONE hold`)
    assert.equal(holds[0].reason, 'ownership_denial_property_unresolved')
    const gate = await resolveAutomationHold({ thread_key: SELLER, property_id: lastProperty, master_owner_id: 'm1' }, { capability: HOLD_CAPABILITIES.AUTO_REPLY, supabase: env.sb })
    assert.equal(gate.held, true, `${label}: the inbound path's execution gate reads the hold (no reply, no follow-up scheduled)`)
    const ai = await aiTurn(env)
    assert.equal(ai.routed.code, 'TURN_OPENED', JSON.stringify(ai.routed))
    assert.equal(ai.turns.length, 1)
    assert.equal(ai.turns[0].result?.code, 'HOLD', `${label}: the AI turn HOLDS: ${JSON.stringify(ai.turns[0].result)}`)
    assert.equal(ai.items.length, 1, `${label}: ONE operator item: ${JSON.stringify(ai.items)}`)
    assert.match(JSON.stringify(ai.items[0]), /ownership_denial_property_unresolved/)
    assert.equal((await intentsOf(env.pool, SELLER)).length, 0, `${label}: zero intents from the real paths`)
    assert.equal((await SENT(env))[0].n, 0, `${label}: zero queue rows`)
    // a MISLABELLED legacy writer plans a not_interested nurture anyway (production labels many bare "No"
    // answers not_interested): refused at plan time with the reason, and nothing ever materializes
    const planned = await planNurture(env.sb, SELLER, { inboundId, property: lastProperty, intent: 'not_interested', extra: { language: 'English' } })
    assert.notEqual(planned.followup_created, true, JSON.stringify(planned))
    const [intent] = await intentsOf(env.pool, SELLER)
    assert.ok(intent && ['held', 'not_executable'].includes(intent.state), `${label}: ${JSON.stringify(intent && { state: intent.state, reason: intent.reason })}`)
    assert.ok(String(intent.reason || '').length > 0)
    await materialize(env)
    assert.equal((await SENT(env))[0].n, 0, `${label}: still zero queue rows after materialization`)
    assert.ok(['held', 'not_executable', 'cancelled', 'superseded'].includes((await intentsOf(env.pool, SELLER))[0].state))
    assert.deepEqual(net.hits, [], `${label}: zero sends`)
  } finally { net.restore() }
}

test('PG P0: TWO separate ownership questions ("Do you still own 12 Oak St?" … "And how about 456 Pine St?") then a bare "No" ⇒ the thread hold; zero intents / rows / sends; one hold; one operator item', { skip }, async () => {
  const w = await world([{ body: 'Hi Dana, this is Helen. Do you still own 12 Oak St?', property: 'p1', minutesAgo: 30 }, { body: 'And how about 456 Pine St?', property: 'p2', minutesAgo: 27 }])
  try { await assertThreadHold(w.env, 'two', w) } finally { await w.env.db.drop() }
})

test('PG P0 (variant): THREE separate questions ⇒ the thread hold', { skip }, async () => {
  const w = await world([{ body: 'Hi Dana, this is Helen. Do you still own 12 Oak St?', property: 'p1', minutesAgo: 40 }, { body: 'And how about 456 Pine St?', property: 'p2', minutesAgo: 38 }, { body: 'What about the one on Elm St?', property: 'p3', minutesAgo: 36 }])
  try { await assertThreadHold(w.env, 'three', w) } finally { await w.env.db.drop() }
})

test('PG P0 (variant): the questions HOURS apart (within the open conversation) ⇒ the thread hold', { skip }, async () => {
  const w = await world([{ body: 'Hi Dana, this is Helen. Do you still own 12 Oak St?', property: 'p1', minutesAgo: 6 * 60 }, { body: 'Also, do you still own 456 Pine St?', property: 'p2', minutesAgo: 2 * 60 }])
  try { await assertThreadHold(w.env, 'hours_apart', w) } finally { await w.env.db.drop() }
})

test('PG P0 (variant): an UNRELATED message between the two questions ⇒ the thread hold', { skip }, async () => {
  const w = await world([{ body: 'Hi Dana, this is Helen. Do you still own 12 Oak St?', property: 'p1', minutesAgo: 50 }, { body: 'Hope your week is going well.', property: null, minutesAgo: 45 }, { body: 'And how about 456 Pine St?', property: 'p2', minutesAgo: 40 }])
  try { await assertThreadHold(w.env, 'unrelated_between', w) } finally { await w.env.db.drop() }
})

async function assertSingleDenial(w, label) {
  const { env } = w
  const net = trapTransport()
  try {
    const p = await inboundPath(w)
    assert.deepEqual([p.att?.ambiguous, p.att?.property], [false, 'p1'], `${label}: the denial is attributed to 12 Oak St only: ${JSON.stringify(p.att)}`)
    assert.equal(p.hold, null, `${label}: no thread hold`)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.automation_holds where thread_key = $1`, [SELLER]))[0].n, 0)
    // a nurture planned for the denied property is refused (the property denial), never executable
    await planNurture(env.sb, SELLER, { inboundId: w.inboundId, property: 'p1', intent: 'not_interested', extra: { language: 'English' } })
    const [intent] = await intentsOf(env.pool, SELLER)
    assert.equal(intent.state, 'not_executable', `${label}: ${JSON.stringify({ state: intent.state, reason: intent.reason })}`)
    assert.equal(intent.reason, 'property_denial:bare_no_to_ownership_question')
    await materialize(env)
    assert.equal((await SENT(env))[0].n, 0, `${label}: no nurture row`)
    assert.deepEqual(net.hits, [])
  } finally { net.restore() }
}

test('PG P0 (control): ONE unambiguous ownership question then "No" ⇒ the property denial on that property only; no hold; no nurture', { skip }, async () => {
  const w = await world([{ body: 'Hi Dana, this is Helen. Do you still own 12 Oak St?', property: 'p1', minutesAgo: 30 }])
  try { await assertSingleDenial(w, 'single') } finally { await w.env.db.drop() }
})

test('PG P0 (control): ONE ownership question followed by an unrelated message, then "No" ⇒ still the denial of THAT property only (an unrelated message is no question)', { skip }, async () => {
  const w = await world([{ body: 'Hi Dana, this is Helen. Do you still own 12 Oak St?', property: 'p1', minutesAgo: 30 }, { body: 'Hope your week is going well.', property: 'p1', minutesAgo: 25 }])
  try { await assertSingleDenial(w, 'single_unrelated') } finally { await w.env.db.drop() }
})
