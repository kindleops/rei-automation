// P0 2026-10-19 — END TO END on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported,
// never vacuous — without it). A Spanish "remove me from your list" inbound runs the REAL classify() and
// the REAL inbound executor (executeInboundAutomationDecision, live compliance authority) against real SQL:
//   ⇒ the durable phone-level suppression row is written (record-phone-suppression → sms_suppression_list),
//   ⇒ the pending nurture (a materialized, claimable follow-up row) AND its intent are cancelled,
//      follow_up_at is cleared, and a NEW follow-up is refused at plan time; nothing is claimable.
// And the FAIL-SAFE: an uncertain Haitian Creole message writes the precautionary contact-wide
// automation_suppressions hold (precautionary_no_contact), holds the pending row, and blocks new plans.
// No provider, no network (fetch and TextGrid credentials are trapped).
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, seedThread, planNurture, materialize, trapTransport, intentsOf, rowsOf, followUpAt, claimableEmptyBodies, sel, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { classify } from '../../src/lib/domain/classification/classify.js'
import { executeInboundAutomationDecision } from '../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)

// prod-shaped compliance tables (the lifecycle fixture carries only the columns its readers select)
const COMPLIANCE_SHAPE = `
  alter table public.sms_suppression_list add column if not exists suppressed_at timestamptz, add column if not exists source text;
  create unique index if not exists sms_suppression_list_phone_sender_uq on public.sms_suppression_list (phone_e164, sender_phone_e164) nulls not distinct;
  alter table public.automation_suppressions add column if not exists action_type text not null default 'suppress_phone',
    add column if not exists dedupe_key text, add column if not exists conversation_thread_id text,
    add column if not exists payload jsonb not null default '{}'::jsonb, add column if not exists suppressed_at timestamptz not null default now(),
    add column if not exists error_message text, add column if not exists source_event_id uuid;
  create unique index if not exists uq_automation_suppressions_dedupe_key on public.automation_suppressions (dedupe_key) where dedupe_key is not null;`

async function world() {
  const env = await lifecycleDb()
  await env.pool.query(COMPLIANCE_SHAPE)
  await seedWorld(env.pool)
  return env
}

/** A ready (materialized, claimable) nurture row for the phone. */
async function readyNurture(env, phone) {
  const { inboundId } = await seedThread(env.pool, { phone })
  const planned = await planNurture(env.sb, phone, { inboundId })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const m = await materialize(env)
  assert.equal(m.counts.materialized, 1, JSON.stringify(m))
  const [row] = await rowsOf(env.pool, phone)
  assert.ok(row && row.message_body.trim().length > 0)
  return row
}

async function inbound(env, phone, text) {
  const classification = await classify(text, null, { heuristicOnly: true })
  const inboundEventId = crypto.randomUUID()
  await env.pool.query(`insert into public.message_events (id, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at)
                        values ($1, 'inbound', $2::text, $2::text, $3::text, $4::text, now(), now())`, [inboundEventId, phone, OURS, text])
  const execution = await executeInboundAutomationDecision({
    message: text,
    threadKey: phone,
    propertyId: 'p1',
    prospectId: 'pr1',
    ownerId: 'm1',
    phoneId: 'ph1',
    classification,
    latestThreadContext: { property_id: 'p1', master_owner_id: 'm1', ids: { property_id: 'p1', master_owner_id: 'm1', prospect_id: 'pr1' } },
    inboundFrom: phone,
    inboundTo: OURS,
    inboundEventId,
    inboundReceivedAt: new Date().toISOString(),
    applySuppression: true,
    enableQueueInsert: false,
    dryRun: true, // the live path passes dryRun for every non-reply turn ...
    complianceDryRun: false, // ... and its REAL write authority for compliance
    supabaseClient: env.sb,
  })
  return { classification, execution }
}

const claimable = (pool, phone) => sel(pool, `select id from public.send_queue where thread_key = $1 and queue_status in ('queued','pending','approved','ready','scheduled')`, [phone])

