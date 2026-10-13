// Intelligence Command 2.0 (increment B) — PostgreSQL proofs of
// PROPOSED_20261013120000_agent_capabilities.sql and the pg capability store,
// against a DISPOSABLE local PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped —
// reported, never vacuous — without it). The plane runs AS agent_api.
// missions.create runs against the real R2 agent.runtime_enqueue.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createPgCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { createCapabilityPlane } from '../../src/lib/agent/capabilities/index.js'
import { createSession } from '../../src/lib/agent/capabilities/registry.js'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { OP, OTHER, ORG, ORG_B, ENV, IDENTITY, SECRET, makeWorld } from '../helpers/agent-capabilities-fake.mjs'

const skip = pgAvailable() ? false : skipReason
const MIGRATION = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261013120000_agent_capabilities.sql')
const ROLLBACK = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261013120000_agent_capabilities_rollback.sql')
const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  revoke all on public.system_control, public.send_queue from agent_api;`

async function capDb({ runtime = false } = {}) {
  const db = await freshDb()
  if (runtime) {
    await runSqlFile(db.pool, SQL.researchPretest)
    await runSqlFile(db.pool, SQL.research)
    await db.pool.query(PUBLIC_FIXTURE)
    await applyInTransaction(db.pool, SQL.runtime)
  }
  await applyInTransaction(db.pool, MIGRATION)
  await db.pool.query(`insert into agent.org (org_id, name) values ($1, 'Other org') on conflict do nothing`, [ORG_B])
  await db.pool.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test'), ($3, $4, 'owner', 'test')`, [ORG, OP, ORG_B, OTHER])
  return db
}

function pgPlane(db, { world = makeWorld(), runtime = false } = {}) {
  const store = createPgCapabilityStore({ pool: db.api })
  if (runtime) {
    const rt = createRuntimePgStore({ pool: db.api })
    world.services.missions = { enqueue: (o) => rt.enqueue(o), events: (id) => rt.jobEvents(id, { after: 0, limit: 5 }) }
  }
  return { plane: createCapabilityPlane({ env: ENV, store, services: world.services, secret: SECRET }), world, store }
}
const ctx = (extra = {}) => ({ org_id: ORG, identity: IDENTITY, source: 'model', session: createSession(), ...extra })

test('pg: prepare_reply → pending row (no phone / body stored) → approve executes once → replay returns the record', { skip }, async () => {
  const db = await capDb()
  try {
    const { plane, world } = pgPlane(db)
    const f = await plane.invoker.invoke({ capability_id: 'inbox.find_conversations', input: { bucket: 'priority' }, ctx: ctx() })
    const ref = f.result.rows[0].thread_ref
    const r = await plane.invoker.invoke({ capability_id: 'inbox.prepare_reply', input: { thread_ref: ref, template_id: 'tpl_s2_en' }, ctx: ctx() })
    assert.equal(r.status, 'approval_pending', JSON.stringify(r))
    const row = (await db.pool.query('select * from agent.approval_request where approval_id = $1', [r.approval_id])).rows[0]
    assert.equal(row.state, 'pending')
    const raw = JSON.stringify(row)
    assert.ok(!/\+?1?2145550147/.test(raw) && !raw.includes('Would you consider'), 'no phone, no message text in the row')
    world.state.sendResult = { ok: true, queue_status: 'sent', provider_message_id: 'SMx', delivery_status_display: 'sent' }
    const a = (await plane.approvals.get({ org_id: ORG, identity: IDENTITY, approval_id: r.approval_id })).approval
    const [d1, d2] = await Promise.all([
      plane.approvals.decide({ org_id: ORG, identity: IDENTITY, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash }),
      plane.approvals.decide({ org_id: ORG, identity: IDENTITY, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash }),
    ])
    assert.equal(world.called('inbox.sendNow').length, 1, 'exactly one execution across concurrent approvals')
    assert.ok([d1, d2].some((d) => d.ok && !d.replayed))
    const after = (await db.pool.query('select state, decided_by::text, execution_result from agent.approval_request where approval_id = $1', [r.approval_id])).rows[0]
    assert.equal(after.state, 'executed')
    assert.equal(after.decided_by, OP)
    assert.equal(after.execution_result.provider_accepted, true)
    const replay = await plane.approvals.decide({ org_id: ORG, identity: IDENTITY, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash })
    assert.equal(replay.replayed, true)
    assert.equal(world.called('inbox.sendNow').length, 1)
    const audit = (await db.pool.query(`select decision, count(*)::int n from agent.capability_audit group by 1`)).rows
    assert.ok(audit.some((x) => x.decision === 'approval_requested'))
  } finally {
    await db.drop()
  }
})

