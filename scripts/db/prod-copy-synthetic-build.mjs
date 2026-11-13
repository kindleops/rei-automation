#!/usr/bin/env node
// SYNTHETIC SOURCE for the production-copy rehearsal (docs/PRODUCTION-COPY-REHEARSAL.md). NEVER production.
//
// Builds a production-SHAPED database that holds only invented rows, then dumps it with `pg_dump -Fc`, so the
// rehearsal tool (scripts/db/prod-copy-rehearsal.mjs) can be proven end to end before the owner authorizes any
// production backup. The shape is the repository's own release chain, reused from the migration-test manifest
// (scripts/db/migration-tests.manifest.mjs, entry rc_8_5_21_release_chain: its setup baselines and every chain
// migration up to and including #28, in production apply order), plus the campaign / template baseline link #32
// reads, plus an invented corpus (scripts/db/fixtures/prod_copy_synthetic_corpus.sql). The state it leaves is
// "everything before #29 applied" — exactly what the §1 prerequisite query of docs/AGENT-MESSAGES-MIGRATION-PLAN.md
// expects of production before the five links.
//
// Safety:
//   * the target must pass the rehearsal guard (loopback / unix socket only, never Supabase-like) and its database
//     name must start with `lc_prodcopy_synth_` — a restored production copy (lc_prodcopy_<tag>) can never be
//     written by this builder;
//   * cluster-global role resets in the manifest (drop role …) are SKIPPED: the local server may be shared, and the
//     chain migrations reuse an existing non-privileged role;
//   * the source database is dropped after the dump unless --keep.
//
//   node scripts/db/prod-copy-synthetic-build.mjs --admin-url postgres://postgres@127.0.0.1:54341/postgres \
//     --db lc_prodcopy_synth_src_20261030 --dump /path/synthetic.dump [--pg-bin /usr/lib/postgresql/17/bin] [--keep]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MIGRATION_TESTS } from './migration-tests.manifest.mjs'
import { assertNotAppliedInProduction } from './applied-in-production.mjs'
import { guardTarget, urlForDb, pgTool, childEnv, redactUrl, SYNTH_PREFIX } from './prod-copy-rehearsal.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(here, '../..')
const rel = (p) => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p))

export const AGENT_MESSAGE_BASELINE = 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_agent_message_baseline.sql'
export const SYNTHETIC_CORPUS = 'scripts/db/fixtures/prod_copy_synthetic_corpus.sql'

/** The build plan: [{ kind: 'file'|'sql', name, file?, sql? }] — reused from the manifest, never copied. */
export function syntheticPlan() {
  const chain = MIGRATION_TESTS.find((t) => t.id === 'rc_8_5_21_release_chain')
  if (!chain) throw new Error('manifest entry rc_8_5_21_release_chain not found')
  const plan = []
  for (const s of chain.setup) {
    if (typeof s === 'string') plan.push({ kind: 'file', name: path.basename(s), file: s })
    else if (/\bdrop\s+role\b/i.test(s.sql)) plan.push({ kind: 'skip', name: s.name, reason: 'cluster-global role reset skipped (shared local server)' })
    else plan.push({ kind: 'sql', name: s.name, sql: s.sql })
  }
  for (const a of chain.apply) {
    if (typeof a === 'string') plan.push({ kind: 'file', name: path.basename(a), file: a })
  }
  plan.push({ kind: 'file', name: path.basename(AGENT_MESSAGE_BASELINE), file: AGENT_MESSAGE_BASELINE })
  plan.push({ kind: 'file', name: path.basename(SYNTHETIC_CORPUS), file: SYNTHETIC_CORPUS })
  return plan
}

function psql(url, args, input) {
  const r = spawnSync(pgTool('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, ...args], { encoding: 'utf8', env: childEnv(), input, maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw r.error
  return r
}

function hasOwnTransaction(file) {
  return /^\s*(begin|start\s+transaction)\s*;/im.test(fs.readFileSync(rel(file), 'utf8').replace(/--[^\n]*/g, ''))
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

export function main(argv = process.argv.slice(2)) {
  if (arg(argv, '--pg-bin')) process.env.LC_PG_BIN = path.resolve(arg(argv, '--pg-bin'))
  const adminUrl = arg(argv, '--admin-url')
  const db = arg(argv, '--db')
  const dump = arg(argv, '--dump')
  if (!adminUrl || !db || !dump) {
    console.error('usage: --admin-url <loopback url> --db lc_prodcopy_synth_<tag> --dump <file> [--pg-bin <dir>] [--keep]')
    return 2
  }
  guardTarget({ adminUrl, db, prefix: SYNTH_PREFIX })
  const url = urlForDb(adminUrl, db)
  const exists = psql(adminUrl, ['-At', '-c', `select 1 from pg_database where datname = '${db}'`])
  if (exists.status !== 0) throw new Error(`cannot reach the admin database: ${exists.stderr.trim().split('\n')[0]}`)
  if (exists.stdout.trim() === '1') throw new Error(`database ${db} already exists: drop it first (it was not created by this run)`)
  const t0 = Date.now()
  const created = psql(adminUrl, ['-c', `create database ${db}`])
  if (created.status !== 0) throw new Error(`create database failed: ${created.stderr.trim()}`)
  console.log(`synthetic build: created ${db} on ${redactUrl(adminUrl)}`)
  const steps = []
  try {
    for (const step of syntheticPlan()) {
      const s0 = Date.now()
      if (step.kind === 'skip') { steps.push({ ...step, ms: 0 }); console.log(`  skip ${step.name}: ${step.reason}`); continue }
      let r
      if (step.kind === 'sql') r = psql(url, ['-c', step.sql])
      else {
        assertNotAppliedInProduction(step.file)
        r = psql(url, hasOwnTransaction(step.file) ? ['-f', rel(step.file)] : ['--single-transaction', '-f', rel(step.file)])
      }
      if (r.status !== 0) throw new Error(`${step.name} failed:\n${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-20).join('\n')}`)
      steps.push({ kind: step.kind, name: step.name, ms: Date.now() - s0 })
      console.log(`  ok  ${step.name} (${Date.now() - s0} ms)`)
    }
    fs.mkdirSync(path.dirname(path.resolve(dump)), { recursive: true })
    const d = spawnSync(pgTool('pg_dump'), ['-Fc', '-f', path.resolve(dump), '-d', url], { encoding: 'utf8', env: childEnv() })
    if (d.status !== 0) throw new Error(`pg_dump failed: ${(d.stderr || '').trim().slice(0, 800)}`)
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(dump))).digest('hex')
    const meta = { database: db, dump: path.resolve(dump), sha256: sha, bytes: fs.statSync(path.resolve(dump)).size, built_ms: Date.now() - t0, steps, synthetic: true, note: 'invented rows only; production-shaped schema from the repository release chain' }
    fs.writeFileSync(`${path.resolve(dump)}.build.json`, `${JSON.stringify(meta, null, 2)}\n`)
    console.log(`synthetic build: dumped ${meta.bytes} bytes, sha256 ${sha}`)
    return 0
  } finally {
    if (!argv.includes('--keep')) {
      const dr = psql(adminUrl, ['-c', `drop database if exists ${db} with (force)`])
      console.log(dr.status === 0 ? `synthetic build: dropped ${db}` : `synthetic build: could not drop ${db}: ${dr.stderr.trim()}`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (e) { console.error(`prod-copy-synthetic-build: ${e.message}`); process.exitCode = 1 }
}
