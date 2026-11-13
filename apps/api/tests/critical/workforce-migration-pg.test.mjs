// Workforce Phase A migration — PostgreSQL proofs of PROPOSED_20261022100000_workforce_foundation.sql
// (+ its pretest / posttest / rollback / rollback posttest) and the born-safe seed
// PROPOSED_20261022100100_workforce_seed.sql, on a DISPOSABLE local PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, freshDb, applyWorkforceChain, applyInTransaction, runSqlFile, SQL } from '../pg/agent-pg-harness.mjs'

const skip = pgAvailable() ? false : skipReason
const ORG = '00000000-0000-4000-8000-00000000a001'
const OWNER = '11111111-1111-4111-8111-111111111111'

function psql(url, file, vars = {}) {
  const args = [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', file]
  const r = spawnSync('psql', args, { encoding: 'utf8' })
  if (r.error) return { skipped: true }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

async function fingerprint(pool) {
  const ns = await sel(pool, `select nspname from pg_namespace where nspname in ('workforce', 'agent') order by 1`)
  const cols = await sel(pool, `select table_schema, table_name, column_name, data_type from information_schema.columns where table_schema in ('agent', 'workforce') order by 1, 2, 3`)
  const fns = await sel(pool, `select p.oid::regprocedure::text sig, md5(prosrc) h, coalesce(array_to_string(proacl, ','), '') acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('agent', 'workforce') order by 1`)
  const pol = await sel(pool, `select schemaname, tablename, policyname from pg_policies where schemaname in ('agent', 'workforce') order by 1, 2, 3`)
  const sched = await sel(pool, `select name from agent.runtime_schedule order by 1`)
  return JSON.stringify({ ns, cols, fns, pol, sched })
}

test('the seed employee list is verbatim in the seed posttest (the fixture exercises the real list)', () => {
  const marker = (src) => src.slice(src.indexOf('\n/*seed:employees*/\n'), src.indexOf('\n/*end*/\n'))
  const seed = marker(fs.readFileSync(SQL.workforceSeed, 'utf8'))
  const post = fs.readFileSync(SQL.workforceSeedPosttest, 'utf8')
  assert.ok(seed.length > 200)
  assert.equal(post.split(seed).length - 1, 2, 'the posttest runs the list twice (idempotency), verbatim')
  for (const id of ['emp_ceo', 'emp_coo', 'emp_cfo', 'emp_head_acquisitions', 'emp_head_marketing', 'emp_head_dispositions', 'emp_head_data', 'emp_ops_supervisor', 'emp_research_01']) assert.ok(seed.includes(`"${id}"`), id)
  assert.match(seed, /"display_name": "Atlas"/)
  assert.match(seed, /"display_name": "Ledger"/)
  assert.doesNotMatch(seed, /acquisition_agent|"markets"/, 'no acquisition agent and no market is seeded')
  const src = fs.readFileSync(SQL.workforceSeed, 'utf8')
  assert.match(src, /runtime_upsert_schedule\('workforce-dispatch', 'workforce\.dispatch', 60, v_owner::text, '\{\}'::jsonb, false, null, 0\)/, 'the schedule is born disabled')
  assert.match(src, /^begin;$/m)
  assert.match(src, /^commit;$/m)
  const mig = fs.readFileSync(SQL.workforce, 'utf8')
  assert.doesNotMatch(mig.replace(/--[^\n]*/g, ''), /^\s*(begin|commit)\s*;/im, 'the migration carries no BEGIN/COMMIT (the runner wraps it)')
  assert.doesNotMatch(mig, /kind_limits\s*=/, 'the migration never arms a kind')
})

test('PG workforce: preconditions RAISE; pretest changes nothing; apply; posttests pass and leave no trace; rollback refuses an active mission, then restores the schema exactly; re-apply', { skip }, async () => {
  const db = await freshDb()
  try {
    // preconditions: without the R2 runtime the migration RAISES (and creates nothing)
    await assert.rejects(applyInTransaction(db.pool, SQL.workforce), /R2 runtime/)
    assert.equal((await sel(db.pool, "select to_regnamespace('workforce') r"))[0].r, null)
    await applyWorkforceChain(db.pool, { workforce: false })
    const before = await fingerprint(db.pool)
    const p1 = psql(db.url, SQL.workforcePretest)
    if (!p1.skipped) {
      assert.equal(p1.status, 0, p1.out)
      assert.match(p1.out, /prerequisites OK/)
      assert.equal(await fingerprint(db.pool), before, 'the pretest leaves no trace')
    }
    await applyInTransaction(db.pool, SQL.workforce)
    const applied = await fingerprint(db.pool)
    assert.notEqual(applied, before)
    await assert.rejects(applyInTransaction(db.pool, SQL.workforce), /already exists/, 'a second apply RAISES')
    if (!p1.skipped) {
      assert.notEqual(psql(db.url, SQL.workforcePretest).status, 0, 'the pretest refuses a second apply')
      for (const f of [SQL.workforcePosttest, SQL.workforceSeedPosttest]) {
        const r = psql(db.url, f)
        assert.equal(r.status, 0, r.out)
        assert.match(r.out, /ALL OK \(rolled back\)/)
        assert.equal(await fingerprint(db.pool), applied, `${f} leaves no trace`)
      }
    }
    // the real seed: refuses a non-owner, seeds the executive staff for an owner, is idempotent
    if (!p1.skipped) {
      const refused = psql(db.url, SQL.workforceSeed, { owner_id: OWNER })
      assert.notEqual(refused.status, 0)
      assert.match(refused.out, /is not an owner/)
      assert.equal(Number((await sel(db.pool, 'select count(*) n from workforce.employee'))[0].n), 0, 'a refused seed writes nothing')
      await db.pool.query("insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test')", [ORG, OWNER])
      for (let i = 0; i < 2; i += 1) {
        const r = psql(db.url, SQL.workforceSeed, { owner_id: OWNER })
        assert.equal(r.status, 0, r.out)
      }
      const emp = await sel(db.pool, 'select employee_id, kind, role_key, user_id::text u, status from workforce.employee order by employee_id')
      assert.equal(emp.length, 9)
      assert.deepEqual(emp.filter((e) => e.role_key === 'ceo').map((e) => [e.employee_id, e.kind, e.u]), [['emp_ceo', 'human', OWNER]])
      const s = await sel(db.pool, "select kind, enabled, interval_seconds from agent.runtime_schedule where name = 'workforce-dispatch'")
      assert.deepEqual(s, [{ kind: 'workforce.dispatch', enabled: false, interval_seconds: 60 }])
      assert.equal((await sel(db.pool, "select count(*)::int n from agent.runtime_limits, jsonb_object_keys(kind_limits) k where k like 'workforce.%'"))[0].n, 0)
    }
    // a live mission blocks the rollback
    if (p1.skipped) await db.pool.query("insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test')", [ORG, OWNER])
    await db.pool.query(`select workforce.employee_upsert($1, jsonb_build_object('employee_id', 'emp_coo', 'kind', 'ai', 'role_key', 'coo', 'department_key', 'executive', 'display_name', 'Atlas'), $2)`, [ORG, OWNER])
    const m = (await sel(db.pool, `select workforce.mission_open($1, 'Triage', 'find sellers', $2, 'emp_coo', 50, null, 'k1') -> 'mission' ->> 'mission_id' id`, [ORG, OWNER]))[0].id
    await assert.rejects(applyInTransaction(db.pool, SQL.workforceRollback), /mission\(s\) still active/)
    assert.equal(await fingerprint(db.pool) === before, false, 'nothing was dropped')
    await db.pool.query(`select workforce.mission_transition($1, $2, 'cancelled')`, [ORG, m])
    await applyInTransaction(db.pool, SQL.workforceRollback)
    if (!p1.skipped) {
      const rp = psql(db.url, SQL.workforceRollbackPosttest)
      assert.equal(rp.status, 0, rp.out)
    }
    assert.equal(await fingerprint(db.pool), before, 'the rollback drops exactly what was created (and the seed schedule)')
    await applyInTransaction(db.pool, SQL.workforceRollback)   // idempotent: nothing to do
    if (!p1.skipped) assert.equal(psql(db.url, SQL.workforcePretest).status, 0, 'the pretest passes again')
    await applyInTransaction(db.pool, SQL.workforce)
    assert.equal(await fingerprint(db.pool), applied, 're-apply restores the same schema')
  } finally {
    await db.drop()
  }
})

test('PG workforce: the migration also applies on the S3 payload body without the rc-8.5.21 opaque-id fix', { skip }, async () => {
  const db = await freshDb({ opaqueIds: false })
  try {
    await applyWorkforceChain(db.pool)
    assert.equal((await sel(db.pool, "select count(*)::int n from pg_proc where pronamespace = 'workforce'::regnamespace"))[0].n > 30, true)
    await runSqlFile(db.pool, SQL.payloadOpaqueIds)
  } finally {
    await db.drop()
  }
})
