#!/usr/bin/env node
// Isolation proof: the agent S3 migration and another PROPOSED migration (default:
// PROPOSED_20261009100000_entity_contact_role_evidence_v2) share NO objects,
// schemas, functions or grants, and apply in EITHER order to the same catalog.
//
// Disposable local Postgres only (loopback guard). The other migration is read
// from a path (it lives on feat, not on this branch):
//   AGENT_S3_PROOF_DB_URL=postgres://postgres@127.0.0.1:55417/postgres \
//   OTHER_MIGRATION=/path/to/PROPOSED_20261009100000_entity_contact_role_evidence_v2.sql \
//   OTHER_ROLLBACK=/path/to/..._rollback.sql \
//   node scripts/proof/agent-s3-migration-isolation-proof.mjs
//
// The other migration's SQL functions reference seller.* tables that a scratch
// DB does not have, so it is applied with check_function_bodies = off (object
// creation and grants are still real) on top of an empty `seller` schema.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ADMIN = String(process.env.AGENT_S3_PROOF_DB_URL || '').trim()
const OTHER = String(process.env.OTHER_MIGRATION || '').trim()
const OTHER_RB = String(process.env.OTHER_ROLLBACK || '').trim()
if (!ADMIN || !OTHER) { console.error('AGENT_S3_PROOF_DB_URL and OTHER_MIGRATION are required'); process.exit(2) }
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(ADMIN).hostname)) { console.error('not a local scratch database. Refusing.'); process.exit(2) }

const here = path.dirname(fileURLToPath(import.meta.url))
const API = path.resolve(here, '../..')
const REPO = path.resolve(API, '../..')
const F = {
  shim: path.join(API, 'tests/pg/supabase-shim.sql'),
  durability: path.join(API, 'supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql'),
  pretest: path.join(REPO, 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence_pretest.sql'),
  agent: path.join(REPO, 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence.sql'),
  agentRb: path.join(REPO, 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence_rollback.sql'),
}
const read = (f) => fs.readFileSync(f, 'utf8')

async function db() {
  const name = `iso_${crypto.randomBytes(4).toString('hex')}`
  const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`create database ${name}`); await a.end()
  const u = new URL(ADMIN); u.pathname = `/${name}`
  const c = new pg.Client({ connectionString: u.toString() }); await c.connect()
  await c.query(read(F.shim)); await c.query(read(F.durability)); await c.query('create schema if not exists seller')
  return { c, name, async drop() { await c.end(); const x = new pg.Client({ connectionString: ADMIN }); await x.connect(); await x.query(`drop database ${name} with (force)`); await x.end() } }
}
const applyAgent = async (c) => { await c.query(read(F.pretest)); await c.query(read(F.agent)) }
const applyOther = async (c) => { await c.query('begin'); await c.query('set local check_function_bodies = off'); await c.query(read(OTHER)); await c.query('commit') }

/** Every user object + its ACL, keyed so two catalogs can be compared. */
async function catalog(c) {
  const q = `
    select 'schema:'||nspname k, coalesce(nspacl::text,'') acl from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'
    union all select 'rel:'||n.nspname||'.'||c.relname, coalesce(c.relacl::text,'')||'|rls='||c.relrowsecurity::text||c.relforcerowsecurity::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    union all select 'fn:'||p.oid::regprocedure::text, coalesce(p.proacl::text,'')||'|secdef='||p.prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    union all select 'policy:'||schemaname||'.'||tablename||'.'||policyname, qual from pg_policies
    union all select 'trigger:'||t.tgrelid::regclass::text||'.'||t.tgname, '' from pg_trigger t where not t.tgisinternal
    union all select 'defacl:'||coalesce(defaclnamespace::regnamespace::text,'*')||':'||defaclobjtype::text, defaclacl::text from pg_default_acl`
  return new Map((await c.query(q)).rows.map((r) => [r.k, r.acl]))
}

const results = []
const check = (ok, msg) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`) }

const base = await db(); const baseCat = await catalog(base.c); await base.drop()
const A = await db(); await applyAgent(A.c); const catA = await catalog(A.c); await A.drop()
const B = await db(); await applyOther(B.c); const catB = await catalog(B.c); await B.drop()
const added = (cat) => new Map([...cat].filter(([k, v]) => baseCat.get(k) !== v))
const addA = added(catA); const addB = added(catB)
const shared = [...addA.keys()].filter((k) => addB.has(k))
check(shared.length === 0, `no shared objects/schemas/functions/grants/policies/triggers/default ACLs (agent adds ${addA.size}, other adds ${addB.size}, overlap ${shared.length}${shared.length ? ': ' + shared.join(', ') : ''})`)
// the ONLY objects outside schema agent: the scoped policy + agent_api grant on the reused ledger
const OUTSIDE_OK = new Set(['rel:public.idempotency_ledger', 'policy:public.idempotency_ledger.idempotency_ledger_agent_api_scope'])
check([...addA.keys()].every((k) => /(^schema:agent$|agent\.|^defacl:agent:)/.test(k) || OUTSIDE_OK.has(k)), 'every object the agent migration adds lives in schema agent (plus the scoped agent_api policy/grant on public.idempotency_ledger)')
check([...addB.keys()].every((k) => !/agent/.test(k)), 'the other migration adds nothing in schema agent')

const AB = await db(); await applyAgent(AB.c); await applyOther(AB.c); const catAB = await catalog(AB.c)
const BA = await db(); await applyOther(BA.c); await applyAgent(BA.c); const catBA = await catalog(BA.c)
const same = catAB.size === catBA.size && [...catAB].every(([k, v]) => catBA.get(k) === v)
check(same, `agent→other and other→agent produce identical catalogs (${catAB.size} entries)`)
const union = new Map([...baseCat, ...addA, ...addB])
check(catAB.size === union.size && [...union].every(([k, v]) => catAB.get(k) === v), 'combined catalog == base ∪ agent ∪ other (neither changes the other)')
// rollbacks are independent too
await AB.c.query(read(F.agentRb))
const afterAgentRb = await catalog(AB.c)
check([...addB].every(([k, v]) => afterAgentRb.get(k) === v), 'agent rollback leaves every object of the other migration intact')
if (OTHER_RB) {
  await BA.c.query('begin'); await BA.c.query(read(OTHER_RB)); await BA.c.query('commit')
  const afterOtherRb = await catalog(BA.c)
  check([...addA].every(([k, v]) => afterOtherRb.get(k) === v), 'other rollback leaves every agent object intact')
}
await AB.drop(); await BA.drop()
process.exit(results.every(Boolean) ? 0 : 1)
