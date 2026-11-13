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
  // LeadCommand Workforce Phase A (docs/WORKFORCE.md §2; no BEGIN/COMMIT inside — see applyInTransaction)
  workforcePretest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100000_workforce_foundation_pretest.sql'),
  workforce: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100000_workforce_foundation.sql'),
  workforcePosttest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100000_workforce_foundation_posttest.sql'),
  workforceRollback: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100000_workforce_foundation_rollback.sql'),
  workforceRollbackPosttest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100000_workforce_foundation_rollback_posttest.sql'),
  workforceSeed: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100100_workforce_seed.sql'),
  workforceSeedPosttest: path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261022100100_workforce_seed_posttest.sql'),
}

// public tables agent.ops_health_snapshot (R2) reads (same fixture as tests/critical/agent-runtime-pg.test.mjs)
export const RUNTIME_PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  create index if not exists idx_send_queue_status_sched on public.send_queue (queue_status, scheduled_for);
  revoke all on public.system_control, public.send_queue from agent_api;`

/** S3 (+ opaque ids) → research → R2 runtime → Workforce, on an already-created S3 database. */
export async function applyWorkforceChain(pool, { workforce = true } = {}) {
  await runSqlFile(pool, SQL.researchPretest)
  await runSqlFile(pool, SQL.research)
  await pool.query(RUNTIME_PUBLIC_FIXTURE)
  await applyInTransaction(pool, SQL.runtime)
  if (workforce) await applyInTransaction(pool, SQL.workforce)
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

/**
 * Fresh database with the S3 schema applied (unless { apply: false }).
 * { workforce: true } also applies the research + R2 runtime chain and the Workforce migration.
 */
export async function freshDb({ apply = true, opaqueIds = true, workforce = false } = {}) {
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
    if (workforce) await applyWorkforceChain(pool)
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

/**
 * Workforce databases, fast: ONE template database carries S3 → research → R2 → Workforce; every
 * fresh() is CREATE DATABASE … TEMPLATE (≈ 100 ms) with a superuser pool and an agent_api pool.
 */
export async function workforceDbFactory() {
  const tpl = await freshDb({ workforce: true })
  await tpl.pool.query('alter role agent_api login')
  const template = tpl.name
  for (const p of [tpl.api]) await p?.end().catch(() => {})
  await tpl.pool.end().catch(() => {})
  const made = []
  return {
    template,
    async fresh() {
      const name = `wf_${crypto.randomBytes(5).toString('hex')}`
      const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
      try { await admin.query(`create database ${name} template ${template}`) } finally { await admin.end() }
      const pool = new pg.Pool({ connectionString: urlFor(name), max: 8 })
      const api = new pg.Pool({ connectionString: urlFor(name, 'agent_api'), max: 8 })
      pool.on('error', () => {})
      api.on('error', () => {})
      const db = {
        name, pool, api, url: urlFor(name), apiUrl: urlFor(name, 'agent_api'),
        async drop() {
          await api.end().catch(() => {})
          await pool.end().catch(() => {})
          const a = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
          await a.query(`drop database if exists ${name} with (force)`).catch(() => {})
          await a.end()
        },
      }
      made.push(db)
      return db
    },
    async dropAll() {
      for (const db of made) await db.drop().catch(() => {})
      const a = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
      await a.query(`drop database if exists ${template} with (force)`).catch(() => {})
      await a.end()
    },
  }
}
