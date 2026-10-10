// Agent S3 — durable Postgres persistence against a DISPOSABLE PostgreSQL 17.
// Skips (reported, never vacuous) unless AGENT_PG_TEST_DB_URL points at a
// local scratch server. CI: .github/workflows/agent-s3-persistence.yml.
//
// Covers: migration apply + rollback round-trip; full Quick Scan through the
// SAME runtime on the pg store; reopen → identical replay; concurrent writers
// (separate pools) → gapless global cursor + per-run seq, no dupes; idempotent
// retry + duplicate prevention; lease-based resume after a killed worker;
// cancel; RLS (own org / owner all / anon nothing / no writes); sanitizer
// CHECKs; append-only; S3 structural $0; retention + delete-on-request.
import test from 'node:test'
import pg from 'pg'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason, freshDb, runSqlFile, asRole, SQL } from '../pg/agent-pg-harness.mjs'
import { multiDb, FIXTURE_PII, killableStore } from '../helpers/agent-s3-fake-db.mjs'
import { createPgAgentStore, DEFAULT_ORG_ID, decodePropertyIds } from '../../src/lib/agent/runtime/pg-store.js'
import { createLiveAgent } from '../../src/lib/agent/live/live-agent.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'
import { createRunService } from '../../src/lib/agent/runtime/run-service.js'
import { appendEventTx } from '../../src/lib/agent/runtime/event-log.js'
import { getEntityGraphDossier } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import * as R from '../../src/lib/agent/live/live-routes.js'
import { ensureMutationAuth } from '../../src/app/api/cockpit/_shared.js'
import { authHeaders, gateB } from '../helpers/agent-test-identity.mjs'

const SCAN_OPERATOR = '11111111-1111-4111-8111-111111111111'
const GB = gateB({ allow: [SCAN_OPERATOR] }) // Gate B: routes verify the operator's own session

const ON = pgAvailable()
const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const t = (name, fn) => test(name, { skip: ON ? false : skipReason }, fn)
const IDS = ['9000000001', '9000000002', '9000000003']
const ORG_B = '00000000-0000-4000-8000-00000000b002'

async function pgAgent(pool, { impl = {}, leaseTtlMs = 15_000, org_id } = {}) {
  const raw = createPgAgentStore({ pool, ...(org_id ? { org_id } : {}) })
  await raw.open()
  const store = killableStore(raw)
  const db = multiDb(IDS)
  const agent = createLiveAgent({ env: { AGENT_MAX_MODE: 'read' }, store, leaseTtlMs, createServices: () => createQuickScanServices({ db, impl }) })
  return agent
}

async function scan(agent, ids = IDS) {
  const pf = await agent.quickScan.preflight({ operator_id: '11111111-1111-4111-8111-111111111111', property_ids: ids })
  const c = await agent.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: '11111111-1111-4111-8111-111111111111' })
  return { pf, c }
}

const dbEvents = async (pool, run_id) => (await pool.query('select event_id, seq, type, task_id, attempt, payload from agent.run_event where run_id = $1 order by event_id', [run_id])).rows

