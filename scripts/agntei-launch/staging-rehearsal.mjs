#!/usr/bin/env node
// STAGING REHEARSAL of the agntei gateway chain on an ISOLATED, LOOPBACK-ONLY PostgreSQL 17 (never Docker, never hosted).
// The staging database carries production's SCHEMA (a schema-only dump made by the owner, no rows) or the repository's
// synthetic production-shaped baseline, plus invented, non-sensitive representative records. Nothing here can reach
// production: the admin URL must be loopback / unix socket, the database must be named lc_staging_<tag>, and every step
// runs the guard first. No message is sent anywhere: there is no provider, and the seller-messaging switch stays off.
//
//   node scripts/agntei-launch/staging-rehearsal.mjs <step|all> --admin-url <loopback url> --db lc_staging_<tag> --out <dir>
//        [--schema-dump <file> | --synthetic] [--pg-bin <dir>] [--postgrest <bin>] [--replace] [--jobs 2]
//   steps, in order: guard create seed snapshot review apply probes gateway rollback reapply report
//
// Evidence: <out>/<step>.json and <out>/rehearsal.log (0700 dir, outside every repository).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { assertDisposableTarget, sanitizedPgEnv } from '../db/db-target-guard.mjs'
import { urlForDb, redactUrl, parseTocList, extractGrantees, summarizeRestoreErrors, DEFAULT_EXCLUDED_SCHEMAS } from '../db/prod-copy-rehearsal.mjs'
import { fingerprint, rowCounts, diffLines } from '../db/run-migration-test.mjs'
import { MIGRATION_TESTS } from '../db/migration-tests.manifest.mjs'
import { review, liveCatalog } from './review-chain.mjs'
import { applyOne } from './apply-one.mjs'
import { PROBES, SIDE_EFFECT_TABLES } from './staging/prod-write-probes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/agntei-launch/gateway-chain.manifest.json'), 'utf8'))
const STEPS = ['guard', 'create', 'seed', 'snapshot', 'review', 'apply', 'probes', 'gateway', 'rollback', 'reapply', 'report']
/** The six links that touch tables production's web code writes every day (docs/AGNTEI-MIGRATION-DOSSIER.md, "Production overlap"). */
export const HOT_LINKS = Object.freeze({
  PROPOSED_20261016200000_automation_holds_registry: ['public.seller_offers', 'public.acquisition_opportunities', 'public.send_queue'],
  PROPOSED_20261015130000_message_origin_ai_generated_messages: ['public.send_queue'],
  PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease: ['public.send_queue'],
  PROPOSED_20261017120000_followup_intent_lifecycle: ['public.send_queue', 'public.inbox_thread_state'],
  PROPOSED_20261020110000_action_gateway_t34: ['public.seller_offers'],
  PROPOSED_20261101120000_record_sync: ['public.inbox_thread_state', 'public.acquisition_opportunities', 'public.seller_offers'],
})
const ORG = '00000000-0000-4000-8000-00000000a001'
const OWNER = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const NEVER_CREATE = (r) => /^(pg_|supabase)/i.test(r)
const AUTHENTICATOR_MEMBERS = new Set(['lc_mcp_reader', 'lc_action_gateway'])

// ─────────────────────────────────────────────────────────────────────────────────── helpers
const argv = process.argv.slice(2)
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes(`--${k}`)
const tool = (name) => (process.env.LC_PG_BIN ? path.join(process.env.LC_PG_BIN, name) : name)
const env = () => sanitizedPgEnv(process.env, {})
function psql(url, args, { input } = {}) {
  return spawnSync(tool('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, ...args], { encoding: 'utf8', env: env(), input, maxBuffer: 512 * 1024 * 1024 })
}
function q(url, sql) { const r = psql(url, ['-At', '-c', sql]); if (r.status !== 0) throw new Error(`psql: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`); return r.stdout.trim() }
/** Fingerprint lines made comparable across a dump / restore round trip: pg_get_constraintdef re-prints CHECK expressions with different parentheses. */
const normLine = (l) => (l.startsWith('con\t') ? l.replace(/[()]/g, '').replace(/\s+/g, ' ') : l)
function sameFingerprint(a, b) { const d = diffLines(a.map(normLine), b.map(normLine)); return { same: !d.removed.length && !d.added.length, diff: d } }
function hasOwnTransaction(file) { return /^\s*(begin|start\s+transaction)\s*;/im.test(fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '')) }
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const ms = (t0) => Date.now() - t0

class Ctx {
  constructor() {
    this.adminUrl = opt('admin-url'); this.db = opt('db'); this.out = opt('out') && path.resolve(opt('out'))
    this.schemaDump = opt('schema-dump') && path.resolve(opt('schema-dump')); this.synthetic = flag('synthetic')
    this.replace = flag('replace'); this.jobs = Number(opt('jobs', 2)); this.postgrest = opt('postgrest') || process.env.LC_POSTGREST_BIN || null
    if (opt('pg-bin')) process.env.LC_PG_BIN = path.resolve(opt('pg-bin'))
    if (!this.adminUrl || !this.db || !this.out) throw new Error('--admin-url, --db and --out are required')
    fs.mkdirSync(this.out, { recursive: true, mode: 0o700 }); fs.chmodSync(this.out, 0o700)
  }
  get url() { return urlForDb(this.adminUrl, this.db) }
  evidence(name) { return path.join(this.out, name) }
  read(step) { try { return JSON.parse(fs.readFileSync(this.evidence(`${step}.json`), 'utf8')) } catch { return null } }
  write(step, doc) { fs.writeFileSync(this.evidence(`${step}.json`), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 }) }
  log(step, msg) { const line = `${new Date().toISOString()} [${step}] ${msg}`; console.log(line); fs.appendFileSync(this.evidence('rehearsal.log'), `${line}\n`, { mode: 0o600 }) }
  require(step, ...deps) { for (const d of deps) { const r = this.read(d); if (!r || r.status !== 'pass') throw new Error(`${step}: ${d} must pass first`) } }
}

async function runStep(ctx, step, fn, deps = []) {
  const doc = { step, started_at: new Date().toISOString(), status: 'running', admin: redactUrl(ctx.adminUrl), db: ctx.db }
  const t0 = Date.now()
  try {
    guard(ctx)
    ctx.require(step, ...deps)
    doc.results = await fn(doc)
    doc.status = doc.status === 'running' ? 'pass' : doc.status
  } catch (e) {
    doc.status = 'fail'; doc.error = String(e?.message || e)
    ctx.log(step, `FAIL ${doc.error}`)
  }
  doc.ms = ms(t0); doc.finished_at = new Date().toISOString()
  ctx.write(step, doc)
  ctx.log(step, `${doc.status} in ${doc.ms} ms`)
  return doc
}

