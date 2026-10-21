// Disposable-Postgres harness for the agent S3 persistence tests.
//
// AGENT_PG_TEST_DB_URL must point at a LOCAL scratch server (loopback only,
// fail-closed — same guard as scripts/proof/durable-state-concurrency-proof.mjs).
// Each call to freshDb() creates a brand-new database, applies:
//   tests/pg/supabase-shim.sql                    (roles + auth.uid(), test only)
//   apps/api/supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql
//   supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence_pretest.sql
//   supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence.sql
//   supabase/migrations/PROPOSED_20261019120000_payload_clean_opaque_ids.sql (unless { opaqueIds: false })
// and returns a pool + a drop() that removes the database.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
export const API_DIR = path.resolve(here, '../..')
export const REPO_DIR = path.resolve(API_DIR, '../..')
export const SQL = {
  shim: path.join(here, 'supabase-shim.sql'),
  durability: path.join(API_DIR, 'supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql'),
  pretest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence_pretest.sql'),
  migration: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence.sql'),
  rollback: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence_rollback.sql'),
  // rc-8.5.21: the payload CHECK never rejects random UUID / opaque hex id tokens (applied after S3, as in production)
  payloadOpaqueIds: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261019120000_payload_clean_opaque_ids.sql'),
  // read-only research agent (companion; applied after the S3 migration)
  researchPretest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261010130000_agent_research_ro_pretest.sql'),
  research: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261010130000_agent_research_ro.sql'),
  researchRollback: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261010130000_agent_research_ro_rollback.sql'),
  // R2 persistent runtime (applied after the research migration; no BEGIN/COMMIT inside — see applyInTransaction)
  runtimePretest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261012140000_intel_runtime_pretest.sql'),
  // rc-8.5.15.1: the apply → assert → ROLLBACK half of the old pretest (a fixture never includes a file)
  runtimePosttest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261012140000_intel_runtime_posttest.sql'),
  runtime: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261012140000_intel_runtime.sql'),
  runtimeRollback: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261012140000_intel_runtime_rollback.sql'),
}

/** Apply a migration file that carries no BEGIN/COMMIT in ONE transaction (psql --single-transaction equivalent). */
export async function applyInTransaction(pool, file) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query(fs.readFileSync(file, 'utf8'))
    await c.query('commit')
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export const ADMIN_URL = String(process.env.AGENT_PG_TEST_DB_URL || '').trim()

export function pgAvailable() {
  if (!ADMIN_URL) return false
  const host = new URL(ADMIN_URL).hostname
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`AGENT_PG_TEST_DB_URL host "${host}" is not a local scratch database. Refusing.`)
  }
  return true
}

export const skipReason = 'AGENT_PG_TEST_DB_URL not set (disposable local PostgreSQL 17); CI runs these in .github/workflows/agent-s3-persistence.yml'

export function urlFor(db, user = null) {
  const u = new URL(ADMIN_URL)
  u.pathname = `/${db}`
  if (user) { u.username = user; u.password = '' }
  return u.toString()
}

export async function runSqlFile(pool, file) {
  await pool.query(fs.readFileSync(file, 'utf8'))
}

/** Fresh database with the S3 schema applied (unless { apply: false }). */
export async function freshDb({ apply = true, opaqueIds = true } = {}) {
  const name = `agent_s3_${crypto.randomBytes(5).toString('hex')}`
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
  await admin.query(`create database ${name}`)
  await admin.end()
  const pool = new pg.Pool({ connectionString: urlFor(name), max: 12 })
  pool.on('error', () => {}) // idle clients are terminated by drop(); never an unhandled error
  await runSqlFile(pool, SQL.shim)
  await runSqlFile(pool, SQL.durability)
  if (apply) {
    await runSqlFile(pool, SQL.pretest)
    await runSqlFile(pool, SQL.migration)
    if (opaqueIds) await runSqlFile(pool, SQL.payloadOpaqueIds)
  }
  const extraPools = []
  // the API's least-privilege role (the companion *_api_login.sql enables LOGIN in prod)
  if (apply) await pool.query('alter role agent_api login')
  const apiUrl = urlFor(name, 'agent_api')
  const track = (p) => { p.on('error', () => {}); extraPools.push(p); return p }
  const api = apply ? track(new pg.Pool({ connectionString: apiUrl, max: 12 })) : null
  return {
    name,
    pool,
    api,
    trackPool: track,
    /** after applying the migration by hand: enable agent_api login and return its pool */
    async enableApi() {
      await pool.query('alter role agent_api login')
      return track(new pg.Pool({ connectionString: apiUrl, max: 6 }))
    },
    url: urlFor(name),
    apiUrl,
    /** extra pool connecting as agent_api (what the API uses) */
    newPool(max = 4) {
      return track(new pg.Pool({ connectionString: apiUrl, max }))
    },
    async drop() {
      for (const p of extraPools) await p.end().catch(() => {})
      await pool.end().catch(() => {})
      const a = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
      await a.query(`drop database if exists ${name} with (force)`).catch(() => {})
      await a.end()
    },
  }
}

/** Run a query as a Supabase role with JWT claims (RLS checks). */
export async function asRole(pool, role, sub, sql, params = []) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    if (sub) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub])
    await c.query(`set local role ${role}`)
    const r = await c.query(sql, params)
    await c.query('rollback')
    return r
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}
