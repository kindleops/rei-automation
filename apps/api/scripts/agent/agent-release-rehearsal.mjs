#!/usr/bin/env node
// Release REHEARSAL for the read-only agent migrations — DISPOSABLE DATABASE ONLY, ALWAYS ROLLBACK.
//
//   node apps/api/scripts/agent/agent-release-rehearsal.mjs --db-url <loopback url> [--owner <uuid>]
//   (or LC_TEST_DB_URL=<loopback url>)
//
// Owner boundary 2026-10-15 (after the 2026-10-14 incident): migration / pretest /
// rollback SQL never runs against production, not even inside BEGIN … ROLLBACK.
// This script used to take a production URL file and rehearse ON PRODUCTION;
// it now refuses every production-like target (scripts/db/db-target-guard.mjs) and
// reads its URL only from --db-url / LC_TEST_DB_URL.
//
// Runs, in ONE transaction on ONE connection, then rolls back unconditionally:
//   S3 pretest → S3 migration → research pretest → research migration →
//   membership seed for the owner → the read-only verify query → ROLLBACK
// and afterwards proves nothing remains (agent.run, the research tables and the
// agent_api role are all absent again).
//
// WHY THIS EXISTS: both migration files carry their own `begin; … commit;`.
// Wrapping them in psql `BEGIN; \i … ROLLBACK;` or `psql -1` would COMMIT at the
// file's own `commit;` — the rehearsal would silently become the real apply.
// This runner strips exactly the one leading `begin;` and the one trailing
// `commit;` of each migration and refuses if any other transaction-control
// statement is present.
//
// Prints check names and booleans only — never the URL, never row data.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { assertDisposableTarget } from '../../../../scripts/db/db-target-guard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '../../../..')
const MIG = (f) => path.join(REPO, 'supabase/migrations', f)
const FILES = {
  s3Pretest: MIG('PROPOSED_20261010120000_agent_s3_persistence_pretest.sql'),
  s3: MIG('PROPOSED_20261010120000_agent_s3_persistence.sql'),
  researchPretest: MIG('PROPOSED_20261010130000_agent_research_ro_pretest.sql'),
  research: MIG('PROPOSED_20261010130000_agent_research_ro.sql'),
  verify: MIG('PROPOSED_20261010130000_agent_research_ro_verify.sql'),
}
const TXN_RE = /^\s*(begin|start\s+transaction|commit|end|rollback|savepoint|release)\b[^;]*;\s*$/im

export function stripOuterTransaction(sql, name) {
  const lines = sql.split('\n')
  const isBegin = (l) => /^\s*begin\s*;\s*$/i.test(l)
  const isCommit = (l) => /^\s*commit\s*;\s*$/i.test(l)
  const b = lines.findIndex(isBegin)
  let c = -1
  for (let i = lines.length - 1; i >= 0; i--) if (isCommit(lines[i])) { c = i; break }
  if (b < 0 || c < 0 || c < b) throw new Error(`${name}: expected exactly one outer begin; … commit;`)
  const inner = [...lines.slice(0, b), ...lines.slice(b + 1, c), ...lines.slice(c + 1)].join('\n')
  // inside DO $$ … $$ bodies plpgsql has no transaction control we use; refuse any remaining top-level one
  const outsideDollar = inner.replace(/\$\$[\s\S]*?\$\$/g, '')
  if (TXN_RE.test(outsideDollar)) throw new Error(`${name}: another transaction-control statement is present; refusing`)
  return inner
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : null
}

export async function rehearse({ url, owner = null, log = console.log, ssl = undefined } = {}) {
  assertDisposableTarget(url) // throws before any connection on a production-like target
  const client = new pg.Client({ connectionString: url, ssl, application_name: 'lc-agent-release-rehearsal', statement_timeout: 120_000, query_timeout: 180_000, connectionTimeoutMillis: 15_000 })
  await client.connect()
  const out = { ok: false, checks: [], after: null }
  // cluster-level roles survive across databases: compare with the state BEFORE the rehearsal
  const before = (await client.query(`select exists (select 1 from pg_roles where rolname = 'agent_api') as role_existed`)).rows[0]
  try {
    await client.query('begin isolation level read committed')
    await client.query(fs.readFileSync(FILES.s3Pretest, 'utf8'))
    log('rehearsal: S3 pretest OK')
    await client.query(stripOuterTransaction(fs.readFileSync(FILES.s3, 'utf8'), 's3'))
    log('rehearsal: S3 migration applied (inside the rehearsal transaction)')
    await client.query(fs.readFileSync(FILES.researchPretest, 'utf8'))
    log('rehearsal: research pretest OK')
    await client.query(stripOuterTransaction(fs.readFileSync(FILES.research, 'utf8'), 'research'))
    log('rehearsal: research migration applied (inside the rehearsal transaction)')
    if (owner) {
      await client.query(`select agent.sync_operator_membership('00000000-0000-4000-8000-00000000a001', array[$1]::uuid[], array[$1]::uuid[], 'rehearsal')`, [owner])
      const m = await client.query(`select count(*)::int n, bool_and(role = 'owner') o from agent.operator_membership`)
      out.checks.push({ check: 'membership seeded: exactly the owner, role owner', ok: m.rows[0].n === 1 && m.rows[0].o === true })
    }
    const v = await client.query(fs.readFileSync(FILES.verify, 'utf8'))
    for (const r of v.rows) out.checks.push({ check: r.check, ok: r.ok === true })
  } finally {
    await client.query('rollback').catch(() => {})
  }
  const after = await client.query(`select to_regclass('agent.run') is null as no_run, to_regclass('agent.spend_ledger') is null as no_ledger, not exists (select 1 from pg_roles where rolname = 'agent_api') as no_role, not exists (select 1 from pg_namespace where nspname = 'agent') as no_schema`)
  await client.end()
  out.after = { ...after.rows[0], no_role: after.rows[0].no_role || before.role_existed === true, role_existed_before: before.role_existed }
  out.ok = out.checks.length > 0 && out.checks.every((c) => c.ok) && out.after.no_run && out.after.no_ledger && out.after.no_role && out.after.no_schema
  for (const c of out.checks) log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.check}`)
  log(`after ROLLBACK: ${JSON.stringify(out.after)}`)
  log(out.ok ? 'REHEARSAL PASS (nothing was committed)' : 'REHEARSAL FAIL')
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (arg('--db-url-file')) { console.error('--db-url-file was removed (owner boundary 2026-10-15): pass a DISPOSABLE --db-url / LC_TEST_DB_URL'); process.exit(2) }
  const url = arg('--db-url') || process.env.LC_TEST_DB_URL || ''
  if (!url) { console.error('usage: --db-url <loopback url of a disposable database> [--owner <uuid>]  (or LC_TEST_DB_URL)'); process.exit(2) }
  try { assertDisposableTarget(url) } catch (e) { console.error(`REHEARSAL REFUSED: ${e.message}`); process.exit(3) }
  rehearse({ url, owner: arg('--owner'), ssl: false })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error(`REHEARSAL ERROR: ${String(e.message).slice(0, 400)}`); process.exit(1) })
}