// ─────────────────────────────────────────────────────────────────────────────────── guard
function guard(ctx) {
  assertDisposableTarget(ctx.adminUrl)
  if (!/^lc_staging_[a-z0-9_]{1,40}$/.test(ctx.db)) throw new Error(`the database must be named lc_staging_<tag>, not ${ctx.db}`)
  const addr = q(ctx.adminUrl, 'select coalesce(host(inet_server_addr()), \'local\')')
  if (!['local', '127.0.0.1', '::1'].includes(addr)) throw new Error(`the server answers on ${addr}, not loopback: refused`)
  // a real Supabase server has login-capable platform admins and the auth / storage admins; the staging stand-in
  // supabase_admin (platform-stubs.sql) is NOLOGIN and alone
  const platform = q(ctx.adminUrl, "select count(*) from pg_roles where (rolname = 'supabase_admin' and rolcanlogin) or rolname in ('supabase_auth_admin','supabase_storage_admin','supabase_replication_admin')")
  if (platform !== '0') throw new Error('the server carries Supabase platform roles: this is not a disposable staging server')
  if (q(ctx.adminUrl, "select count(*) from pg_namespace where nspname = 'supabase_migrations'") !== '0') throw new Error('the admin database carries supabase_migrations: this is not a disposable staging server')
}
function dbExists(ctx) { return q(ctx.adminUrl, `select count(*) from pg_database where datname = '${ctx.db}'`) === '1' }

// ─────────────────────────────────────────────────────────────────────────────────── create
function installPgNetStandIn(ctx, step = 'create') {
  const bin = process.env.LC_PG_BIN || path.dirname(spawnSync('sh', ['-c', 'command -v pg_config'], { encoding: 'utf8' }).stdout.trim())
  const share = spawnSync(path.join(bin, 'pg_config'), ['--sharedir'], { encoding: 'utf8' }).stdout.trim()
  if (!share) throw new Error('pg_config --sharedir did not answer: cannot install the pg_net stand-in')
  const dir = path.join(share, 'extension'); const src = path.join(HERE, 'staging/pg_net-stand-in')
  const installed = []
  for (const f of ['pg_net.control', 'pg_net--0.20.0.sql']) {
    const to = path.join(dir, f); const body = fs.readFileSync(path.join(src, f))
    if (fs.existsSync(to) && !/stand-in/i.test(fs.readFileSync(to, 'utf8').slice(0, 400))) throw new Error(`${to} is a real pg_net: refusing to overwrite it (this is not a staging server)`)
    if (!fs.existsSync(to) || !fs.readFileSync(to).equals(body)) { fs.writeFileSync(to, body); installed.push(f) }
  }
  if (installed.length) ctx.log(step, `installed the pg_net stand-in into ${dir}: ${installed.join(', ')}`)
  return dir
}
function platformStubs(ctx, url, step = 'create') {
  installPgNetStandIn(ctx, step)
  for (const f of ['apps/api/tests/pg/supabase-shim.sql', 'scripts/agntei-launch/staging/platform-stubs.sql']) {
    const r = psql(url, ['-f', path.join(ROOT, f)])
    if (r.status !== 0) throw new Error(`${f}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`)
    ctx.log(step, `applied ${f}`)
  }
}
function restoreSchemaDump(ctx, url, file, excluded) {
  const list = spawnSync(tool('pg_restore'), ['--list', file], { encoding: 'utf8', env: env(), maxBuffer: 1024 * 1024 * 1024 })
  if (list.status !== 0) throw new Error(`pg_restore --list: ${(list.stderr || '').trim().slice(0, 300)}`)
  const toc = parseTocList(list.stdout)
  const roleEntries = toc.entries.filter((e) => ['ACL', 'DEFAULT ACL', 'POLICY'].includes(e.desc) && !excluded.includes(e.schema))
  const roleListFile = ctx.evidence(`restore.role-list.${process.pid}`)
  fs.writeFileSync(roleListFile, `${roleEntries.map((e) => e.line).join('\n')}\n`, { mode: 0o600 })
  const script = spawnSync(tool('pg_restore'), ['-f', '-', '-L', roleListFile, file], { encoding: 'utf8', env: env(), maxBuffer: 1024 * 1024 * 1024 })
  fs.rmSync(roleListFile, { force: true })
  const grantees = extractGrantees(script.stdout)
  const existing = new Set(q(url, 'select coalesce(string_agg(rolname, \',\'), \'\') from pg_roles').split(','))
  const created = []
  for (const r of grantees) {
    if (existing.has(r) || NEVER_CREATE(r)) continue
    q(url, `create role "${r}" nologin noinherit`); created.push(r)
    if (AUTHENTICATOR_MEMBERS.has(r)) q(url, `grant "${r}" to authenticator`)
  }
  if (created.length) ctx.log('create', `created ${created.length} role(s) the archive names, NOLOGIN NOINHERIT: ${created.join(', ')}`)
  const t0 = Date.now()
  const args = ['--no-owner', '--no-privileges', '-d', url, '--jobs', String(ctx.jobs), ...excluded.flatMap((s) => ['--exclude-schema', s]), file]
  const r = spawnSync(tool('pg_restore'), args, { encoding: 'utf8', env: env(), maxBuffer: 1024 * 1024 * 1024 })
  const data = { ms: ms(t0), exit: r.status, ...summarizeRestoreErrors(r.stderr) }
  fs.writeFileSync(ctx.evidence('restore.stderr.log'), r.stderr || '', { mode: 0o600 })
  ctx.log('create', `pg_restore --no-owner --no-privileges: exit ${r.status}, ${data.errors} error(s) ${JSON.stringify(data.by_class ?? {})} in ${data.ms} ms (full stderr: restore.stderr.log)`)
  // the archive's own GRANT / REVOKE entries, so privilege self-checks judge production's ACLs
  const acl = toc.entries.filter((e) => (e.desc === 'ACL' || e.desc === 'DEFAULT ACL') && !excluded.includes(e.schema))
  const aclFile = ctx.evidence(`restore.acl-list.${process.pid}`)
  fs.writeFileSync(aclFile, `${acl.map((e) => e.line).join('\n')}\n`, { mode: 0o600 })
  const a0 = Date.now()
  const ra = spawnSync(tool('pg_restore'), ['--no-owner', '-L', aclFile, '-d', url, file], { encoding: 'utf8', env: env(), maxBuffer: 1024 * 1024 * 1024 })
  fs.rmSync(aclFile, { force: true })
  fs.writeFileSync(ctx.evidence('restore.acl.stderr.log'), ra.stderr || '', { mode: 0o600 })
  const aclPass = { entries: acl.length, ms: ms(a0), exit: ra.status, ...summarizeRestoreErrors(ra.stderr) }
  ctx.log('create', `ACL pass: ${acl.length} entries, ${aclPass.errors} error(s)`)
  return { toc_entries: toc.entries.length, roles_named_by_archive: grantees, roles_created: created, restore: data, acl_pass: aclPass }
}
/** The pre-chain production-shaped world: the release-chain manifest entry's SETUP baselines only (the shim, the three links
 *  production already carries, the live baselines captured from production). The chain itself is what the rehearsal applies. */
