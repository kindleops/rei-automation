// rc-8.5.21 v4 fix pass — OFFER-SILENCE follow-ups are never silently dropped.
// Defects (v4 descriptions): (1) after a COUNTER-offer sequence no offer-silence follow-up was created at
// all — it must quote the LATEST offer amount from the offer record; (2) an AMBIGUOUS / approximate number
// produced nothing — it needs the approved no-number variant or a visible hold with a recorded reason.
// On a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported — without it): the REAL delivery
// trigger (maybeScheduleNoResponseFollowUp) → the follow-up lifecycle intent → materialization → the row.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, materialize, intentsOf, rowsOf, sel, OURS, applyS11Ledger } from '../helpers/followup-lifecycle-pg.mjs'
import { maybeScheduleNoResponseFollowUp } from '../../src/lib/domain/seller-flow/delivery-triggered-followup.js'
import { detectOutboundOffer, OFFER_NO_NUMBER_USE_CASE } from '../../src/lib/domain/seller-flow/no-response-followup.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

__setAutomationHoldResolverForTests(null)
const skip = pgAvailable() ? false : skipReason

// ── pure: what counts as OUR offer, and which number it carries ─────────────────────────────────────────
test('offer detection: counter / revised-offer vocabulary is an offer; an approximate amount is the no-number offer; a record-backed amount among several is the one quoted', () => {
  const counterForms = ['We can come up to $97,500 if that works', 'I can meet you at 97,500', 'Best we can do is $97,500', 'Our final number is $97,500 cash', 'We could stretch to $97,500', 'We\'d be at $97,500']
  for (const b of counterForms) {
    const r = detectOutboundOffer({ message_body: b })
    assert.equal(r.is_offer, true, b)
    assert.equal(r.mode, 'number', b)
    assert.equal(r.amount, 97500, b)
  }
  for (const b of ['We could do somewhere in the 90s depending on the walkthrough', 'We\'d be in the high 80s cash', 'Our offer would be around 90 grand', 'We can offer in the low six figures']) {
    const r = detectOutboundOffer({ message_body: b })
    assert.deepEqual([r.is_offer, r.mode], [true, 'no_number'], b)
  }
  // several amounts: the latest offer RECORD names the live one (only when the text carries it)
  const seq = 'Best we can do is $97,500, up from the $95,000 we sent'
  assert.equal(detectOutboundOffer({ message_body: seq }).mode, 'no_number', 'without a record several amounts never pick one')
  assert.deepEqual([detectOutboundOffer({ message_body: seq, offer_record_amount: 97500 }).mode, detectOutboundOffer({ message_body: seq, offer_record_amount: 97500 }).amount], ['number', 97500])
  assert.equal(detectOutboundOffer({ message_body: seq, offer_record_amount: 120000 }).mode, 'no_number', 'a record amount the text does not carry is never quoted')
  // negatives: not our offer
  for (const b of ['Thanks! Do you have an asking price in mind?', 'The house was built in the 90s, right?', 'I will call you at 3', 'What price range are you thinking for it?']) {
    assert.equal(detectOutboundOffer({ message_body: b }).is_offer, false, b)
  }
})

