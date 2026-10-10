// Agent S3 — unauthorized access through a REAL PostgREST (Supabase's REST
// layer) in front of a disposable PostgreSQL 17 with the S3 schema applied.
// Skips unless AGENT_PG_TEST_DB_URL + AGENT_PGRST_BIN are set (CI downloads
// the PostgREST binary; see .github/workflows/agent-s3-persistence.yml).
//
//   1 Supabase default exposure (db-schemas = public, graphql_public): the agent
//     schema is not reachable at all — anon key, authenticated JWT, even the
//     service key get 406 for Accept-Profile: agent.
//   2 Misconfiguration drill (someone adds "agent" to exposed schemas): anon is
//     denied; an authenticated non-member reads nothing; a member of another
//     org reads only that org; the owner reads all; no authenticated write or
//     RPC succeeds.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'

import { pgAvailable, skipReason, freshDb } from '../pg/agent-pg-harness.mjs'
import { multiDb } from '../helpers/agent-s3-fake-db.mjs'
import { createPgAgentStore, DEFAULT_ORG_ID } from '../../src/lib/agent/runtime/pg-store.js'
import { createLiveAgent } from '../../src/lib/agent/live/live-agent.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'

const BIN = String(process.env.AGENT_PGRST_BIN || '').trim()
const ON = pgAvailable() && Boolean(BIN)
const SECRET = 'agent-s3-test-jwt-secret-at-least-32-characters-long'
const ORG_B = '00000000-0000-4000-8000-00000000b002'
const U_A = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const U_B = 'aaaaaaaa-0000-4000-8000-0000000000b1'
const OWNER = 'aaaaaaaa-0000-4000-8000-0000000000c1'
const STRANGER = 'aaaaaaaa-0000-4000-8000-0000000000d1'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function jwt(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' })
  const p = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${sig}`
}
const KEYS = {
  anon: jwt({ role: 'anon' }),
  stranger: jwt({ role: 'authenticated', sub: STRANGER }),
  memberA: jwt({ role: 'authenticated', sub: U_A }),
  memberB: jwt({ role: 'authenticated', sub: U_B }),
  owner: jwt({ role: 'authenticated', sub: OWNER }),
  service: jwt({ role: 'service_role' }),
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
  })
}

async function startPostgrest(dbUrl, schemas) {
  const port = await freePort()
  const u = new URL(dbUrl)
  u.username = 'authenticator'
  const proc = spawn(BIN, [], {
    env: { PGRST_DB_URI: u.toString(), PGRST_DB_SCHEMAS: schemas, PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET, PGRST_SERVER_PORT: String(port), PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_POOL: '4', PGRST_LOG_LEVEL: 'crit' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(`${base}/`); if (r.status < 500) break } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { base, stop: () => proc.kill('SIGTERM') }
}

async function seed(d) {
  await d.pool.query("insert into agent.org (org_id, name) values ($1, 'Other org')", [ORG_B])
  await d.pool.query("insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'operator', 't'), ($3, $4, 'operator', 't'), ($1, $5, 'owner', 't')", [DEFAULT_ORG_ID, U_A, ORG_B, U_B, OWNER])
  for (const org of [DEFAULT_ORG_ID, ORG_B]) {
    const store = createPgAgentStore({ pool: d.api, org_id: org })
    await store.open()
    const db = multiDb(['9000000001'])
    const agent = createLiveAgent({ env: { AGENT_MAX_MODE: 'read' }, store, createServices: () => createQuickScanServices({ db }) })
    const pf = await agent.quickScan.preflight({ operator_id: 'op', property_ids: ['9000000001'] })
    await (await agent.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: 'op' })).done
  }
}

const get = (base, key, table, profile = 'agent', select = 'org_id') => fetch(`${base}/${table}?select=${select}`, { headers: { Authorization: `Bearer ${key}`, 'Accept-Profile': profile } })

test('PostgREST, Supabase default exposure: the agent schema is unreachable for anon, authenticated and service keys', { skip: ON ? false : `${skipReason}; and AGENT_PGRST_BIN (PostgREST binary)` }, async () => {
  const d = await freshDb()
  const pg = await startPostgrest(d.url, 'public,graphql_public')
  try {
    await seed(d)
    for (const [who, key] of Object.entries(KEYS)) {
      for (const table of ['run', 'run_event', 'finding']) {
        const r = await get(pg.base, key, table)
        assert.equal(r.status, 406, `${who} ${table}: ${r.status}`)
        assert.match(await r.text(), /schema|PGRST106/i)
      }
    }
    const rpc = await fetch(`${pg.base}/rpc/purge_expired`, { method: 'POST', headers: { Authorization: `Bearer ${KEYS.anon}`, 'Content-Profile': 'agent', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(rpc.status, 406)
  } finally { pg.stop(); await d.drop() }
})

test('PostgREST, misconfiguration drill (agent exposed): anon denied; non-member nothing; other org only its own; owner all; no authenticated writes or RPCs', { skip: ON ? false : `${skipReason}; and AGENT_PGRST_BIN (PostgREST binary)` }, async () => {
  const d = await freshDb()
  const pg = await startPostgrest(d.url, 'public,agent')
  try {
    await seed(d)
    const orgs = async (key, table) => {
      const r = await get(pg.base, key, table)
      return { status: r.status, orgs: r.status === 200 ? [...new Set((await r.json()).map((x) => x.org_id))].sort() : (await r.text(), null) }
    }
    for (const table of ['run', 'run_event', 'research_job', 'research_task', 'finding', 'finding_conflict']) {
      const anon = await orgs(KEYS.anon, table)
      assert.ok([401, 403].includes(anon.status), `anon ${table} → ${anon.status}`)
      assert.deepEqual(await orgs(KEYS.stranger, table), { status: 200, orgs: [] }, `stranger ${table}`)
      assert.deepEqual(await orgs(KEYS.memberA, table), { status: 200, orgs: [DEFAULT_ORG_ID] }, `member A ${table}`)
      assert.deepEqual(await orgs(KEYS.memberB, table), { status: 200, orgs: [ORG_B] }, `member B ${table}`)
      assert.deepEqual(await orgs(KEYS.owner, table), { status: 200, orgs: [DEFAULT_ORG_ID, ORG_B].sort() }, `owner ${table}`)
    }
    for (const table of ['store_head', 'deletion_log', 'runtime_limits', 'retention_policy', 'org', 'tool_call']) {
      const r = await get(pg.base, KEYS.owner, table, 'agent', '*')
      assert.ok([401, 403].includes(r.status), `owner reading ${table} → ${r.status} ${await r.text()}`)
    }
    const write = (method, path, key, body) => fetch(`${pg.base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Profile': 'agent', 'content-type': 'application/json', Prefer: 'return=minimal' }, body: body ? JSON.stringify(body) : undefined })
    for (const key of [KEYS.anon, KEYS.memberA, KEYS.owner]) {
      assert.ok([401, 403].includes((await write('POST', '/run_event', key, { event_id: 999999, run_id: 'run_x', seq: 1, type: 'decision', at: new Date().toISOString(), payload: {} })).status))
      assert.ok([401, 403].includes((await write('PATCH', '/run?run_id=neq.x', key, { state: 'failed' })).status))
      assert.ok([401, 403].includes((await write('DELETE', '/finding?finding_id=neq.x', key)).status))
      for (const fn of ['purge_expired', 'delete_run', 'sync_operator_membership']) {
        const r = await write('POST', `/rpc/${fn}`, key, {})
        assert.ok([401, 403, 404].includes(r.status), `${fn} → ${r.status}`)
      }
    }
    const rows = (await d.pool.query('select count(*)::int n from agent.run')).rows[0].n
    assert.equal(rows, 2, 'nothing was written through PostgREST')
  } finally { pg.stop(); await d.drop() }
})