function syntheticSetupPlan() {
  const chain = MIGRATION_TESTS.find((t) => t.id === 'rc_8_5_21_release_chain')
  if (!chain) throw new Error('manifest entry rc_8_5_21_release_chain not found')
  const plan = chain.setup.map((s) => (typeof s === 'string' ? { kind: 'file', name: path.basename(s), file: s } : /\bdrop\s+role\b/i.test(s.sql) ? { kind: 'skip', name: s.name, reason: 'cluster-global role reset skipped (shared local server)' } : { kind: 'sql', name: s.name, sql: s.sql }))
  // production relations the later links' pretests read (ownership_template_rotation_control and the campaign / template
  // baseline), captured for the gateway tests; the owner's schema dump carries the real ones
  plan.push({ kind: 'file', name: 'action_gateway_agent_message_baseline.sql (production relations link 26 reads)', file: 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_agent_message_baseline.sql' })
  plan.push({ kind: 'file', name: 'action_gateway_service_principals_baseline.sql (production campaign relations link 28 reads)', file: 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_service_principals_baseline.sql' })
  return plan
}
/** Links 1 to 11 of the chain are on release/cloudflare-production byte-identically (docs/AGNTEI-MIGRATION-DOSSIER.md,
 *  "On production branch"); the production-like synthetic world carries them applied, as the chain tests assume. The real
 *  state is read, not assumed, when the owner's schema dump is the source. */
const LINKS_ON_PRODUCTION_BRANCH = 11
function buildSynthetic(ctx, url) {
  const steps = []
  const setup = syntheticSetupPlan()
  const inSetup = new Set(setup.filter((s) => s.kind === 'file').map((s) => s.file))
  for (const m of MANIFEST.migrations.slice(0, LINKS_ON_PRODUCTION_BRANCH)) if (!inSetup.has(m.file)) setup.push({ kind: 'file', name: `${m.name} (on the production branch: applied as a baseline)`, file: m.file })
  for (const step of setup) {
    if (step.kind === 'skip') { steps.push({ ...step, ms: 0 }); continue }
    if (step.kind === 'file' && /supabase-shim\.sql$/.test(step.file)) continue // already applied by platformStubs
    const t0 = Date.now()
    const file = step.kind === 'file' ? path.join(ROOT, step.file) : null
    const r = step.kind === 'sql' ? psql(url, ['-c', step.sql]) : psql(url, hasOwnTransaction(file) ? ['-f', file] : ['--single-transaction', '-f', file])
    if (r.status !== 0) throw new Error(`${step.name} failed: ${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-6).join(' | ')}`)
    steps.push({ kind: step.kind, name: step.name, ms: ms(t0) })
  }
  return { steps }
}
async function cmdCreate(ctx) {
  return runStep(ctx, 'create', async () => {
    if (!ctx.schemaDump && !ctx.synthetic) throw new Error('give --schema-dump <file> (the owner\'s schema-only dump) or --synthetic')
    if (dbExists(ctx)) { if (!ctx.replace) throw new Error(`${ctx.db} exists: pass --replace to drop and re-create it`); q(ctx.adminUrl, `drop database ${ctx.db} with (force)`); ctx.log('create', `dropped ${ctx.db}`) }
    for (const extra of [`${ctx.db}_snap`, `${ctx.db}_logical`]) if (q(ctx.adminUrl, `select count(*) from pg_database where datname = '${extra}'`) === '1') { q(ctx.adminUrl, `drop database ${extra} with (force)`); ctx.log('create', `dropped ${extra}`) }
    for (const s of STEPS.filter((x) => x !== 'guard' && x !== 'create')) if (fs.existsSync(ctx.evidence(`${s}.json`))) fs.renameSync(ctx.evidence(`${s}.json`), ctx.evidence(`${s}.json.previous`))
    q(ctx.adminUrl, `create database ${ctx.db} template template0 encoding 'UTF8'`)
    const url = ctx.url
    platformStubs(ctx, url)
    const res = { source: ctx.schemaDump ? { kind: 'schema-dump', file: ctx.schemaDump, sha256: sha256(fs.readFileSync(ctx.schemaDump)), bytes: fs.statSync(ctx.schemaDump).size } : { kind: 'synthetic' } }
    if (ctx.schemaDump) Object.assign(res, restoreSchemaDump(ctx, url, ctx.schemaDump, [...DEFAULT_EXCLUDED_SCHEMAS, 'cron', 'extensions']))
    else Object.assign(res, buildSynthetic(ctx, url))
    res.schemas = q(url, "select coalesce(string_agg(nspname, ',' order by nspname), '') from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'").split(',').filter(Boolean)
    res.extensions = q(url, "select coalesce(string_agg(extname, ',' order by extname), '') from pg_extension").split(',').filter(Boolean)
    res.tables = Number(q(url, "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'"))
    res.functions = Number(q(url, "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'"))
    res.triggers = Number(q(url, 'select count(*) from pg_trigger where not tgisinternal'))
    res.policies = Number(q(url, 'select count(*) from pg_policies'))
    res.server = q(url, 'select version()')
    res.staging_deviations = ['postgis: Postgres.app ships 3.5.x; the catalog version label is set to 3.3.7 so the migration\'s pinned allowlist (supabase_postgis_dynamic_sql.v1) is exercised; functions and grants are real', 'pg_net: a stand-in extension with the pinned object inventory and grants; it records calls and sends nothing', 'pg_cron / supabase_vault: stand-ins that run and store nothing; not executable by PUBLIC', 'supabase_admin: NOLOGIN superuser owning the two extensions, as on the platform']
    ctx.log('create', `${ctx.db}: ${res.tables} tables, ${res.functions} functions, ${res.triggers} triggers, ${res.policies} policies; schemas ${res.schemas.join(', ')}`)
    return res
  })
}

// ─────────────────────────────────────────────────────────────────────────────────── seed
async function cmdSeed(ctx) {
  return runStep(ctx, 'seed', async () => {
    const file = path.join(ROOT, 'scripts/agntei-launch/staging/seed-representative.sql')
    const r = psql(ctx.url, ['--single-transaction', '-f', file])
    if (r.status !== 0) throw new Error(`seed failed: ${(r.stderr || '').trim().split('\n').slice(-4).join(' | ')}`)
    const counts = {}
    for (const t of ['public.properties', 'public.phones', 'public.prospects', 'public.master_owners', 'public.inbox_thread_state', 'public.message_events', 'public.send_queue', 'public.sms_suppression_list', 'public.campaigns', 'public.campaign_targets', 'public.campaign_target_graph', 'public.seller_offers', 'public.acquisition_opportunities', 'public.contact_property_resolution', 'agent.operator_membership']) {
      try { counts[t] = Number(q(ctx.url, `select count(*) from ${t}`)) } catch { counts[t] = null }
    }
    ctx.log('seed', `representative records: ${Object.entries(counts).filter(([, n]) => n != null).map(([t, n]) => `${t.replace('public.', '')}=${n}`).join(' ')}`)
    return { file: path.relative(ROOT, file), sha256: sha256(fs.readFileSync(file)), counts, invented: true, note: 'every row is invented; no production data' }
  }, ['create'])
}

// ─────────────────────────────────────────────────────────────────────────────────── snapshot / review
async function cmdSnapshot(ctx) {
  return runStep(ctx, 'snapshot', async () => {
    const file = ctx.evidence('before.dump'); const t0 = Date.now()
    const d = spawnSync(tool('pg_dump'), ['-Fc', '-f', file, '-d', ctx.url], { encoding: 'utf8', env: env() })
    if (d.status !== 0) throw new Error(`pg_dump: ${(d.stderr || '').trim().slice(0, 300)}`)
    fs.chmodSync(file, 0o600)
    const fp = fingerprint(ctx.url)
    fs.writeFileSync(ctx.evidence('fingerprint.before.txt'), fp.lines.join('\n'), { mode: 0o600 })
    // the physical copy: CREATE DATABASE ... TEMPLATE copies the files, catalogs and ACLs exactly, as a point-in-time
    // restore does on the platform; the logical dump is the pg_dump / pg_restore path, rehearsed as well
    const c0 = Date.now(); const snapDb = `${ctx.db}_snap`
    if (q(ctx.adminUrl, `select count(*) from pg_database where datname = '${snapDb}'`) === '1') q(ctx.adminUrl, `drop database ${snapDb} with (force)`)
    q(ctx.adminUrl, `create database ${snapDb} template ${ctx.db}`)
    const res = { file, bytes: fs.statSync(file).size, dump_ms: ms(t0), physical_copy: snapDb, physical_copy_ms: ms(c0), fingerprint: fp.hash, fingerprint_lines: fp.lines.length, row_counts: rowCounts(ctx.url), database_bytes: Number(q(ctx.url, 'select pg_database_size(current_database())')) }
    ctx.log('snapshot', `before.dump ${res.bytes} bytes in ${res.dump_ms} ms; physical copy ${snapDb} in ${res.physical_copy_ms} ms; fingerprint ${res.fingerprint} (${res.fingerprint_lines} lines)`)
    return res
  }, ['create'])
}
async function reviewNow(ctx) { return review(MANIFEST, (await liveCatalog(ctx.url)).live) }
async function cmdReview(ctx) {
  return runStep(ctx, 'review', async () => {
    const rev = await reviewNow(ctx)
    for (const row of rev.rows) ctx.log('review', `${row.status.padEnd(10)} ${row.name}`)
    if (rev.drift.length) ctx.log('review', `DRIFT: ${rev.drift.join('; ')}`)
    return { rows: rev.rows, pending: rev.pending, superseded: rev.superseded ?? [], drift: rev.drift, orderBroken: rev.orderBroken, next: rev.next, server: rev.server }
  }, ['create'])
}

// ─────────────────────────────────────────────────────────────────────────────────── apply (with a workload on the hot tables)
function startWorkload(ctx, label) {
  const stats = ctx.evidence(`workload.${label}.json`)
  const child = spawn(process.execPath, [path.join(HERE, 'staging/workload.mjs'), '--url', ctx.url, '--stats', stats], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PATH: process.env.PATH } })
  let err = ''; child.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
  const samples = []; const pool = new pg.Client({ connectionString: ctx.url }); let timer = null
  const start = pool.connect().then(() => {
    timer = setInterval(async () => {
      try {
        const r = await pool.query("select count(*)::int as blocked, coalesce(max(extract(epoch from (now() - state_change)) * 1000), 0)::int as max_wait_ms from pg_stat_activity where datname = current_database() and application_name = 'staging-workload' and wait_event_type = 'Lock'")
        samples.push(r.rows[0])
      } catch { /* sampling only */ }
    }, 100)
  })
  return {
    async stop() {
      await start; clearInterval(timer); await pool.end()
      child.kill('SIGTERM')
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 15000) })
      let s = null; try { s = JSON.parse(fs.readFileSync(stats, 'utf8')) } catch { s = { error: `no stats: ${err.slice(-300)}` } }
      const blocked = samples.filter((x) => x.blocked > 0)
      return { ...s, lock_samples: samples.length, samples_with_lock_wait: blocked.length, max_lock_wait_ms: Math.max(0, ...samples.map((x) => x.max_wait_ms)) }
    },
  }
}
async function applyAll(ctx, step, { workload = false } = {}) {
  const before = await reviewNow(ctx)
  if (before.drift.length || before.orderBroken) throw new Error(`refusing to apply: drift ${JSON.stringify(before.drift)} orderBroken ${before.orderBroken}`)
  const links = []
  let pending = [...before.pending]
  while (pending.length) {
    const name = pending[0]
    const hot = HOT_LINKS[name] ?? null
    const wl = workload && hot ? startWorkload(ctx, `${step}.${name.slice(0, 40)}`) : null
    if (wl) await new Promise((r) => setTimeout(r, 1500)) // the workload must be running before the lock is taken
    const t0 = Date.now(); let error = null
    try { await applyOne(ctx.url, name, { manifest: MANIFEST, log: (m) => ctx.log(step, `  ${m}`) }) } catch (e) { error = String(e.message) }
    const took = ms(t0)
    const w = wl ? await wl.stop() : null
    links.push({ name, hot_tables: hot, ms: took, ok: !error, error, workload: w })
    ctx.log(step, `${error ? 'FAIL' : 'ok  '} ${name} in ${took} ms${hot ? ` [hot: ${hot.join(', ')}]${w ? ` workload ops=${w.ops} errors=${w.errors} max_stmt_ms=${w.max_stmt_ms} max_lock_wait_ms=${w.max_lock_wait_ms}` : ''}` : ''}`)
    if (error) throw new Error(`${name}: ${error}`)
    const again = await reviewNow(ctx); pending = again.pending
  }
  const after = await reviewNow(ctx)
  const fp = fingerprint(ctx.url)
  return { links, total_ms: links.reduce((a, l) => a + l.ms, 0), applied: after.rows.filter((r) => r.status === 'applied').length, superseded: after.superseded ?? [], pending_after: after.pending, drift_after: after.drift, fingerprint: fp.hash, fingerprint_lines: fp.lines }
}
async function cmdApply(ctx) {
  return runStep(ctx, 'apply', async () => {
    const r = await applyAll(ctx, 'apply', { workload: true })
    fs.writeFileSync(ctx.evidence('fingerprint.after.txt'), r.fingerprint_lines.join('\n'), { mode: 0o600 }); delete r.fingerprint_lines
    if (r.pending_after.length) throw new Error(`still pending after apply: ${r.pending_after.join(', ')}`)
    ctx.log('apply', `${r.links.length} link(s) applied in ${r.total_ms} ms; ${r.applied} applied, ${r.superseded.length} superseded; fingerprint ${r.fingerprint}`)
    return r
  }, ['snapshot', 'review'])
}