// ── PG: the real delivery trigger ───────────────────────────────────────────────────────────────────────
async function world(env) {
  await applyS11Ledger(env.pool)
  await seedWorld(env.pool)
  const enabledAt = new Date(Date.now() - 30 * 864e5).toISOString()
  for (const [k, v] of Object.entries({ followup_no_response_mode: 'live', followup_no_response_enabled_at: enabledAt })) {
    await env.pool.query('insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v])
  }
  await env.pool.query(`insert into public.sms_templates (template_id, use_case, language, is_active, safe_for_auto_reply, template_body) values
    ('t-offer-fu1', 'offer_no_response_fu1', 'English', true, true, 'Hi {{seller_first_name}}, just following up. Would {{offer_price}} work for you, or is there a number you had in mind?'),
    ('t-offer-nn', $1, 'English', true, true, 'Hi {{seller_first_name}}, just following up on my offer. Would it work for you, or is there a number you had in mind?')`, [OFFER_NO_NUMBER_USE_CASE])
}

async function seedOfferAnchor(env, { phone, anchorBody, sentHoursAgo = 25, offers = [] }) {
  const anchorEventId = crypto.randomUUID()
  const sentAt = new Date(Date.now() - sentHoursAgo * 3_600_000).toISOString()
  const inboundAt = new Date(Date.parse(sentAt) - 3_600_000).toISOString()
  await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, stage, lifecycle_stage, last_inbound_at, our_number)
                        values ($1::text, $1::text, 'p1', 'm1', 'pr1', 'offer', 'offer', $2, $3)`, [phone, inboundAt, OURS])
  await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                        values ($1, $2, 'inbound', $3::text, $3::text, $4::text, 'I would need at least 110 for it honestly', $5, $5, 'p1', 'en'),
                               ($6, $7, 'outbound', $3::text, $4::text, $3::text, $8::text, $9, $9, 'p1', 'en')`,
  [crypto.randomUUID(), `SMi${anchorEventId.slice(0, 8)}`, phone, OURS, inboundAt, anchorEventId, `SMo${anchorEventId.slice(0, 8)}`, anchorBody, sentAt])
  for (const o of offers) {
    await env.pool.query(`insert into public.seller_offers (offer_id, thread_key, purchase_price, status, created_at, sent_at) values ($1, $2, $3, $4, $5, $5)`,
      [`off-${crypto.randomUUID().slice(0, 8)}`, phone, o.amount, o.status, new Date(Date.parse(sentAt) - (o.minutesBefore ?? 0) * 60_000).toISOString()])
  }
  const anchorRow = (await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, seller_first_name,
                        property_id, master_owner_id, property_address, created_at, sent_at, delivered_at, type, language, metadata)
                      values ($1, 'delivered', $2, $3::text, $4::text, $3::text, 'manual_reply', 'Helen', 'Rosa', 'p1', 'm1', '12 Oak St', $5, $5, $5, 'outbound', 'English', '{}'::jsonb) returning id`,
  [`anchor:${anchorEventId}`, anchorBody, phone, OURS, sentAt])).rows[0]
  return { anchorEventId, anchorRowId: anchorRow.id, sentAt }
}

const trigger = (env, { phone, anchorEventId, anchorRowId, sentAt }) => maybeScheduleNoResponseFollowUp({
  supabase: env.sb, outbound: { id: anchorEventId, queue_id: anchorRowId, thread_key: phone }, sid: `SMo${anchorEventId.slice(0, 8)}`,
  mode: 'full_live', sent_at: sentAt, isInternalTestPhoneImpl: () => false,
  getSystemValueImpl: async (key) => (await sel(env.pool, 'select value from public.system_control where key = $1', [key]))[0]?.value ?? null,
})

test('PG offer silence after a COUNTER sequence: the follow-up quotes the LATEST offer record amount (never the superseded one, never nothing)', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await world(env)
    const phone = '+13125550711'
    const a = await seedOfferAnchor(env, { phone, anchorBody: 'Understood. Best we can do is $97,500, up from the $95,000 we sent last week.', offers: [{ amount: 95000, status: 'superseded', minutesBefore: 7 * 1440 }, { amount: 97500, status: 'active', minutesBefore: 1 }] })
    const trig = await trigger(env, { phone, ...a })
    assert.equal(trig.handled, true, JSON.stringify(trig))
    assert.equal(trig.result.no_response_kind, 'offer', JSON.stringify(trig))
    const [intent] = await intentsOf(env.pool, phone)
    assert.equal(intent?.state, 'planned', JSON.stringify({ trig, intent }))
    const m = await materialize(env)
    assert.equal(m.counts.materialized, 1, JSON.stringify(m))
    const [row] = await rowsOf(env.pool, phone)
    assert.match(row.message_body, /Would \$97,500 work for you/, row.message_body)
    assert.ok(!/95,000/.test(row.message_body))
  } finally { await env.db.drop() }
})

test('PG offer silence with a counter phrasing outside the classic cues ("we can come up to $X"): a follow-up quoting $X', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await world(env)
    const phone = '+13125550712'
    const a = await seedOfferAnchor(env, { phone, anchorBody: 'We can come up to $97,500 if that works for you.' })
    const trig = await trigger(env, { phone, ...a })
    assert.equal(trig.result.no_response_kind, 'offer', JSON.stringify(trig))
    await materialize(env)
    const [row] = await rowsOf(env.pool, phone)
    assert.match(row?.message_body || '', /Would \$97,500 work for you/)
  } finally { await env.db.drop() }
})

test('PG offer silence with an AMBIGUOUS number ("somewhere in the 90s"): the approved no-number variant, never a guessed amount', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await world(env)
    const phone = '+13125550713'
    const a = await seedOfferAnchor(env, { phone, anchorBody: 'Honestly we could do somewhere in the 90s depending on the walkthrough.' })
    const trig = await trigger(env, { phone, ...a })
    assert.equal(trig.result.no_response_kind, 'offer', JSON.stringify(trig))
    assert.equal(trig.result.use_case, OFFER_NO_NUMBER_USE_CASE, JSON.stringify(trig))
    await materialize(env)
    const [row] = await rowsOf(env.pool, phone)
    assert.match(row?.message_body || '', /following up on my offer/)
    assert.ok(!/\$|\d{2}/.test(row.message_body), 'no number is quoted')
  } finally { await env.db.drop() }
})

test('PG an offer anchor that cannot get a follow-up for an unexplained reason is a VISIBLE held intent with the reason (never a silent drop)', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await world(env)
    const phone = '+13125550714'
    // delivered 15 days ago: beyond the live-conversation age, not explained by the seller / a suppression
    const a = await seedOfferAnchor(env, { phone, anchorBody: 'We could offer $104,500 cash for it.', sentHoursAgo: 15 * 24 })
    const trig = await trigger(env, { phone, ...a })
    assert.equal(trig.handled, true)
    assert.equal(trig.result.reason, 'anchor_too_old')
    assert.equal(trig.result.held_recorded, true, JSON.stringify(trig))
    const [intent] = await intentsOf(env.pool, phone)
    assert.equal(intent?.state, 'held', JSON.stringify(intent))
    assert.match(String(intent.reason || intent.state_reason || JSON.stringify(intent)), /anchor_too_old/)
    assert.equal((await rowsOf(env.pool, phone)).length, 0, 'nothing is sent')
  } finally { await env.db.drop() }
})
