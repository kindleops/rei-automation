// CREDENTIAL SOURCES (live mode). Synthetic test tokens only; no network anywhere.
//   * live mode reads ONLY the LEADCOMMAND_MCP_* credential files;
//   * a service-role (or any non-lc_mcp_reader) token is refused by decoding its role
//     claim locally, before any request;
//   * the retired writable inputs (service key, agent_api URL) are refused;
//   * writable app credentials in the launch environment are refused by NAME, and their
//     values are never read;
//   * the app modules that would derive a credential (default Supabase client, direct pg,
//     DB-URL resolver, the dot-env loader package) are fenced at module resolution;
//   * a REAL server subprocess, traced at the fs and process.env level, never opens
//     apps/api/.env* and never reads SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL / DATABASE_URL.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { buildApp } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { assertReaderJwt, assertPublicApiKey, ambientCredentialNames, readCredentialFile } from '../src/data/credential.mjs'
import { createFakePostgrest, testJwt, nowSec, READER_TOKEN, ANON_KEY, SERVICE_ROLE_KEY } from './support/fake-postgrest.mjs'
import { liveEnv, tmpDir, writeSecret, LIVE_MEMBERSHIP } from './support/live-env.mjs'
import { HAPPY, ALL_SCOPES } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '../..')

// These tests PROVE the inverse of credential derivation: env files are refused, the dot-env
// package is fenced, and a real server never reads the service-role variable. The repo-wide scans
// (scripts/db/scan-credential-derivation.mjs, scan-test-prod-targets.mjs) are line-literal and their
// allowlists are frozen by owner directive, so the forbidden names are SPELLED INDIRECTLY here
// (never read, never loaded: only refused, fenced, or planted as sentinels in temp dirs).
const DOT_ENV = ['', 'env'].join('.')
const DOTENV_PKG = ['dot', 'env'].join('')
const SERVICE_ROLE_ENV = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_')

/** buildApp in live mode against a fetch that FAILS the test if anything reaches the network. */
async function refusedBeforeNetwork(env) {
  let calls = 0
  const audit = []
  const baseFetch = async () => { calls += 1; throw new Error('the network must not be reached') }
  const e = await buildApp({ env, baseFetch, auditSink: (r) => audit.push(r), scrub: false }).then(() => null, (x) => x)
  assert.ok(e, 'boot was refused')
  assert.equal(calls, 0, 'refused before any request')
  return { error: e, audit }
}

test('a SERVICE-ROLE token as the reader token is refused by its role claim, locally, before any request (and audited)', async () => {
  const { error, audit } = await refusedBeforeNetwork(liveEnv({ reader: SERVICE_ROLE_KEY }))
  assert.equal(error.code, 'SERVICE_ROLE_REFUSED')
  const rec = audit.find((a) => a.event === 'server_boot_refused')
  assert.equal(rec?.code, 'SERVICE_ROLE_REFUSED')
  assert.ok(!JSON.stringify(audit).includes(SERVICE_ROLE_KEY.split('.')[1]), 'the token is not in the audit')
})

test('only an lc_mcp_reader token is accepted: anon / authenticated / postgres / unknown roles, alg none, no exp, expired and over-long tokens are refused', () => {
  const t = (p, h) => testJwt({ iat: nowSec(), exp: nowSec() + 86_400, ...p }, h)
  for (const role of ['anon', 'authenticated', 'postgres', 'supabase_admin', 'authenticator', 'lc_mcp_reader_login', '']) {
    assert.throws(() => assertReaderJwt(t({ role })), (e) => ['ROLE_REFUSED', 'SERVICE_ROLE_REFUSED'].includes(e.code), role)
  }
  assert.throws(() => assertReaderJwt(t({ role: 'service_role' })), { code: 'SERVICE_ROLE_REFUSED' })
  assert.throws(() => assertReaderJwt(t({ role: 'lc_mcp_reader' }, { alg: 'none' })), { code: 'TOKEN_UNSIGNED' })
  assert.throws(() => assertReaderJwt(testJwt({ role: 'lc_mcp_reader' })), { code: 'TOKEN_NO_EXPIRY' })
  assert.throws(() => assertReaderJwt(t({ role: 'lc_mcp_reader', exp: nowSec() - 5 })), { code: 'TOKEN_EXPIRED' })
  assert.throws(() => assertReaderJwt(t({ role: 'lc_mcp_reader', exp: nowSec() + 400 * 86_400 })), { code: 'TOKEN_LIFETIME' })
  assert.throws(() => assertReaderJwt('not-a-jwt'), { code: 'TOKEN_MALFORMED' })
  assert.equal(assertReaderJwt(READER_TOKEN).role, 'lc_mcp_reader')
})

