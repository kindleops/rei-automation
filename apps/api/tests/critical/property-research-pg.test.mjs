// 8.5.20-b property.research — PostgreSQL proof against a DISPOSABLE local PostgreSQL
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). Applies the
// S3 → research → R2 runtime → capabilities → kind-limits fix → persistent missions chain
// and runs the mission AS agent_api through the real agent.runtime_* functions, so the
// DB CHECKs (agent.payload_is_clean on input / progress / checkpoint / result / events /
// findings), the event arming and the leases judge it — not the memory twin.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { buildMissionHandlers, createMissionPgReads, PROPERTY_RESEARCH_KIND } from '../../src/lib/agent/missions/index.js'
import { enqueuePropertyResearch } from '../../src/lib/agent/missions/property-research-triggers.js'
import { decodeFromStore } from '../../src/lib/agent/research/pii.js'
import { OP, ORG } from '../helpers/agent-capabilities-fake.mjs'
import { PID, SECRET_PHONE, SECRET_NAME, memorySource } from '../helpers/property-research-fixtures.mjs'

const skip = pgAvailable() ? false : skipReason
const M = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  revoke all on public.system_control, public.send_queue from agent_api;`

async function db() {
  const d = await freshDb()
  await runSqlFile(d.pool, SQL.researchPretest)
  await runSqlFile(d.pool, SQL.research)
  await d.pool.query(PUBLIC_FIXTURE)
  await applyInTransaction(d.pool, SQL.runtime)
  await applyInTransaction(d.pool, M('PROPOSED_20261013120000_agent_capabilities.sql'))
  await applyInTransaction(d.pool, M('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await applyInTransaction(d.pool, M('PROPOSED_20261014120000_persistent_missions.sql'))
  await d.pool.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test') on conflict do nothing`, [ORG, OP])
  return d
}

test('PG property.research: unarmed ⇒ refused by the DB; armed ⇒ event job runs as agent_api, every finding passes agent.payload_is_clean, nothing contact-shaped stored', { skip }, async () => {
  const d = await db()
  try {
    const store = createRuntimePgStore({ pool: d.api })
    const env = { PROPERTY_RESEARCH_ENABLED: '1' }
    const refused = await enqueuePropertyResearch({ store, env, trigger: 'asking_price_revealed', property_id: PID, discriminator: 'ask:185000' })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /not_armed|kind/)
    await d.pool.query('update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, lease_seconds = 30, backoff_base_seconds = 5, kind_limits = $1::jsonb where id = 1',
      [JSON.stringify({ [PROPERTY_RESEARCH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } })])
    const e = await enqueuePropertyResearch({ store, env, trigger: 'asking_price_revealed', property_id: PID, discriminator: 'ask:185000' })
    assert.ok(e.ok && !e.deduped, JSON.stringify(e))
    const reads = createMissionPgReads({ pool: d.api })
    const source = memorySource({ inbound: [{ id: 'in-1', body: `I'd take 185000, call ${SECRET_PHONE}`, at: '2026-10-14T10:00:00Z' }] })
    const handlers = buildMissionHandlers({ env, runtimeStore: store, reads, propertyResearchSource: source })
    const s = await runRuntimeTick({ store, handlers, workerId: 'pg-w1', budgetMs: 30_000, concurrent: false })
    assert.equal(s.jobs?.[0]?.outcome, 'completed', JSON.stringify(s))
    const job = (await d.pool.query('select state, result, requested_by, trigger_kind from agent.research_job where job_id = $1', [e.job_id])).rows[0]
    assert.equal(job.state, 'completed')
    assert.equal(job.trigger_kind, 'event')
    assert.equal(job.requested_by, OP)
    const fs = (await d.pool.query('select finding_type, value from agent.finding where job_id = $1 order by finding_type', [e.job_id])).rows
    assert.deepEqual(fs.map((f) => f.finding_type), ['property.comps_area', 'property.dossier', 'property.economics', 'property.offer_plan', 'property.research'])
    const raw = JSON.stringify(fs)
    assert.ok(!raw.includes(SECRET_PHONE) && !raw.includes('2145550147') && !raw.includes(SECRET_NAME))
    const plan = JSON.parse(decodeFromStore(fs.find((f) => f.finding_type === 'property.offer_plan').value.payload_v1))
    assert.equal(plan.visibility, 'internal_only')
    assert.ok(plan.opening.recommended < plan.mao.amount)
  } finally {
    await d.drop()
  }
})
