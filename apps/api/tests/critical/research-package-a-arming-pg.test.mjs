// PACKAGE A (hotfix/research-runtime) — the HARD GUARANTEE, proven on a DISPOSABLE PostgreSQL
// (AGENT_PG_TEST_DB_URL on 127.0.0.1; skipped — reported, never vacuous — without it).
//
// Start from the PRODUCTION state: S3 + research_ro + intel_runtime applied, the Fix A runtime state (runtime
// off, emergency stop ON 'pretest', kind_limits {}), then the Package A migrations in the production order and
// the born-disabled schedule seed. Seed the messaging world the package must never touch: paused / held /
// queued / scheduled / approved send_queue rows (some DUE), paused / scheduled / active campaigns, the
// system_control send keys, threads with dispositions and stages, offers, scores.
// Then run the REAL owner scripts with psql (activate.sql, enable-schedules.sql, disarm.sql), drive the REAL
// runtime tick as agent_api with every Package A handler until the queue drains, and assert:
//   • ZERO change to send_queue / campaigns / system_control / inbox_thread_state / opportunities (+ history) /
//     seller_offers / property_acquisition_scores / message_events / seller_followup_state / closing_cases /
//     suppression (full-row md5 fingerprints, before == after), and no write through any client
//   • only Package A kinds were ever enqueued or claimed; messaging kinds stay refused (kind_not_armed)
//   • the emergency stop was changed ONLY by activate.sql (cleared) and disarm.sql (re-engaged)
//   • owner exclusions (Maxwell, Hartford) produced no job and no work item
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR, API_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { DEFAULT_RUNTIME_HANDLERS } from '../../src/lib/agent/runtime/runtime-service.js'
import { createMissionPgReads } from '../../src/lib/agent/missions/mission-reads.js'
import { createOperationsPgSource, createOperationsPgStore } from '../../src/lib/agent/operations/index.js'
import { buildResearchPackageHandlers, RESEARCH_PACKAGE_KINDS } from '../../src/lib/ai/research-runtime-wiring.js'
import { createPropertyResearchSweepSupabaseSource } from '../../src/lib/agent/missions/property-research-triggers.js'
import { HARTFORD_EXCLUSION } from '../../src/lib/agent/missions/research-exclusions.js'
import { OP, ORG } from '../helpers/agent-capabilities-fake.mjs'
import { PID, memorySource } from '../helpers/property-research-fixtures.mjs'
import { pgSupabase } from '../helpers/pg-supabase.mjs'

const PSQL = process.env.LC_PSQL || 'psql'
const psqlOk = spawnSync(PSQL, ['--version'], { encoding: 'utf8' }).status === 0
const skip = !pgAvailable() ? skipReason : !psqlOk ? 'psql not on PATH (or LC_PSQL): the owner scripts are run with psql' : false
const M = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const OPS = (f) => path.join(API_DIR, 'scripts/ops/research-package-a', f)
const MAXWELL_PID = '251027062'
const PACKAGE_CHAIN = [
  'PROPOSED_20261013120000_agent_capabilities.sql',
  'PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql',
  'PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql',
  'PROPOSED_20261014120000_persistent_missions.sql',
  'PROPOSED_20261016140000_operations_action_center.sql',
  // PROPOSED_20261019120000_payload_clean_opaque_ids.sql is applied by freshDb() (as in production order: after S3)
  'PROPOSED_20261020120000_research_event_budget_ceilings.sql',
]
const PROTECTED = ['send_queue', 'campaigns', 'system_control', 'inbox_thread_state', 'acquisition_opportunities', 'acquisition_opportunity_history', 'seller_offers', 'property_acquisition_scores', 'message_events', 'seller_followup_state', 'closing_cases', 'sms_suppression_list', 'textgrid_numbers']
const SEND_KEYS = { queue_processor_mode: 'paused', queue_execution_mode: 'scoped_canary_only', queue_emergency_stop_at: '2026-10-19T00:00:00Z', campaign_mode: 'paused', auto_reply_mode: 'off', followup_automation_mode: 'off', followup_execution_mode: 'off', outbound_sending_enabled: 'false' }