t('migration: pretest → apply → rollback (empty) → re-apply → rollback refused with data → override → pretest passes again', async () => {
  const d = await freshDb({ apply: false })
  try {
    await runSqlFile(d.pool, SQL.pretest)
    await runSqlFile(d.pool, SQL.migration)
    await assert.rejects(runSqlFile(d.pool, SQL.pretest), /already exist/)
    const tables = (await d.pool.query("select tablename from pg_tables where schemaname = 'agent' order by 1")).rows.map((r) => r.tablename)
    assert.deepEqual(tables, ['deletion_log', 'finding', 'finding_conflict', 'operator_membership', 'org', 'public_execute_revoked', 'research_job', 'research_task', 'retention_policy', 'run', 'run_event', 'runtime_limits', 'store_head', 'tool_call'])
    const rls = (await d.pool.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relkind = 'r' and not c.relrowsecurity")).rows
    assert.deepEqual(rls, [], 'RLS on for every agent table')
    await runSqlFile(d.pool, SQL.rollback)
    assert.equal((await d.pool.query("select count(*)::int n from pg_namespace where nspname = 'agent'")).rows[0].n, 0)
    await runSqlFile(d.pool, SQL.pretest)
    await runSqlFile(d.pool, SQL.migration)
    const agent = await pgAgent(await d.enableApi())
    const { c } = await scan(agent, IDS.slice(0, 1))
    await c.done
    await assert.rejects(runSqlFile(d.pool, SQL.rollback), /persisted run/)
    await d.pool.query("insert into public.idempotency_ledger (scope, key) values ('other.scope', 'keep-me')")
    const client = await d.pool.connect()
    try {
      await client.query("set agent.rollback_discard_data = 'on'")
      await client.query((await import('node:fs')).readFileSync(SQL.rollback, 'utf8'))
    } finally { client.release() }
    assert.equal((await d.pool.query("select count(*)::int n from pg_namespace where nspname = 'agent'")).rows[0].n, 0)
    assert.equal((await d.pool.query("select count(*)::int n from public.idempotency_ledger where scope = 'other.scope'")).rows[0].n, 1, 'rollback touches nothing outside agent.* / scope agent.tool')
    await runSqlFile(d.pool, SQL.pretest)
  } finally { await d.drop() }
})

t('a full Quick Scan persists through the same runtime; a reopened store replays identically; DB rows obey every invariant', async () => {
  const d = await freshDb()
  try {
    const a = await pgAgent(d.api)
    const { pf, c } = await scan(a)
    assert.equal((await c.done).state, 'completed')
    const mem = a.store.read().events.filter((e) => e.run_id === pf.run_id)
    const rows = await dbEvents(d.pool, pf.run_id)
    assert.equal(rows.length, mem.length)
    rows.forEach((r, i) => { assert.equal(Number(r.event_id), mem[i].event_id); assert.equal(r.seq, i + 1); assert.deepEqual(decodePropertyIds(r.payload), mem[i].payload) })
    // property ids never sit raw in jsonb (they are indistinguishable from phones)
    assert.equal((await d.pool.query("select count(*)::int n from agent.run_event where payload::text ~ '9000000001'")).rows[0].n, 0)
    assert.ok(rows.some((r) => JSON.stringify(r.payload).includes('pid_pggggggggh')))
    const head = (await d.pool.query('select generation, event_id from agent.store_head')).rows[0]
    assert.equal(Number(head.event_id), mem[mem.length - 1].event_id)
    const run = (await d.pool.query('select state, depth, budget_cap_usd, accrued_usd, ended_at, lease_owner, last_seq from agent.run where run_id = $1', [pf.run_id])).rows[0]
    assert.deepEqual([run.state, run.depth, Number(run.budget_cap_usd), Number(run.accrued_usd), Boolean(run.ended_at), run.lease_owner, run.last_seq], ['completed', 'quick', 0, 0, true, null, mem.length])
    const counts = (await d.pool.query('select (select count(*) from agent.research_task where run_id = $1)::int tasks, (select count(*) from agent.finding where run_id = $1)::int findings, (select count(*) from agent.tool_call where run_id = $1)::int calls, (select count(*) from agent.finding_conflict where run_id = $1)::int conflicts', [pf.run_id])).rows[0]
    assert.equal(counts.tasks, 27)
    assert.equal(counts.calls, 27)
    assert.ok(counts.findings > 40 && counts.conflicts >= 3)
    const dump = JSON.stringify((await d.pool.query("select json_agg(t) j from (select doc from agent.finding union all select doc from agent.research_task union all select payload from agent.run_event) t")).rows[0].j)
    for (const pii of [FIXTURE_PII.ownerName, FIXTURE_PII.prospectName, FIXTURE_PII.phoneDigits, FIXTURE_PII.email, 'SECRETKEY123']) assert.ok(!dump.includes(pii), `db leaked ${pii}`)
    // one task per property × tool: a duplicate task row is refused
    await assert.rejects(d.pool.query("insert into agent.research_task (task_id, job_id, run_id, org_id, property_id, tool, finding_type, state, attempt, gen, doc) select 'rtask_dupe', job_id, run_id, org_id, property_id, tool, finding_type, 'planned', 1, 0, '{}' from agent.research_task where run_id = $1 limit 1", [pf.run_id]), (e) => e.code === '23505')
    // restart: a new process opens the store
    const b = await pgAgent(d.api)
    await b.store.hydrateRun(pf.run_id)
    assert.deepEqual(b.store.read().events.filter((e) => e.run_id === pf.run_id), mem)
    assert.deepEqual(b.quickScan.snapshot(pf.run_id).view, a.quickScan.snapshot(pf.run_id).view)
    assert.equal(b.quickScan.snapshot(pf.run_id).findings.length, a.quickScan.snapshot(pf.run_id).findings.length)
    for (const size of [1, 13, 500]) {
      let cursor = 0
      const got = []
      for (;;) { const p = b.eventLog.replay({ run_id: pf.run_id, after: cursor, limit: size }); if (!p.events.length) break; got.push(...p.events); cursor = p.cursor }
      assert.deepEqual(got, mem, `page ${size}`)
    }
  } finally { await d.drop() }
})

t('concurrent writers (8 processes, separate pools): one global gapless cursor, gapless per-run seq, no duplicates, all converge', async () => {
  const d = await freshDb()
  try {
    const stores = []
    for (let i = 0; i < 8; i += 1) { const s = createPgAgentStore({ pool: d.newPool(2) }); await s.open(); stores.push(s) }
    const runs = stores.map((s) => createRunService({ store: s }))
    const shared = await runs[0].createRun({ kind: 'task', operator_id: 'op', title: 'shared' })
    const own = await Promise.all(runs.map((r, i) => r.createRun({ kind: 'research', depth: 'quick', operator_id: `op${i}`, property_count: 1 })))
    await Promise.all(stores.map((s, i) => (async () => {
      for (let k = 0; k < 15; k += 1) {
        await s.transaction((tx) => {
          appendEventTx(tx, { run_id: shared.id, type: 'decision', payload: { summary: `w${i}-${k}`, criterion: 'concurrency' } })
          appendEventTx(tx, { run_id: own[i].id, type: 'decision', payload: { summary: `own${i}-${k}`, criterion: 'concurrency' } })
        })
      }
    })()))
    const all = (await d.pool.query('select event_id, run_id, seq from agent.run_event order by event_id')).rows
    all.forEach((r, i) => assert.equal(Number(r.event_id), i + 1, 'global cursor gapless'))
    const byRun = new Map()
    for (const r of all) { if (!byRun.has(r.run_id)) byRun.set(r.run_id, []); byRun.get(r.run_id).push(r.seq) }
    for (const [rid, seqs] of byRun) seqs.forEach((s, i) => assert.equal(s, i + 1, `run ${rid} seq gapless`))
    assert.equal(byRun.get(shared.id).length, 1 + 8 * 15)
    for (const s of stores) await s.refresh()
    const views = stores.map((s) => s.read().events.filter((e) => e.run_id === shared.id))
    for (const v of views) assert.deepEqual(v, views[0], 'every process converges on the same stream')
    assert.equal(views[0].length, 1 + 8 * 15)
  } finally { await d.drop() }
})

t('idempotent retry: a failed transaction leaves DB + memory unchanged; retry succeeds once; duplicate task events and tool keys are prevented', async () => {
  const d = await freshDb()
  try {
    const s = createPgAgentStore({ pool: d.api })
    await s.open()
    const runs = createRunService({ store: s })
    const r = await runs.createRun({ kind: 'research', depth: 'quick', operator_id: 'op', property_count: 1 })
    const before = (await d.pool.query('select count(*)::int n from agent.run_event')).rows[0].n
    const memBefore = s.read().events.length
    await assert.rejects(s.transaction((tx) => { appendEventTx(tx, { run_id: r.id, type: 'decision', payload: { summary: 'x' } }); throw new Error('worker died mid-transaction') }), /worker died/)
    assert.equal((await d.pool.query('select count(*)::int n from agent.run_event')).rows[0].n, before)
    assert.equal(s.read().events.length, memBefore)
    // task-scoped event: the runtime dedupes on (run, task, type, attempt) and so does the DB
    const send = () => s.transaction((tx) => appendEventTx(tx, { run_id: r.id, task_id: 'rtask_dup', type: 'task.completed', payload: { duration_ms: 1, cost_usd: 0 } }))
    assert.equal((await send()).duplicate, false)
    assert.equal((await send()).duplicate, true)
    assert.equal((await d.pool.query("select count(*)::int n from agent.run_event where task_id = 'rtask_dup'")).rows[0].n, 1)
    await assert.rejects(d.pool.query("insert into agent.run_event (event_id, run_id, org_id, seq, type, at, task_id, actor_user_id, payload) select 999, $1, $2, (select max(seq)+1 from agent.run_event where run_id = $1), 'task.completed', now(), 'rtask_dup', 'op', '{}'", [r.id, DEFAULT_ORG_ID]), /run_event_task_attempt_uq|duplicate key/)
    // tool idempotency persists in the REUSED public.idempotency_ledger (scope agent.tool)
    await s.transaction((tx) => { tx.idempotency.set('agent.tool:k1', { tool_call_id: 'tc_x', state: 'succeeded' }) })
    const led = (await d.pool.query("select status, metadata from public.idempotency_ledger where scope = 'agent.tool' and key = 'k1'")).rows[0]
    assert.equal(led.status, 'completed')
    const s2 = createPgAgentStore({ pool: d.api })
    await s2.open()
    assert.deepEqual(s2.read().idempotency.get('agent.tool:k1'), { tool_call_id: 'tc_x', state: 'succeeded' })
  } finally { await d.drop() }
})

t('lease-based resume: a worker killed mid-scan is taken over after its lease expires; interrupted read re-runs as attempt 2; no duplicates', async () => {
  const d = await freshDb()
  try {
    let hang = true
    const impl = { getEntityGraphDossier: async (kind, id, deps) => { if (hang && id === '9000000002') await new Promise(() => {}); return getEntityGraphDossier(kind, id, deps) } }
    const a = await pgAgent(d.newPool(4), { impl, leaseTtlMs: 300 })
    const { pf } = await scan(a)
    for (let i = 0; i < 400; i += 1) {
      const n = (await d.pool.query("select count(*)::int n from agent.run_event where run_id = $1 and type = 'task.started' and property_id = '9000000002'", [pf.run_id])).rows[0].n
      if (n) break
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 150))
    a.store.kill() // SIGKILL worker A: no more heartbeats or writes
    hang = false
    const b = await pgAgent(d.newPool(4), { impl, leaseTtlMs: 300 })
    const first = await b.quickScan.recover()
    // a live lease is never stolen: the job is resumed now or deferred until A's lease expires
    assert.deepEqual([...first, ...first.deferred], [pf.job_id])
    for (let i = 0; i < 600; i += 1) {
      const st = (await d.pool.query('select state from agent.run where run_id = $1', [pf.run_id])).rows[0].state
      if (['completed', 'completed_partial'].includes(st)) break
      await new Promise((r) => setTimeout(r, 20))
    }
    await b.quickScan.idle()
    const rows = await dbEvents(d.pool, pf.run_id)
    rows.forEach((r, i) => assert.equal(r.seq, i + 1))
    const k = rows.filter((r) => r.task_id && /^(task|source|observation)\./.test(r.type)).map((r) => `${r.task_id}|${r.type}|${r.attempt}`)
    assert.equal(new Set(k).size, k.length)
    const intr = rows.find((r) => r.type === 'task.unavailable' && r.payload.reason === 'interrupted_by_restart')
    assert.ok(intr)
    assert.ok(rows.some((r) => r.type === 'task.started' && r.task_id === intr.task_id && r.attempt === 2), JSON.stringify(rows.filter((r) => r.task_id === intr.task_id).map((r) => [r.type, r.attempt, r.seq])))
    assert.equal(rows.filter((r) => r.type === 'run.completed').length, 1)
    assert.equal((await d.pool.query('select lease_owner from agent.run where run_id = $1', [pf.run_id])).rows[0].lease_owner, null)
  } finally { await d.drop() }
})

