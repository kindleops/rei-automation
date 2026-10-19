// Action Gateway phase 1, the T1 tools + set_thread_hold (T2) END TO END on a DISPOSABLE PostgreSQL 17:
// the real prerequisite migrations + PROPOSED link #26, every gateway call through the database entry
// points AS lc_action_gateway (tenant claim), every domain write through the lease-bound SECURITY DEFINER
// functions, every guard the EXISTING domain service's. The provider is simulated (no network, no TextGrid).
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { gatewayDb, seedWorld, registerAgent, seedThread, makeGateway, sel, audits, intentRow, outcomeRow, trapTransport, setControls, findPhoneLike, ORG, OPERATOR, SELLER, SELLER_2 } from '../helpers/action-gateway-pg.mjs'
import { pgSupabase } from '../helpers/pg-supabase.mjs'
import { claimRow, dispatchRow, simProvider } from '../helpers/followup-lifecycle-pg.mjs'
import { fakeProvider } from '../helpers/conversation-ai-runtime-fakes.mjs'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { __setAutomationHoldResolverForTests, resolveAutomationHold, HOLD_CAPABILITIES } from '../../src/lib/domain/holds/automation-hold.js'
import { decodePropertyRef, encodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null) // the REAL registry answers every hold check

const ALL_T1 = [['research.create_job', 1], ['valuation.request', 1], ['tasks.create_operator_task', 1], ['tasks.update_operator_task', 1], ['conversation.draft_reply', 1], ['ops.reconciliation_report', 1], ['conversation.read_context', 1]]

async function world({ grants = ALL_T1, tier_ceiling = 2, read_scopes = [] } = {}) {
  const env = await gatewayDb()
  await seedWorld(env.owner)
  const cred = await registerAgent(env.owner, { grants, tier_ceiling, read_scopes })
  return { env, cred }
}

