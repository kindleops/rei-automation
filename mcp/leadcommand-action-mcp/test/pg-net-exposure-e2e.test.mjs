// END TO END, compensating control (c) of the Supabase pg_net platform exception (docs/SUPABASE-PG-NET-POSTURE.md):
// a REAL PostgREST + a DISPOSABLE PostgreSQL 17 where pg_net is Supabase-shaped (CREATE EXTENSION pg_net AS
// supabase_admin, the documented ACL; apps/api/tests/helpers/pg-net-posture.mjs) and the REAL role migrations are
// applied (#26 lc_action_gateway with its chain; #25 lc_mcp_reader with its emulation). authenticator's
// pgrst.db_schemas role setting is ABSENT, so the SQL can only record exposed_schemas_from_dashboard_unverified_in_sql
// and the live probe is the proof. In front of PostgREST, the API gateway minimally (as Supabase's routes it):
//   /rest/v1/*    → PostgREST /*                        (no apikey → 401)
//   /graphql/v1   → PostgREST POST /rpc/graphql with Content-Profile: graphql_public (pg_graphql's resolver; here a
//                   shape-only emulation that reflects the role's search_path, pg_net_emulation/graphql_public_emulation.sql)
// Proves: net NOT exposed → the probe passes and BOTH servers boot (the audit lists the exception and the probe);
// PGRST_DB_SCHEMAS includes net → the probe fails and both servers REFUSE to start; GraphQL reflecting net → the probe
// fails; the role cannot run the resolver at all (PUBLIC lacks USAGE on graphql_public, as in production 2026-10-23)
// → PostgREST's exact 42501 is accepted (refused_no_graphql_access) and BOTH servers boot, REST still required to refuse.
// (The read-only suite's test/graphql-access-e2e.test.mjs covers every GraphQL answer shape at the reader's boot.)
// Opt-in: LC_PG_BIN=<pg17 bin dir> LC_POSTGREST_BIN=<postgrest>.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pgNetServer, installPgNet, setExposedSchemas, LC_MCP_RELATIONS, REPO_DIR, EMULATION_DIR } from '../../../apps/api/tests/helpers/pg-net-posture.mjs'
import { probePlatformExposure, PG_NET_FINGERPRINT_VERSION } from '../../leadcommand-mcp/src/data/platform-exposure.mjs'
import { startSupabaseEdge, mintJwt } from '../../leadcommand-mcp/test/support/supabase-edge.mjs'
import { writeSecretFile } from '../src/config.mjs'

const PG_BIN = process.env.LC_PG_BIN
const PGRST_BIN = process.env.LC_POSTGREST_BIN
const skip = !(PG_BIN && PGRST_BIN) && 'set LC_PG_BIN and LC_POSTGREST_BIN to run the real-PostgREST pg_net exposure end-to-end'
const ORG = '00000000-0000-4000-8000-0000000000c1'
const now = () => Math.floor(Date.now() / 1000)
const mint = mintJwt

/** PostgREST (127.0.0.1, AS authenticator, the given exposed schemas) + the minimal API gateway in front of it. */
const startRest = ({ dbUrl, schemas, secret }) => startSupabaseEdge({ postgrestBin: PGRST_BIN, dbUrl, schemas, secret })

