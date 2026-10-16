// 8.5.18 persistent missions — PostgreSQL proofs against a DISPOSABLE local
// PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it).
// Applies S3 → research → R2 runtime → capabilities → PROPOSED_20261014120000_persistent_missions,
// and runs every mission AS agent_api through the real agent.runtime_* functions:
// the DB CHECKs (agent.payload_is_clean on input / progress / checkpoint / result /
// events / findings), the spend guard, the claim concurrency limits and the leases.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createModelResolver } from '../../src/lib/agent/research/models.js'
import { toApiName as researchApi } from '../../src/lib/agent/research/research-tools.js'
import { createPgCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { createCapabilityPlane } from '../../src/lib/agent/capabilities/index.js'
import { buildMissionHandlers, createMissionPgReads, createMissionsService, MISSION_RESEARCH_KIND, MISSION_SUPERVISOR_KIND, DISCOVERY_KIND, REVIEW_DIGEST_KIND } from '../../src/lib/agent/missions/index.js'
import { createDiscoverySqlSource } from '../../src/lib/agent/missions/discovery-source.js'
import { decodeText } from '../../src/lib/agent/missions/mission-codec.js'
import { OP, ORG, ENV as CAP_ENV, SECRET, makeWorld } from '../helpers/agent-capabilities-fake.mjs'
import { fakeDb, fakeServices, makeTables, LISTED_MODELS, toolUse, reply, answer, usage } from '../helpers/agent-research-fake.mjs'

const skip = pgAvailable() ? false : skipReason
const CAPS = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261013120000_agent_capabilities.sql')
const MIG = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261014120000_persistent_missions.sql')
const MIG_PRETEST = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261014120000_persistent_missions_pretest.sql')
const MIG_ROLLBACK = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261014120000_persistent_missions_rollback.sql')
const SCHEDULES = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261014120100_persistent_missions_schedules.sql')
const ENV = Object.freeze({ ...CAP_ENV, AGENT_RESEARCH_ENABLED: '1', AGENT_SPEND_GLOBAL_DAILY_USD: '10', AGENT_SPEND_USER_DAILY_USD: '10', AGENT_SPEND_CYCLE_USD: '150', AGENT_MISSIONS_ENABLED: '1' })
const PID = '2124415662'

const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  create table public.eg_property_facts (property_id text primary key, market text, property_address_state text, zip_code text, asset_type text, property_type text, units_count integer,
    estimated_value numeric, equity_known_pct numeric, equity_percent numeric, ownership_years numeric, is_corporate_owner boolean, out_of_state_owner boolean, tax_delinquent boolean,
    tax_delinquent_year integer, active_lien boolean, is_hot_preforeclosure boolean, rec_has_probate boolean, rec_has_lis_pendens boolean, rec_has_default_notice boolean, rec_has_tax_lien boolean,
    rec_has_judgment boolean, rec_foreclosure_stage text, rec_has_death_record boolean, distress_signal_count integer, signal_labels text[], sms_status text, contact_identity text,
    contact_candidate_phones integer, last_contact_at timestamptz, campaign_count integer, pipeline_stage text, conversation_stage text, scores_aos_score integer, refreshed_at timestamptz,
    owner_name text, person_age integer);
  create index egpf_refreshed_at on public.eg_property_facts (refreshed_at);
  create table public.campaign_target_graph (graph_id text primary key, property_id text, identity_alignment text, sms_eligible boolean, wrong_number boolean, true_post_contact_suppression boolean,
    pending_prior_touch boolean, active_queue_item boolean, last_outbound_at timestamptz, latest_contact_at timestamptz, touch_count integer, canonical_e164 text);
  create table public.probate_status (property_id text primary key, has_death_record boolean, only_deceased_reachable boolean, exclude_targeting boolean, reachable_living_dm boolean);
  create table public.campaign_targets (id bigserial primary key, campaign_id uuid, property_id text, to_phone_number text);
  revoke all on public.system_control, public.send_queue, public.eg_property_facts, public.campaign_target_graph, public.probate_status, public.campaign_targets from agent_api;`

async function missionsDb({ apply = true } = {}) {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await db.pool.query(PUBLIC_FIXTURE)
  await applyInTransaction(db.pool, SQL.runtime)
  await applyInTransaction(db.pool, CAPS)
  if (apply) await applyInTransaction(db.pool, MIG)
  await db.pool.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test') on conflict do nothing`, [ORG, OP])
  await db.pool.query('update agent.research_limits set enabled = true where id = 1')
  return db
}
const arm = (pool, kinds, { global = 4, tickMax = 5 } = {}) => pool.query(
  'update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = $1, tick_max_jobs = $2, lease_seconds = 30, backoff_base_seconds = 5, kind_limits = $3::jsonb where id = 1',
  [global, tickMax, JSON.stringify(Object.fromEntries(Object.entries(kinds).map(([k, n]) => [k, { enabled: true, max_concurrency: n, armed_by: OP }])))])
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