test('PG gateway: create_research_job enqueues ONE mission.research job accountable to the human sponsor; a replay returns the recorded outcome (no second job); the same key with other params is a conflict', { skip }, async () => {
  const { env, cred } = await world()
  const net = trapTransport()
  try {
    await env.owner.query(`insert into public.properties (property_id, property_type) values ('2128263281', 'SFR')`)
    const { gateway } = makeGateway(env)
    const args = { client_request_id: 'research-0001', question: 'What did similar 3 bed houses near 2128263281 sell for this year? Seller said call 312-555-0161.', property_ids: ['2128263281'], budget_usd: 0.4 }
    const r = await gateway.call({ credential: cred, tool: 'create_research_job', args })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.code, 'JOB_ENQUEUED')
    const jobs = await sel(env.owner, `select job_id, kind, requested_by, budget_cap_usd, input from agent.research_job where kind = 'mission.research'`)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].requested_by, OPERATOR, 'the mission is accountable to the named human sponsor')
    assert.equal(Number(jobs[0].budget_cap_usd), 0.4)
    assert.equal(jobs[0].input.action_intent_id, r.intent_id)
    assert.equal(jobs[0].input.context.property_ids[0], encodePropertyRef('2128263281'), 'property ids are stored encoded')
    assert.match(jobs[0].input.context.property_ids[0], /^pid_[g-p]+$/)
    assert.equal(findPhoneLike(JSON.stringify(jobs[0].input)), null, 'no phone shape reaches the job input')
    assert.equal(r.result.job_id, jobs[0].job_id)
    // replay: same client key → the recorded outcome, no second job
    const again = await gateway.call({ credential: cred, tool: 'create_research_job', args })
    assert.equal(again.status, 'replayed')
    assert.equal(again.intent_id, r.intent_id)
    assert.equal(again.result.job_id, jobs[0].job_id)
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.research_job where kind = 'mission.research'`))[0].n, 1)
    // the same key with different parameters: refused as a conflict, nothing new
    const clash = await gateway.call({ credential: cred, tool: 'create_research_job', args: { ...args, budget_usd: 0.3 } })
    assert.equal(clash.ok, false)
    assert.equal(clash.error.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents`))[0].n, 1)
    const auth = (await sel(env.owner, `select * from action_gateway.action_authorizations where intent_id = $1`, [r.intent_id]))[0]
    assert.equal(auth.sponsor_user_id, OPERATOR)
    assert.equal(auth.policy_id, 'create_research_job.policy')
    assert.equal(auth.approval_id, null)
    const ev = (await audits(env.owner, r.intent_id)).map((e) => e.event_type)
    for (const e of ['intent_opened', 'authorized', 'claimed', 'intent_succeeded']) assert.ok(ev.includes(e), `audit ${e}: ${ev}`)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG gateway: request_property_valuation enqueues a READ-ONLY property.research job (no web, $0); an unknown property is not_found; a HELD property is refused by the hold authority', { skip }, async () => {
  const { env, cred } = await world()
  try {
    await env.owner.query(`insert into public.properties (property_id, property_type) values ('1000000001', 'SFR'), ('1000000002', 'SFR')`)
    await env.owner.query(`insert into public.automation_holds (hold_key, hold_type, property_id, reason, set_by, approval_ref) values ('test:held-prop', 'operator_hold', '1000000002', 'operator review', 'owner', 'test')`)
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'request_property_valuation', args: { client_request_id: 'valuation-01', property_id: '1000000001' } })
    assert.equal(r.ok, true, JSON.stringify(r))
    const job = (await sel(env.owner, `select kind, input, budget_cap_usd from agent.research_job where kind = 'property.research'`))[0]
    assert.equal(job.input.trigger, 'valuation_stale_or_missing')
    assert.equal(job.input.web, false)
    assert.equal(decodePropertyRef(job.input.property_ref), '1000000001')
    assert.equal(Number(job.budget_cap_usd), 0)
    const nf = await gateway.call({ credential: cred, tool: 'request_property_valuation', args: { client_request_id: 'valuation-02', property_id: '1000000009' } })
    assert.equal(nf.error.code, 'PROPERTY_NOT_FOUND')
    const held = await gateway.call({ credential: cred, tool: 'request_property_valuation', args: { client_request_id: 'valuation-03', property_id: '1000000002' } })
    assert.equal(held.status, 'refused')
    assert.equal(held.code, 'AUTOMATION_HOLD')
    assert.equal((await outcomeRow(env.owner, held.intent_id)).status, 'refused')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.research_job where kind = 'property.research'`))[0].n, 1, 'the held property got no job')
  } finally { await env.db.drop() }
})

test('PG gateway: create_operator_task lands in the Action Center (agent.ops_work_item scope agent); update_operator_task adds a note and resolves it; a work item of another subsystem is untouchable', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const t = await seedThread(env.owner)
    const { gateway } = makeGateway(env)
    const c = await gateway.call({ credential: cred, tool: 'create_operator_task', args: { client_request_id: 'task-0001', title: 'Confirm which property the seller meant', note: 'Seller replied No to two questions; reach them at 312.555.0161 or dana@example.com', priority: 300, severity: 'warning', subject: { type: 'thread', id: t.thread_id } } })
    assert.equal(c.ok, true, JSON.stringify(c))
    const w = (await sel(env.owner, `select * from agent.ops_work_item where work_item_id = $1`, [c.result.work_item_id]))[0]
    assert.deepEqual([w.scope, w.kind, w.state, w.subject_type, w.subject_id, w.severity, w.priority], ['agent', 'agent_task', 'open', 'conversation', t.thread_id, 'warning', 300])
    assert.ok(!/555|example\.com/.test(JSON.stringify(w.detail)), `phones / emails are masked: ${JSON.stringify(w.detail)}`)
    const u = await gateway.call({ credential: cred, tool: 'update_operator_task', args: { client_request_id: 'task-0002', work_item_id: w.work_item_id, note: 'Seller confirmed Oak St', resolve: true } })
    assert.equal(u.ok, true, JSON.stringify(u))
    const w2 = (await sel(env.owner, `select * from agent.ops_work_item where work_item_id = $1`, [w.work_item_id]))[0]
    assert.equal(w2.state, 'resolved')
    assert.equal(w2.resolved_by, 'auto:agent_gateway')
    assert.equal(w2.detail.notes.length, 2)
    // a pipeline-scope item (another subsystem) is invisible to the gateway
    const other = (await sel(env.owner, `insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, title, subject_type) values ($1, 'pipeline', 'pipeline_mismatch', 'pipeline:opp:x', 'info', 'Pipeline: x', 'system') returning work_item_id`, [ORG]))[0]
    const nf = await gateway.call({ credential: cred, tool: 'update_operator_task', args: { client_request_id: 'task-0003', work_item_id: other.work_item_id, resolve: true } })
    assert.equal(nf.error.code, 'TASK_NOT_FOUND')
    assert.equal((await sel(env.owner, `select state from agent.ops_work_item where work_item_id = $1`, [other.work_item_id]))[0].state, 'open')
    // a resolved agent task cannot be updated again
    const closed = await gateway.call({ credential: cred, tool: 'update_operator_task', args: { client_request_id: 'task-0004', work_item_id: w.work_item_id, note: 'again' } })
    assert.equal(closed.code, 'TASK_CLOSED')
  } finally { await env.db.drop() }
})

test('PG gateway: draft_seller_reply runs decideAndCompose in SHADOW (review-draft service) and is NEVER queued: no send_queue row, no ai_generated record, a hash-only outcome; the text is returned once', { skip }, async () => {
  const { env, cred } = await world()
  const net = trapTransport()
  try {
    const t = await seedThread(env.owner, { inboundBody: 'Yes I still own it' })
    const provider = fakeProvider((p) => (p.tools[0].input_schema?.properties?.message ? { message: 'Good to know. Would you consider an offer on it?' }
      : makeDecision({ intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: 'R1 TEXT NEVER SENT', confidence: 0.93, source_message_ids: [], facts_extracted: [], stage_evidence: { stage: 'S2_interest', evidence_message_ids: [], rationale: 'x' } })))
    const { gateway } = makeGateway(env, { provider })
    const queueBefore = (await sel(env.owner, `select count(*)::int n from public.send_queue`))[0].n
    const r = await gateway.call({ credential: cred, tool: 'draft_seller_reply', args: { client_request_id: 'draft-00001', thread_id: t.thread_id } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.code, 'DRAFT_COMPOSED', JSON.stringify(r.result))
    assert.equal(r.result.model_used, true)
    assert.equal(r.result.send_status, 'never_sent_draft')
    assert.equal(r.response.draft.send_status, 'never_sent_draft')
    if (r.code === 'DRAFT_COMPOSED') {
      assert.equal(typeof r.response.draft.text, 'string')
      assert.equal(r.result.draft_length, r.response.draft.text.length)
    }
    const out = await outcomeRow(env.owner, r.intent_id)
    assert.ok(!('text' in out.result) && !JSON.stringify(out.result).includes('Would you consider'), 'the stored outcome carries no message text')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.send_queue`))[0].n, queueBefore, 'nothing queued')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.automation_holds`))[0].n, 0)
    assert.deepEqual(net.hits, [], 'no network')
    // the replay returns the recorded (hash-only) outcome and does not re-draft
    const again = await gateway.call({ credential: cred, tool: 'draft_seller_reply', args: { client_request_id: 'draft-00001', thread_id: t.thread_id } })
    assert.equal(again.status, 'replayed')
    assert.equal(again.response, undefined)
  } finally { net.restore(); await env.db.drop() }
})

test('PG gateway: STOP on the latest inbound refuses the draft BEFORE it is prepared, and a STOP arriving DURING draft preparation discards the draft (refused + recorded)', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const stopped = await seedThread(env.owner, { phone: SELLER, inboundBody: 'STOP texting me' })
    const live = await seedThread(env.owner, { phone: SELLER_2, property: 'p101', inboundBody: 'Maybe, depends on the price' })
    // the draft service is the REAL one; while it runs, the seller's STOP arrives
    let arrived = false
    const draft = async (a) => {
      const { draftReplyForInbound } = await import('../../src/lib/ai/conversation-ai-draft-service.js')
      const r = await draftReplyForInbound({ ...a, caller: 'capability' })
      await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                             values (gen_random_uuid(), 'SMstop-mid', 'inbound', $1::text, $1::text, '+13125550199', 'STOP', now(), now(), 'p101', 'en')`, [SELLER_2])
      arrived = true
      return r
    }
    const { gateway } = makeGateway(env, { draft })
    const pre = await gateway.call({ credential: cred, tool: 'draft_seller_reply', args: { client_request_id: 'draft-stop-1', thread_id: stopped.thread_id } })
    assert.equal(pre.status, 'refused')
    assert.equal(pre.code, 'STOP_REQUESTED')
    const mid = await gateway.call({ credential: cred, tool: 'draft_seller_reply', args: { client_request_id: 'draft-stop-2', thread_id: live.thread_id } })
    assert.ok(arrived, 'the STOP arrived while the draft was prepared')
    assert.equal(mid.ok, false)
    assert.equal(mid.status, 'refused')
    assert.equal(mid.code, 'STOP_RECEIVED_DURING_DRAFT')
    assert.equal(mid.response, undefined, 'the draft is discarded, not returned')
    const o = await outcomeRow(env.owner, mid.intent_id)
    assert.deepEqual([o.status, o.code, o.result.discarded], ['refused', 'STOP_RECEIVED_DURING_DRAFT', true])
    assert.ok((await audits(env.owner, mid.intent_id)).some((e) => e.event_type === 'intent_refused'))
  } finally { await env.db.drop() }
})