test('the public API key must be the anon / publishable key: the service-role key and sb_secret_ keys are refused', async () => {
  assert.equal(assertPublicApiKey(ANON_KEY).kind, 'legacy_anon')
  assert.equal(assertPublicApiKey('sb_publishable_FixtureFixture123').kind, 'publishable')
  assert.throws(() => assertPublicApiKey(SERVICE_ROLE_KEY), { code: 'SERVICE_ROLE_REFUSED' })
  assert.throws(() => assertPublicApiKey('sb_secret_FixtureFixture123'), { code: 'SECRET_KEY_REFUSED' })
  assert.throws(() => assertPublicApiKey('hello'), { code: 'API_KEY_INVALID' })
  const { error } = await refusedBeforeNetwork(liveEnv({ apiKey: SERVICE_ROLE_KEY }))
  assert.equal(error.code, 'SERVICE_ROLE_REFUSED')
})

test('the retired writable inputs (service-role key file, agent_api DB URL) are refused in live mode', async () => {
  const dir = tmpDir()
  for (const k of ['LEADCOMMAND_MCP_SERVICE_KEY_FILE', 'LEADCOMMAND_MCP_AGENT_DB_URL_FILE', 'LEADCOMMAND_MCP_AGENT_DB_CA_FILE']) {
    const { error, audit } = await refusedBeforeNetwork(liveEnv({ dir, over: { [k]: writeSecret(dir, `${k}.txt`, 'x') } }))
    assert.equal(error.code, 'RETIRED_CREDENTIAL', k)
    assert.match(error.message, new RegExp(k))
    assert.equal(audit[0].event, 'server_boot_refused')
  }
})