function provider(step) {
  const calls = []
  let inflight = 0
  let peak = 0
  return {
    calls,
    get peak() { return peak },
    async listModels() { return LISTED_MODELS.map((m) => ({ ...m })) },
    async createMessage(body, opts = {}) {
      calls.push(body)
      inflight += 1
      peak = Math.max(peak, inflight)
      try { return await step(body, calls.length, opts) } finally { inflight -= 1 }
    },
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const researchScript = (body) => {
  const last = body.messages[body.messages.length - 1]
  if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) return answer(`Property ${PID} is tax delinquent per campaign_target_graph (2023), last checked 2026-10-11T04:05:02Z. Gaps: no lien detail.`)
  return reply([toolUse(researchApi('eg.distress_signals'), { property_id: PID })])
}

function wire(db, { step = researchScript, world = makeWorld() } = {}) {
  const store = createRuntimePgStore({ pool: db.api })
  world.services.missions = { enqueue: (o) => store.enqueue(o), events: (id) => store.jobEvents(id, { after: 0, limit: 5 }) }
  const plane = createCapabilityPlane({ env: ENV, store: createPgCapabilityStore({ pool: db.api }), services: world.services, secret: SECRET })
  const reads = createMissionPgReads({ pool: db.api })
  const prov = provider(step)
  const resolver = createModelResolver({ provider: prov, env: ENV })
  const tables = makeTables()
  const ro = async (sql, params) => {
    const c = await db.pool.connect()
    try { await c.query('begin read only'); const r = await c.query(sql, params); await c.query('rollback'); return r.rows } finally { c.release() }
  }
  const handlers = buildMissionHandlers({ env: ENV, runtimeStore: store, reads, provider: prov, resolver, getPlane: async () => plane, createServices: () => fakeServices(fakeDb(tables)), discoverySource: createDiscoverySqlSource({ query: ro }) })
  const service = createMissionsService({ runtimeStore: store, reads, getPlane: async () => plane })
  const tick = (o = {}) => runRuntimeTick({ store, handlers, workerId: 'pg-w1', budgetMs: 30_000, concurrent: true, ...o })
  return { store, plane, reads, prov, handlers, service, tick, world }
}
const IDENT = Object.freeze({ verified: true, named: true, user_id: OP, method: 'test' })

function psql(url, args) {
  const r = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' })
  if (r.error) return { skipped: true }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

test('PG missions migration: pretest passes and rolls back; kind max_concurrency 3 accepted only after apply; rollback restores the R2 rule and refuses while a kind uses 3', { skip }, async () => {
  const db = await missionsDb({ apply: false })
  try {
    const three = { [MISSION_RESEARCH_KIND]: { enabled: true, max_concurrency: 3, armed_by: OP } }
    await assert.rejects(db.pool.query('update agent.runtime_limits set kind_limits = $1::jsonb where id = 1', [JSON.stringify(three)]), /runtime_limits_kind_limits_valid/)
    const p = psql(db.url, ['-v', `migration=${MIG}`, '-f', MIG_PRETEST])
    if (!p.skipped) { assert.equal(p.status, 0, p.out); assert.match(p.out, /ALL OK \(rolled back\)/) }
    await applyInTransaction(db.pool, MIG)
    await db.pool.query('update agent.runtime_limits set kind_limits = $1::jsonb where id = 1', [JSON.stringify(three)])
    await assert.rejects(runSqlFile(db.pool, MIG_ROLLBACK), /max_concurrency 3/)
    await db.pool.query(`update agent.runtime_limits set kind_limits = '{}'::jsonb where id = 1`)
    await runSqlFile(db.pool, MIG_ROLLBACK)
    await assert.rejects(db.pool.query('update agent.runtime_limits set kind_limits = $1::jsonb where id = 1', [JSON.stringify(three)]), /runtime_limits_kind_limits_valid/)
    assert.equal((await sel(db.pool, "select to_regclass('agent.research_job_requested_recent_idx') r"))[0].r, null)
    // the schedules seed: three schedules, all disabled
    await applyInTransaction(db.pool, MIG)
    const s = psql(db.url, ['-v', `owner_id=${OP}`, '-f', SCHEDULES])
    if (!s.skipped) {
      assert.equal(s.status, 0, s.out)
      const rows = await sel(db.pool, 'select name, kind, enabled, interval_seconds from agent.runtime_schedule order by name')
      assert.deepEqual(rows.map((r) => [r.name, r.kind, r.enabled, r.interval_seconds]), [['acquisition-discovery', 'acquisition.discovery', false, 21600], ['conversation-review-digest', 'conversation.review_digest', false, 86400], ['ops-health-check', 'ops.health_check', false, 900]])
    }
  } finally { await db.drop() }
})

test('PG mission.research as agent_api: missions.create → runtime_enqueue; every stored payload passes agent.payload_is_clean; crash after the ask (lease expiry) resumes without a second model call or reserve; findings once', { skip }, async () => {
  const db = await missionsDb()
  try {
    await arm(db.pool, { [MISSION_RESEARCH_KIND]: 3 })
    const w = wire(db)
    const c = await w.service.create({ identity: IDENT, body: { kind: 'mission.research', question: `Research the distress evidence for property ${PID} (call 214-555-0147 is NOT a property).`, context: { property_ids: [PID] }, budget_usd: 0.5 } })
    assert.ok(c.ok, JSON.stringify(c))
    const id = c.mission_id
    const row = (await sel(db.pool, 'select input, budget_cap_usd, requested_by from agent.research_job where job_id = $1', [id]))[0]
    assert.ok(!JSON.stringify(row.input).includes(PID) && !JSON.stringify(row.input).includes('0147'), 'no raw id, the phone masked')
    assert.match(decodeText(row.input.question_v1), /2124415662/)
    assert.equal(Number(row.budget_cap_usd), 0.5)
    // crash: the process dies right after the ask.done checkpoint commits
    let dead = false
    // (the pg store is frozen: wrap its methods in a plain object instead of a Proxy)
    const dying = Object.fromEntries(Object.entries(w.store).map(([k, v]) => [k, typeof v !== 'function' ? v : (...a) => {
      if (dead) return Promise.reject(Object.assign(new Error('gone'), { code: 'AGENT_RUNTIME_DB_UNAVAILABLE' }))
      const r = v(...a)
      if (k === 'checkpoint' && a[0]?.event_payload?.step === 'ask.done') return r.then((x) => { dead = true; return x })
      return r
    }]))
    const s0 = await w.tick({ store: dying })
    assert.equal((await sel(db.pool, 'select state from agent.research_job where job_id = $1', [id]))[0].state, 'running', JSON.stringify(s0))
    assert.equal(w.prov.calls.length, 2)
    const led1 = await sel(db.pool, 'select state from agent.spend_ledger where job_id = $1', [id])
    assert.equal(led1.length, 2)
    await db.pool.query("update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where job_id = $1", [id]) // the lease runs out
    await w.tick() // reaper → retrying
    await db.pool.query('update agent.research_job set next_attempt_at = clock_timestamp() where job_id = $1', [id]) // the backoff passes
    const s = await w.tick()
    assert.equal(s.jobs.find((j) => j.job_id === id)?.outcome, 'completed', JSON.stringify(s))
    assert.equal(w.prov.calls.length, 2, 'no second model call')
    assert.equal((await sel(db.pool, 'select count(*)::int n from agent.spend_ledger where job_id = $1', [id]))[0].n, 2, 'no second reserve')
    const j = (await sel(db.pool, `select state, result, checkpoint, progress, agent.payload_is_clean(result) rc, agent.payload_is_clean(checkpoint) cc from agent.research_job where job_id = $1`, [id]))[0]
    assert.deepEqual([j.state, j.rc, j.cc], ['completed', true, true])
    assert.match(decodeText(j.result.answer_v1), /2124415662 is tax delinquent/)
    const f = await sel(db.pool, 'select finding_type, key, value, actor_user_id, agent.payload_is_clean(value) clean from agent.finding where job_id = $1 order by finding_type, key', [id])
    assert.deepEqual(f.map((x) => `${x.finding_type}:${x.key}`), ['mission.answer:answer', `mission.property_evidence:property.pid_${PID.split('').map((d) => 'ghijklmnop'[d]).join('')}`])
    assert.ok(f.every((x) => x.clean && x.actor_user_id === OP))
    const evClean = await sel(db.pool, 'select bool_and(agent.payload_is_clean(payload)) ok, count(*)::int n from agent.job_event where job_id = $1', [id])
    assert.ok(evClean[0].ok && evClean[0].n > 8)
    // the API read model over agent_api
    const g = await w.service.get({ identity: IDENT, mission_id: id })
    assert.equal(g.mission.state, 'completed')
    assert.equal(g.mission.cost.model_calls, 2)
    assert.ok(g.mission.cost.committed_usd > 0)
    assert.equal((await w.service.list({ identity: IDENT })).missions[0].mission_id, id)
  } finally { await db.drop() }
})

test('PG budget_blocked through the real spend guard (a mission cap below one reserve)', { skip }, async () => {
  const db = await missionsDb()
  try {
    await arm(db.pool, { [MISSION_RESEARCH_KIND]: 1 })
    const w = wire(db)
    const { researchMissionInput } = await import('../../src/lib/agent/capabilities/defs/platform.js')
    const c = { mission_id: (await w.store.enqueue({ kind: MISSION_RESEARCH_KIND, idempotency_key: 'b'.repeat(64), input: researchMissionInput({ kind: MISSION_RESEARCH_KIND, question: 'Research distress evidence across the Dallas audience.' }), requested_by: OP, budget_cap_usd: 0.0001 })).job_id }
    const s = await w.tick()
    assert.equal(s.jobs[0].outcome, 'budget_blocked', JSON.stringify(s))
    const j = (await sel(db.pool, 'select state, last_error from agent.research_job where job_id = $1', [c.mission_id]))[0]
    assert.equal(j.state, 'budget_blocked')
    assert.match(j.last_error.code, /^AGENT_SPEND_CAP_(JOB|RUN)$/)
    assert.equal(w.prov.calls.length, 0)
  } finally { await db.drop() }
})

test('PG mission.supervisor: the real runtime_claim grants 3 concurrent sub-missions (kind max 3 after the migration); consolidated result; total cost from the ledger', { skip }, async () => {
  const db = await missionsDb()
  try {
    await arm(db.pool, { [MISSION_RESEARCH_KIND]: 3, [MISSION_SUPERVISOR_KIND]: 1 })
    const w = wire(db, { step: async (body) => (JSON.stringify(body.system || '').includes('consolidate') ? answer('Consolidated across 3 markets.') : (await sleep(800), answer(`Sub-answer ${body.messages[0].content.slice(-30)}`))) })
    const c = await w.service.create({ identity: IDENT, body: { kind: 'mission.supervisor', question: 'Compare acquisition evidence across three markets.', sub_questions: ['Dallas evidence.', 'Minneapolis evidence.', 'Houston evidence.'], per_mission_budget_usd: 0.3 } })
    await w.tick()
    await db.pool.query("update agent.research_job set next_attempt_at = clock_timestamp() where kind = 'mission.supervisor'")
    await w.tick()
    assert.equal(w.prov.peak, 3, 'three sub-missions in flight at once')
    await db.pool.query("update agent.research_job set next_attempt_at = clock_timestamp() where kind = 'mission.supervisor'")
    await w.tick()
    const sup = (await sel(db.pool, 'select state, result from agent.research_job where job_id = $1', [c.mission_id]))[0]
    assert.equal(sup.state, 'completed', JSON.stringify(sup))
    assert.equal(sup.result.children.length, 3)
    assert.equal(sup.result.method, 'model')
    const kids = await sel(db.pool, "select budget_cap_usd, requested_by, state from agent.research_job where kind = 'mission.research'")
    assert.ok(kids.every((k) => Number(k.budget_cap_usd) === 0.3 && k.requested_by === OP && k.state === 'completed'))
    const total = (await sel(db.pool, 'select sum(agent.spend_committed(state, reserved_usd, actual_usd))::float8 t from agent.spend_ledger'))[0].t
    assert.ok(Math.abs(total - sup.result.total_cost_usd) < 1e-6)
  } finally { await db.drop() }
})

test('PG acquisition.discovery: SQL source (read-only) → screen → one rank call → findings with evidence (CHECK-clean) → a NEW draft + a pending launch approval row; the schedule watermark advances', { skip }, async () => {
  const db = await missionsDb()
  try {
    await db.pool.query(`insert into public.eg_property_facts (property_id, market, asset_type, units_count, estimated_value, equity_known_pct, ownership_years, tax_delinquent, rec_has_death_record, rec_has_probate, signal_labels, sms_status, contact_identity, last_contact_at, campaign_count, scores_aos_score, refreshed_at, owner_name, person_age) values
      ('300000001', 'Dallas, TX', 'sfr', 1, 185000, 55, 21, true, false, false, '{Tax Delinquent}', 'eligible', 'verified', null, 0, 70, '2026-10-11T04:05:02Z', 'Jane Q Testowner', 71),
      ('300000002', 'Dallas, TX', 'sfr', 1, 185000, 55, 21, true, false, false, '{}', 'suppressed', 'verified', null, 0, 70, '2026-10-11T04:05:02Z', 'X', 50),
      ('300000003', 'Dallas, TX', 'sfr', 1, 185000, 55, 21, true, true, true, '{}', 'eligible', 'verified', null, 0, 70, '2026-10-11T04:05:02Z', 'X', 50),
      ('300000004', 'Dallas, TX', 'sfr', 1, 185000, 55, 21, true, false, false, '{}', 'eligible', 'verified', now(), 1, 70, '2026-10-11T04:05:02Z', 'X', 50)`)
    await db.pool.query(`insert into public.campaign_target_graph (graph_id, property_id, identity_alignment, sms_eligible, wrong_number, true_post_contact_suppression, pending_prior_touch, active_queue_item, touch_count, canonical_e164)
      select 'g' || property_id, property_id, 'verified', true, false, property_id = '300000002', false, false, 0, '+12145550147' from public.eg_property_facts`)
    await db.pool.query(`insert into public.probate_status values ('300000003', true, true, true, false)`)
    await arm(db.pool, { [DISCOVERY_KIND]: 1 })
    const w = wire(db, { step: (body) => answer(JSON.stringify({ ranking: JSON.parse(body.messages[0].content).candidates.map((c) => ({ c: c.c, score: 77, why: ['tax_delinquent'] })) }), usage(600, 80)) })
    const sc = (await sel(db.pool, `select agent.runtime_upsert_schedule('acquisition-discovery', $1, 21600, $2, '{"scan_limit": 50, "rank_top_n": 10}'::jsonb, true, null, 0.25) r`, [DISCOVERY_KIND, OP]))[0].r
    const s = await w.tick()
    const jr = s.jobs[0]
    assert.equal(jr.outcome, 'completed', JSON.stringify(s))
    const j = (await sel(db.pool, 'select result, agent.payload_is_clean(result) rc, agent.payload_is_clean(checkpoint) cc from agent.research_job where job_id = $1', [jr.job_id]))[0]
    assert.ok(j.rc && j.cc)
    assert.deepEqual([j.result.scanned, j.result.screened], [4, 1])
    // one property may fail several rules (a suppressed contact is also not a usable verified contact)
    assert.deepEqual(j.result.excluded, { no_verified_contact: 1, suppressed: 1, deceased_only_or_unverified: 1, prior_touch: 1, no_credible_evidence: 0, already_surfaced: 0 })
    assert.equal(w.prov.calls.length, 1)
    assert.ok(!JSON.stringify(w.prov.calls[0]).includes('300000001') && !JSON.stringify(w.prov.calls[0]).includes('Testowner'))
    const f = await sel(db.pool, `select finding_type, value, agent.payload_is_clean(value) clean from agent.finding where job_id = $1 and finding_type = 'discovery.candidate'`, [jr.job_id])
    assert.equal(f.length, 1)
    assert.ok(f[0].clean && f[0].value.evidence.length >= 4 && f[0].value.model_score === 77)
    assert.equal(j.result.draft.status, 'draft')
    const apr = await sel(db.pool, 'select state, capability_id from agent.approval_request where approval_id = $1', [j.result.draft.approval.approval_id])
    assert.deepEqual(apr, [{ state: 'pending', capability_id: 'campaigns.prepare_launch_approval' }])
    assert.equal(w.world.called('campaigns.launch').length, 0)
    const wm = (await sel(db.pool, 'select watermark from agent.runtime_schedule where schedule_id = $1', [sc.schedule_id]))[0].watermark
    assert.equal(wm.pass_done, true)
    assert.equal(wm.generation, '2026-10-11T04:05:02.000Z')
    // the read model (agent_api) sees the discovery finding for the de-dupe
    const keys = await w.reads.recentFindingKeys({ finding_type: 'discovery.candidate', keys: [`property.pid_${'300000001'.split('').map((d) => 'ghijklmnop'[d]).join('')}`], since: '2026-01-01T00:00:00Z' })
    assert.equal(keys.size, 1)
  } finally { await db.drop() }
})

test('PG conversation.review_digest + the read model as agent_api: digest finding (CHECK-clean) counts completed missions, findings and pending approvals', { skip }, async () => {
  const db = await missionsDb()
  try {
    await arm(db.pool, { [MISSION_RESEARCH_KIND]: 1, [REVIEW_DIGEST_KIND]: 1 })
    const w = wire(db)
    await w.service.create({ identity: IDENT, body: { kind: 'mission.research', question: `Research distress evidence for property ${PID}.`, context: { property_ids: [PID] } } })
    await w.tick()
    await w.plane.invoker.invoke({ capability_id: 'campaigns.prepare_launch_approval', input: { campaign_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', start: 'now' }, ctx: { org_id: ORG, identity: IDENT, source: 'operator', session: { tainted: false } } })
    await w.store.enqueue({ kind: REVIEW_DIGEST_KIND, idempotency_key: 'f'.repeat(64), input: { window_hours: 24 }, requested_by: OP })
    await w.tick()
    const d = (await sel(db.pool, `select f.value, agent.payload_is_clean(f.value) clean from agent.finding f join agent.research_job j on j.job_id = f.job_id where j.kind = $1`, [REVIEW_DIGEST_KIND]))[0]
    assert.ok(d.clean)
    assert.equal(d.value.missions.completed, 1)
    assert.equal(d.value.approvals_waiting.total, 1)
    assert.ok(d.value.findings.by_type['mission.answer'] >= 1)
    // the agent_api read model never needs a write grant
    const priv = await sel(db.api, "select has_table_privilege('agent_api', 'agent.research_job', 'UPDATE') u, has_table_privilege('agent_api', 'agent.finding', 'SELECT') s")
    assert.equal(priv[0].s, true)
  } finally { await db.drop() }
})