test('pg: drift refuses; cross-org cannot see or decide; the DB refuses a phone in a target and a direct update', { skip }, async () => {
  const db = await capDb()
  try {
    const { plane, world, store } = pgPlane(db)
    const r = await plane.invoker.invoke({ capability_id: 'campaigns.prepare_launch_approval', input: { campaign_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', start: 'now' }, ctx: ctx() })
    assert.equal(r.status, 'approval_pending')
    const a = (await plane.approvals.get({ org_id: ORG, identity: IDENTITY, approval_id: r.approval_id })).approval
    const outsider = { verified: true, named: true, user_id: OTHER, method: 'test' }
    assert.equal((await plane.approvals.get({ org_id: ORG_B, identity: outsider, approval_id: a.approval_id })).code, 'APPROVAL_NOT_FOUND')
    assert.equal((await plane.approvals.decide({ org_id: ORG_B, identity: outsider, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash })).code, 'APPROVAL_NOT_FOUND')
    world.campaigns.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').status = 'built'
    const d = await plane.approvals.decide({ org_id: ORG, identity: IDENTITY, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash })
    assert.equal(d.code, 'STATE_DRIFTED')
    assert.equal((await db.pool.query('select state from agent.approval_request where approval_id = $1', [a.approval_id])).rows[0].state, 'refused_drift')
    assert.equal(world.called('campaigns.launch').length, 0)
    await assert.rejects(store.insertApproval({ approval_id: 'apr_00000000-0000-4000-8000-000000000001', org_id: ORG, capability_id: 'inbox.prepare_reply', capability_version: 1, tier: 'requires_explicit_approval', requested_by: OP, provenance: 'model', target: { thread_key: '+12145550147' }, intended_change: { action: 'x' }, summary: [], snapshot_hash: 'a'.repeat(64), payload_hash: 'b'.repeat(64), idempotency_key: 'c'.repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: new Date().toISOString() }), /check/i)
    await assert.rejects(db.api.query(`update agent.approval_request set state = 'executed'`), /permission denied/)
    await assert.rejects(db.api.query(`delete from agent.capability_audit`), /permission denied/)
  } finally {
    await db.drop()
  }
})

test('pg: missions.create enqueues through the real agent.runtime_enqueue as agent_api and reads back job.enqueued', { skip }, async () => {
  const db = await capDb({ runtime: true })
  try {
    const { plane } = pgPlane(db, { runtime: true })
    const r = await plane.invoker.invoke({ capability_id: 'missions.create', input: { kind: 'ops.health_check' }, ctx: ctx({ source: 'operator' }) })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.result.state, 'queued')
    assert.equal(r.result.readback.event, 'job.enqueued')
    const job = (await db.pool.query('select requested_by, kind, state from agent.research_job where job_id = $1', [r.result.job_id])).rows[0]
    assert.deepEqual({ ...job }, { requested_by: OP, kind: 'ops.health_check', state: 'queued' })
  } finally {
    await db.drop()
  }
})

test('pg: rollback removes everything and refuses while data exists without the discard switch', { skip }, async () => {
  const db = await capDb()
  try {
    await db.pool.query(`insert into agent.capability_audit (org_id, capability_id, actor, source, decision) values ($1, 'platform.health', $2, 'operator', 'read')`, [ORG, OP])
    const sql = fs.readFileSync(ROLLBACK, 'utf8')
    const c = await db.pool.connect()
    try {
      await assert.rejects(c.query(sql), /refused/)
      await c.query('rollback')
      await c.query(`set agent.rollback_discard_data = 'on'`)
      await c.query(sql)
    } finally {
      c.release()
    }
    const left = (await db.pool.query(`select to_regclass('agent.approval_request') a, to_regclass('agent.capability_audit') b`)).rows[0]
    assert.deepEqual({ ...left }, { a: null, b: null })
  } finally {
    await db.drop()
  }
})