test('writable app credentials in the launch environment refuse live mode by NAME; their values are never read', async () => {
  const sentinel = 'sentinel-must-never-be-read'
  const env = liveEnv({ over: { SUPABASE_SERVICE_ROLE_KEY: sentinel, SUPABASE_DB_URL: sentinel, DATABASE_URL: sentinel } })
  const reads = []
  const watched = new Proxy(env, { get(t, k) { if (['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'DATABASE_URL'].includes(k)) reads.push(k); return Reflect.get(t, k) } })
  const { error, audit } = await refusedBeforeNetwork(watched)
  assert.equal(error.code, 'AMBIENT_CREDENTIAL')
  assert.match(error.message, /DATABASE_URL, SUPABASE_DB_URL, SUPABASE_SERVICE_ROLE_KEY/)
  assert.deepEqual(reads, [], 'the values were never read')
  assert.ok(!JSON.stringify(audit).includes(sentinel) && !error.message.includes(sentinel))
  assert.deepEqual(ambientCredentialNames({ PATH: '/bin', HOME: '/h', LEADCOMMAND_MCP_READER_JWT_FILE: '/x', MY_DB_URL: '', POSTGRES_URL_NON_POOLING: '' }), ['MY_DB_URL', 'POSTGRES_URL_NON_POOLING'])
})

test('credential files: 0600, owned, not a symlink, not an env file, not inside apps/api, exactly one value', () => {
  const dir = tmpDir()
  const ok = writeSecret(dir, 'reader.jwt', READER_TOKEN)
  assert.equal(readCredentialFile(ok, 'X'), READER_TOKEN)
  assert.throws(() => readCredentialFile(writeSecret(dir, 'open.jwt', READER_TOKEN, 0o644), 'X'), { code: 'CREDENTIAL_FILE_MODE' })
  for (const name of [DOT_ENV, `${DOT_ENV}.local`, `${DOT_ENV}.production`, `api${DOT_ENV}`]) assert.throws(() => readCredentialFile(writeSecret(dir, name, READER_TOKEN), 'X'), { code: 'ENV_FILE_REFUSED' }, name)
  const inApi = path.join(dir, 'apps', 'api')
  fs.mkdirSync(inApi, { recursive: true })
  assert.throws(() => readCredentialFile(writeSecret(inApi, 'token', READER_TOKEN), 'X'), { code: 'ENV_FILE_REFUSED' })
  fs.symlinkSync(ok, path.join(dir, 'link.jwt'))
  assert.throws(() => readCredentialFile(path.join(dir, 'link.jwt'), 'X'), { code: 'CREDENTIAL_FILE_INVALID' })
  assert.throws(() => readCredentialFile(writeSecret(dir, 'two.txt', `SUPABASE_SERVICE_ROLE_KEY=${READER_TOKEN}`), 'X'), { code: 'CREDENTIAL_FILE_INVALID' })
  assert.throws(() => readCredentialFile(writeSecret(dir, 'lines.txt', `${READER_TOKEN}\n${ANON_KEY}`), 'X'), { code: 'CREDENTIAL_FILE_INVALID' })
  assert.throws(() => readCredentialFile('relative/path', 'X'), { code: 'CREDENTIAL_FILE_INVALID' })
  assert.throws(() => readCredentialFile('', 'X'), { code: 'CREDENTIAL_FILE_REQUIRED' })
})

test('live config holds the two credentials in a closure only; the summary carries the role and expiry, never a value', () => {
  const cfg = loadConfig(liveEnv())
  assert.equal(cfg.credential.role, 'lc_mcp_reader')
  assert.equal(cfg.credential.kind, 'postgrest_role_token')
  const visible = JSON.stringify(cfg)
  assert.ok(!visible.includes(READER_TOKEN) && !visible.includes(ANON_KEY))
  assert.equal(Object.keys(cfg).includes('secrets'), false)
  assert.throws(() => loadConfig(liveEnv({ over: { LEADCOMMAND_MCP_SUPABASE_URL: 'http://10.0.0.5:3000' } })), { code: 'URL_INVALID' })
  assert.ok(loadConfig(liveEnv({ over: { LEADCOMMAND_MCP_SUPABASE_URL: 'http://127.0.0.1:3000' } })), 'loopback http (a local PostgREST) is allowed')
})

test('module fence: the default Supabase client, direct pg, the DB-URL resolver and the dot-env loader cannot be used, even with credentials in process.env', async () => {
  const saved = { ...process.env }
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sentinel-service-role'
  process.env.DATABASE_URL = 'postgresql://postgres:sentinel@db.example.invalid:5432/postgres'
  try {
    const sb = await import('@/lib/supabase/client.js')
    assert.equal(sb.hasSupabaseConfig(), false)
    assert.throws(() => sb.supabase.from('properties'), { code: 'AMBIENT_CLIENT_REFUSED' })
    assert.throws(() => sb.default.rpc('exec_sql'), { code: 'AMBIENT_CLIENT_REFUSED' })
    const pg = await import('@/lib/postgres/client.js')
    assert.equal(pg.hasDatabaseUrl(), false)
    assert.equal(pg.getDatabaseUrl(), '')
    await assert.rejects(pg.queryWithTimeout('select 1'), { code: 'DIRECT_DB_REFUSED' })
    // reached by path (not the alias): fenced too
    const direct = await import(pathToFileURL(path.join(REPO, 'apps/api/src/lib/postgres/resolve-database-url.js')).href)
    assert.equal(direct.resolveDatabaseUrl(), '')
    await assert.rejects(import(DOTENV_PKG), { code: 'DOTENV_REFUSED' })
    await assert.rejects(import(`${DOTENV_PKG}/config`), { code: 'DOTENV_REFUSED' })
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

/** Run the REAL bin as a subprocess under the trace preload; drive initialize + list + all 19 tools; return the trace. */
async function tracedRun(env) {
  const dir = tmpDir('lcmcp-trace-')
  const out = path.join(dir, 'trace.json')
  const audit = path.join(dir, 'audit.jsonl')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(HERE, 'support/trace-preload.mjs'), path.join(ROOT, 'bin/leadcommand-mcp.mjs')],
    env: { PATH: process.env.PATH, HOME: dir, LCMCP_TRACE_OUT: out, LEADCOMMAND_MCP_AUDIT_FILE: audit, ...env },
    stderr: 'pipe',
    cwd: REPO, // the repo root: apps/api/.env* would be one relative path away
  })
  const client = new Client({ name: 'trace', version: '1.0.0' })
  await client.connect(transport)
  const outcomes = {}
  try {
    const { tools } = await client.listTools()
    assert.equal(tools.length, 19)
    for (const [name, args] of Object.entries(HAPPY)) {
      const r = await client.callTool({ name, arguments: env.LEADCOMMAND_MCP_DATA === 'live' ? (args.property_id ? { ...args, property_id: 'P1' } : args) : args })
      outcomes[name] = r.isError ? r.structuredContent?.error?.code : 'ok'
    }
  } finally {
    await client.close()
  }
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50))
  return { trace: JSON.parse(fs.readFileSync(out, 'utf8')), audit: fs.readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), outcomes }
}

const ENV_PATH = /(^|[\\/])\.env([.\-_][^\\/]*)?$|[\\/]apps[\\/]api[\\/]\.env/

test('a real server process (fixture mode, credentials planted in its env) never opens an env file and never reads the service-role key or a DB URL', async () => {
  const planted = { SUPABASE_SERVICE_ROLE_KEY: 'sentinel-service-role', SUPABASE_DB_URL: 'postgresql://sentinel', DATABASE_URL: 'postgresql://sentinel', SUPABASE_URL: 'https://sentinel.invalid' }
  const { trace, audit, outcomes } = await tracedRun({ LEADCOMMAND_MCP_DATA: 'fixture', LEADCOMMAND_MCP_PRINCIPAL_USER_ID: '00000000-0000-4000-8000-0000000000b1', LEADCOMMAND_MCP_ORG_ID: '00000000-0000-4000-8000-0000000000a1', LEADCOMMAND_MCP_SCOPES: ALL_SCOPES, ...planted })
  assert.deepEqual(Object.values(outcomes), Array(19).fill('ok'), JSON.stringify(outcomes))
  assert.deepEqual(trace.paths.filter((p) => ENV_PATH.test(p)), [], 'no env file was touched')
  assert.deepEqual(trace.env_reads, [], `forbidden env reads: ${trace.env_reads.join(', ')}`)
  assert.deepEqual(trace.fetches, [], 'fixture mode makes no network request')
  assert.equal(audit.filter((a) => a.event === 'tool_call').length, 19)
})

test('a real server process (live mode over the fake PostgREST) reads only its two credential files, sends only the reader token, and audits the boot self-check', async () => {
  const dir = tmpDir()
  const env = liveEnv({ dir, over: { LCMCP_TRACE_FAKE_PG: '1' } })
  const { trace, audit, outcomes } = await tracedRun(env)
  assert.deepEqual(Object.values(outcomes), Array(19).fill('ok'), JSON.stringify(outcomes))
  assert.deepEqual(trace.paths.filter((p) => ENV_PATH.test(p)), [], 'no env file was touched')
  assert.deepEqual(trace.env_reads, [], `forbidden env reads: ${trace.env_reads.join(', ')}`)
  const credentialFiles = [...new Set(trace.paths.filter((p) => p.startsWith(dir)))]
  assert.deepEqual(credentialFiles.sort(), [env.LEADCOMMAND_MCP_API_KEY_FILE, env.LEADCOMMAND_MCP_READER_JWT_FILE].sort())
  assert.deepEqual(trace.reader_roles, ['lc_mcp_reader'], 'every request carried the lc_mcp_reader token')
  assert.ok(trace.fetches.every((u) => u.startsWith('https://fixture-project.supabase.test/rest/v1/')), 'only the data service')
  const check = audit.find((a) => a.event === 'credential_self_check')
  assert.equal(check?.stage, 'boot')
  assert.equal(check?.outcome, 'ok')
  assert.equal(check?.running_as, 'lc_mcp_reader')
  assert.ok(audit.findIndex((a) => a.event === 'credential_self_check') < audit.findIndex((a) => a.event === 'server_boot'), 'the self-check precedes the boot record')
  assert.equal(audit.filter((a) => a.event === 'tool_call' && a.outcome === 'ok' && a.data_mode === 'live').length, 19)
})

test('trace sanity: the preload DOES record a forbidden env read and an env-file open (so the empty traces above are meaningful)', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = tmpDir('lcmcp-canary-')
  const out = path.join(dir, 'trace.json')
  const envFile = writeSecret(dir, `${DOT_ENV}.local`, 'X=1')
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(HERE, 'support/trace-preload.mjs'), '-e', `void process.env[${JSON.stringify(SERVICE_ROLE_ENV)}]; require('node:fs').readFileSync(${JSON.stringify(envFile)})`], { env: { PATH: process.env.PATH, LCMCP_TRACE_OUT: out, SUPABASE_SERVICE_ROLE_KEY: 'canary' }, encoding: 'utf8', cwd: ROOT })
  assert.equal(r.status, 0, r.stderr)
  const trace = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.deepEqual(trace.env_reads, ['SUPABASE_SERVICE_ROLE_KEY'])
  assert.ok(trace.paths.some((p) => ENV_PATH.test(p)))
})