function psql(url, file, vars = {}) {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-d', url, '-f', file]
  const r = spawnSync(PSQL, args, { encoding: 'utf8', env: { PATH: process.env.PATH, PGCONNECT_TIMEOUT: '10' } })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

async function fingerprint(pool) {
  const out = {}
  for (const t of PROTECTED) out[t] = (await pool.query(`select count(*)::int n, coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') h from public.${t} x`)).rows[0]
  return out
}

/** A supabase-shaped client over the admin pool that COUNTS every write attempt (and refuses it). */
function countingClient(pool) {
  const db = pgSupabase(pool)
  const writes = []
  return {
    writes,
    client: {
      from(table) {
        const b = db.from(table)
        return new Proxy(b, { get(t, p, r) { if (['insert', 'upsert', 'update', 'delete'].includes(String(p))) return () => { writes.push(`${table}.${String(p)}`); throw Object.assign(new Error('WRITE_REFUSED_IN_TEST'), { code: 'WRITE_REFUSED_IN_TEST' }) }; const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v } })
      },
      rpc(name, args) { writes.push(`rpc:${name}`); return db.rpc(name, args) },
    },
  }
}

async function productionStateDb() {
  const d = await freshDb() // S3 + payload_clean_opaque_ids
  await runSqlFile(d.pool, SQL.researchPretest)
  await runSqlFile(d.pool, SQL.research)
  await runSqlFile(d.pool, path.join(REPO_DIR, 'scripts/db/fixtures/operations_public_baseline.sql'))
  await applyInTransaction(d.pool, SQL.runtime)
  await runSqlFile(d.pool, path.join(REPO_DIR, 'scripts/db/fixtures/fix_a_runtime_state.sql'))
  for (const f of PACKAGE_CHAIN) await applyInTransaction(d.pool, M(f))
  await d.pool.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test') on conflict do nothing`, [ORG, OP])
  const seed = psql(d.url, M('PROPOSED_20261020120100_research_package_schedules.sql'), { owner_id: OP })
  assert.equal(seed.status, 0, seed.out)
  return d
}

async function seedMessagingWorld(pool) {
  const q = (s, p = []) => pool.query(s, p)
  for (const [k, v] of Object.entries(SEND_KEYS)) await q('insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v])
  await q(`insert into public.system_control (key, value) values ('queue_processor_heartbeat_at', now()::text), ('campaign_feeder_heartbeat_at', now()::text), ('followup_no_response_heartbeat_at', now()::text), ('seller_state_reconcile_heartbeat_at', now()::text), ('webhook_delivery_recovery_last_at', now()::text) on conflict (key) do nothing`)
  const threads = (await q(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, seller_stage, contactability_status, disposition, is_archived, updated_at) values
     (gen_random_uuid(), '+15550000201', '+15550000201', $1, 'offer_interest', 'contactable', 'interested', false, now() - interval '20 days'),
     ($2::uuid, '+15550000202', '+15550000202', $3, 'negotiation', 'contactable', 'closed_lost', false, now() - interval '3 days'),
     (gen_random_uuid(), '+15550000203', '+15550000203', $4, 'ownership_confirmation', 'contactable', null, false, now() - interval '2 days'),
     (gen_random_uuid(), '+15550000204', '+15550000204', '2124415663', 'ownership_confirmation', 'opted_out', 'opted_out', false, now() - interval '1 day')
     returning id::text, thread_key`, [PID, HARTFORD_EXCLUSION.thread_id, HARTFORD_EXCLUSION.property_id, MAXWELL_PID])).rows
  await q(`insert into public.message_events (thread_key, direction, detected_intent, is_opt_out, event_timestamp, language) values
     ('+15550000201', 'outbound', null, false, now() - interval '21 days', null),
     ('+15550000201', 'inbound', 'asks_offer', false, now() - interval '20 days', 'English'),
     ('+15550000202', 'inbound', 'price_given', false, now() - interval '3 days', 'English'),
     ('+15550000203', 'inbound', 'ownership_confirmed', false, now() - interval '2 days', 'English'),
     ('+15550000204', 'inbound', 'opt_out', true, now() - interval '1 day', 'English')`)
  await q(`insert into public.acquisition_opportunities (id, dedupe_key, primary_thread_key, primary_property_id, acquisition_stage, opportunity_status, temperature, stage_entered_at, asking_price, updated_at) values
     (gen_random_uuid(), 'pkga-1', '+15550000201', $1, 'offer', 'active', 'hot', now() - interval '20 days', 185000, now() - interval '1 day'),
     ($2::uuid, 'pkga-hartford', '+15550000202', $3, 'negotiation', 'active', 'hot', now() - interval '10 days', 315000, now() - interval '2 days'),
     (gen_random_uuid(), 'pkga-maxwell', '+15550000203', $4, 'ownership', 'active', 'warm', now() - interval '5 days', null, now() - interval '3 days')`,
  [PID, HARTFORD_EXCLUSION.opportunity_id, HARTFORD_EXCLUSION.property_id, MAXWELL_PID])
  // the queue rows the package must never release: paused / held / queued (DUE) / scheduled / approved / pending, plus history
  await q(`insert into public.send_queue (queue_status, scheduled_for, scheduled_for_utc, thread_key, message_type, created_at) values
     ('paused', now() - interval '1 hour', now() - interval '1 hour', '+15550000201', 'follow_up', now() - interval '2 days'),
     ('held', now() - interval '30 minutes', now() - interval '30 minutes', '+15550000202', 'follow_up', now() - interval '2 days'),
     ('queued', now() - interval '5 minutes', now() - interval '5 minutes', '+15550000203', 'campaign', now() - interval '1 day'),
     ('scheduled', now() + interval '1 day', now() + interval '1 day', '+15550000201', 'follow_up', now()),
     ('approved', now() - interval '2 minutes', now() - interval '2 minutes', '+15550000201', 'auto_reply', now()),
     ('pending', now() - interval '2 minutes', now() - interval '2 minutes', '+15550000203', 'auto_reply', now())`)
  await q(`insert into public.send_queue (queue_status, thread_key, sent_at, delivered_at, created_at, provider_message_id) values ('delivered', '+15550000201', now() - interval '21 days', now() - interval '21 days', now() - interval '21 days', 'SMa')`)
  await q(`insert into public.campaigns (name, status, last_transition_at) values ('paused-a', 'paused', now() - interval '3 days'), ('paused-b', 'paused', now() - interval '1 day'), ('scheduled-due', 'scheduled', now() - interval '1 hour'), ('active-c', 'active', now() - interval '2 days'), ('draft-d', 'draft', now())`)
  return threads
}

async function tickUntilIdle(store, handlers, max = 40) {
  const seen = []
  for (let i = 0; i < max; i += 1) {
    const s = await runRuntimeTick({ store, handlers, workerId: 'pkga-w', budgetMs: 30_000 })
    for (const j of s.jobs) seen.push(`${j.kind}:${j.outcome}`)
    if (!s.claimed && !(s.schedules?.enqueued > 0)) break
  }
  return seen
}

test('PACKAGE A arming on the production state: only research / ops kinds arm and run; paused / held / due queue rows, paused campaigns and every send key are untouched; disarm restores the stop', { skip, timeout: 240_000 }, async (t) => {
  const d = await productionStateDb()
  try {
    const threads = await seedMessagingWorld(d.pool)
    const before = await fingerprint(d.pool)
    const limits0 = (await d.pool.query('select runtime_enabled, emergency_stop, emergency_stop_reason, kind_limits from agent.runtime_limits where id = 1')).rows[0]
    assert.deepEqual([limits0.runtime_enabled, limits0.emergency_stop, limits0.emergency_stop_reason, limits0.kind_limits], [false, true, 'pretest', {}], 'starts from the Fix A state')

    // the read-only scripts run against the real shape and write nothing
    for (const f of ['preflight.sql', 'verify.sql', 'monitor.sql']) {
      const r = psql(d.url, OPS(f))
      assert.equal(r.status, 0, `${f}: ${r.out}`)
    }
    assert.deepEqual(await fingerprint(d.pool), before, 'the read-only scripts changed nothing')

    // BEFORE activation: the emergency stop + disabled runtime refuse everything, even an armed-looking enqueue
    const api = d.api
    const store = createRuntimePgStore({ pool: api })
    const pre = await store.enqueueEvent({ kind: 'property.research', event_key: 'pre', input: {} })
    assert.equal(pre.ok, false)

    // STEP 4: activate.sql (psql, the owner path)
    const act = psql(d.url, OPS('activate.sql'), { owner_id: OP })
    assert.equal(act.status, 0, act.out)
    const lim = (await d.pool.query('select runtime_enabled, emergency_stop, emergency_stop_at, kind_limits, event_budget_ceilings, tick_max_jobs, max_concurrency_global from agent.runtime_limits where id = 1')).rows[0]
    assert.equal(lim.runtime_enabled, true)
    assert.equal(lim.emergency_stop, false)
    assert.equal(lim.emergency_stop_at, null)
    assert.deepEqual(Object.keys(lim.kind_limits).sort(), [...RESEARCH_PACKAGE_KINDS].sort(), 'ONLY the Package A kinds are armed')
    for (const [k, v] of Object.entries(lim.kind_limits)) assert.deepEqual(v, { enabled: true, max_concurrency: 1, armed_by: OP, ...(k === 'property.research' ? { event_budget_cap_usd: 0.3 } : {}) }, k)
    assert.deepEqual(lim.event_budget_ceilings, { 'property.research': 0.3 })
    // re-running activate is idempotent; a foreign armed kind makes it refuse (and change nothing)
    assert.equal(psql(d.url, OPS('activate.sql'), { owner_id: OP }).status, 0, 'idempotent')
    // messaging kinds stay refused by the DB
    for (const kind of ['conversation.decide', 'conversation.turn', 'followup.dispatch', 'followup.execution_sweep', 'mission.research', 'acquisition.discovery', 'pipeline.reconcile']) {
      const r = await store.enqueueEvent({ kind, event_key: `x-${kind}`, input: {} })
      assert.deepEqual([r.ok, r.reason], [false, 'kind_not_armed'], kind)
    }
    assert.deepEqual(await fingerprint(d.pool), before, 'activation changed nothing outside agent.*')
    // the owner's one-property enqueue: an armed event job (0.30 cap); the exclusions are refused
    const one = psql(d.url, OPS('enqueue-property.sql'), { property_id: PID, trigger: 'offer_request' })
    assert.equal(one.status, 0, one.out)
    assert.notEqual(psql(d.url, OPS('enqueue-property.sql'), { property_id: MAXWELL_PID, trigger: 'offer_request' }).status, 0, 'Maxwell refused')
    assert.notEqual(psql(d.url, OPS('enqueue-property.sql'), { property_id: PID, trigger: 'send_now' }).status, 0, 'unknown trigger refused')

    // STEP 5: enable every Package A schedule, make them due
    const en = psql(d.url, OPS('enable-schedules.sql'), { names: 'property-research-sweep,valuation-refresh,recovery-sweep,inbox-action-center,ops-supervisor,conversation-review-digest,ops-health-check' })
    assert.equal(en.status, 0, en.out)
    const bad = psql(d.url, OPS('enable-schedules.sql'), { names: 'pipeline-reconcile' })
    assert.notEqual(bad.status, 0, 'a non-package schedule name is refused')
    await d.pool.query(`update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 minute' where enabled`)

    // the REAL handlers (tick route composition) as agent_api; sources read the seeded tables; writes are counted
    const env = { AGENT_ENABLED: '1', AGENT_RUNTIME_ENABLED: '1', PROPERTY_RESEARCH_ENABLED: '1', VALUATION_REFRESH_ENABLED: '1', AGENT_OPERATIONS_ENABLED: '1' }
    const reads = createMissionPgReads({ pool: api })
    const operations = { source: (({ researchValuationSnapshot: _x, ...s }) => s)(createOperationsPgSource({ pool: api })), store: createOperationsPgStore({ pool: api }) }
    const sweepDb = countingClient(d.pool)
    const valDb = countingClient(d.pool)
    const research = memorySource({ inbound: [{ id: 'in-1', body: 'I would take 185000', at: new Date(Date.now() - 20 * 864e5).toISOString() }] })
    const handlers = {
      ...DEFAULT_RUNTIME_HANDLERS,
      ...buildResearchPackageHandlers({
        env, runtimeStore: store, reads, operations,
        sources: {
          research,
          sweep: createPropertyResearchSweepSupabaseSource({ db: sweepDb.client }),
          valuation: { candidates: async () => [{ opportunity_id: 'o1', property_id: PID, stage: 'offer', status: 'active', asking_price: 185000, intents: ['asks_offer'], offers_sent: 0, updated_at: new Date().toISOString() }, { opportunity_id: 'o2', property_id: MAXWELL_PID, stage: 'ownership', status: 'active', intents: [], offers_sent: 0 }] },
          valuationClient: valDb.client,
        },
      }),
    }
    assert.deepEqual(Object.keys(handlers).sort(), [...RESEARCH_PACKAGE_KINDS].sort())
    const seen = await tickUntilIdle(store, handlers)

    const jobs = (await d.pool.query(`select kind, state, budget_cap_usd, input, result, last_error from agent.research_job where runtime_managed order by created_at`)).rows
    assert.ok(jobs.length >= 7, `jobs ran: ${seen.join(', ')}`)
    for (const j of jobs) assert.ok(RESEARCH_PACKAGE_KINDS.includes(j.kind), `only Package A kinds exist: ${j.kind}`)
    for (const kind of ['property.research_sweep', 'valuation.refresh', 'recovery.sweep', 'inbox.action_center', 'ops.supervisor', 'conversation.review_digest', 'ops.health_check']) {
      assert.ok(jobs.some((j) => j.kind === kind && j.state === 'completed'), `${kind} completed: ${JSON.stringify(jobs.filter((j) => j.kind === kind).map((j) => [j.state, j.last_error]))}`)
    }
    const pr = jobs.filter((j) => j.kind === 'property.research')
    assert.ok(pr.some((j) => j.state === 'completed'), `property.research ran: ${JSON.stringify(pr.map((j) => [j.state, j.last_error]))}`)
    for (const j of pr) assert.equal(Number(j.budget_cap_usd), 0.3, 'an event research job carries the armed 0.30 cap')
    for (const j of jobs) if (j.result && 'sends' in j.result) assert.equal(j.result.sends, 0, j.kind)
    // owner exclusions: no research job, no work item, no valuation of Hartford / Maxwell
    const refs = JSON.stringify(pr.map((j) => j.input))
    for (const pid of [MAXWELL_PID, HARTFORD_EXCLUSION.property_id]) assert.ok(!refs.includes(Buffer.from(pid).toString('base64url')) && !refs.includes(pid), `${pid} was never researched`)
    const items = (await d.pool.query(`select subject_id from agent.ops_work_item`)).rows.map((r) => r.subject_id)
    assert.ok(!items.includes(HARTFORD_EXCLUSION.thread_id), 'Hartford raised no operator item')
    const vf = (await d.pool.query(`select value from agent.finding where finding_type = 'valuation.dry_run'`)).rows.map((r) => r.value)
    assert.ok(vf.length >= 1 && vf.every((v) => v.mode === 'dry_run' && (v.writes === 0)), JSON.stringify(vf))
    // operator tasks exist (the action center / recovery / supervisor produced work items) and a brief was written
    assert.ok(items.length >= 1, 'operator work items were created')
    assert.equal((await d.pool.query(`select count(*)::int n from agent.finding where finding_type = 'digest.morning'`)).rows[0].n, 1)

    // THE GUARANTEE: nothing outside agent.* changed, no client write was attempted
    assert.deepEqual(sweepDb.writes, [], 'the sweep source attempted no write')
    assert.deepEqual(valDb.writes.filter((w) => !w.startsWith('rpc:get_comp_candidates') && !w.startsWith('rpc:deal_market_demand') && !w.startsWith('rpc:v3_comp_candidates')), [], 'the valuation dry run attempted no write')
    assert.deepEqual(await fingerprint(d.pool), before, 'send_queue / campaigns / system_control / threads / opportunities / offers / scores / events unchanged')
    const sk = (await d.pool.query(`select jsonb_object_agg(key, value) v from public.system_control where key = any($1)`, [Object.keys(SEND_KEYS)])).rows[0].v
    assert.deepEqual(sk, SEND_KEYS, 'every send key keeps its value')
    assert.equal((await d.pool.query(`select count(*)::int n from public.send_queue where queue_status in ('paused','held','queued','scheduled','approved','pending')`)).rows[0].n, 6, 'no queue row released or cancelled')
    assert.equal((await d.pool.query(`select count(*)::int n from public.campaigns where status = 'paused'`)).rows[0].n, 2, 'paused campaigns stay paused')
    const v = psql(d.url, OPS('verify.sql'))
    assert.equal(v.status, 0, v.out)
    assert.doesNotMatch(v.out, /\|\s*f\s*\|/, `verify.sql: every check ok\n${v.out}`)

    // ROLLBACK: disarm.sql re-engages the stop; the next tick claims nothing
    await d.pool.query(`select agent.runtime_enqueue_event('property.research', 'after', '{"property_ref":"x"}'::jsonb, 120)`).catch(() => null)
    const dis = psql(d.url, OPS('disarm.sql'), { owner_id: OP })
    assert.equal(dis.status, 0, dis.out)
    const lim2 = (await d.pool.query('select runtime_enabled, emergency_stop, kind_limits, event_budget_ceilings from agent.runtime_limits where id = 1')).rows[0]
    assert.deepEqual([lim2.runtime_enabled, lim2.emergency_stop, lim2.kind_limits, lim2.event_budget_ceilings], [false, true, {}, {}])
    assert.equal((await d.pool.query(`select count(*)::int n from agent.runtime_schedule where enabled`)).rows[0].n, 0)
    assert.equal((await d.pool.query(`select count(*)::int n from agent.research_job where runtime_managed and state in ('queued','retrying','claimed','running')`)).rows[0].n, 0, 'pending jobs cancelled')
    const after = await runRuntimeTick({ store, handlers, workerId: 'pkga-w', budgetMs: 10_000 })
    assert.equal(after.blocked, 'runtime_disabled')
    assert.deepEqual(await fingerprint(d.pool), before, 'disarm changed nothing outside agent.*')
    assert.ok(threads.length === 4)
    t.diagnostic(`jobs: ${JSON.stringify(jobs.reduce((a, j) => ({ ...a, [`${j.kind}:${j.state}`]: (a[`${j.kind}:${j.state}`] || 0) + 1 }), {}))}; work items: ${items.length}; valuation findings: ${vf.length}; protected tables fingerprinted: ${PROTECTED.length}`)
  } finally {
    await d.drop()
  }
})

test('PACKAGE A activate.sql refuses (and changes nothing) when a foreign kind is armed or runtime jobs are pending', { skip, timeout: 120_000 }, async () => {
  const d = await productionStateDb()
  try {
    await d.pool.query(`update agent.runtime_limits set kind_limits = $1::jsonb where id = 1`, [JSON.stringify({ 'conversation.decide': { enabled: false, max_concurrency: 1, armed_by: OP } })])
    const snap = async () => (await d.pool.query('select to_jsonb(l) - $1::text[] j from agent.runtime_limits l where id = 1', [['updated_at']])).rows[0].j
    const s0 = await snap()
    const r = psql(d.url, OPS('activate.sql'), { owner_id: OP })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /neither \{\} \(Fix A\) nor the Package A set/)
    assert.deepEqual(await snap(), s0, 'nothing changed')
    await d.pool.query(`update agent.runtime_limits set kind_limits = '{}'::jsonb where id = 1`)
    await d.pool.query(`select agent.runtime_enqueue('ops.supervisor', repeat('a', 64), '{}'::jsonb, $1, 100, 3, 0, false, null)`, [OP])
    const r2 = psql(d.url, OPS('activate.sql'), { owner_id: OP })
    assert.notEqual(r2.status, 0)
    assert.match(r2.out, /runtime jobs are pending/)
    assert.equal((await d.pool.query('select emergency_stop from agent.runtime_limits where id = 1')).rows[0].emergency_stop, true, 'the stop stays engaged')
    const r3 = psql(d.url, OPS('activate.sql'), { owner_id: 'not-a-uuid' })
    assert.notEqual(r3.status, 0)
  } finally {
    await d.drop()
  }
})
