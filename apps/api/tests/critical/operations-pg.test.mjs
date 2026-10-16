// 8.5.20 part C — PostgreSQL proofs on a DISPOSABLE local PostgreSQL 17 (AGENT_PG_TEST_DB_URL;
// skipped — reported, never vacuous — without it). Applies S3 → research → R2 runtime →
// capabilities → 8.5.15/8.5.18 → PROPOSED_20261016140000_operations_action_center over the
// prod-shaped public fixture, and runs the four operations jobs AS agent_api through the real
// agent.runtime_* and agent.ops_* functions (payload CHECKs, lease binding, scope binding).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createPgCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { createCapabilityPlane } from '../../src/lib/agent/capabilities/index.js'
import { createMissionPgReads, REVIEW_DIGEST_KIND, buildMissionHandlers } from '../../src/lib/agent/missions/index.js'
import { buildOperationsHandlers, createOperationsPgSource, createOperationsPgStore, createOperationsSqlSource, RECOVERY_SWEEP_KIND, ACTION_CENTER_KIND, PIPELINE_RECONCILE_KIND, OPS_SUPERVISOR_KIND } from '../../src/lib/agent/operations/index.js'
import { OP, ORG, ENV as CAP_ENV, SECRET, makeWorld } from '../helpers/agent-capabilities-fake.mjs'

const skip = pgAvailable() ? false : skipReason
const M = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const FIXTURE = path.join(REPO_DIR, 'scripts/db/fixtures/operations_public_baseline.sql')
const CHAIN = ['PROPOSED_20261013120000_agent_capabilities.sql', 'PROPOSED_20261013160000_conversation_ai_shadow.sql', 'PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql', 'PROPOSED_20261013161000_conversation_decide_event_budget.sql', 'PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql', 'PROPOSED_20261014120000_persistent_missions.sql']
const OPS_MIG = M('PROPOSED_20261016140000_operations_action_center.sql')
const KINDS = [RECOVERY_SWEEP_KIND, ACTION_CENTER_KIND, PIPELINE_RECONCILE_KIND, OPS_SUPERVISOR_KIND, REVIEW_DIGEST_KIND]

async function opsDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await runSqlFile(db.pool, FIXTURE)
  await applyInTransaction(db.pool, SQL.runtime)
  for (const f of CHAIN) await applyInTransaction(db.pool, M(f))
  await applyInTransaction(db.pool, OPS_MIG)
  await db.pool.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test') on conflict do nothing`, [ORG, OP])
  await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 4, tick_max_jobs = 5, lease_seconds = 60, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify(Object.fromEntries(KINDS.map((k) => [k, { enabled: true, max_concurrency: 1, armed_by: OP }])))])
  return db
}