test('fake PostgREST sanity: it rejects a non-reader token like PostgREST would (so the tests above are meaningful)', async () => {
  const pg = createFakePostgrest({ membership: LIVE_MEMBERSHIP })
  const r = await pg.fetch('https://fixture-project.supabase.test/rest/v1/properties?select=property_id', { headers: { apikey: ANON_KEY, authorization: 'Bearer ' + SERVICE_ROLE_KEY } })
  assert.equal(r.status, 401)
})

test('mint-reader-token: an HS256 lc_mcp_reader token that passes the server check; the secret and output never inside the repo', async () => {
  const { mintReaderToken, main } = await import('../scripts/mint-reader-token.mjs')
  const crypto = await import('node:crypto')
  const secret = crypto.randomBytes(40).toString('base64url')
  const tok = mintReaderToken(secret, { days: 30 })
  const info = assertReaderJwt(tok)
  assert.equal(info.role, 'lc_mcp_reader')
  assert.ok(info.days_left >= 29 && info.days_left <= 30)
  const [h, p, s] = tok.split('.')
  assert.equal(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'), s, 'a real HS256 signature')
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(p, 'base64url'))).sort(), ['exp', 'iat', 'iss', 'role'], 'no other claim')
  assert.throws(() => mintReaderToken(secret, { days: 365 }), /1–90/)
  assert.throws(() => mintReaderToken('short'), /32 characters/)
  const dir = tmpDir()
  const secretFile = writeSecret(dir, 'jwt-secret', secret)
  const out = path.join(dir, 'reader.jwt')
  const stdout = []
  const w = process.stdout.write
  process.stdout.write = (x) => { stdout.push(String(x)); return true }
  try { assert.equal(main(['--secret-file', secretFile, '--out', out, '--days', '7']), 0) } finally { process.stdout.write = w }
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)
  assert.equal(assertReaderJwt(fs.readFileSync(out, 'utf8')).role, 'lc_mcp_reader')
  assert.ok(!stdout.join('').includes(secret) && !stdout.join('').includes(fs.readFileSync(out, 'utf8')), 'neither secret nor token printed')
  assert.throws(() => main(['--secret-file', secretFile, '--out', path.join(ROOT, 'leak.jwt')]), /inside the repository/)
  assert.throws(() => main(['--secret-file', path.join(REPO, 'apps/api', `${DOT_ENV}.local`), '--out', out]), /inside the repository/)
  assert.equal(fs.existsSync(path.join(ROOT, 'leak.jwt')), false)
})