t('multi-instance: instance A runs the scan, instance B serves the live routes (snapshot + cursor events) from Postgres', async () => {
  const d = await freshDb()
  try {
    const a = await pgAgent(d.newPool(4))
    const b = await pgAgent(d.newPool(4))
    const { pf, c } = await scan(a, IDS.slice(0, 2))
    await c.done
    const env = { AGENT_LIVE_ROUTES: '1', AGENT_MAX_MODE: 'read', NODE_ENV: 'development' }
    const H = authHeaders(SCAN_OPERATOR)
    const o = { env, auth: ensureMutationAuth, ...GB, agent: b, params: { run_id: pf.run_id } }
    const snap = await (await R.handleLiveRunSnapshot(new Request(`http://x/runs/${pf.run_id}`, { headers: H }), o)).json()
    assert.deepEqual([snap.ok, snap.state, snap.store.kind], [true, 'completed', 'postgres'])
    let cursor = 0
    const got = []
    for (;;) {
      const page = await (await R.handleLiveRunEvents(new Request(`http://x/runs/${pf.run_id}/events?after=${cursor}&limit=50`, { headers: H }), o)).json()
      got.push(...page.events)
      cursor = page.cursor
      if (!page.events.length) break
    }
    const db = await dbEvents(d.pool, pf.run_id)
    assert.deepEqual(got.map((e) => [e.event_id, e.seq]), db.map((r) => [Number(r.event_id), r.seq]))
    assert.equal(snap.last_event_id, Number(db[db.length - 1].event_id))
  } finally { await d.drop() }
})

t('a second instance booting mid-scan never steals a LIVE lease: it defers, the owner finishes, nothing is marked interrupted', async () => {
  const d = await freshDb()
  try {
    let release
    const gate = new Promise((r) => { release = r })
    const a = await pgAgent(d.newPool(4), { impl: { getEntityGraphZipContext: async () => { await gate; return { zips: {}, buildId: null } } }, leaseTtlMs: 5_000 })
    const { pf, c } = await scan(a, IDS.slice(0, 1))
    for (let i = 0; i < 300 && !a.store.read().events.some((e) => e.run_id === pf.run_id && e.type === 'task.started' && e.payload.finding_type === 'market_context'); i += 1) await new Promise((r) => setTimeout(r, 10))
    const b = await pgAgent(d.newPool(4), { leaseTtlMs: 5_000 })
    const r = await b.quickScan.recover()
    assert.deepEqual([[...r], r.deferred], [[], [pf.job_id]])
    release()
    assert.ok(['completed', 'completed_partial'].includes((await c.done).state))
    const rows = await dbEvents(d.pool, pf.run_id)
    assert.ok(!rows.some((x) => x.payload?.reason === 'interrupted_by_restart'))
    assert.equal(rows.filter((x) => x.type === 'run.completed').length, 1)
  } finally { await d.drop() }
})

t('cancel: persisted as cancel_requested → run.cancelled after acknowledgement; terminal row has ended_at; findings kept', async () => {
  const d = await freshDb()
  try {
    let release
    const gate = new Promise((r) => { release = r })
    const a = await pgAgent(d.api, { impl: { getEntityGraphOutreachState: async () => { await gate; return { states: {}, unavailable: [] } } } })
    const { pf, c } = await scan(a)
    for (let i = 0; i < 300 && !a.store.read().events.some((e) => e.run_id === pf.run_id && e.type === 'task.started' && e.payload.finding_type === 'outreach_state'); i += 1) await new Promise((r) => setTimeout(r, 10))
    await a.quickScan.cancel({ run_id: pf.run_id, requested_by: 'op' })
    const mid = (await d.pool.query('select state, cancel_requested_at from agent.run where run_id = $1', [pf.run_id])).rows[0]
    assert.ok(mid.cancel_requested_at && mid.state !== 'cancelled')
    release()
    assert.equal((await c.done).state, 'cancelled')
    const end = (await d.pool.query('select state, ended_at from agent.run where run_id = $1', [pf.run_id])).rows[0]
    assert.equal(end.state, 'cancelled')
    assert.ok(end.ended_at)
    const types = (await dbEvents(d.pool, pf.run_id)).map((r) => r.type)
    assert.ok(types.indexOf('run.cancelled') > types.indexOf('run.cancel_requested'))
    assert.ok((await d.pool.query('select count(*)::int n from agent.finding where run_id = $1', [pf.run_id])).rows[0].n > 0)
  } finally { await d.drop() }
})

t('RLS: operator reads own org only; owner reads all; anon reads nothing; authenticated cannot write; internal events hidden', async () => {
  const d = await freshDb()
  try {
    await d.pool.query("insert into agent.org (org_id, name) values ($1, 'Other org')", [ORG_B])
    const U1 = 'aaaaaaaa-0000-4000-8000-000000000001'; const U2 = 'aaaaaaaa-0000-4000-8000-000000000002'; const OWNER = 'aaaaaaaa-0000-4000-8000-000000000003'; const STRANGER = 'aaaaaaaa-0000-4000-8000-000000000009'
    await d.pool.query("insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'operator', 'test'), ($3, $4, 'operator', 'test'), ($1, $5, 'owner', 'test')", [DEFAULT_ORG_ID, U1, ORG_B, U2, OWNER])
    const a = await pgAgent(d.api)
    const ra = await scan(a, IDS.slice(0, 1)); await ra.c.done
    const b = await pgAgent(d.api, { org_id: ORG_B })
    const rb = await scan(b, IDS.slice(1, 2)); await rb.c.done
    const see = async (sub, table) => (await asRole(d.pool, 'authenticated', sub, `select distinct org_id::text o from agent.${table}`)).rows.map((r) => r.o).sort()
    for (const table of ['run', 'run_event', 'research_job', 'research_task', 'finding', 'finding_conflict']) {
      assert.deepEqual(await see(U1, table), [DEFAULT_ORG_ID], `${table}: U1 sees org A only`)
      assert.deepEqual(await see(U2, table), [ORG_B], `${table}: U2 sees org B only`)
      assert.deepEqual(await see(OWNER, table), [DEFAULT_ORG_ID, ORG_B].sort(), `${table}: owner sees all`)
      assert.deepEqual(await see(STRANGER, table), [], `${table}: non-member sees nothing`)
      assert.deepEqual(await see(null, table), [], `${table}: no session sees nothing`)
      await assert.rejects(asRole(d.pool, 'anon', null, `select 1 from agent.${table} limit 1`), /permission denied/, `${table}: anon denied`)
    }
    for (const sql of ["insert into agent.org (org_id, name) values (gen_random_uuid(), 'x')", 'delete from agent.finding', "update agent.run set state = 'failed'", 'select * from agent.store_head', 'select agent.purge_expired()']) {
      await assert.rejects(asRole(d.pool, 'authenticated', U1, sql), /permission denied/, sql)
    }
    // membership: a user sees only their own membership rows
    assert.equal((await asRole(d.pool, 'authenticated', U1, 'select count(*)::int n from agent.operator_membership')).rows[0].n, 1)
    // internal-visibility events are never readable by authenticated users
    await a.store.transaction((tx) => appendEventTx(tx, { run_id: ra.pf.run_id, type: 'decision', visibility: 'internal', payload: { summary: 'internal note' } }))
    const vis = (await asRole(d.pool, 'authenticated', OWNER, "select count(*)::int n from agent.run_event where visibility = 'internal'")).rows[0].n
    assert.equal(vis, 0)
  } finally { await d.drop() }
})

