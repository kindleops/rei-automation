#!/usr/bin/env node
// MIGRATION TEST RUNNER — disposable PostgreSQL only (rc-8.5.15.1).
//
// Owner boundary 2026-10-15: migration, rollback and pretest SQL never runs
// against production, not even inside BEGIN … ROLLBACK. This runner is the one
// sanctioned way to exercise a migration and its fixtures:
//
//   setup → pretest (must change nothing) → [pre-apply fixtures] → APPLY →
//   verify → posttest → ROLLBACK FILE(S) → rollback posttest →
//   schema must equal the pre-apply fingerprint → pretest again → RE-APPLY →
//   verify → posttest
//
// on a database it creates itself and drops afterwards, on a server that is
// either
//   (a) a fresh cluster it initdb's into a temp / --data-root directory,
//       listening on a unix socket only (no TCP at all):
//         --pg-bin <dir with initdb, pg_ctl, postgres>   (or LC_PG_BIN)
//   (b) an existing LOCAL scratch server (CI service container on 127.0.0.1):
//         --admin-url <libpq url>                         (or LC_MIGRATION_TEST_ADMIN_URL)
// Every target goes through db-target-guard.assertDisposableTarget: Supabase /
// production-like hosts are refused always; anything not loopback or a unix
// socket is refused unless LC_DISPOSABLE_DB_HOST names it. After connecting it
// also refuses a server that carries Supabase platform roles. Every fixture is
// linted first (lint-migration-fixtures.mjs); a fixture that fails the lint is
// never executed.
//
//   node scripts/db/run-migration-test.mjs --list
//   node scripts/db/run-migration-test.mjs --pg-bin <dir> [--data-root <dir>] --all
//   node scripts/db/run-migration-test.mjs --admin-url postgres://postgres:postgres@127.0.0.1:5432/postgres --id intel_runtime
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertDisposableTarget, sanitizedPgEnv, UnsafeDbTargetError } from './db-target-guard.mjs'
import { lintFixtureSource, classifyFile } from './lint-migration-fixtures.mjs'
import { lexPsqlScript, leadingWords } from './sql-fixture-lexer.mjs'
import { MIGRATION_TESTS, PROD_SHAPE } from './migration-tests.manifest.mjs'