async function seed(pool) {
  // a waiting seller with an unanswered offer request (archived!), an opt-out, a stale "offer" with no offer event, an outbound-only thread
  const q = (s, p = []) => pool.query(s, p)
  const t = (await q(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, seller_stage, contactability_status, is_archived, updated_at)
     values ('+15550000101', '+15550000101', '2124415662', 'offer_interest', 'contactable', true, now() - interval '2 days'),
            ('+15550000102', '+15550000102', '2124415663', 'ownership_confirmation', 'opted_out', false, now() - interval '1 day'),
            ('+15550000103', '+15550000103', null, null, 'contactable', false, now()) returning id, thread_key`)).rows
  await q(`insert into public.message_events (thread_key, direction, detected_intent, is_opt_out, event_timestamp, language) values
     ('+15550000101', 'outbound', null, false, now() - interval '3 days', null),
     ('+15550000101', 'inbound', 'ownership_confirmed', false, now() - interval '2 days 22 hours', 'English'),
     ('+15550000101', 'inbound', 'asks_offer', false, now() - interval '2 days', 'English'),
     ('+15550000102', 'inbound', 'opt_out', true, now() - interval '1 day', 'English'),
     ('+15550000103', 'outbound', null, false, now(), null)`)
  const o = (await q(`insert into public.acquisition_opportunities (dedupe_key, primary_thread_key, primary_property_id, acquisition_stage, opportunity_status, temperature, stage_entered_at, asking_price)
     values ('ops-pg-1', '+15550000101', '2124415662', 'offer', 'active', 'hot', now() - interval '20 days', 180000) returning id`)).rows[0].id
  await q(`insert into public.send_queue (queue_status, thread_key, sent_at, delivered_at, created_at, provider_message_id) values ('delivered', '+15550000103', now() - interval '1 hour', now() - interval '59 minutes', now() - interval '1 hour', 'SMx'),
     ('failed', '+15550000103', now() - interval '2 hours', null, now() - interval '2 hours', 'SMy')`)
  await q(`insert into public.system_control (key, value) values ('queue_processor_heartbeat_at', now()::text), ('campaign_feeder_heartbeat_at', now()::text),
     ('followup_no_response_heartbeat_at', now()::text), ('seller_state_reconcile_heartbeat_at', now()::text), ('webhook_delivery_recovery_last_at', now()::text)`)
  return { waitingId: t.find((x) => x.thread_key.endsWith('101')).id, optId: t.find((x) => x.thread_key.endsWith('102')).id, oppId: o }
}

test('PG operations jobs as agent_api: recovery → action center → pipeline → supervisor → daily brief; every write lease-bound and CHECK-clean; nothing in public written; $0', { skip }, async () => {
  const db = await opsDb()
  try {
    const ids = await seed(db.pool)
    const api = await db.enableApi()
    const runtime = createRuntimePgStore({ pool: api })
    const reads = createMissionPgReads({ pool: api })
    const source = createOperationsPgSource({ pool: api })
    const store = createOperationsPgStore({ pool: api })
    const world = makeWorld()
    world.services.pipeline.get = async (id) => (id === String(ids.oppId) ? { id, acquisition_stage: 'offer', opportunity_status: 'active', stage_entered_at: new Date().toISOString() } : null)
    const plane = createCapabilityPlane({ env: CAP_ENV, store: createPgCapabilityStore({ pool: api }), services: world.services, secret: SECRET })
    const handlers = {
      ...buildOperationsHandlers({ source, store, reads, getPlane: async () => plane }),
      ...buildMissionHandlers({ env: { ...CAP_ENV, AGENT_MISSIONS_ENABLED: '1' }, runtimeStore: runtime, reads, operations: { source, store } }),
    }
    const publicBefore = (await db.pool.query(`select (select count(*) from public.inbox_thread_state) a, (select count(*) from public.send_queue) b, (select count(*) from public.acquisition_opportunities) c, (select string_agg(acquisition_stage, ',') from public.acquisition_opportunities) s`)).rows[0]
    const run = async (kind, key, input = {}) => {
      const r = await runtime.enqueue({ kind, idempotency_key: key.repeat(64), input, requested_by: OP })
      assert.equal(r.ok, true, JSON.stringify(r))
      await runRuntimeTick({ store: runtime, handlers, workerId: 'pg-w', budgetMs: 25_000 })
      const j = (await db.pool.query('select state, result, last_error from agent.research_job where job_id = $1', [r.job_id])).rows[0]
      assert.equal(j.state, 'completed', `${kind}: ${JSON.stringify(j.last_error)}`)
      return j.result
    }

    const rec = await run(RECOVERY_SWEEP_KIND, 'a')
    assert.equal(rec.scanned, 2, 'only conversations with an inbound')
    assert.equal(rec.by_class.suppressed, 1)
    assert.equal(rec.sends, 0)
    const ac = await run(ACTION_CENTER_KIND, 'b')
    assert.equal(ac.lost, 1)
    const st = (await db.pool.query('select conversation_id::text id, state, lost, verified_stage, stage_verified, stage_note from agent.conversation_action_state order by state')).rows
    assert.deepEqual(st.map((r) => [r.id, r.state, r.lost]).sort(), [[String(ids.optId), 'suppressed_ineligible', false], [String(ids.waitingId), 'needs_attention', true]].sort())
    assert.deepEqual(st.find((r) => r.id === String(ids.waitingId)).stage_note, 'offer_stage_without_offer_event', 'archived + unanswered is still the active queue; the "offer" is not verified')
    const pipe = await run(PIPELINE_RECONCILE_KIND, 'c')
    assert.equal(pipe.scanned, 1)
    assert.equal(pipe.stage_writes, 0)
    assert.equal(pipe.proposals[0].status, 'approval_pending', JSON.stringify(pipe.proposals))
    const appr = (await db.pool.query(`select capability_id, state, intended_change from agent.approval_request`)).rows
    assert.deepEqual(appr.map((a) => [a.capability_id, a.state, a.intended_change.to_stage]), [['pipeline.propose_stage_change', 'pending', 'property_condition']])
    const sup = await run(OPS_SUPERVISOR_KIND, 'd')
    assert.equal(sup.model_calls, 0)
    assert.equal(sup.statuses.unhandled_inbounds, 'warn')
    assert.equal(sup.statuses.hot_opportunities, 'critical')
    assert.equal(sup.statuses.profitability, 'unavailable')
    // a re-run of the action center now sees the pending approval on the opportunity
    const ac2 = await run(ACTION_CENTER_KIND, 'e')
    assert.equal(ac2.counts.awaiting_operator_decision, 1)
    const brief = await run(REVIEW_DIGEST_KIND, 'f', { window_hours: 24 })
    assert.equal(brief.brief_sections.length, 10)
    const finding = (await db.pool.query(`select value from agent.finding where finding_type = 'digest.morning' order by retrieved_at desc limit 1`)).rows[0].value
    const sections = Object.fromEntries(finding.brief.sections.map((s) => [s.id, s]))
    assert.equal(sections.offers_prepared.available, true)
    assert.equal(sections.offers_prepared.lines[0].value, 0, 'a read table with no rows is a real 0')
    assert.equal(sections.deals_awaiting_approval.lines[0].value, 1)
    assert.ok(sections.recommended_next_actions.lines.length >= 1)

    // work items: scoped, de-duplicated; an operator decision through the API function
    const items = (await db.pool.query(`select scope, kind, state, dedupe_key, escalated from agent.ops_work_item order by scope, dedupe_key`)).rows
    assert.ok(items.some((i) => i.scope === 'recovery' && i.kind === 'recovery_review'))
    assert.ok(items.some((i) => i.scope === 'action_center' && i.kind === 'lost_conversation'))
    assert.ok(items.some((i) => i.scope === 'pipeline' && i.kind === 'pipeline_mismatch'))
    assert.ok(items.some((i) => i.scope === 'supervisor' && i.escalated))
    // the pending approval made the conversation assigned ⇒ its lost item resolved itself
    const lostItem = (await db.pool.query(`select state, resolved_by from agent.ops_work_item where scope = 'action_center'`)).rows[0]
    assert.deepEqual([lostItem.state, lostItem.resolved_by], ['resolved', 'auto:condition_cleared'])
    const wid = (await db.pool.query(`select work_item_id from agent.ops_work_item where scope = 'recovery'`)).rows[0].work_item_id
    assert.equal((await store.decideWorkItem({ work_item_id: wid, by: OP, action: 'acknowledge' })).ok, true)
    assert.equal((await store.decideWorkItem({ work_item_id: wid, by: 'system:cron', action: 'resolve' })).reason, 'by_not_named_operator')
    const listed = await store.listWorkItems({ states: ['acknowledged'] })
    assert.deepEqual(listed.map((w) => w.work_item_id), [wid])
    const summary = await store.actionCenterSummary()
    assert.equal(summary.total, 2)

    // nothing in public changed; no model spend
    const publicAfter = (await db.pool.query(`select (select count(*) from public.inbox_thread_state) a, (select count(*) from public.send_queue) b, (select count(*) from public.acquisition_opportunities) c, (select string_agg(acquisition_stage, ',') from public.acquisition_opportunities) s`)).rows[0]
    assert.deepEqual(publicAfter, publicBefore)
    assert.equal(Number((await db.pool.query('select count(*) n from agent.spend_ledger')).rows[0].n), 0)
    // agent_api cannot read public, and cannot write the read model directly
    await assert.rejects(api.query('select 1 from public.inbox_thread_state limit 1'), /permission denied/)
    await assert.rejects(api.query(`update agent.conversation_action_state set state = 'resolved'`), /permission denied/)

    // the SQL text path (the live proof's) reads the same facts as the function path
    const viaSql = await createOperationsSqlSource({ query: async (s, p) => (await db.pool.query(s, p)).rows }).conversationFacts({ limit: 50 })
    const viaFn = await source.conversationFacts({ limit: 50 })
    assert.deepEqual(viaSql.map((r) => [r.conversation_id, r.last_meaningful_intent, Number(r.outbound_after_inbound)]), viaFn.map((r) => [r.conversation_id, r.last_meaningful_intent, Number(r.outbound_after_inbound)]))
  } finally {
    await db.drop()
  }
})