test('PG gateway: set_thread_hold puts the thread under the ONE hold authority and actually blocks sends: a queued row can no longer be claimed (registry trigger) and a row claimed BEFORE the hold is deferred by the REAL dispatcher (zero provider calls)', { skip }, async () => {
  const { env, cred } = await world({ grants: [['holds.set_thread_hold', 2]] })
  const net = trapTransport()
  try {
    const t = await seedThread(env.owner)
    await setControls(env.owner, { queue_processor_mode: 'live', queue_execution_mode: 'normal' })
    const queued = (await sel(env.owner, `insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata, scheduled_for) values ('gw-q-queued', 'queued', 'Checking back in about Oak St.', $1::text, $1::text, 'followup', '{}'::jsonb, now()) returning id`, [SELLER]))[0]
    const pre = (await sel(env.owner, `insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata, scheduled_for) values ('gw-q-claimed', 'queued', 'Any update on Oak St?', $1::text, $1::text, 'followup', '{}'::jsonb, now()) returning id`, [SELLER]))[0]
    const claimed = await claimRow(env.owner, pre.id) // the runner claimed this one BEFORE the hold
    assert.ok(claimed)
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'set_thread_hold', args: { client_request_id: 'hold-000001', thread_id: t.thread_id, reason_code: 'seller_requested_pause' } })
    assert.equal(r.ok, true, JSON.stringify(r))
    const hold = (await sel(env.owner, `select * from public.automation_holds where released_at is null`))
    assert.equal(hold.length, 1)
    assert.deepEqual([hold[0].thread_key, hold[0].inbox_thread_id, hold[0].set_by, hold[0].approval_ref], [SELLER, t.thread_id, 'agent:agt_alpha', `action_intent:${r.intent_id}`])
    assert.ok(!hold[0].blocked_capabilities.includes('manual_send'), 'a human can still reply manually')
    // the hold authority answers held for an outbound send on the thread
    const verdict = await resolveAutomationHold({ thread_key: SELLER }, { capability: HOLD_CAPABILITIES.OUTBOUND_SEND, supabase: pgSupabase(env.owner) })
    assert.equal(verdict.held, true)
    // (1) the queued row cannot be claimed any more (DB backstop: the registry's send_queue trigger)
    await assert.rejects(env.owner.query(`update public.send_queue set queue_status = 'processing', is_locked = true, lock_token = gen_random_uuid() where id = $1`, [queued.id]), /AUTOMATION_HOLD/)
    // (2) the row claimed before the hold: the REAL dispatcher defers it; the simulated provider is never called
    const provider = simProvider()
    const out = await dispatchRow({ pool: env.owner, sb: pgSupabase(env.owner) }, claimed, { provider, now: new Date().toISOString() })
    assert.equal(out.sent, false)
    assert.equal(out.reason, 'automation_hold', JSON.stringify(out))
    assert.equal(provider.sent.length, 0)
    assert.deepEqual(net.hits, [])
    // SET only: a second agent hold on the same thread is idempotent (one active hold)
    const again = await gateway.call({ credential: cred, tool: 'set_thread_hold', args: { client_request_id: 'hold-000002', thread_id: t.thread_id, reason_code: 'operator_review' } })
    assert.equal(again.code, 'ALREADY_HELD')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.automation_holds where released_at is null`))[0].n, 1)
  } finally { net.restore(); await env.db.drop() }
})

test('PG gateway: run_authorized_reconciliation is REPORT ONLY: findings about live opportunities come back, and no stage, work item, finding or approval is written', { skip }, async () => {
  const { env, cred } = await world()
  try {
    await env.owner.query(`insert into public.acquisition_opportunities (id, primary_property_id, acquisition_stage, opportunity_status, next_action, updated_at)
                           values (gen_random_uuid(), 'p200', 'offer', 'active', null, now()), (gen_random_uuid(), 'p201', 'asking_price', 'active', 'call back', now())`)
    const counts = async () => (await sel(env.owner, `select (select count(*) from agent.ops_work_item)::int w, (select count(*) from agent.approval_request)::int a, (select count(*) from agent.finding)::int f,
                                                        (select string_agg(acquisition_stage, ',' order by acquisition_stage) from public.acquisition_opportunities) s`))[0]
    const before = await counts()
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'run_authorized_reconciliation', args: { client_request_id: 'recon-00001', kind: 'pipeline' } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.response.report.mode, 'report_only')
    assert.ok(r.response.report.scanned >= 1)
    assert.ok(r.response.report.by_issue.stage_not_projection_consistent >= 1, JSON.stringify(r.response.report))
    assert.deepEqual(r.response.report.writes, { stages: 0, work_items: 0, approvals: 0 })
    assert.deepEqual(await counts(), before, 'nothing written')
  } finally { await env.db.drop() }
})

test('PG gateway: read_conversation_context needs its own scope; it returns bodies, facts, persona, permission state and property evidence with NO raw phone number, and every read is audited', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const noScope = await registerAgent(env.owner, { agent_id: 'agt_noscope', grants: [['conversation.read_context', 1]] })
    const reader = await registerAgent(env.owner, { agent_id: 'agt_reader', grants: [['conversation.read_context', 1]], read_scopes: ['conversation_context.read'] })
    const t = await seedThread(env.owner, { inboundBody: 'Yes, text me at 312-555-0161 or mail dana@example.com about 12 Oak St' })
    const { gateway } = makeGateway(env)
    const refused = await gateway.call({ credential: noScope, tool: 'read_conversation_context', args: { thread_id: t.thread_id } })
    assert.equal(refused.error.code, 'READ_SCOPE_NOT_GRANTED')
    const r = await gateway.call({ credential: reader, tool: 'read_conversation_context', args: { thread_id: t.thread_id } })
    assert.equal(r.ok, true, JSON.stringify(r))
    const text = JSON.stringify(r.result)
    assert.ok(!text.includes(SELLER) && !text.includes('13125550161') && !text.includes('3125550161'), 'no thread key / phone')
    assert.equal(findPhoneLike(text), null, `a phone number in the context payload: ${findPhoneLike(text)}`)
    // NEGATIVE CONTROL: the detector catches the seller's REAL number as it sits unmasked in the database row the
    // projection reads, in every common rendering, so a regression that leaked it would fail the assertion above
    const rawBody = (await sel(env.owner, `select message_body from public.message_events where id = $1`, [t.inbound_id]))[0].message_body
    assert.equal(findPhoneLike(rawBody), '312-555-0161')
    for (const leak of [SELLER, SELLER.slice(2), '(312) 555-0161', '312.555.0161', '1 312 555 0161']) assert.ok(findPhoneLike(JSON.stringify({ ...r.result, leaked: leak })), `the detector misses ${leak}`)
    assert.ok(!text.includes('dana@example.com'))
    assert.ok(r.result.messages.length >= 2)
    assert.ok(r.result.messages.some((m) => /still own/i.test(m.body)))
    assert.equal(r.result.sender.routing, 'resolved_inside_leadcommand')
    assert.equal(r.result.persona.name, 'Helen')
    assert.equal(r.result.permission.hold.held, false)
    assert.equal(r.result.property_evidence.properties[0].city, 'Chicago')
    const reads = await sel(env.owner, `select agent_id, code from action_gateway.action_audit_events where event_type = 'context_read'`)
    assert.deepEqual(reads, [{ agent_id: 'agt_reader', code: 'READ' }])
    assert.ok((await sel(env.owner, `select 1 from action_gateway.action_audit_events where event_type = 'call_refused' and code = 'READ_SCOPE_NOT_GRANTED' and agent_id = 'agt_noscope'`)).length === 1)
  } finally { await env.db.drop() }
})

test('PG gateway: every registered-but-unimplemented tool answers capability_not_implemented (even with a grant) and never writes anything', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner, { tiers: 'T1,T2,T3,T4' })
    const { ACTIONS } = await import('../../src/lib/domain/action-gateway/catalog.js')
    const stubs = ACTIONS.filter((a) => a.implemented === false)
    assert.equal(stubs.length, 14)
    const cred = await registerAgent(env.owner, { tier_ceiling: 4, grants: stubs.map((s) => [s.capability, 4]) })
    const { gateway } = makeGateway(env)
    for (const s of stubs) {
      const r = await gateway.call({ credential: cred, tool: s.name, args: { client_request_id: `stub-${s.name}`.slice(0, 80) } })
      assert.equal(r.ok, false, s.name)
      assert.equal(r.error.class, 'not_implemented', s.name)
      assert.equal(r.error.code, 'capability_not_implemented', s.name)
    }
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents`))[0].n, 0)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_audit_events where code = 'capability_not_implemented'`))[0].n, 14)
  } finally { await env.db.drop() }
})