// A production-shaped database = a SCHEMA-ONLY snapshot (pg_dump --schema-only of production,
// taken read-only) restored into the disposable database before the test's own setup. The
// snapshot is a local input, never committed; it must contain no data and no transaction control
// beyond what pg_dump emits.
export const PROD_SHAPE_ENV = 'LC_PROD_SHAPE_SETUP'
export function assertSnapshotFile(f) {
  const src = fs.readFileSync(f, 'utf8')
  if (/^-- Data for Name: |^COPY \S+.* FROM stdin;$|^INSERT INTO /m.test(src)) throw new UnsafeDbTargetError(`refused: ${path.basename(f)} carries row data — a production-shaped snapshot must be schema-only`)
  for (const item of lexPsqlScript(src)) {
    if (item.kind === 'meta' && /^(i|ir|include|include_relative|c|connect|!|gexec)$/.test(item.command)) throw new UnsafeDbTargetError(`refused: ${path.basename(f)} includes / reconnects / runs shell (line ${item.line})`)
    if (item.kind === 'statement' && /^(BEGIN|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|START|PREPARE)$/.test(leadingWords(item.text, 1)[0] || '')) throw new UnsafeDbTargetError(`refused: ${path.basename(f)} carries transaction control (line ${item.line})`)
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '../..')
export const SCRATCH_SCHEMA = 'lc_mt' // runner-owned cross-stage state; excluded from fingerprints

// ── target resolution ───────────────────────────────────────────────────────

/**
 * Resolve the admin target, refusing anything that is not disposable.
 * Exported for the refusal tests.
 */
export function resolveAdminTarget({ adminUrl = null, pgBin = null, env = process.env } = {}) {
  const url = adminUrl || env.LC_MIGRATION_TEST_ADMIN_URL || null
  const bin = pgBin || env.LC_PG_BIN || null
  if (url && bin) throw new UnsafeDbTargetError('give either --admin-url or --pg-bin, not both')
  if (url) {
    assertDisposableTarget(url, { env })
    return { mode: 'url', url }
  }
  if (bin) return { mode: 'cluster', bin }
  throw new UnsafeDbTargetError('no disposable server: pass --pg-bin <dir> (fresh cluster) or --admin-url <loopback url>')
}

function urlForDb(adminUrl, db) {
  if (/^postgres(?:ql)?:\/\//i.test(adminUrl)) {
    const m = /^(postgres(?:ql)?:\/\/[^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/i.exec(adminUrl)
    return `${m[1]}/${db}${m[3] || ''}`
  }
  return `${adminUrl} dbname=${db}`
}

function psqlBin(env = process.env) {
  return env.LC_PSQL || 'psql'
}

function runPsql(url, args, { env, input = null } = {}) {
  assertDisposableTarget(url, { env: process.env })
  const r = spawnSync(psqlBin(), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, ...args], {
    encoding: 'utf8',
    env: sanitizedPgEnv(process.env, env || {}),
    input: input ?? undefined,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function sql(url, text, env) {
  const r = runPsql(url, ['-At', '-F', '\t', '-c', text], { env })
  if (r.status !== 0) throw new Error(`psql -c failed: ${r.stderr.trim().slice(0, 800)}`)
  return r.stdout.trim()
}

// ── fresh cluster (unix socket only) ────────────────────────────────────────

export function startCluster({ bin, dataRoot = null, log = () => {} }) {
  const root = dataRoot ? fs.mkdtempSync(path.join(path.resolve(dataRoot), 'cluster-')) : fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mt-'))
  const data = path.join(root, 'data')
  const sock = fs.mkdtempSync('/tmp/lcmt-') // short: unix socket paths are length-limited
  const exe = (name) => path.join(bin, name)
  const env = sanitizedPgEnv(process.env)
  const init = spawnSync(exe('initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--no-locale', '--no-instructions'], { encoding: 'utf8', env })
  if (init.status !== 0) throw new Error(`initdb failed: ${(init.stderr || init.stdout || '').slice(0, 800)}`)
  const opts = `-c listen_addresses='' -k ${sock} -c port=5432 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`
  const start = spawnSync(exe('pg_ctl'), ['-D', data, '-o', opts, '-l', path.join(root, 'server.log'), '-w', '-t', '60', 'start'], { encoding: 'utf8', env })
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${(start.stderr || start.stdout || '').slice(0, 800)}`)
  const url = `postgresql://postgres@/postgres?host=${encodeURIComponent(sock)}&port=5432`
  log(`cluster: started (unix socket only) data=${data}`)
  return {
    url,
    root,
    stop() {
      spawnSync(exe('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8', env })
      fs.rmSync(sock, { recursive: true, force: true })
      log('cluster: stopped')
    },
  }
}

// ── safety checks after connecting ─────────────────────────────────────────

function assertServerIsDisposable(adminUrl) {
  const out = sql(adminUrl, `select coalesce(string_agg(rolname, ','), '') from pg_roles where rolname in ('supabase_admin','supabase_auth_admin','supabase_storage_admin','supabase_replication_admin','pgbouncer')`)
  if (out) throw new UnsafeDbTargetError(`refused: the server carries Supabase platform roles (${out}) — not a disposable database`)
}

// ── fingerprint ────────────────────────────────────────────────────────────

const FINGERPRINT_SQL = `
with ns as (select oid, nspname from pg_namespace where nspname not in ('pg_catalog','information_schema','pg_toast','${SCRATCH_SCHEMA}') and nspname not like 'pg_temp%' and nspname not like 'pg_toast_temp%')
select 'ns'::text k, n.nspname::text o, coalesce(array_to_string(n.nspacl, ','), '') d from pg_namespace n join ns on ns.oid = n.oid
union all select 'rel', format('%s.%s', ns.nspname, c.relname), format('%s:%s%s:%s', c.relkind, c.relrowsecurity, c.relforcerowsecurity, coalesce(array_to_string(c.relacl, ','), ''))
  from pg_class c join ns on ns.oid = c.relnamespace where c.relkind in ('r','v','m','S','p','f')
union all select 'col', format('%s.%s.%s', table_schema, table_name, column_name), format('%s:%s:%s', data_type, is_nullable, coalesce(column_default, ''))
  from information_schema.columns where table_schema in (select nspname from ns)
union all select 'con', format('%s.%s', conrelid::regclass, conname), pg_get_constraintdef(c.oid) from pg_constraint c join ns on ns.oid = c.connamespace
union all select 'idx', format('%s.%s', schemaname, indexname), indexdef from pg_indexes where schemaname in (select nspname from ns)
union all select 'fn', p.oid::regprocedure::text, format('%s:%s:%s:%s:%s', md5(p.prosrc), p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), coalesce(array_to_string(p.proacl, ','), ''), coalesce(obj_description(p.oid, 'pg_proc'), ''))
  from pg_proc p join ns on ns.oid = p.pronamespace
union all select 'trg', format('%s.%s', t.tgrelid::regclass, t.tgname), format('%s:%s', pg_get_triggerdef(t.oid), t.tgenabled) from pg_trigger t join pg_class c on c.oid = t.tgrelid join ns on ns.oid = c.relnamespace where not t.tgisinternal
union all select 'pol', format('%s.%s.%s', schemaname, tablename, policyname), format('%s:%s:%s:%s', cmd, array_to_string(roles, ','), coalesce(qual, ''), coalesce(with_check, '')) from pg_policies where schemaname in (select nspname from ns)
union all select 'view', format('%s.%s', schemaname, viewname), md5(definition) from pg_views where schemaname in (select nspname from ns)
union all select 'role', rolname::text, format('%s:%s:%s', rolsuper, rolbypassrls, rolcanlogin) from pg_roles where rolname !~ '^pg_'
order by 1, 2`

function fingerprint(url) {
  const out = sql(url, FINGERPRINT_SQL)
  return { hash: crypto.createHash('sha256').update(out).digest('hex').slice(0, 16), lines: out.split('\n') }
}

function rowCounts(url) {
  const out = sql(url, `select coalesce(string_agg(format('%s=%s', c.oid::regclass, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s', c.oid::regclass), false, true, '')))[1]::text), ',' order by c.oid::regclass::text), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname not in ('pg_catalog','information_schema','${SCRATCH_SCHEMA}') and n.nspname not like 'pg_%'`)
  return out
}

function diffLines(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  return { removed: a.filter((x) => !B.has(x)).slice(0, 20), added: b.filter((x) => !A.has(x)).slice(0, 20) }
}

// ── steps ──────────────────────────────────────────────────────────────────

function rel(p) {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p)
}

/** Lint every fixture a test will execute; returns violations (empty = ok). */
export function lintTestFixtures(t) {
  const fixtures = [t.pretest, ...(t.preApply || []), ...t.apply.filter((a) => typeof a === 'object' && a.fixture).map((a) => a.fixture), ...(t.verify || []), ...(t.posttest || []), ...(t.rollbackPosttest || [])].filter(Boolean)
  const out = []
  for (const f of fixtures) {
    const src = fs.readFileSync(rel(f), 'utf8')
    const r = lintFixtureSource(f, src)
    if (r.cls !== 'fixture') out.push({ file: f, line: 0, rule: 'not-a-fixture', detail: `classified as ${r.cls}: name it *_pretest/_posttest/_verify.sql or declare "-- lc-fixture: …"` })
    for (const x of r.violations) out.push({ file: f, ...x })
  }
  for (const f of t.setup || []) {
    if (typeof f !== 'string' || f === PROD_SHAPE) continue
    const src = fs.readFileSync(rel(f), 'utf8')
    if (classifyFile(f, src).cls === 'fixture') for (const x of lintFixtureSource(f, src).violations) out.push({ file: f, ...x })
  }
  return out
}

function hasOwnTransaction(file) {
  const src = fs.readFileSync(rel(file), 'utf8')
  return /^\s*(begin|start\s+transaction)\s*;/im.test(src.replace(/--[^\n]*/g, ''))
}

function applyFile(url, file, env) {
  const args = hasOwnTransaction(file) ? ['-f', rel(file)] : ['--single-transaction', '-f', rel(file)]
  return runPsql(url, args, { env })
}

function runStep(log, name, fn, { tolerateErrors = false } = {}) {
  const t0 = Date.now()
  const r = fn()
  if (tolerateErrors && r) {
    const errors = (r.stderr.match(/ERROR:/g) || []).length
    log(`  ok  ${name} (${Date.now() - t0} ms; ${errors} object(s) not restorable on vanilla PostgreSQL — see the snapshot notes)`)
    return r
  }
  if (r && r.status !== undefined && r.status !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-25).join('\n')
    throw new Error(`${name} FAILED (exit ${r.status})\n${tail}`)
  }
  log(`  ok  ${name} (${Date.now() - t0} ms)`)
  return r
}

function checkVerifyOutput(name, out) {
  const bad = out.split('\n').filter(Boolean).filter((l) => {
    const f = l.split(' | ')
    return (f.length >= 2 ? f[1] : f[0]).trim() === 'f'
  })
  if (bad.length) throw new Error(`${name}: verify rows report ok = false:\n${bad.slice(0, 15).join('\n')}`)
}

/**
 * Run one manifest entry on a fresh database under adminUrl.
 * @returns {{ id: string, ok: boolean, steps: string[], error?: string }}
 */
export function runMigrationTest(t, { adminUrl, log = console.log, keep = false, prodShapeFiles = [] } = {}) {
  assertDisposableTarget(adminUrl)
  if ((t.setup || []).includes(PROD_SHAPE) && !prodShapeFiles.length) {
    return { id: t.id, ok: false, skipped: true, steps: [], error: `needs a production-shaped schema snapshot: --prod-shape <prelude.sql,schema.sql> (or ${PROD_SHAPE_ENV})` }
  }
  for (const f of prodShapeFiles) assertSnapshotFile(f)
  const lint = lintTestFixtures(t)
  if (lint.length) {
    return { id: t.id, ok: false, steps: [], error: `fixture lint failed; nothing executed:\n${lint.map((x) => `${x.file}:${x.line} [${x.rule}] ${x.detail}`).join('\n')}` }
  }
  const db = `lc_mt_${t.id.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 30)}_${crypto.randomBytes(4).toString('hex')}`
  sql(adminUrl, `create database ${db}`)
  const url = urlForDb(adminUrl, db)
  assertDisposableTarget(url)
  const steps = []
  const L = (m) => { steps.push(m); log(m) }
  try {
    L(`[${t.id}] database ${db}`)
    sql(url, `create schema ${SCRATCH_SCHEMA}`)
    for (const s of t.setup || []) {
      if (s === PROD_SHAPE) {
        for (const f of prodShapeFiles) runStep(L, `setup (production-shaped snapshot) ${path.basename(f)}`, () => runPsql(url, ['-v', 'ON_ERROR_STOP=0', '-f', f]), { tolerateErrors: true })
      } else if (typeof s === 'string') runStep(L, `setup ${path.basename(s)}`, () => applyFile(url, s))
      else runStep(L, `setup ${s.name || 'inline'}`, () => runPsql(url, ['-c', s.sql]))
    }
    const cycle = (label) => {
      const fp0 = fingerprint(url)
      const rows0 = rowCounts(url)
      if (t.pretest) {
        runStep(L, `${label}: pretest ${path.basename(t.pretest)}`, () => runPsql(url, ['-f', rel(t.pretest)]))
        const fp1 = fingerprint(url)
        if (fp1.hash !== fp0.hash) throw new Error(`${label}: the pretest changed the schema: ${JSON.stringify(diffLines(fp0.lines, fp1.lines))}`)
        if (rowCounts(url) !== rows0) throw new Error(`${label}: the pretest changed row counts`)
        L(`  ok  ${label}: pretest left no trace (fingerprint ${fp0.hash})`)
      }
      for (const f of t.preApply || []) runStep(L, `${label}: pre-apply ${path.basename(f)}`, () => runPsql(url, ['-f', rel(f)]))
      for (const f of t.apply) {
        if (typeof f === 'object' && f.fixture) runStep(L, `${label}: fixture ${path.basename(f.fixture)}`, () => runPsql(url, ['-f', rel(f.fixture)]))
        else runStep(L, `${label}: APPLY ${path.basename(f)}`, () => applyFile(url, f))
      }
      for (const f of t.verify || []) {
        const r = runStep(L, `${label}: verify ${path.basename(f)}`, () => runPsql(url, ['-At', '-F', ' | ', '-f', rel(f)]))
        checkVerifyOutput(`${label}: verify ${path.basename(f)}`, r.stdout)
      }
      const fpApplied = fingerprint(url)
      for (const f of t.posttest || []) {
        runStep(L, `${label}: posttest ${path.basename(f)}`, () => runPsql(url, ['-f', rel(f)]))
        const fpAfter = fingerprint(url)
        if (fpAfter.hash !== fpApplied.hash) throw new Error(`${label}: the posttest changed the schema (it must end in ROLLBACK): ${JSON.stringify(diffLines(fpApplied.lines, fpAfter.lines))}`)
      }
      return { fp0, rows0 }
    }
    const first = cycle('cycle 1')
    for (const f of [...(t.rollback || [])].reverse()) runStep(L, `ROLLBACK FILE ${path.basename(f)}`, () => applyFile(url, f, t.rollbackEnv))
    for (const f of t.rollbackPosttest || []) runStep(L, `rollback posttest ${path.basename(f)}`, () => runPsql(url, ['-f', rel(f)]))
    if (t.rollback?.length) {
      const fpBack = fingerprint(url)
      if (fpBack.hash !== first.fp0.hash) throw new Error(`rollback did not restore the pre-apply schema: ${JSON.stringify(diffLines(first.fp0.lines, fpBack.lines))}`)
      if (!t.rollbackKeepsData && rowCounts(url) !== first.rows0) throw new Error('rollback did not restore pre-apply row counts')
      L(`  ok  rollback restored the pre-apply fingerprint ${first.fp0.hash}`)
      cycle('cycle 2 (re-apply)')
    }
    L(`[${t.id}] PASS`)
    return { id: t.id, ok: true, steps }
  } catch (e) {
    L(`[${t.id}] FAIL: ${e.message}`)
    return { id: t.id, ok: false, steps, error: e.message }
  } finally {
    if (!keep) {
      try { sql(adminUrl, `drop database if exists ${db} with (force)`) } catch { /* reported by the caller's cluster stop */ }
    }
  }
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
function args(argv, name) {
  return argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--list')) {
    for (const t of MIGRATION_TESTS) console.log(`${t.id.padEnd(40)} ${t.apply.map((f) => (typeof f === 'string' ? path.basename(f) : `[fixture ${path.basename(f.fixture)}]`)).join(', ')}${t.requires ? `   (requires ${t.requires})` : ''}`)
    return 0
  }
  const prodShapeFiles = String(arg(argv, '--prod-shape') || process.env[PROD_SHAPE_ENV] || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => path.resolve(x))
  const ids = argv.includes('--all')
    ? MIGRATION_TESTS.filter((t) => !t.requires || (t.requires === PROD_SHAPE && prodShapeFiles.length)).map((t) => t.id)
    : args(argv, '--id')
  for (const t of MIGRATION_TESTS) if (argv.includes('--all') && !ids.includes(t.id)) console.log(`skipped ${t.id}: requires ${t.requires}`)
  if (!ids.length) { console.error('usage: --list | --all | --id <id> [--id …]  with --pg-bin <dir> [--data-root <dir>] or --admin-url <loopback url>'); return 2 }
  const tests = ids.map((id) => {
    const t = MIGRATION_TESTS.find((x) => x.id === id)
    if (!t) throw new Error(`unknown test id ${id}`)
    return t
  })
  let target
  try {
    target = resolveAdminTarget({ adminUrl: arg(argv, '--admin-url'), pgBin: arg(argv, '--pg-bin') })
  } catch (e) {
    console.error(`run-migration-test: ${e.message}`)
    return 3
  }
  let cluster = null
  let adminUrl = target.url
  if (target.mode === 'cluster') {
    cluster = startCluster({ bin: target.bin, dataRoot: arg(argv, '--data-root'), log: console.log })
    adminUrl = cluster.url
  }
  const results = []
  try {
    assertDisposableTarget(adminUrl)
    assertServerIsDisposable(adminUrl)
    for (const t of tests) results.push(runMigrationTest(t, { adminUrl, keep: argv.includes('--keep'), prodShapeFiles }))
  } finally {
    if (cluster) cluster.stop()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\nrun-migration-test: ${results.length - failed.length}/${results.length} PASS${failed.length ? `; FAILED: ${failed.map((r) => r.id).join(', ')}` : ''}`)
  return failed.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(`run-migration-test: ${e.message}`); process.exitCode = 2 })
}