t('sanitizer CHECKs reject phones, emails, message bodies and contact keys — in events, findings, tasks and run docs — and the store rolls back', async () => {
  const d = await freshDb()
  try {
    const s = createPgAgentStore({ pool: d.api })
    await s.open()
    const runs = createRunService({ store: s })
    const r = await runs.createRun({ kind: 'research', depth: 'quick', operator_id: 'op', property_count: 1 })
    const ins = (payload) => d.pool.query("insert into agent.run_event (event_id, run_id, org_id, seq, type, at, actor_user_id, payload) select (select event_id + 1000 from agent.store_head), $1, $2, (select coalesce(max(seq),0)+1 from agent.run_event where run_id = $1), 'decision', now(), 'op', $3::jsonb", [r.id, DEFAULT_ORG_ID, JSON.stringify(payload)])
    for (const bad of [{ summary: 'call 612-555-0147' }, { summary: '+16125550147' }, { n: 6125550147 }, { nested: { deep: ['ok', 'reach me at (612) 555 0147'] } }, { summary: 'x@example.com' }, { latest_message_body: 'hello' }, { preview: 'hi' }, { canonical_e164: 'x' }, { phones_json: [] }, { phone: '•••-0147' }, { phones: [{ masked: 'x' }] }, { thinking: 'x' }, { token: 'x' }]) {
      await assert.rejects(ins(bad), (e) => e.code === '23514', JSON.stringify(bad))
    }
    // identifiers, hashes, dates and money are not phones
    await ins({ summary: 'Last transfer 2014-03-10 · $1,234,567 · 48 sales', property_id: 'pid_imimiogmio', basis_finding_ids: ['fnd_abc'], target_refs: ['property:pid_imimiogmio'], idempotency_key: 'a25d77d3ac362a1563949319e29da334', contact_candidates: { people: 1, phones: 2 }, at: '2026-10-09T04:00:00.000Z' })
    // the adapter path: a task output (not JS-sanitized) carrying a phone is refused and memory rolls back
    const before = s.read().researchTasks.size
    await assert.rejects(s.transaction((tx) => {
      tx.researchJobs.set('rjob_x', { job_id: 'rjob_x', run_id: r.id, depth: 'quick', state: 'draft', scope_hash: 'a'.repeat(64), property_ids: ['p1'], created_at: new Date().toISOString() })
      tx.researchTasks.set('rtask_x', { task_id: 'rtask_x', job_id: 'rjob_x', run_id: r.id, property_id: 'p1', tool: 'eg.outreach_state', finding_type: 'outreach_state', state: 'succeeded', attempt: 1, billable: false, output: { note: 'seller cell 612.555.0147' } })
    }), (e) => e.code === 'PG_STORE_CONSTRAINT')
    assert.equal(s.read().researchTasks.size, before)
    assert.equal(s.read().researchJobs.has('rjob_x'), false)
    await assert.rejects(d.pool.query("update agent.run set doc = doc || '{\"objective\":\"text 612-555-0147\"}' where run_id = $1", [r.id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("insert into agent.finding (finding_id, run_id, org_id, property_id, finding_type, key, evidence_status, source_class, source_id, value, confidence, retrieved_at, actor_user_id, gen, doc) values ('f1', $1, $2, 'p1', 'x', 'k', 'internal_record', 'internal_record', 's', '{\"owner_email\":\"a@b.co\"}', 0.9, now(), 'op', 0, '{}')", [r.id, DEFAULT_ORG_ID]), (e) => e.code === '23514')
  } finally { await d.drop() }
})

t('append-only + ordering + S3 structural rules are enforced by the database itself', async () => {
  const d = await freshDb()
  try {
    const a = await pgAgent(d.api)
    const { pf, c } = await scan(a, IDS.slice(0, 1))
    await c.done
    await assert.rejects(d.pool.query('update agent.run_event set type = $2 where run_id = $1', [pf.run_id, 'decision']), /append-only/)
    await assert.rejects(d.pool.query('truncate agent.run_event'), /append-only/)
    const head = Number((await d.pool.query('select event_id from agent.store_head')).rows[0].event_id)
    await assert.rejects(d.pool.query("insert into agent.run_event (event_id, run_id, org_id, seq, type, at, actor_user_id, payload) values ($1, $2, $3, 999, 'decision', now(), '11111111-1111-4111-8111-111111111111', '{}')", [head + 1, pf.run_id, DEFAULT_ORG_ID]), /seq gap/)
    const nextSeq = (await d.pool.query('select max(seq)+1 s from agent.run_event where run_id = $1', [pf.run_id])).rows[0].s
    await assert.rejects(d.pool.query("insert into agent.run_event (event_id, run_id, org_id, seq, type, at, actor_user_id, payload) values (1, $1, $2, $3, 'decision', now(), '11111111-1111-4111-8111-111111111111', '{}')", [pf.run_id, DEFAULT_ORG_ID, nextSeq]), /monotonic|duplicate key/)
    await assert.rejects(d.pool.query("insert into agent.run_event (event_id, run_id, org_id, seq, type, at, actor_user_id, payload, fixture) values ($1, $2, $3, $4, 'decision', now(), '11111111-1111-4111-8111-111111111111', '{}', true)", [head + 1, pf.run_id, DEFAULT_ORG_ID, nextSeq]), (e) => e.code === '23514')
    // $0 / AI-off by structure
    await assert.rejects(d.pool.query("update agent.run set accrued_usd = 0.01 where run_id = $1", [pf.run_id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("update agent.run set budget_cap_usd = 1 where run_id = $1", [pf.run_id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("update agent.research_job set depth = 'deep' where run_id = $1", [pf.run_id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("update agent.research_task set billable = true where run_id = $1", [pf.run_id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("update agent.tool_call set tier = 'T2' where run_id = $1", [pf.run_id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("update agent.finding set evidence_status = 'model_inference', source_class = 'derived_inferred' where run_id = $1", [pf.run_id]), (e) => e.code === '23514')
    // unavailable never carries a value; class/status must agree; open conflicts name no winner
    await assert.rejects(d.pool.query("update agent.finding set value = '\"none\"' where run_id = $1 and evidence_status = 'unavailable'", [pf.run_id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("update agent.finding set source_class = 'official_public_record' where run_id = $1 and evidence_status = 'vendor_reported'", [pf.run_id]), (e) => e.code === '23514')
    await assert.rejects(d.pool.query("update agent.finding set is_negative_claim = true where run_id = $1", [pf.run_id]), (e) => e.code === '23514')
    assert.ok((await d.pool.query("select count(*)::int n from agent.finding_conflict where run_id = $1 and doc -> 'best_supported' is not null and jsonb_typeof(doc -> 'best_supported') <> 'null'", [pf.run_id])).rows[0].n > 0)
    await assert.rejects(d.pool.query("update agent.finding_conflict set resolution_state = 'open' where run_id = $1 and jsonb_typeof(doc -> 'best_supported') = 'object'", [pf.run_id]), (e) => e.code === '23514')
    // the adapter refuses tables S3 does not persist (ledger, approvals, artifacts, audit)
    await assert.rejects(a.store.transaction((tx) => { tx.ledger.push({ id: 1, kind: 'reserve', cost_usd: 0.01 }) }), (e) => e.code === 'PG_STORE_TABLE_NOT_PERSISTED')
    assert.equal(a.store.read().ledger.length, 0)
  } finally { await d.drop() }
})

t('retention: only terminal runs age out (events/findings at 180 d, runs at 365 d); in-flight untouched; delete-on-request refuses in-flight; both logged', async () => {
  const d = await freshDb()
  try {
    const a = await pgAgent(d.api)
    const done1 = await scan(a, IDS.slice(0, 1)); await done1.c.done
    const done2 = await scan(a, IDS.slice(1, 2)); await done2.c.done
    const live = await a.quickScan.preflight({ operator_id: 'op', property_ids: [IDS[2]] }) // draft: in flight (not terminal)
    // age the two finished runs (ended_at is a plain column; events stay append-only)
    await d.pool.query("update agent.run set ended_at = now() - interval '200 days' where run_id = $1", [done1.pf.run_id])
    await d.pool.query("update agent.run set ended_at = now() - interval '400 days' where run_id = $1", [done2.pf.run_id])
    const res = (await d.pool.query('select agent.purge_expired() r')).rows[0].r
    assert.ok(res.events > 0 && res.findings > 0 && res.runs === 1)
    const left = async (table, run) => (await d.pool.query(`select count(*)::int n from agent.${table} where run_id = $1`, [run])).rows[0].n
    assert.equal(await left('run_event', done1.pf.run_id), 0)
    assert.equal(await left('finding', done1.pf.run_id), 0)
    assert.equal(await left('run', done1.pf.run_id), 1, 'the run summary row outlives its events')
    assert.equal(await left('run', done2.pf.run_id), 0, 'past run_days the whole run goes')
    assert.ok(await left('run_event', live.run_id) > 0, 'in-flight runs are never purged')
    assert.deepEqual((await d.pool.query('select agent.purge_expired() r')).rows[0].r, { events: 0, findings: 0, conflicts: 0, tasks: 0, runs: 0, runs_marked: 0 }, 'idempotent')
    assert.equal((await d.pool.query("select agent.delete_run($1, 'op', 'test') r", [live.run_id])).rows[0].r.reason, 'run_in_flight')
    const del = (await d.pool.query("select agent.delete_run($1, 'owner', 'owner request') r", [done1.pf.run_id])).rows[0].r
    assert.equal(del.ok, true)
    assert.equal(await left('run', done1.pf.run_id), 0)
    const log = (await d.pool.query('select kind, requested_by from agent.deletion_log order by id')).rows
    assert.deepEqual(log.map((l) => l.kind), ['retention_run', 'retention', 'request'])
  } finally { await d.drop() }
})

t('cross-server research slots: 4 worker PROCESSES never hold more than 2 active research jobs; all finish; the DB trigger refuses a 3rd lease', async () => {
  const d = await freshDb()
  try {
    const props = ['9000000001', '9000000002', '9000000003', '9000000004']
    let peak = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const n = (await d.pool.query("select count(*)::int n from agent.run where kind = 'research' and ended_at is null and lease_owner is not null and lease_until > now()")).rows[0].n
        peak = Math.max(peak, n)
        await new Promise((r) => setTimeout(r, 15))
      }
    })()
    const outs = await Promise.all(props.map((pid) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', './tests/register-aliases.mjs', 'tests/pg/slot-worker.mjs', d.apiUrl, pid, '40'], { cwd: API, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', (b) => { out += b })
      p.stderr.on('data', () => {})
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`worker ${pid} exited ${code}: ${out}`))))
    })))
    sampling = false
    await sampler
    assert.ok(peak <= 2, `peak active research jobs ${peak}`)
    assert.ok(peak >= 1)
    assert.ok(outs.every((o) => /DONE run_\S+ completed/.test(o)), outs.join('|'))
    const waited = (await d.pool.query("select count(distinct run_id)::int n from agent.run_event where type = 'decision' and payload ->> 'criterion' = 'research_slot_wait'")).rows[0].n
    assert.ok(waited >= 1, 'at least one job waited for a slot (and said so)')
    // DB backstop: a third live lease is refused even when written directly
    const ids = (await d.pool.query("select run_id from agent.run where kind = 'research' order by created_at limit 3")).rows.map((r) => r.run_id)
    await d.pool.query("update agent.run set state = 'running', ended_at = null, lease_owner = 'x', lease_until = now() + interval '1 minute' where run_id = any($1::text[]) and run_id <> $2", [ids.slice(0, 2), ids[2]]).catch(() => {})
    const live = (await d.pool.query("select count(*)::int n from agent.run where kind='research' and lease_owner is not null and lease_until > now() and ended_at is null")).rows[0].n
    if (live === 2) {
      await assert.rejects(d.pool.query("update agent.run set state = 'running', ended_at = null, lease_owner = 'y', lease_until = now() + interval '1 minute' where run_id = $1", [ids[2]]), /research slot limit/)
    }
    // the cap is lower-only
    await assert.rejects(d.pool.query('update agent.runtime_limits set max_active_research_jobs = 3'), (e) => e.code === '23514')
    await d.pool.query('update agent.runtime_limits set max_active_research_jobs = 1')
  } finally { await d.drop() }
})

t('in-process slots (memory or pg): a third job waits with an honest decision event and starts after one finishes', async () => {
  const d = await freshDb()
  try {
    let release
    const gate = new Promise((r) => { release = r })
    const impl = { getEntityGraphZipContext: async () => { await gate; return { zips: {}, buildId: null } } }
    const store = createPgAgentStore({ pool: d.api })
    await store.open()
    const db = multiDb(IDS)
    const agent = createLiveAgent({ env: { AGENT_MAX_MODE: 'read' }, store, slotPollMs: 50, createServices: () => createQuickScanServices({ db, impl }) })
    const jobs = []
    for (const pid of IDS) jobs.push(await scan(agent, [pid]))
    for (let i = 0; i < 300 && !store.read().events.some((e) => e.payload?.criterion === 'research_slot_wait'); i += 1) await new Promise((r) => setTimeout(r, 10))
    const waiting = store.read().events.filter((e) => e.payload?.criterion === 'research_slot_wait')
    assert.equal(waiting.length, 1)
    const leased = [...store.read().runs.values()].filter((r) => r.kind === 'research' && r.lease_owner && !r.ended_at).length
    assert.equal(leased, 2)
    release()
    const states = await Promise.all(jobs.map((j) => j.c.done))
    assert.ok(states.every((s) => ['completed', 'completed_partial'].includes(s.state)))
  } finally { await d.drop() }
})

t('retention expiry is explicit: purged runs are MARKED, snapshot/events/history say "evidence expired", caches evict, never shown as complete evidence', async () => {
  const d = await freshDb()
  try {
    const a = await pgAgent(d.api)
    const done = await scan(a, IDS.slice(0, 1))
    await done.c.done
    assert.equal(a.quickScan.snapshot(done.pf.run_id).evidence_complete, true)
    const b = await pgAgent(d.api)
    await b.store.hydrateRun(done.pf.run_id)
    assert.ok(b.store.read().events.some((e) => e.run_id === done.pf.run_id))
    await d.pool.query("update agent.run set ended_at = now() - interval '200 days' where run_id = $1", [done.pf.run_id])
    const res = (await d.pool.query('select agent.purge_expired() r')).rows[0].r
    assert.equal(res.runs_marked, 1)
    const row = (await d.pool.query('select state, evidence_expired_at, evidence_expiry, doc from agent.run where run_id = $1', [done.pf.run_id])).rows[0]
    assert.equal(row.state, 'completed')
    assert.ok(row.evidence_expired_at)
    assert.ok(row.evidence_expiry.events_purged > 0 && row.evidence_expiry.findings_purged > 0 && row.evidence_expiry.tasks_purged > 0)
    assert.equal(row.evidence_expiry.reason, 'retention_policy')
    // both instances (one had the run hot in cache) now report expiry, not a complete run
    for (const agent of [a, b]) {
      await agent.store.refresh()
      assert.equal(agent.store.read().events.filter((e) => e.run_id === done.pf.run_id).length, 0, 'cached evidence evicted')
      const snap = agent.quickScan.snapshot(done.pf.run_id)
      assert.equal(snap.evidence_complete, false)
      assert.equal(snap.evidence_expired.expired, true)
      assert.match(snap.evidence_expired.notice, /^Evidence expired on \d{4}-\d{2}-\d{2}/)
      assert.deepEqual([snap.view, snap.findings.length, snap.conflicts.length], [null, 0, 0])
      assert.ok(agent.quickScan.history().find((h) => h.run_id === done.pf.run_id).evidence_expired_at)
    }
    const env = { AGENT_LIVE_ROUTES: '1', AGENT_MAX_MODE: 'read', NODE_ENV: 'development' }
    const ev = await (await R.handleLiveRunEvents(new Request(`http://x/runs/${done.pf.run_id}/events`, { headers: authHeaders(SCAN_OPERATOR) }), { env, auth: ensureMutationAuth, ...GB, agent: b, params: { run_id: done.pf.run_id } })).json()
    assert.deepEqual([ev.events.length, ev.done, ev.evidence_complete, ev.evidence_expired.expired], [0, true, false, true])
    // a second purge does not re-mark or double count
    assert.equal((await d.pool.query('select agent.purge_expired() r')).rows[0].r.runs_marked, 0)
    // delete-on-request: caches evict the run entirely
    await d.pool.query("select agent.delete_run($1, 'owner', 'request')", [done.pf.run_id])
    await a.store.refresh()
    assert.equal(a.store.read().runs.has(done.pf.run_id), false)
    assert.equal(a.quickScan.snapshot(done.pf.run_id), null)
  } finally { await d.drop() }
})

t('Supabase permissions: explicit revokes beat (worse-than-prod) default privileges; FORCE RLS everywhere; only can_read_org is executable by authenticated', async () => {
  const d = await freshDb()
  try {
    const tables = (await d.pool.query("select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relkind = 'r' order by 1")).rows
    assert.equal(tables.length, 14)
    assert.ok(tables.every((t) => t.relrowsecurity && t.relforcerowsecurity), 'RLS enabled + forced on every table')
    const READABLE = new Set(['run', 'run_event', 'research_job', 'research_task', 'finding', 'finding_conflict', 'operator_membership'])
    for (const { relname } of tables) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal((await d.pool.query('select has_table_privilege($1, $2, $3) p', ['anon', `agent.${relname}`, priv])).rows[0].p, false, `anon ${priv} ${relname}`)
        const want = priv === 'SELECT' && READABLE.has(relname)
        assert.equal((await d.pool.query('select has_table_privilege($1, $2, $3) p', ['authenticated', `agent.${relname}`, priv])).rows[0].p, want, `authenticated ${priv} ${relname}`)
      }
    }
    const fns = (await d.pool.query("select p.oid::regprocedure::text sig, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'agent' order by 1")).rows
    assert.ok(fns.length >= 7)
    for (const f of fns) {
      assert.equal((await d.pool.query("select has_function_privilege('anon', $1, 'EXECUTE') p", [f.sig])).rows[0].p, false, `anon EXECUTE ${f.sig}`)
      assert.equal((await d.pool.query("select has_function_privilege('authenticated', $1, 'EXECUTE') p", [f.sig])).rows[0].p, f.sig === 'agent.can_read_org(uuid)', `authenticated EXECUTE ${f.sig}`)
      const pub = (await d.pool.query("select coalesce(bool_or(a.grantee = 0), false) p from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.privilege_type = 'EXECUTE'", [f.sig])).rows[0].p
      assert.equal(pub, false, `PUBLIC EXECUTE ${f.sig}`)
    }
    for (const seq of (await d.pool.query("select c.oid::regclass::text s from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relkind = 'S'")).rows) {
      for (const role of ['anon', 'authenticated']) assert.equal((await d.pool.query("select has_sequence_privilege($1, $2, 'USAGE') p", [role, seq.s])).rows[0].p, false, `${role} ${seq.s}`)
    }
    assert.equal((await d.pool.query("select has_schema_privilege('anon', 'agent', 'USAGE') p")).rows[0].p, false)
    // the store refuses to run with bypass privileges (service_role / superuser); agent_api works under FORCE RLS
    const svc = d.trackPool(new pg.Pool({ connectionString: d.url, max: 2 }))
    svc.on('connect', (c) => c.query('set role service_role'))
    await assert.rejects(createPgAgentStore({ pool: svc }).open(), (e) => e.code === 'PG_STORE_ROLE_TOO_PRIVILEGED')
    await assert.rejects(createPgAgentStore({ pool: d.pool }).open(), (e) => e.code === 'PG_STORE_ROLE_TOO_PRIVILEGED')
    const s = createPgAgentStore({ pool: d.api })
    await s.open()
    const r = await createRunService({ store: s }).createRun({ kind: 'research', depth: 'quick', operator_id: 'op', property_count: 1 })
    assert.equal((await d.pool.query('select count(*)::int n from agent.run where run_id = $1', [r.id])).rows[0].n, 1)
    // membership seeding mirrors the allowlist (service_role only)
    const U = ['aaaaaaaa-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000012']
    const O = ['aaaaaaaa-0000-4000-8000-000000000013']
    assert.deepEqual((await svc.query("select agent.sync_operator_membership($1, $2::uuid[], $3::uuid[], 'gate-B') r", [DEFAULT_ORG_ID, U, O])).rows[0].r, { upserted: 3, removed: 0 })
    assert.deepEqual((await svc.query("select agent.sync_operator_membership($1, $2::uuid[], $3::uuid[], 'gate-B') r", [DEFAULT_ORG_ID, U.slice(0, 1), O])).rows[0].r, { upserted: 2, removed: 1 })
    assert.deepEqual((await d.pool.query('select user_id::text, role from agent.operator_membership order by user_id')).rows, [{ user_id: U[0], role: 'operator' }, { user_id: O[0], role: 'owner' }])
    await assert.rejects(asRole(d.pool, 'authenticated', U[0], "select agent.sync_operator_membership($1, '{}'::uuid[], '{}'::uuid[], 'x')", [DEFAULT_ORG_ID]), /permission denied/)
  } finally { await d.drop() }
})

t('M1: no API role can bypass append-only or delete — the old session-setting trick, DELETE, TRUNCATE, DISABLE TRIGGER, DDL and other ledger scopes are all refused', async () => {
  const d = await freshDb()
  try {
    const a = await pgAgent(d.api)
    const { pf, c } = await scan(a, IDS.slice(0, 1))
    await c.done
    await d.pool.query("insert into public.idempotency_ledger (scope, key) values ('inbound.sms', 'not-yours')")
    const as = async (who, fn) => {
      const cl = who === 'agent_api' ? await d.api.connect() : await d.pool.connect()
      try {
        await cl.query('begin')
        if (who === 'service_role') await cl.query('set local role service_role')
        return await fn(cl)
      } finally { await cl.query('rollback').catch(() => {}); cl.release() }
    }
    const before = (await d.pool.query('select count(*)::int n from agent.run_event')).rows[0].n
    for (const who of ['agent_api', 'service_role']) {
      const attempts = [
        "set local agent.purge = 'on'; delete from agent.run_event",
        'delete from agent.run_event',
        "update agent.run_event set type = 'decision'",
        'truncate agent.run_event',
        'alter table agent.run_event disable trigger run_event_guard_mut',
        'delete from agent.run',
        'delete from agent.finding',
        'truncate agent.finding',
        'create table agent.sneaky (x int)',
        'drop table agent.finding',
      ]
      // retention + delete-on-request are the service_role (cron / owner path) jobs; the API role cannot run them
      if (who === 'agent_api') attempts.push("select agent.purge_expired()", "select agent.delete_run('x', 'y')", "select agent.sync_operator_membership('00000000-0000-4000-8000-00000000a001', '{}'::uuid[], '{}'::uuid[], 'x')", "update agent.runtime_limits set max_active_research_jobs = 1")
      for (const sql of attempts) {
        await assert.rejects(as(who, (cl) => cl.query(sql)), (e) => ['42501', '42P01', '0A000'].includes(e.code) || /append-only|permission denied|must be owner/.test(e.message), `${who}: ${sql}`)
      }
    }
    assert.equal((await d.pool.query('select count(*)::int n from agent.run_event')).rows[0].n, before, 'not one event removed')
    // agent_api sees and touches only scope agent.tool in the reused ledger
    assert.equal((await as('agent_api', (cl) => cl.query("select count(*)::int n from public.idempotency_ledger where scope <> 'agent.tool'"))).rows[0].n, 0)
    const del = await as('agent_api', (cl) => cl.query("delete from public.idempotency_ledger where scope = 'inbound.sms'"))
    assert.equal(del.rowCount, 0)
    await assert.rejects(as('agent_api', (cl) => cl.query("insert into public.idempotency_ledger (scope, key) values ('inbound.sms', 'forged')")), (e) => e.code === '42501')
    // role attributes: non-owner, no bypass, no inherit
    const role = (await d.pool.query("select rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb from pg_roles where rolname = 'agent_api'")).rows[0]
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false })
    assert.equal((await d.pool.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and pg_get_userbyid(c.relowner) = 'agent_api'")).rows[0].n, 0, 'agent_api owns nothing')
    // the retention / delete-on-request path still deletes (as the owner, inside SECURITY DEFINER)
    await d.pool.query("update agent.run set ended_at = now() - interval '200 days' where run_id = $1", [pf.run_id])
    const svc = d.trackPool(new pg.Pool({ connectionString: d.url, max: 1 }))
    svc.on('connect', (cl) => cl.query('set role service_role'))
    assert.equal((await svc.query('select agent.purge_expired() r')).rows[0].r.runs_marked, 1)
    assert.equal((await svc.query("select agent.delete_run($1, 'owner', 'request') r", [pf.run_id])).rows[0].r.ok, true)
  } finally { await d.drop() }
})

t('L4: membership sync de-duplicates and an owner listed twice (or as operator too) stays owner', async () => {
  const d = await freshDb()
  try {
    const U = 'aaaaaaaa-0000-4000-8000-000000000021'
    const O = 'aaaaaaaa-0000-4000-8000-000000000022'
    const r = (await d.pool.query("select agent.sync_operator_membership($1, $2::uuid[], $3::uuid[], 't') r", [DEFAULT_ORG_ID, [U, U, O], [O, O]])).rows[0].r
    assert.equal(r.upserted, 2)
    assert.deepEqual((await d.pool.query('select user_id::text, role from agent.operator_membership order by user_id')).rows, [{ user_id: U, role: 'operator' }, { user_id: O, role: 'owner' }])
  } finally { await d.drop() }
})

t('L1: the slot guard re-checks on kind / ended_at / state changes, not only lease columns', async () => {
  const d = await freshDb()
  try {
    const s = createPgAgentStore({ pool: d.api }); await s.open()
    const rs = createRunService({ store: s })
    const runs = []
    for (let i = 0; i < 3; i += 1) runs.push(await rs.createRun({ kind: 'research', depth: 'quick', operator_id: 'op', property_count: 1 }))
    await d.pool.query("update agent.run set state = 'running', lease_owner = 'w', lease_until = now() + interval '1 minute' where run_id = any($1::text[])", [runs.slice(0, 2).map((r) => r.id)])
    // run 3 holds a lease while TERMINAL (allowed); re-opening it (ended_at → null) must hit the cap
    await d.pool.query("update agent.run set state = 'completed', ended_at = now(), lease_owner = 'w3', lease_until = now() + interval '1 minute' where run_id = $1", [runs[2].id])
    await assert.rejects(d.pool.query("update agent.run set state = 'running', ended_at = null where run_id = $1", [runs[2].id]), /research slot limit/)
    // a task-kind run with a lease flipped to research is also counted
    const t1 = await rs.createRun({ kind: 'task', operator_id: 'op' })
    await d.pool.query("update agent.run set state = 'running', lease_owner = 'w4', lease_until = now() + interval '1 minute' where run_id = $1", [t1.id])
    await assert.rejects(d.pool.query("update agent.run set kind = 'research' where run_id = $1", [t1.id]), /research slot limit/)
  } finally { await d.drop() }
})

t('M2: payload_is_clean closes every reported gap (each case is a row) and still accepts real Quick Scan shapes', async () => {
  const d = await freshDb()
  try {
    const v = async (obj) => (await d.pool.query('select agent.payload_violation($1::jsonb) r', [JSON.stringify(obj)])).rows[0].r
    const REJECT = [
      // subtrees under *_refs / *_ids were skipped
      { target_refs: [{ note: 'call 214-555-1234' }] },
      { basis_finding_ids: ['ok', { phone_number: '2145551234' }] },
      { observation_ids: ['2145551234'] },
      // object KEYS were never scanned
      { '2145551234': 'x' }, { 'owner@example.com': 1 },
      // *_id / *_key / *_hash values skipped the phone check
      { seller_id: '2145551234' }, { lookup_key: '214-555-1234' }, { payload_hash: '2145551234' }, { idempotency_key: 'call 2145551234' },
      // credential keys matched exactly only
      { access_token: 'x' }, { service_role_key: 'x' }, { secret_key: 'x' }, { private_key: 'x' }, { refreshToken: 'x' }, { clientSecret: 'x' }, { 'X-Api-Key': 'x' }, { authHeader: 'x' }, { session_cookie: 'x' },
      { note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
      { note: 'Authorization: Bearer abcdefgh12345678' }, { note: 'sk_live_abcdefgh12345678' }, { note: 'sb_secret_abcdefgh1234' },
      // body keys: text / content / message / camelCase
      { text: 'hello' }, { content: 'hi' }, { message: 'x' }, { messageBody: 'x' }, { latestMessageBody: 'x' }, { smsText: 'x' }, { email_body: 'x' },
      // phone shapes
      { n: '２１４５５５１２３４' }, { n: '٢١٤٥٥٥١٢٣٤' }, { n: 'tel2145551234' }, { n: '214/555/1234' }, { n: '214 - 555 - 1234' }, { n: '+44 20 7946 0958' }, { n: '+52 55 1234 5678' },
      { n: '(214)555-1234x' }, { n: 'ph:214.555.1234' }, { n: -2145551234 }, { n: 12145551234 }, { n: 2145551234 },
      { n: Buffer.from('call 214-555-1234').toString('base64') }, { n: Buffer.from('owner@example.com').toString('base64') },
      // contact keys may only hold counts / flags
      { phone: '•••-1234' }, { emails: ['x'] }, { phones_json: [] }, { canonical_e164: 'x' }, { bestPhone: 'x' },
      { thinking: 'x' }, { chainOfThought: 'x' },
      // hardening pass 2 (re-review residue)
      { n: '๒๑๔๕๕๕๑๒๓๔' }, { n: '𝟐𝟏𝟒𝟓𝟓𝟓𝟏𝟐𝟑𝟒' }, { n: '²¹⁴⁵⁵⁵¹²³⁴' }, { n: '2\u200b1\u200b4\u200b5\u200b5\u200b5\u200b1\u200b2\u200b3\u200b4' },
      { n: '214 -- 555 -- 1234' }, { n: '214 / 555 / 1234' }, { n: 'AKIAIOSFODNN7EXAMPLE' }, { n: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }, { n: 'github_pat_11ABCDEFG0123456789_abcdefghij' },
      { n: Buffer.from('call 214-555-1234').toString('base64url') }, { n: Buffer.from(Buffer.from('214-555-1234').toString('base64')).toString('base64') },
      { 'ｐｈｏｎｅ': 'x' }, { 'nоte': 'x' }, // full-width key; Cyrillic о homoglyph
      { property_id: '2145551234' }, { property_id: '2128263281' }, { property_ids: ['232065345'] }, { target_refs: ['property:2145551234'] }, { basis_refs: ['property:2145551234'] }, { property_id: 2145551234 },
    ]
    for (const c of REJECT) assert.notEqual(await v(c), null, `should reject ${JSON.stringify(c)}`)
    const ACCEPT = [
      { property_id: 'pid_imimiogmio' }, { property_ids: ['pid_imimiogmio', 'pid_jjmgllj'] }, { cross_checked_property_ids: ['pid_imimiogmio'] },
      { target_refs: ['property:pid_imimiogmio'] },
      { run_id: 'run_12345678-1234-4123-8123-123456789012' }, { operator_id: '11111111-1111-4111-8111-111111111111' }, { requested_by: '11111111-1111-4111-8111-111111111111' },
      { idempotency_key: 'a25d77d3ac362a1563949319e29da334b7e0d7f8ffc5a25d77d3ac362a156394' }, { scope_hash: '1234567890123456789012345678901234567890123456789012345678901234' },
      { at: '2026-10-09T04:00:00.000Z' }, { evidence_expired_at: '2026-10-09T04:00:00.123456+00:00' }, { valuation_date: '2026-04-22' },
      { summary: 'Last transfer 2014-03-10 · $1,234,567 · Warranty Deed · cash' }, { display_value: '1 recorded mortgage (1 in open slots) · latest 2026-06-15 · $180,000' },
      { display_value: 'ZIP 55411 · 48 sales (1y) · 45% investor · 40% cash · median $210,000' },
      { contact_candidates: { people: 1, phones: 2, unresolved: 0 } }, { phone: 2 }, { email: true }, { phones: null },
      { key: 'recorded_mortgages' }, { section_key: 'taxes_liens' }, { claims: [{ text: 'Vendor AVM $250,000', finding_ids: ['fnd_abc'] }] },
      { case_number: '2024-012345-CA-01' }, { private_lender: false }, { tokens: { input: 10 } }, { estimate: { label: 'Quick Scan: no billable operations ($0)' } },
      { amounts: [180000, 250000, 1234567] }, { confidence: 0.95 }, { sales1y: 48 },
      { title: 'Recorded documents (vendor-transcribed)' }, { finding_id: 'fnd_ihaibknidcpfoilpepnkilfg' }, { source_id: 'lc.recorded_documents' }, { key: 'recorded_mortgages' },
    ]
    // the codec round-trips and the encoded form contains no digits
    const { encodePropertyIds } = await import('../../src/lib/agent/runtime/pg-store.js')
    const sample = { property_id: '2128263281', nested: { cross_checked_property_ids: ['232065345'], target_refs: ['property:2128263281', 'campaign:7'] }, other: '2128263281x' }
    const enc = encodePropertyIds(sample)
    assert.ok(!/[0-9]/.test(JSON.stringify([enc.property_id, enc.nested.cross_checked_property_ids, enc.nested.target_refs[0]])))
    assert.deepEqual(decodePropertyIds(enc), sample)
    assert.equal(await v(enc.nested), null)
    for (const c of ACCEPT) assert.equal(await v(c), null, `should accept ${JSON.stringify(c)}`)
    // a "claims.text" exemption is key-only: its content is still scanned
    assert.notEqual(await v({ claims: [{ text: 'call 214-555-1234' }] }), null)
    // the CHECK is what guards the tables
    assert.equal((await d.pool.query("select agent.payload_is_clean('{\"access_token\":\"x\"}') ok")).rows[0].ok, false)
  } finally { await d.drop() }
})

t('L2: a worker whose lease lapsed while the cap filled up backs off and finishes — the DB refusal never fails the run', async () => {
  const d = await freshDb()
  try {
    const db = multiDb(IDS)
    const rawA = createPgAgentStore({ pool: d.newPool(4) }); await rawA.open()
    const storeA = killableStore(rawA)
    const a = createLiveAgent({ env: { AGENT_MAX_MODE: 'read' }, store: storeA, leaseTtlMs: 250, slotPollMs: 50, createServices: () => createQuickScanServices({ db }) })
    let release
    const gate = new Promise((r) => { release = r })
    const rawB = createPgAgentStore({ pool: d.newPool(4) }); await rawB.open()
    const b = createLiveAgent({ env: { AGENT_MAX_MODE: 'read' }, store: rawB, leaseTtlMs: 5_000, slotPollMs: 50, createServices: () => createQuickScanServices({ db, impl: { getEntityGraphZipContext: async () => { await gate; return { zips: {}, buildId: null } } } }) })
    const ja = await scan(a, [IDS[0]])
    for (let i = 0; i < 300 && !rawA.read().events.some((e) => e.run_id === ja.pf.run_id && e.type === 'task.started'); i += 1) await new Promise((r) => setTimeout(r, 5))
    storeA.kill() // A pauses; its lease lapses
    await new Promise((r) => setTimeout(r, 400))
    const jb1 = await scan(b, [IDS[1]])
    const jb2 = await scan(b, [IDS[2]])
    for (let i = 0; i < 300; i += 1) {
      const n = (await d.pool.query("select count(*)::int n from agent.run where kind='research' and ended_at is null and lease_owner is not null and lease_until > clock_timestamp()")).rows[0].n
      if (n === 2) break
      await new Promise((r) => setTimeout(r, 10))
    }
    storeA.revive() // A wakes: renewing its lapsed lease is refused by the DB while the cap is full
    await new Promise((r) => setTimeout(r, 300))
    assert.notEqual((await d.pool.query('select state from agent.run where run_id = $1', [ja.pf.run_id])).rows[0].state, 'failed')
    release()
    const states = await Promise.all([ja.c.done, jb1.c.done, jb2.c.done])
    assert.ok(states.every((s) => ['completed', 'completed_partial'].includes(s.state)), JSON.stringify(states))
  } finally { await d.drop() }
})

t('gate-B hardening: slot guard needs READ COMMITTED; pretest needs ledger RLS + no unfixable PUBLIC definer functions; migration narrows fixable ones; store refuses definer exposure', async () => {
  // 1. slot guard refuses to count under a snapshot isolation level
  const d = await freshDb()
  try {
    const s = createPgAgentStore({ pool: d.api }); await s.open()
    const run = await createRunService({ store: s }).createRun({ kind: 'research', depth: 'quick', operator_id: 'op', property_count: 1 })
    const c = await d.pool.connect()
    try {
      await c.query('begin isolation level repeatable read')
      await assert.rejects(c.query("update agent.run set state = 'running', lease_owner = 'w', lease_until = clock_timestamp() + interval '1 minute' where run_id = $1", [run.id]), /requires READ COMMITTED/)
      await c.query('rollback')
    } finally { c.release() }
    // 4b. the store refuses to open if its role can reach a definer function outside agent
    await d.pool.query("create function public.leak_probe() returns int language sql security definer as 'select 1'")
    await d.pool.query('revoke all on function public.leak_probe() from public')
    await d.pool.query('grant execute on function public.leak_probe() to agent_api')
    await assert.rejects(createPgAgentStore({ pool: d.api }).open(), (e) => e.code === 'PG_STORE_DEFINER_EXPOSURE')
  } finally { await d.drop() }

  // 2–4. pretest + migration behaviour on fresh databases
  const e = await freshDb({ apply: false })
  try {
    await e.pool.query('alter table public.idempotency_ledger disable row level security')
    await assert.rejects(runSqlFile(e.pool, SQL.pretest), /RLS must be enabled on public.idempotency_ledger/)
    await e.pool.query('alter table public.idempotency_ledger enable row level security')
    // a PUBLIC-executable definer function owned by ANOTHER role cannot be fixed by the migration → pretest refuses
    await e.pool.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'third_party_owner') then create role third_party_owner nologin; end if; end $$")
    await e.pool.query("create function public.foreign_definer() returns int language sql security definer as 'select 1'")
    await e.pool.query('alter function public.foreign_definer() owner to third_party_owner')
    await assert.rejects(runSqlFile(e.pool, SQL.pretest), /foreign_definer/)
    await e.pool.query('drop function public.foreign_definer()')
    // one the applier owns is narrowed by the migration: PUBLIC loses EXECUTE, anon/authenticated/service_role keep it, agent_api cannot call it
    await e.pool.query("create function public.own_definer() returns int language sql security definer as 'select 1'")
    await e.pool.query('grant execute on function public.own_definer() to public')
    await runSqlFile(e.pool, SQL.pretest)
    await runSqlFile(e.pool, SQL.migration)
    const can = async (role) => (await e.pool.query("select has_function_privilege($1, 'public.own_definer()', 'EXECUTE') p", [role])).rows[0].p
    assert.deepEqual([await can('agent_api'), await can('anon'), await can('authenticated'), await can('service_role')], [false, true, true, true])
    assert.deepEqual((await e.pool.query('select signature from agent.public_execute_revoked')).rows.map((r) => r.signature), ['own_definer()'])
    const api = await e.enableApi()
    const st = createPgAgentStore({ pool: api }); await st.open() // opens: no exposure remains
    // rollback restores PUBLIC EXECUTE
    const cl = await e.pool.connect()
    try { await cl.query("set agent.rollback_discard_data = 'on'"); await cl.query((await import('node:fs')).readFileSync(SQL.rollback, 'utf8')) } finally { cl.release() }
    const pub = (await e.pool.query("select coalesce(bool_or(a.grantee = 0), false) p from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = 'public.own_definer()'::regprocedure and a.privilege_type = 'EXECUTE'")).rows[0].p
    assert.equal(pub, true)
  } finally { await e.drop() }
})