test('PG e2e: Spanish "Quíteme de su lista" ⇒ opt-out suppression written, the pending nurture row AND intent cancelled, follow_up_at cleared, a new follow-up refused; nothing claimable, nothing sent', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550311'
    const row = await readyNurture(env, phone)
    assert.equal((await claimable(env.pool, phone)).length, 1)

    const { classification, execution } = await inbound(env, phone, 'Quíteme de su lista por favor, no me interesa')
    assert.equal(classification.primary_intent, 'opt_out')
    assert.equal(classification.compliance_flag, 'stop_texting')
    assert.equal(execution.suppression_applied, true, JSON.stringify(execution).slice(0, 500))

    const supp = await sel(env.pool, 'select phone_e164, sender_phone_e164, is_active, suppression_type, source from public.sms_suppression_list where phone_e164 = $1', [phone])
    assert.equal(supp.length, 1, JSON.stringify(supp))
    assert.deepEqual([supp[0].is_active, supp[0].sender_phone_e164, supp[0].suppression_type, supp[0].source], [true, null, 'opt_out', 'inbound_opt_out'])

    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'cancelled')
    const intents = await intentsOf(env.pool, phone)
    assert.ok(intents.length >= 1 && intents.every((i) => ['cancelled', 'superseded', 'not_executable'].includes(i.state)), JSON.stringify(intents.map((i) => [i.kind, i.state, i.reason])))
    assert.equal(await followUpAt(env.pool, phone), null)
    assert.deepEqual(await claimable(env.pool, phone), [])

    // STOP is contact-wide: a new nurture for this phone is refused at PLAN time, and nothing materializes
    const again = await planNurture(env.sb, phone, { inboundId: crypto.randomUUID() })
    assert.equal(again.ok, false, JSON.stringify(again))
    assert.equal((await materialize(env)).counts.materialized, 0)
    assert.deepEqual(await claimable(env.pool, phone), [])
    assert.deepEqual(await claimableEmptyBodies(env.pool), [])
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG e2e: Haitian Creole "Tanpri sispann voye mesaj ban mwen" and "sispann ekri m" ⇒ opt-out suppression written and the pending nurture cancelled', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    for (const [phone, text] of [['+13125550312', 'Tanpri sispann voye mesaj ban mwen'], ['+13125550313', 'sispann ekri m']]) {
      const row = await readyNurture(env, phone)
      const { classification, execution } = await inbound(env, phone, text)
      assert.equal(classification.primary_intent, 'opt_out', text)
      assert.equal(execution.suppression_applied, true, text)
      assert.equal((await sel(env.pool, 'select count(*)::int n from public.sms_suppression_list where phone_e164 = $1 and is_active', [phone]))[0].n, 1)
      assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'cancelled')
      assert.deepEqual(await claimable(env.pool, phone), [])
    }
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG e2e FAIL-SAFE: an uncertain non-English stop token ("M pa vle, efase m") ⇒ a contact-wide precautionary_no_contact hold, the pending row held, new follow-ups refused, NO opt-out written (operator decides)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550314'
    const row = await readyNurture(env, phone)
    const { classification, execution } = await inbound(env, phone, 'M pa vle, efase m')
    assert.notEqual(classification.primary_intent, 'opt_out')
    assert.equal(classification.automation_decision.precautionary_hold, true)
    assert.equal(execution.suppression_candidate, true)
    assert.equal(execution.precautionary_hold?.ok, true, JSON.stringify(execution.precautionary_hold))

    const holds = await sel(env.pool, `select status, suppression_type, suppression_reason, expires_at, payload from public.automation_suppressions where phone_e164 = $1`, [phone])
    assert.equal(holds.length, 1, JSON.stringify(holds))
    assert.deepEqual([holds[0].status, holds[0].suppression_type, holds[0].suppression_reason, holds[0].expires_at], ['active', 'precautionary_no_contact', 'possible_opt_out_unconfirmed', null])
    assert.equal(holds[0].payload.requires_operator_review, true)
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.sms_suppression_list where phone_e164 = $1', [phone]))[0].n, 0, 'no opt-out is recorded for an uncertain message')

    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'cancelled')
    assert.deepEqual(await claimable(env.pool, phone), [])
    const again = await planNurture(env.sb, phone, { inboundId: crypto.randomUUID() })
    assert.equal(again.ok, false, JSON.stringify(again))
    assert.equal((await materialize(env)).counts.materialized, 0)

    // webhook replay of the same inbound: idempotent (one hold row)
    const { recordPrecautionaryNoContactHold } = await import('../../src/lib/domain/compliance/record-precautionary-hold.js')
    const replay = await recordPrecautionaryNoContactHold({ supabase: env.sb, phone, threadKey: phone, inboundEventId: holds[0].payload.inbound_event_id })
    assert.equal(replay.ok, true)
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.automation_suppressions where phone_e164 = $1', [phone]))[0].n, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG e2e control: "No me interesa" stays a nurture (no suppression, no hold) — disinterest is never an opt-out', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550315'
    await seedThread(env.pool, { phone })
    const { classification } = await inbound(env, phone, 'No me interesa')
    assert.equal(classification.primary_intent, 'not_interested')
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.sms_suppression_list where phone_e164 = $1', [phone]))[0].n, 0)
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.automation_suppressions where phone_e164 = $1', [phone]))[0].n, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
