// The launch review of the agntei gateway chain, on a disposable PostgreSQL 17: the reviewer reads the catalog inside a
// READ ONLY transaction and tells, per migration in order, applied / partial / absent, the live version of every
// function body, DRIFT (a body no reviewed migration produced) and a broken order. The manifest must match the files.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { pgAvailable, skipReason, ADMIN_URL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { CHAIN } from '../../../../scripts/agntei-launch/chain.mjs'
import { review, liveCatalog } from '../../../../scripts/agntei-launch/review-chain.mjs'
import { applyOne } from '../../../../scripts/agntei-launch/apply-one.mjs'
import { plan } from '../../../../scripts/agntei-launch/grants.mjs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { servicePrincipalDb, keyFor } from '../helpers/service-principal-pg.mjs'
import { seedWorld, ORG, OWNER, PEPPER } from '../helpers/action-gateway-pg.mjs'

const skip = pgAvailable() ? false : skipReason
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'scripts/agntei-launch/gateway-chain.manifest.json'), 'utf8'))
async function world(apply) {
  const name = `launch_${crypto.randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect(); await admin.query(`create database ${name}`); await admin.end()
  const u = new URL(ADMIN_URL); u.pathname = `/${name}`
  const c = new pg.Client({ connectionString: u.toString() }); await c.connect()
  const drop = async () => { await c.end().catch(() => {}); const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`drop database if exists ${name} with (force)`); await a.end() }
  try {
    // a pretest runs only when its own migration is applied (it checks that migration's preconditions)
    const applied = new Set(CHAIN.filter((s, i) => s.kind === 'migration' && apply(s, i)).map((s) => s.file))
    for (const [i, step] of CHAIN.entries()) {
      const on = step.kind === 'pretest' ? applied.has(step.file.replace(/_pretest\.sql$/, '.sql')) : apply(step, i)
      if (!on) continue
      await c.query('begin'); try { await c.query(fs.readFileSync(path.join(REPO_DIR, step.file), 'utf8')); await c.query('commit') } catch (e) { await c.query('rollback').catch(() => {}); throw new Error(`${step.file}: ${e.message}`) }
    }
  } catch (e) { await drop(); throw e }
  return { url: u.toString(), c, drop }
}
const migrationsOnProductionBranch = new Set(manifest.migrations.slice(0, 11).map((m) => m.name))

test('the manifest is current: every migration file still hashes to what was fingerprinted', () => {
  for (const m of manifest.migrations) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_DIR, m.file))).digest('hex'), m.sha256, `${m.file} changed since the manifest was built: rebuild it`)
  assert.deepEqual(manifest.migrations.map((m) => m.file), CHAIN.filter((s) => s.kind === 'migration').map((s) => s.file))
})

test('PG launch review: a production-like database (the shared migrations applied) shows exactly what is pending, in order', { skip }, async () => {
  const w = await world((s) => s.kind !== 'migration' || migrationsOnProductionBranch.has(path.basename(s.file, '.sql')))
  try {
    const { live } = await liveCatalog(w.url)
    const r = review(manifest, live)
    assert.deepEqual(r.rows.slice(0, 11).map((x) => x.status), Array(11).fill('applied'))
    assert.equal(r.next, 'PROPOSED_20261017122000_conversation_turn_operator_items')
    assert.equal(r.pending.length, manifest.migrations.length - 11)
    assert.equal(r.orderBroken, false); assert.deepEqual(r.drift, [])
    assert.ok(r.rows.find((x) => x.name === 'PROPOSED_20261105120000_action_gateway_service_principals').status === 'absent')
  } finally { await w.drop() }
})

test('PG launch review: the full chain reads as applied; a hand-edited function body is DRIFT; a skipped middle migration breaks the order', { skip }, async () => {
  const full = await world(() => true)
  try {
    let r = review(manifest, (await liveCatalog(full.url)).live)
    assert.deepEqual(r.pending, []); assert.equal(r.next, null); assert.deepEqual(r.drift, [])
    // someone edits a reviewed function in place (a body no migration produced)
    const fn = Object.keys(manifest.migrations.find((m) => m.name === 'PROPOSED_20261101120000_record_sync').bodies)[0]
    const def = (await full.c.query(`select pg_get_functiondef(to_regprocedure($1)) d`, [fn])).rows[0].d
    await full.c.query(def.replace(/\$function\$/, '$function$\n-- edited outside the chain'))
    r = review(manifest, (await liveCatalog(full.url)).live)
    assert.ok(r.drift.some((d) => d.includes(fn)), 'the edited body is reported as drift')
  } finally { await full.drop() }
  const gap = await world((s) => !s.file.endsWith('PROPOSED_20261015190000_negotiation_authority.sql') && !s.file.includes('negotiation_send_authorization') && !s.file.includes('action_gateway') && !s.file.includes('record_sync') && !s.file.includes('ai_generated_outbound') && !s.file.includes('followup_intent'))
  try {
    const r = review(manifest, (await liveCatalog(gap.url)).live)
    assert.equal(r.next, 'PROPOSED_20261015190000_negotiation_authority')
    assert.equal(r.rows.find((x) => x.name === 'PROPOSED_20261015190000_negotiation_authority').status, 'absent')
  } finally { await gap.drop() }
})

test('PG launch review is read-only: the reviewer cannot write even if asked to', { skip }, async () => {
  const w = await world((s) => s.file.endsWith('supabase-shim.sql'))
  try {
    const c = new pg.Client({ connectionString: w.url }); await c.connect()
    await c.query('begin transaction read only')
    await assert.rejects(c.query('create table should_not_exist (x int)'), /read-only transaction/)
    await c.query('rollback'); await c.end()
    const { live } = await liveCatalog(w.url)
    assert.equal(live.has('table:public.should_not_exist'), false)
  } finally { await w.drop() }
})

test('PG launch apply-one: only the NEXT reviewed migration, pretest read-only first, one transaction, read back; anything else is refused', { skip }, async () => {
  const w = await world((s) => s.kind !== 'migration' || migrationsOnProductionBranch.has(path.basename(s.file, '.sql')))
  try {
    const log = []
    await assert.rejects(applyOne(w.url, 'PROPOSED_20261105120000_action_gateway_service_principals', { log: (x) => log.push(x) }), /the next migration is PROPOSED_20261017122000_conversation_turn_operator_items/)
    await assert.rejects(applyOne(w.url, 'PROPOSED_not_in_the_chain'), /not a migration of the reviewed chain/)
    const tampered = JSON.parse(JSON.stringify(manifest)); tampered.migrations.find((m) => m.name === 'PROPOSED_20261017122000_conversation_turn_operator_items').sha256 = '0'.repeat(64)
    await assert.rejects(applyOne(w.url, 'PROPOSED_20261017122000_conversation_turn_operator_items', { manifest: tampered }), /differs from the reviewed manifest/)
    const r = await applyOne(w.url, 'PROPOSED_20261017122000_conversation_turn_operator_items', { log: (x) => log.push(x) })
    assert.equal(r.status, 'applied'); assert.equal(r.next, 'PROPOSED_20261016200000_automation_holds_registry')
    assert.ok(log.some((l) => /applied .* in one transaction/.test(l)) && log.some((l) => /read back: .* is applied/.test(l)))
  } finally { await w.drop() }
})

test('PG launch grants: principals registered with a discarded credential, role grants written and read back, nothing that sends; the real mint then detaches the agents\' own credentials', { skip }, async () => {
  const env = await servicePrincipalDb()
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'launch-grants-'))
  try {
    await seedWorld(env.owner)
    const urlFile = path.join(dir, 'owner.dburl'); fs.writeFileSync(urlFile, env.url, { mode: 0o600 })
    const pepFile = path.join(dir, 'pepper'); fs.writeFileSync(pepFile, PEPPER, { mode: 0o600 })
    const args = ['scripts/agntei-launch/grants.mjs', '--org', ORG, '--owner', OWNER, '--agents', 'rowan=agt_launch_rowan,reps=agt_launch_cruz,research=agt_launch_scout']
    const env2 = { ...process.env, LC_OWNER_DB_URL_FILE: urlFile, LC_PEPPER_FILE: pepFile }
    const preview = spawnSync('node', args, { cwd: REPO_DIR, env: env2, encoding: 'utf8' })
    assert.equal(preview.status, 0); assert.match(preview.stdout, /Preview only/)
    assert.equal(Number((await env.owner.query("select count(*) n from action_gateway.capability_grants where agent_id like 'agt_launch_%'")).rows[0].n), 0, 'a preview writes nothing')
    assert.equal(spawnSync('node', [...args, '--apply'], { cwd: REPO_DIR, env: env2, encoding: 'utf8' }).status, 2, '--apply without --confirm GRANT is refused')
    const run = spawnSync('node', [...args, '--apply', '--confirm', 'GRANT'], { cwd: REPO_DIR, env: env2, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /every planned grant is present/)
    const grants = (await env.owner.query("select agent_id, capability, max_tier from action_gateway.capability_grants where agent_id like 'agt_launch_%' and revoked_at is null order by 1, 2")).rows
    assert.equal(grants.length, plan({ org: ORG, owner: OWNER, agents: { rowan: ['agt_launch_rowan'], reps: ['agt_launch_cruz'], research: ['agt_launch_scout'] } }).rows.length)
    assert.ok(grants.every((g) => !/sms|send|launch|schedule/.test(g.capability)))
    const tiers = Object.fromEntries((await env.owner.query("select agent_id, tier_ceiling from action_gateway.agent_principals where agent_id like 'agt_launch_%'")).rows.map((r) => [r.agent_id, r.tier_ceiling]))
    assert.deepEqual(tiers, { agt_launch_rowan: 2, agt_launch_cruz: 2, agt_launch_scout: 1 })
    assert.equal(spawnSync('node', [...args, '--apply', '--confirm', 'GRANT'], { cwd: REPO_DIR, env: env2, encoding: 'utf8' }).status, 0, 'a second run adds nothing and still reads back')
    assert.equal(Number((await env.owner.query("select count(*) n from action_gateway.capability_grants where agent_id like 'agt_launch_%'")).rows[0].n), grants.length)
    // the owner's next step: the real mint script, with the agents' PUBLIC keys, detaching their own credentials
    const mint = spawnSync('node', ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './src/loader/register.mjs', 'scripts/mint-service-credential.mjs', '--database-url-file', urlFile, '--org', ORG, '--owner', OWNER, '--create', '--service-id', 'svc_launch', '--sponsor', OWNER, '--tier-ceiling', '2', '--pepper-file', pepFile, '--days', '7', '--detach-agent-credentials', ...['agt_launch_rowan', 'agt_launch_cruz', 'agt_launch_scout'].flatMap((a) => ['--delegate', `${a}=${keyFor(a).publicKey}`])], { cwd: path.join(REPO_DIR, 'mcp/leadcommand-action-mcp'), env: process.env, encoding: 'utf8' })
    assert.equal(mint.status, 0, mint.stderr); assert.match(mint.stdout, /lcsvc_[A-Za-z0-9_-]{43}/)
    assert.equal(Number((await env.owner.query("select count(*) n from action_gateway.agent_principals where agent_id like 'agt_launch_%' and credential_digest is not null")).rows[0].n), 0, 'the agents can now act only through the service')
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await env.db.drop().catch(() => {}) }
})