// ─────────────────────────────────────────────────────────────────────────────────── probes (production-shaped writes after the chain)
async function cmdProbes(ctx) {
  return runStep(ctx, 'probes', async () => {
    const c = new pg.Client({ connectionString: ctx.url, application_name: 'staging-probes' }); await c.connect()
    const results = []
    try {
      const present = {}
      for (const t of SIDE_EFFECT_TABLES) present[t] = (await c.query('select to_regclass($1) as r', [t])).rows[0].r != null
      const counts = async () => { const o = {}; for (const t of SIDE_EFFECT_TABLES) if (present[t]) o[t] = Number((await c.query(`select count(*) from ${t}`)).rows[0].count); return o }
      for (const p of PROBES) {
        const before = await counts(); const t0 = Date.now(); let error = null; let rows = null
        // a probe gated in production's own code on columns a migration outside the chain adds: absent before and after the chain, it is gated off here as there
        const missing = []
        for (const col of p.requires ?? []) { const [sch, tbl, name] = col.split('.'); if (!(await c.query('select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3', [sch, tbl, name])).rowCount) missing.push(col) }
        if (missing.length) { results.push({ name: p.name, shape: p.shape, table: p.table, ok: true, gated: { missing, by: p.gatedBy ?? null }, ms: ms(t0), rows: null, error: null, side_effects: {}, expect: p.expect ?? 'ok' }); ctx.log('probes', `gated ${p.name}: ${missing.join(', ')} absent before and after the chain (${p.gatedBy ?? 'gated in code'})`); continue }
        try { await c.query('begin'); const r = await c.query(p.sql, p.params ?? []); rows = r.rowCount; await c.query('commit') } catch (e) { await c.query('rollback').catch(() => {}); error = { code: e.code, message: String(e.message).slice(0, 300) } }
        const after = await counts()
        const sideEffects = Object.fromEntries(Object.keys(after).filter((t) => after[t] !== before[t]).map((t) => [t, after[t] - before[t]]))
        // on the synthetic baseline a column or table production has but the fixtures lack is not a verdict: recorded as n/a
        const synthetic = ctx.read('create')?.results?.source?.kind === 'synthetic'
        const notApplicable = synthetic && error && ['42703', '42P01'].includes(error.code)
        const ok = notApplicable ? true : p.expect === 'error' ? !!error : !error
        results.push({ name: p.name, shape: p.shape, table: p.table, ok, not_applicable: notApplicable || undefined, ms: ms(t0), rows, error, side_effects: sideEffects, expect: p.expect ?? 'ok' })
        ctx.log('probes', `${ok ? 'ok  ' : 'FAIL'} ${p.name}${error ? ` -> ${error.code} ${error.message.slice(0, 120)}` : ''}${Object.keys(sideEffects).length ? ` side effects ${JSON.stringify(sideEffects)}` : ''}`)
      }
    } finally { await c.end() }
    const failed = results.filter((r) => !r.ok)
    if (failed.length) throw Object.assign(new Error(`${failed.length} production-shaped write(s) failed on the migrated schema: ${failed.map((f) => f.name).join(', ')}`), { results })
    return { probes: results, side_effect_tables: SIDE_EFFECT_TABLES }
  }, ['apply'])
}