test('real PostgREST + Supabase-shaped pg_net: the exposure probe passes only when net is not exposed; both servers boot then, and refuse to start when PGRST_DB_SCHEMAS includes net', { skip, timeout: 300_000 }, async (t) => {
  const server = await pgNetServer()
  process.env.AGENT_PG_TEST_DB_URL = server.url // before the harness modules read it
  const { gatewayDb, GATEWAY_MIGRATION } = await import('../../../apps/api/tests/helpers/action-gateway-pg.mjs')
  const { freshDb, applyInTransaction } = await import('../../../apps/api/tests/pg/agent-pg-harness.mjs')
  const { buildApp: buildActionApp } = await import('../src/app.mjs')
  const { buildApp: buildReaderApp } = await import('../../leadcommand-mcp/src/app.mjs')
  const dbs = []
  const rests = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pgnet-e2e-'))
  const secret = crypto.randomBytes(32).toString('base64url')
  const anon = mint(secret, { role: 'anon', iss: 'supabase', iat: now(), exp: now() + 3600 })
  const gwToken = mint(secret, { role: 'lc_action_gateway', lc_org: ORG, iss: 'supabase', iat: now(), exp: now() + 3600 })
  const roToken = mint(secret, { role: 'lc_mcp_reader', iss: 'supabase', iat: now(), exp: now() + 3600 })
  const graphqlFixture = fs.readFileSync(path.join(EMULATION_DIR, 'graphql_public_emulation.sql'), 'utf8')
  try {
    // #26 on its real chain, ON TOP of Supabase-shaped pg_net; the exposed-schemas role setting is absent
    const gw = await gatewayDb({ apply: false })
    dbs.push(gw.db)
    await installPgNet(gw.db.pool)
    await setExposedSchemas(gw.db.pool, null)
    await gw.db.pool.query(graphqlFixture)
    await applyInTransaction(gw.db.pool, GATEWAY_MIGRATION)
    // #25 on its emulation, the same pg_net shape
    const ro = await freshDb({ apply: false })
    dbs.push(ro)
    await ro.pool.query(fs.readFileSync(path.join(REPO_DIR, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_supabase_emulation.sql'), 'utf8'))
    await installPgNet(ro.pool)
    await setExposedSchemas(ro.pool, null)
    await ro.pool.query(graphqlFixture)
    await applyInTransaction(ro.pool, path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql'))

    const gwSelf = (await gw.db.pool.query(`select action_gateway.self_check('lc_action_gateway') j`)).rows[0].j
    assert.equal(gwSelf.ok, true, JSON.stringify(gwSelf.findings))
    assert.deepEqual(gwSelf.platform_exceptions[0].notes, ['exposed_schemas_from_dashboard_unverified_in_sql'], 'the SQL cannot see the dashboard config: the probe is the proof')

    const actionEnv = (url) => ({
      LEADCOMMAND_ACTION_MCP_ORG_ID: ORG, LEADCOMMAND_ACTION_MCP_SUPABASE_URL: url, LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http',
      LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: '0',
      LEADCOMMAND_ACTION_MCP_API_KEY_FILE: writeSecretFile(path.join(dir, `anon-${crypto.randomUUID()}`), anon),
      LEADCOMMAND_ACTION_MCP_GATEWAY_JWT_FILE: writeSecretFile(path.join(dir, `gw-${crypto.randomUUID()}`), gwToken),
      LEADCOMMAND_ACTION_MCP_PEPPER_FILE: writeSecretFile(path.join(dir, `pepper-${crypto.randomUUID()}`), 'pg-net-exposure-e2e-pepper-0123456789abcdef'),
    })
    const readerEnv = (url) => ({
      LEADCOMMAND_MCP_DATA: 'live', LEADCOMMAND_MCP_SUPABASE_URL: url,
      LEADCOMMAND_MCP_READER_JWT_FILE: writeSecretFile(path.join(dir, `ro-${crypto.randomUUID()}`), roToken),
      LEADCOMMAND_MCP_API_KEY_FILE: writeSecretFile(path.join(dir, `anon-${crypto.randomUUID()}`), anon),
    })
    const restFor = async (db, schemas) => { const r = await startRest({ dbUrl: db.url, schemas, secret }); rests.push(r); return r }
    const stopRest = async (r) => { await r.stop(); rests.splice(rests.indexOf(r), 1) }

    await t.test('net NOT exposed (public, graphql_public): the probe passes AS each role; both servers boot, the audit lists the exception and the probe', async () => {
      const gwRest = await restFor(gw.db, 'public,graphql_public')
      const roRest = await restFor(ro, 'public,graphql_public')
      try {
        for (const [url, token] of [[gwRest.url, gwToken], [roRest.url, roToken]]) {
          const p = await probePlatformExposure({ origin: url, apiKey: anon, token })
          assert.equal(p.ok, true, JSON.stringify(p.checks))
          assert.deepEqual(p.checks.filter((c) => c.name.startsWith('rest_')).map((c) => c.code), ['PGRST106', 'PGRST106', 'PGRST106', 'PGRST106'])
          assert.ok(p.checks.filter((c) => c.name.startsWith('graphql:')).every((c) => c.code === 'unknown_field'), JSON.stringify(p.checks))
        }
        // the inventory IS reflected (the emulation answers, so "unknown field" for net is meaningful, not a dead endpoint)
        const ok = await fetch(`${roRest.url}/graphql/v1`, { method: 'POST', headers: { apikey: anon, authorization: `Bearer ${roToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: `{ ${LC_MCP_RELATIONS.includes('properties') ? 'properties' : LC_MCP_RELATIONS[0]}Collection(first: 1) { __typename } }` }) }).then((r) => r.json())
        assert.ok(ok.data && !ok.errors, JSON.stringify(ok))

        const audit = []
        const app = await buildActionApp({ env: actionEnv(gwRest.url), scrub: false, auditSink: (r) => audit.push(r) })
        await app.close()
        const check = audit.find((a) => a.event === 'credential_self_check')
        assert.equal(check.outcome, 'ok', JSON.stringify(check.findings))
        assert.equal(check.running_as, 'lc_action_gateway')
        assert.equal(check.platform_exceptions[0].fingerprint_version, PG_NET_FINGERPRINT_VERSION)
        assert.equal(check.platform_exceptions[0].status, 'applied')
        assert.deepEqual(check.platform_exceptions[0].notes, ['exposed_schemas_from_dashboard_unverified_in_sql'])
        assert.ok(check.exposure_probe.length === 8 && check.exposure_probe.every((x) => /:refused_as_required:(pgrst106|unknown_field)$/.test(x)), JSON.stringify(check.exposure_probe))
        assert.equal(check.exposure_probe_graphql, 'unknown_field')

        const audit2 = []
        const ro2 = await buildReaderApp({ env: readerEnv(roRest.url), scrub: false, auditSink: (r) => audit2.push(r) })
        await ro2.close()
        const check2 = audit2.find((a) => a.event === 'credential_self_check')
        assert.equal(check2.outcome, 'ok', JSON.stringify(check2.findings))
        assert.equal(check2.running_as, 'lc_mcp_reader')
        assert.equal(check2.platform_exceptions[0].status, 'applied')
        assert.ok(check2.exposure_probe.every((x) => /:refused_as_required:(pgrst106|unknown_field)$/.test(x)), JSON.stringify(check2.exposure_probe))
        assert.equal(check2.exposure_probe_graphql, 'unknown_field')
      } finally {
        await stopRest(gwRest)
        await stopRest(roRest)
      }
    })

    await t.test('PGRST_DB_SCHEMAS includes net: the probe fails; BOTH servers refuse to start (audited)', async () => {
      const gwRest = await restFor(gw.db, 'public,graphql_public,net')
      const roRest = await restFor(ro, 'public,graphql_public,net')
      try {
        const p = await probePlatformExposure({ origin: gwRest.url, apiKey: anon, token: gwToken })
        assert.equal(p.ok, false)
        assert.deepEqual(p.checks.filter((c) => !c.pass).map((c) => c.name), ['rest_get_net', 'rest_post_net'])
        assert.equal(p.checks[0].status, 200, 'net IS exposed: PostgREST answered the zero-row read')
        assert.equal(p.checks[1].code, 'PGRST202', 'the POST named a function that does not exist: no side effect')
        assert.equal((await gw.db.pool.query('select count(*)::int n from net.http_request_queue')).rows[0].n, 0, 'the probe enqueued nothing')

        const audit = []
        await assert.rejects(buildActionApp({ env: actionEnv(gwRest.url), scrub: false, auditSink: (r) => audit.push(r) }), (e) => e.code === 'CREDENTIAL_SELF_CHECK_FAILED' && /exposure_probe_failed:rest_get_net/.test(e.message))
        const check = audit.find((a) => a.event === 'credential_self_check')
        assert.equal(check.outcome, 'refused')
        assert.ok(check.findings.some((f) => /exposure_probe_failed:rest_post_net/.test(f)), JSON.stringify(check.findings))
        assert.ok(!audit.some((a) => a.event === 'server_boot'), 'no server_boot record')

        const audit2 = []
        await assert.rejects(buildReaderApp({ env: readerEnv(roRest.url), scrub: false, auditSink: (r) => audit2.push(r) }), (e) => e.code === 'CREDENTIAL_SELF_CHECK_FAILED' && /exposure_probe_failed:rest_get_net/.test(e.message))
        assert.equal(audit2.find((a) => a.event === 'credential_self_check').outcome, 'refused')
      } finally {
        await stopRest(gwRest)
        await stopRest(roRest)
      }
    })

    await t.test('GraphQL reflecting net (the role\'s search_path names net) → the probe fails (and the SQL control (d) refuses too)', async () => {
      await gw.db.pool.query('alter role lc_action_gateway set search_path = public, net')
      const gwRest = await restFor(gw.db, 'public,graphql_public')
      try {
        const p = await probePlatformExposure({ origin: gwRest.url, apiKey: anon, token: gwToken })
        assert.equal(p.ok, false, JSON.stringify(p.checks))
        assert.ok(p.checks.filter((c) => !c.pass).every((c) => c.name.startsWith('graphql:')), JSON.stringify(p.checks))
        assert.ok(p.checks.some((c) => c.name === 'graphql:http_request_queueCollection' && !c.pass))
        const self = (await gw.db.pool.query(`select action_gateway.self_check('lc_action_gateway') j`)).rows[0].j
        assert.ok(self.findings.includes('platform_exception_control_d:search_path_includes:net'))
      } finally {
        await stopRest(gwRest)
        await gw.db.pool.query('alter role lc_action_gateway set search_path = public')
      }
    })

    await t.test('the role cannot run the resolver (PUBLIC lacks USAGE on graphql_public, the production ACL): PostgREST\'s 42501 is accepted as refused_no_graphql_access; BOTH servers boot', async () => {
      const prodAcl = 'revoke usage on schema graphql_public from public; grant usage on schema graphql_public to postgres, anon, authenticated, service_role'
      await gw.db.pool.query(prodAcl)
      await ro.pool.query(prodAcl)
      const gwRest = await restFor(gw.db, 'public,graphql_public')
      const roRest = await restFor(ro, 'public,graphql_public')
      try {
        for (const [url, token] of [[gwRest.url, gwToken], [roRest.url, roToken]]) {
          const p = await probePlatformExposure({ origin: url, apiKey: anon, token })
          assert.equal(p.ok, true, JSON.stringify(p.checks))
          assert.equal(p.graphql_variant, 'refused_no_graphql_access')
          assert.ok(p.checks.filter((c) => c.name.startsWith('rest_')).every((c) => c.pass && c.code === 'PGRST106'), 'REST still refuses net')
          assert.ok(p.checks.filter((c) => c.name.startsWith('graphql:')).every((c) => c.status === 403 && c.code === '42501'), JSON.stringify(p.checks))
        }
        const audit = []
        const app = await buildActionApp({ env: actionEnv(gwRest.url), scrub: false, auditSink: (r) => audit.push(r) })
        await app.close()
        const check = audit.find((a) => a.event === 'credential_self_check')
        assert.equal(check.outcome, 'ok', JSON.stringify(check.findings))
        assert.equal(check.exposure_probe_graphql, 'refused_no_graphql_access')
        assert.equal(check.exposure_probe.filter((x) => x.endsWith(':refused_as_required:refused_no_graphql_access')).length, 4, JSON.stringify(check.exposure_probe))
        const audit2 = []
        const ro2 = await buildReaderApp({ env: readerEnv(roRest.url), scrub: false, auditSink: (r) => audit2.push(r) })
        await ro2.close()
        const check2 = audit2.find((a) => a.event === 'credential_self_check')
        assert.equal(check2.outcome, 'ok', JSON.stringify(check2.findings))
        assert.equal(check2.exposure_probe_graphql, 'refused_no_graphql_access')
      } finally {
        await stopRest(gwRest)
        await stopRest(roRest)
        await gw.db.pool.query('grant usage on schema graphql_public to public')
        await ro.pool.query('grant usage on schema graphql_public to public')
      }
    })
  } finally {
    for (const r of rests) await r.stop().catch(() => {})
    for (const d of dbs) await d.drop().catch(() => {})
    await server.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
