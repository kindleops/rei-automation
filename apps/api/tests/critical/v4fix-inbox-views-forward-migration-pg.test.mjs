// rc-8.5.21 v4 fix pass — the FORWARD inbox bucket view migration (PROPOSED_20261020120500) refuses on
// drift and succeeds only on the production 10-10 body. DISPOSABLE PostgreSQL 17 only
// (AGENT_PG_TEST_DB_URL; skipped — reported — without it). Never production.
//   precondition  md5(pg_get_viewdef('public.v_inbox_thread_state_buckets'::regclass)) =
//                 'edba02b93d68b768a408a96614a35dad' (and v_inbox_bucket_counts = '140bccf2…'); the 10-10 body
//                 seeded here reproduces BOTH md5 values byte-for-byte on PG17, so there is no override
//   postcondition the declined_unverified mapping exists; dependants (v_inbox_bucket_counts, v_inbox_zero_counts) kept
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { pgAvailable, skipReason, freshDb, REPO_DIR } from '../pg/agent-pg-harness.mjs'

const skip = pgAvailable() ? false : skipReason
const F = (p) => fs.readFileSync(path.join(REPO_DIR, p), 'utf8')
const MIG = 'supabase/migrations/PROPOSED_20261020120500_inbox_bucket_views_declined_unverified'
const BASE = 'scripts/db/fixtures/inbox_bucket_views_public_baseline.sql'
const DEP = 'scripts/db/fixtures/inbox_zero_counts_dependant.sql'

async function productionState() {
  const db = await freshDb({ apply: false })
  await db.pool.query(F(BASE))
  await db.pool.query(F(`${MIG}_rollback.sql`)) // = the production 10-10 body
  await db.pool.query(F(DEP))
  return db
}
const md5 = async (pool, v) => (await pool.query(`select md5(pg_get_viewdef($1::regclass)) as m`, [v])).rows[0].m
const def = async (pool) => (await pool.query(`select pg_get_viewdef('public.v_inbox_thread_state_buckets'::regclass) as d`)).rows[0].d

async function applyMigration(pool) {
  const c = await pool.connect()
  try { await c.query(F(`${MIG}.sql`)); return { ok: true } } catch (e) { await c.query('rollback').catch(() => {}); return { ok: false, error: String(e.message) } } finally { c.release() }
}

test('PG forward view migration: the seeded 10-10 body has the production md5 values; apply succeeds; the mapping exists; dependants kept; a re-run refuses (already applied)', { skip }, async () => {
  const db = await productionState()
  try {
    assert.equal(await md5(db.pool, 'public.v_inbox_thread_state_buckets'), 'edba02b93d68b768a408a96614a35dad', 'PG17 reproduces the production buckets md5 from the 10-10 body')
    assert.equal(await md5(db.pool, 'public.v_inbox_bucket_counts'), '140bccf254cf97faf339c2e88d1cbf9a', 'PG17 reproduces the production counts md5')
    const r = await applyMigration(db.pool)
    assert.equal(r.ok, true, r.error)
    assert.match(await def(db.pool), /declined_unverified/)
    await db.pool.query(`insert into public.inbox_thread_state (thread_key, disposition, latest_direction, last_intent, is_archived, is_suppressed) values ('+15550002001', 'declined_unverified', 'inbound', 'ownership_declined_unverified', false, false)`)
    const row = (await db.pool.query(`select in_dead, f_closed_disposition, f_reply_resolved from public.v_inbox_thread_state_buckets where thread_key = '+15550002001'`)).rows[0]
    assert.deepEqual(row, { in_dead: true, f_closed_disposition: true, f_reply_resolved: true })
    assert.ok((await db.pool.query('select * from public.v_inbox_zero_counts')).rows.length === 1, 'the dependant v_inbox_zero_counts still resolves')
    assert.equal(Number((await db.pool.query(`select count(*) as n from information_schema.columns where table_schema = 'public' and table_name = 'v_inbox_bucket_counts'`)).rows[0].n), 21)
    // already applied ⇒ the precondition refuses (nothing changes)
    const again = await applyMigration(db.pool)
    assert.equal(again.ok, false)
    assert.match(again.error, /refused/)
  } finally { await db.drop() }
})

test('PG forward view migration REFUSES on drift (any buckets body but production\'s) and changes nothing', { skip }, async () => {
  const db = await productionState()
  try {
    // drift: a hand edit of the production body (one predicate changed, same columns)
    const drifted = F(`${MIG}_rollback.sql`).replace("then 'cold'", "then 'cold' ") .replace("array['sold','unqualified']) then 'dead'", "array['sold','unqualified','x_drift']) then 'dead'")
    assert.notEqual(drifted, F(`${MIG}_rollback.sql`))
    await db.pool.query(drifted)
    const before = await def(db.pool)
    assert.notEqual(await md5(db.pool, 'public.v_inbox_thread_state_buckets'), 'edba02b93d68b768a408a96614a35dad')
    const r = await applyMigration(db.pool)
    assert.equal(r.ok, false, 'refused')
    assert.match(r.error, /refused — v_inbox_thread_state_buckets definition md5/)
    assert.equal(await def(db.pool), before, 'nothing changed')
    assert.ok(!/declined_unverified/.test(before))
  } finally { await db.drop() }
})