// ─────────────────────────────────────────────────────────────────────────────────── gateway (the real Action Gateway binary, loopback, against staging through PostgREST)
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function mintHs256(secret, payload) { const h = b64url({ alg: 'HS256', typ: 'JWT' }); const p = b64url(payload); const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'); return `${h}.${p}.${s}` }
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const waitHttp = async (url, { method = 'GET', ok = (s) => s < 500, tries = 100 } = {}) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { method }); if (ok(r.status)) return r.status } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 200)) } return null }
async function cmdGateway(ctx) {
  return runStep(ctx, 'gateway', async (doc) => {
    if (!ctx.postgrest) { doc.status = 'skipped'; ctx.log('gateway', 'no PostgREST binary (--postgrest): skipped'); return { skipped: 'no PostgREST binary' } }
    // the repository's own Supabase edge stand-in (tests): a real PostgREST as authenticator, /rest/v1 and /graphql/v1 routed as Supabase routes them
    const { startSupabaseEdge, mintJwt } = await import(path.join(ROOT, 'mcp/leadcommand-mcp/test/support/supabase-edge.mjs'))
    const u = new URL(ctx.url); const dbName = u.pathname.slice(1); const pgHost = u.hostname; const pgPort = u.port || '5432'
    const dir = ctx.evidence('gateway'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const secret = (name, value) => { const f = path.join(dir, name); fs.writeFileSync(f, value, { mode: 0o600 }); return f }
    const jwtSecret = crypto.randomBytes(32).toString('base64url')
    const exp = (d) => Math.floor(Date.now() / 1000) + d * 86_400
    const anonKey = secret('anon.key', mintJwt(jwtSecret, { role: 'anon', iss: 'supabase', iat: exp(0) - 60, exp: exp(30) }))
    const gatewayJwt = secret('gateway.jwt', mintJwt(jwtSecret, { role: 'lc_action_gateway', lc_org: ORG, iss: 'supabase', iat: exp(0) - 60, exp: exp(7) }))
    const pepper = secret('pepper', crypto.randomBytes(48).toString('base64url'))
    const dbUrlFile = secret('staging.dburl', ctx.url)
    const gwPort = await freePort()
    const edge = await startSupabaseEdge({ postgrestBin: ctx.postgrest, dbUrl: `postgres://authenticator@${pgHost}:${pgPort}/${dbName}`, schemas: 'public,graphql_public', secret: jwtSecret })
    const res = { edge: { url: edge.url, upstream: edge.upstream, schemas: 'public,graphql_public' }, gateway: { port: gwPort } }
    let gw = null
    try {
      // 1. the real gateway binary, exactly as the LaunchAgent runs it, against staging through the edge
      const gwLog = path.join(dir, 'gateway.log'); const gwOut = fs.openSync(gwLog, 'a')
      const gwEnv = { PATH: process.env.PATH, HOME: os.homedir(), LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: String(gwPort), LEADCOMMAND_ACTION_MCP_ORG_ID: ORG, LEADCOMMAND_ACTION_MCP_SUPABASE_URL: edge.url, LEADCOMMAND_ACTION_MCP_PEPPER_FILE: pepper, LEADCOMMAND_ACTION_MCP_API_KEY_FILE: anonKey, LEADCOMMAND_ACTION_MCP_GATEWAY_JWT_FILE: gatewayJwt, LEADCOMMAND_ACTION_MCP_AUDIT_FILE: path.join(dir, 'gateway-audit.jsonl') }
      gw = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'mcp/leadcommand-action-mcp/bin/leadcommand-action-mcp.mjs')], { cwd: path.join(ROOT, 'mcp/leadcommand-action-mcp'), env: gwEnv, stdio: ['ignore', gwOut, gwOut] })
      let exited = null; gw.on('exit', (code) => { exited = code })
      const up = await waitHttp(`http://127.0.0.1:${gwPort}/mcp`, { method: 'POST', ok: (s) => s === 401, tries: 150 })
      const logText = fs.readFileSync(gwLog, 'utf8')
      res.gateway.boot = { answered_401_without_credential: up === 401, exit_code: exited, self_check: logText.match(/"event":"(server_boot_failed|credential_self_check[^"]*|boot[^"]*)"[^\n]*/g)?.slice(-3) ?? null, log_tail: logText.slice(-1500) }
      ctx.log('gateway', up === 401 ? `the Action Gateway booted against staging (boot self-check passed) and refuses a call without a credential (401) on 127.0.0.1:${gwPort}` : `the gateway did not come up (exit ${exited}); see ${gwLog}`)
      if (up !== 401) throw new Error('gateway boot failed')
      // 2. the owner's grants, exactly as production will get them (grants.mjs --apply), on staging
      const agents = 'rowan=agt_rowan,reps=agt_cruz+agt_sterling,research=agt_scout'
      const g = spawnSync(process.execPath, [path.join(ROOT, 'scripts/agntei-launch/grants.mjs'), '--org', ORG, '--owner', OWNER, '--agents', agents, '--apply', '--confirm', 'GRANT'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LC_OWNER_DB_URL_FILE: dbUrlFile, LC_PEPPER_FILE: pepper } })
      res.grants = { exit: g.status, out: g.stdout.slice(-1200), err: g.stderr.slice(-600) }
      ctx.log('gateway', `grants.mjs --apply on staging: exit ${g.status}`)
      if (g.status !== 0) throw new Error(`grants failed: ${g.stderr.slice(-300)}`)
      // 3. the ONE service credential, minted the production way, with invented delegate keys
      const pub = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
      const m = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './src/loader/register.mjs', 'scripts/mint-service-credential.mjs', '--database-url-file', dbUrlFile, '--org', ORG, '--owner', OWNER, '--create', '--service-id', 'svc_agntei_staging', '--sponsor', OWNER, '--tier-ceiling', '2', '--pepper-file', pepper, '--display-name', 'agntei staging rehearsal', '--days', '7', '--detach-agent-credentials', '--delegate', `agt_rowan=${pub()}`, '--delegate', `agt_cruz=${pub()}`, '--delegate', `agt_sterling=${pub()}`, '--delegate', `agt_scout=${pub()}`], { cwd: path.join(ROOT, 'mcp/leadcommand-action-mcp'), encoding: 'utf8', env: { ...process.env } })
      const cred = m.stdout.match(/lcsvc_[A-Za-z0-9_-]{43}/)?.[0] ?? null
      res.mint = { exit: m.status, minted: !!cred, out: m.stdout.replace(/lcsvc_[A-Za-z0-9_-]+/g, 'lcsvc_[hidden]').slice(-800), err: m.stderr.slice(-400) }
      ctx.log('gateway', `mint-service-credential on staging: exit ${m.status}, credential ${cred ? 'minted (never written anywhere)' : 'NOT minted'}`)
      if (!cred) throw new Error(`mint failed: ${m.stderr.slice(-300)}`)
      // 4. the MCP handshake with the credential: initialize, then tools/list
      const call = async (body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${gwPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${cred}`, ...headers }, body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, session: r.headers.get('mcp-session-id'), text: t.slice(0, 4000) } }
      const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-rehearsal', version: '1' } } })
      res.mcp = { initialize: { status: init.status, session: !!init.session, body: init.text.slice(0, 400) } }
      if (init.session) { const tl = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': init.session }); const names = [...tl.text.matchAll(/"name":"([a-z_.]+)"/g)].map((x) => x[1]); res.mcp.tools_list = { status: tl.status, count: names.length, names: names.slice(0, 60) } }
      ctx.log('gateway', `MCP initialize ${init.status}${res.mcp.tools_list ? `; tools/list ${res.mcp.tools_list.status} (${res.mcp.tools_list.count} tools)` : ''}`)
      if (init.status !== 200) throw new Error(`MCP initialize answered ${init.status}: ${init.text.slice(0, 200)}`)
      res.audit_lines = fs.existsSync(path.join(dir, 'gateway-audit.jsonl')) ? fs.readFileSync(path.join(dir, 'gateway-audit.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
      res.isolation_after_gateway = isolationFacts(ctx)
      ctx.log('gateway', `dispatch isolation after apply, probes and the gateway: pg_net requests ${res.isolation_after_gateway.pg_net_requests_recorded}, cron jobs ${res.isolation_after_gateway.cron_jobs_recorded}, rows created here ${res.isolation_after_gateway.rows_created_here} of which reached sent ${res.isolation_after_gateway.rows_created_here_that_reached_sent}, send switch ${res.isolation_after_gateway.ai_conversation_send_enabled}`)
      return res
    } finally {
      if (gw) gw.kill('SIGTERM')
      await edge.stop().catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
    }
  }, ['apply'])
}

// ─────────────────────────────────────────────────────────────────────────────────── rollback (recovery = restore the pre-apply backup) and re-apply
async function cmdRollback(ctx) {
  return runStep(ctx, 'rollback', async () => {
    const snap = ctx.read('snapshot').results
    const before = fs.readFileSync(ctx.evidence('fingerprint.before.txt'), 'utf8').split('\n')
    // A. physical recovery: the database is replaced by the snapshot copy (what a point-in-time restore does on the platform)
    const t0 = Date.now()
    q(ctx.adminUrl, `drop database ${ctx.db} with (force)`)
    q(ctx.adminUrl, `create database ${ctx.db} template ${snap.physical_copy}`)
    const fp = fingerprint(ctx.url)
    const phys = { ms: ms(t0), fingerprint: fp.hash, identical: fp.hash === snap.fingerprint, row_counts_equal: rowCounts(ctx.url) === snap.row_counts }
    const rev = await reviewNow(ctx)
    ctx.log('rollback', `physical recovery from ${snap.physical_copy} in ${phys.ms} ms: fingerprint ${fp.hash} ${phys.identical ? 'IDENTICAL to' : 'DIFFERS FROM'} the pre-apply ${snap.fingerprint}; ${rev.pending.length} link(s) pending again`)
    if (!phys.identical) throw new Error('the physically recovered database does not fingerprint like the pre-apply snapshot')
    // B. the logical path: pg_restore of before.dump into a fresh database inside the platform stand-ins; its drift is a
    // finding about this recovery method (default privileges re-grant the API roles on restored public objects the chain
    // had revoked), never a verdict on the chain
    const l0 = Date.now(); const logicalDb = `${ctx.db}_logical`; const logicalUrl = urlForDb(ctx.adminUrl, logicalDb)
    if (q(ctx.adminUrl, `select count(*) from pg_database where datname = '${logicalDb}'`) === '1') q(ctx.adminUrl, `drop database ${logicalDb} with (force)`)
    q(ctx.adminUrl, `create database ${logicalDb} template template0 encoding 'UTF8'`)
    platformStubs(ctx, logicalUrl, 'rollback')
    const r = spawnSync(tool('pg_restore'), ['--no-owner', '-d', logicalUrl, '--jobs', String(ctx.jobs), snap.file], { encoding: 'utf8', env: env(), maxBuffer: 1024 * 1024 * 1024 })
    fs.writeFileSync(ctx.evidence('rollback.logical.stderr.log'), r.stderr || '', { mode: 0o600 })
    const lfp = fingerprint(logicalUrl)
    const cmp = sameFingerprint(before, lfp.lines)
    const kinds = {}; for (const l of [...cmp.diff.removed, ...cmp.diff.added]) kinds[l.split('\t')[0]] = (kinds[l.split('\t')[0]] ?? 0) + 1
    const logical = { ms: ms(l0), restore_exit: r.status, ...summarizeRestoreErrors(r.stderr), fingerprint: lfp.hash, identical_after_normalising: cmp.same, drift_lines: { missing: cmp.diff.removed.length, extra: cmp.diff.added.length, kinds }, drift_examples: [...cmp.diff.removed.slice(0, 3), ...cmp.diff.added.slice(0, 3)].map((l) => l.slice(0, 200)), note: 'a logical restore into the platform re-applies its default privileges to restored public objects: the chain\'s explicit revokes are not replayed by pg_restore. Recovery in production is the platform\'s point-in-time restore (physical), rehearsed above.' }
    q(ctx.adminUrl, `drop database ${logicalDb} with (force)`)
    ctx.log('rollback', `logical path (pg_restore into a fresh database with the stand-ins): ${logical.errors} restore error(s), fingerprint ${cmp.same ? 'identical after normalising' : `drifts by ${cmp.diff.removed.length} missing / ${cmp.diff.added.length} extra line(s) (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')})`}`)
    return { physical: phys, logical, pending_again: rev.pending.length, recovery_ms: phys.ms }
  }, ['snapshot', 'apply'])
}
async function cmdReapply(ctx) {
  return runStep(ctx, 'reapply', async () => {
    const first = ctx.read('apply').results
    const r = await applyAll(ctx, 'reapply', { workload: false })
    const firstLines = fs.readFileSync(ctx.evidence('fingerprint.after.txt'), 'utf8').split('\n')
    const cmp = sameFingerprint(firstLines, r.fingerprint_lines); delete r.fingerprint_lines
    const same = cmp.same
    ctx.log('reapply', `${r.links.length} link(s) re-applied in ${r.total_ms} ms; fingerprint ${r.fingerprint} ${same ? 'EQUALS' : 'DIFFERS FROM'} the first apply ${first.fingerprint}`)
    if (!same) throw new Error(`re-apply does not fingerprint like the first apply: ${cmp.diff.removed.length} missing, ${cmp.diff.added.length} extra; e.g. ${(cmp.diff.removed[0] ?? cmp.diff.added[0] ?? '').slice(0, 160)}`)
    return { ...r, equals_first_apply: same, per_link_delta_ms: r.links.map((l) => ({ name: l.name, first_ms: first.links.find((x) => x.name === l.name)?.ms ?? null, second_ms: l.ms })) }
  }, ['rollback'])
}

// ─────────────────────────────────────────────────────────────────────────────────── dispatch isolation
/** Staging has no provider, no credential and no path to production sending; these facts say so, from the database itself. */
function isolationFacts(ctx) {
  const iso = { measured_at: new Date().toISOString() }
  try {
    iso.pg_net_requests_recorded = Number(q(ctx.url, 'select count(*) from net.http_request_queue'))
    iso.cron_jobs_recorded = Number(q(ctx.url, 'select count(*) from cron.job'))
    // every row the rehearsal itself created (the workload's wl-*, the probes' probe-*) must still be queued or cancelled: nothing sends on staging
    iso.rows_created_here = Number(q(ctx.url, "select count(*) from public.send_queue where queue_key not like 'seed-q-%'"))
    iso.rows_created_here_that_reached_sent = Number(q(ctx.url, "select count(*) from public.send_queue where queue_key not like 'seed-q-%' and queue_status in ('sent','delivered','sending')"))
    iso.ai_conversation_send_enabled = q(ctx.url, "select coalesce((select value from public.system_control where key = 'ai_conversation_send_enabled'), 'absent')")
    iso.provider_env_present = Object.keys(process.env).filter((k) => /TEXTGRID|TWILIO|TELNYX|SMS_PROVIDER|SUPABASE_SERVICE_ROLE/i.test(k))
    iso.server_listens_on = q(ctx.adminUrl, "select coalesce(host(inet_server_addr()), 'unix socket')")
  } catch (e) { iso.error = String(e.message).slice(0, 200) }
  return iso
}

// ─────────────────────────────────────────────────────────────────────────────────── report
async function cmdReport(ctx) {
  return runStep(ctx, 'report', async () => writeReport(ctx))
}
function writeReport(ctx) {
  const docs = Object.fromEntries(STEPS.filter((s) => s !== 'report').map((s) => [s, ctx.read(s)]))
  const L = []
  L.push(`# Staging rehearsal of the agntei gateway chain (${new Date().toISOString().slice(0, 10)})`, '')
  L.push(`Database \`${ctx.db}\` on ${redactUrl(ctx.adminUrl)} (loopback only). Source: ${docs.create?.results?.source?.kind ?? 'none'}${docs.create?.results?.source?.file ? ` (${path.basename(docs.create.results.source.file)}, sha256 ${docs.create.results.source.sha256.slice(0, 16)})` : ''}. Server: ${docs.create?.results?.server ?? ''}.`, '')
  L.push('| Step | Status | Time | Facts |', '|---|---|---|---|')
  const fact = (s) => {
    const r = s?.results ?? {}
    switch (s?.step) {
      case 'create': return `${r.tables} tables, ${r.functions} functions, ${r.triggers} triggers, ${r.policies} policies${r.restore ? `; restore ${r.restore.errors} error(s) ${JSON.stringify(r.restore.by_class ?? {})}` : ''}`
      case 'seed': return Object.entries(r.counts ?? {}).filter(([, n]) => n != null).map(([t, n]) => `${t.replace('public.', '')} ${n}`).join(', ')
      case 'snapshot': return `${r.bytes} bytes in ${r.dump_ms} ms; fingerprint ${r.fingerprint}`
      case 'review': return `${(r.rows ?? []).filter((x) => x.status === 'applied').length} applied, ${(r.pending ?? []).length} pending, ${(r.superseded ?? []).length} superseded, drift ${(r.drift ?? []).length}`
      case 'apply': case 'reapply': return `${(r.links ?? []).length} links in ${r.total_ms} ms; fingerprint ${r.fingerprint}${s.step === 'reapply' ? `; equals first apply: ${r.equals_first_apply}` : ''}`
      case 'probes': { const ps = r.probes ?? []; const na = ps.filter((p) => p.not_applicable).length; const g = ps.filter((p) => p.gated).length; return `${ps.filter((p) => p.ok && !p.not_applicable && !p.gated).length} ok, ${ps.filter((p) => !p.ok).length} failed${na ? `, ${na} n/a on the synthetic baseline` : ''}${g ? `, ${g} gated off in production's code (columns of a migration outside the chain)` : ''} of ${ps.length} production-shaped writes` }
      case 'gateway': return r.skipped ? r.skipped : `boot 401: ${r.gateway?.boot?.answered_401_without_credential}; grants exit ${r.grants?.exit}; credential minted: ${r.mint?.minted}; MCP initialize ${r.mcp?.initialize?.status}; tools ${r.mcp?.tools_list?.count ?? '-'}`
      case 'rollback': return `physical recovery ${r.physical?.ms} ms, identical: ${r.physical?.identical}, rows equal: ${r.physical?.row_counts_equal}; logical pg_restore path: ${r.logical?.identical_after_normalising ? 'identical' : `drifts (${r.logical?.drift_lines?.missing} missing / ${r.logical?.drift_lines?.extra} extra lines)`}`
      default: return ''
    }
  }
  for (const s of STEPS.filter((x) => x !== 'report')) L.push(`| ${s} | ${docs[s]?.status ?? 'not run'} | ${docs[s]?.ms != null ? `${docs[s].ms} ms` : ''} | ${fact(docs[s])}${docs[s]?.error ? ` **${docs[s].error.slice(0, 160)}**` : ''} |`)
  const links = docs.apply?.results?.links ?? []
  if (links.length) {
    L.push('', '## Per-link apply timing (first apply, with a concurrent production-shaped workload on the hot links)', '', '| # | Migration | ms | Hot tables | Workload ops | Workload errors | Max stmt ms | Max lock wait ms |', '|---|---|---|---|---|---|---|---|')
    links.forEach((l, i) => L.push(`| ${i + 1} | \`${l.name}\` | ${l.ms} | ${(l.hot_tables ?? []).join(', ') || ''} | ${l.workload?.ops ?? ''} | ${l.workload?.errors ?? ''} | ${l.workload?.max_stmt_ms ?? ''} | ${l.workload?.max_lock_wait_ms ?? ''} |`))
  }
  const probes = docs.probes?.results?.probes ?? docs.probes?.error ? (docs.probes?.results?.probes ?? []) : []
  if (probes.length) { L.push('', '## Production-shaped writes after the chain', '', '| Probe | Table | Shape | Result | Side effects |', '|---|---|---|---|---|'); for (const p of probes) L.push(`| ${p.name} | ${p.table} | ${p.shape} | ${p.not_applicable ? `n/a on the synthetic baseline (${p.error?.message?.slice(0, 80) ?? 'column absent'}); decided by the production-schema run` : p.gated ? `gated off, as in production: ${p.gated.missing.join(', ')} absent before and after the chain (${p.gated.by})` : p.ok ? 'ok' : `FAIL ${p.error?.code ?? ''} ${p.error?.message?.slice(0, 100) ?? ''}`} | ${JSON.stringify(p.side_effects)} |`) }
  L.push('', '## What this does and does not prove', '', '- Proves: the reviewed chain applies in order on this schema, how long each link takes, what the concurrent workload saw on the hot tables, that production-shaped writes still succeed afterwards, that the real gateway binary boots and answers the MCP handshake against the migrated schema, that recovery is a restore of the pre-apply backup (timed, fingerprint-identical), and that a second apply is identical.', '- Does not prove: production data volume (schema only or invented rows), production\'s web workers (the workload is a stand-in for their write shapes), or anything about sending: nothing was sent.')
  // dispatch isolation: the facts recorded at the end of the gateway step (after apply, probes and the gateway, before the
  // rollback replaced the database), else as the database stands now
  const iso = docs.gateway?.results?.isolation_after_gateway ?? isolationFacts(ctx)
  L.push('', '## Dispatch isolation (nothing can reach production sending from here)', '', '| Check | Value |', '|---|---|')
  for (const [k, v] of Object.entries(iso)) L.push(`| ${k} | ${Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v} |`)
  L.push('', `Expected: 0 pg_net requests, 0 cron jobs run, 0 rows created here that reached sent, send switch false, no provider variable, loopback only. ${iso.pg_net_requests_recorded === 0 && iso.cron_jobs_recorded === 0 && iso.rows_created_here_that_reached_sent === 0 && iso.ai_conversation_send_enabled === 'false' && (iso.provider_env_present ?? []).length === 0 ? '**All as expected.**' : '**Review the values above.**'}`)
  fs.writeFileSync(ctx.evidence('REPORT.md'), `${L.join('\n')}\n`, { mode: 0o600 })
  fs.writeFileSync(ctx.evidence('isolation.json'), `${JSON.stringify(iso, null, 2)}\n`, { mode: 0o600 })
  ctx.log('report', `wrote ${ctx.evidence('REPORT.md')}`)
  const failed = STEPS.filter((s) => s !== 'report' && docs[s] && docs[s].status === 'fail')
  if (failed.length) throw new Error(`steps failed: ${failed.join(', ')}`)
  return { report: ctx.evidence('REPORT.md'), isolation: iso, steps: Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v?.status ?? 'not run'])) }
}

// ─────────────────────────────────────────────────────────────────────────────────── main
const COMMANDS = { guard: async (ctx) => runStep(ctx, 'guard', async () => ({ ok: true })), create: cmdCreate, seed: cmdSeed, snapshot: cmdSnapshot, review: cmdReview, apply: cmdApply, probes: cmdProbes, gateway: cmdGateway, rollback: cmdRollback, reapply: cmdReapply, report: cmdReport }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--')) ?? 'all'
  const ctx = new Ctx()
  const run = async () => {
    if (cmd === 'all') { for (const s of STEPS) { const d = await COMMANDS[s](ctx); if (d?.status === 'fail') { process.exitCode = 1; return } } return }
    if (!COMMANDS[cmd]) { console.error(`unknown step ${cmd}; steps: ${STEPS.join(' ')}`); process.exitCode = 2; return }
    const d = await COMMANDS[cmd](ctx); if (d?.status === 'fail') process.exitCode = 1
  }
  run().catch((e) => { console.error(`staging-rehearsal: ${e.message}`); process.exitCode = 1 })
}