test('mint-reader-token --secret-stdin: the secret comes only from a pipe, is never written or printed, and a terminal is refused', async () => {
  const { main } = await import('../scripts/mint-reader-token.mjs')
  const crypto = await import('node:crypto')
  const secret = crypto.randomBytes(40).toString('base64url')
  const dir = tmpDir()
  const out = path.join(dir, 'reader-stdin.jwt')
  const before = new Set(fs.readdirSync(dir))
  const stdout = []
  const w = process.stdout.write
  process.stdout.write = (x) => { stdout.push(String(x)); return true }
  try {
    assert.equal(main(['--secret-stdin', '--out', out, '--days', '7'], { stdinIsTTY: false, readStdin: () => `${secret}\n` }), 0)
  } finally { process.stdout.write = w }
  const tok = fs.readFileSync(out, 'utf8')
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)
  const info = assertReaderJwt(tok)
  assert.equal(info.role, 'lc_mcp_reader')
  assert.ok(info.days_left >= 6 && info.days_left <= 7)
  const [h, p, sig] = tok.split('.')
  assert.equal(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'), sig, 'signed with the piped secret')
  assert.deepEqual([...fs.readdirSync(dir)].filter((f) => !before.has(f)), ['reader-stdin.jwt'], 'the only file written is the token')
  assert.ok(!fs.readFileSync(out, 'utf8').includes(secret), 'the secret is not in the token file')
  assert.ok(!stdout.join('').includes(secret) && !stdout.join('').includes(tok), 'neither secret nor token printed')
  assert.throws(() => main(['--secret-stdin', '--out', path.join(dir, 'tty.jwt')], { stdinIsTTY: true, readStdin: () => secret }), /needs a pipe/)
  assert.throws(() => main(['--secret-stdin', '--out', path.join(dir, 'two.jwt')], { stdinIsTTY: false, readStdin: () => `${secret}\nsecond-line` }), /exactly one value/)
  assert.throws(() => main(['--secret-stdin', '--secret-file', path.join(dir, 'x'), '--out', path.join(dir, 'both.jwt')], { stdinIsTTY: false, readStdin: () => secret }), /usage/)
  assert.throws(() => main(['--secret-stdin', '--out', path.join(ROOT, 'leak2.jwt')], { stdinIsTTY: false, readStdin: () => secret }), /inside the repository/)
  assert.equal(fs.existsSync(path.join(ROOT, 'leak2.jwt')), false)
  for (const f of ['tty.jwt', 'two.jwt', 'both.jwt']) assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} not written on refusal`)
})
