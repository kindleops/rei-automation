// END TO END, the GraphQL leg of the boot exposure probe (compensating control (c), docs/SUPABASE-PG-NET-POSTURE.md §9
// step 5), for THIS server: a REAL PostgREST + a DISPOSABLE PostgreSQL 17 with Supabase-shaped pg_net (CREATE EXTENSION
// AS supabase_admin) + the platform shape (PostGIS 3.3.7, the pg_net event trigger, the pg_cron ACL) + the REAL
// lc_mcp_reader migration on its emulation; Supabase's API gateway in front (test/support/supabase-edge.mjs:
// /graphql/v1 → PostgREST POST /rpc/graphql, Content-Profile graphql_public). The resolver is the shape-only
// emulation apps/api/tests/pg/pg_net_emulation/graphql_public_emulation.sql (pg_graphql is not available locally).
// Proves, through the reader's REAL boot (buildApp → self-check → probe AS lc_mcp_reader):
//   * PUBLIC lacks USAGE on graphql_public (the production ACL 2026-10-23): PostgREST answers HTTP 403
//     {"code":"42501","details":null,"hint":null,"message":"permission denied for schema graphql_public"}; the boot
//     SUCCEEDS and the audit line names refused_no_graphql_access (REST still answers PGRST106);
//   * USAGE but no EXECUTE on graphql_public.graphql: 42501 "permission denied for function graphql" → boots, same variant;
//   * the resolver runs: "Unknown field" → boots, unknown_field;
//   * the resolver REFLECTS net → the boot is REFUSED (the SQL self-check cannot see it: the probe is the proof);
//   * the resolver runs but fails inside on another object (42501 on pg_graphql's schema graphql) → REFUSED;
//   * the dry preflight's boot_probe row predicts each permission case (info ↔ boots, BOOT_BLOCKER ↔ refused).
// Opt-in: LC_PG_BIN=<pg17 bin dir> LC_POSTGREST_BIN=<postgrest>.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pgNetServer, installPgNet, installPlatformShape, setExposedSchemas, REPO_DIR, EMULATION_DIR } from '../../../apps/api/tests/helpers/pg-net-posture.mjs'
import { probePlatformExposure, GRAPHQL_FIELDS, REST_PROBES } from '../src/data/platform-exposure.mjs'
import { startSupabaseEdge, mintJwt } from './support/supabase-edge.mjs'
import { tmpDir, writeSecret } from './support/live-env.mjs'

const PG_BIN = process.env.LC_PG_BIN
const PGRST_BIN = process.env.LC_POSTGREST_BIN
const skip = !(PG_BIN && PGRST_BIN) && 'set LC_PG_BIN and LC_POSTGREST_BIN to run the real-PostgREST GraphQL-access end-to-end'
const now = () => Math.floor(Date.now() / 1000)

const PROD_ACL = 'revoke usage on schema graphql_public from public; grant usage on schema graphql_public to postgres, anon, authenticated, service_role'
// a resolver that REFLECTS net's tables whatever the caller's search_path (a pg_graphql the SQL self-check cannot judge)
const REFLECTING = `create or replace function graphql_public.graphql("operationName" text default null, query text default null, variables jsonb default null, extensions jsonb default null)
returns jsonb language plpgsql volatile as $g$
declare f text := substring(coalesce(query, '') from '^\\s*\\{\\s*([A-Za-z_][A-Za-z0-9_]*)');
begin
  if f in ('http_request_queueCollection', '_http_responseCollection', 'httpRequestQueueCollection', 'httpResponseCollection') then
    return jsonb_build_object('data', jsonb_build_object(f, jsonb_build_object('__typename', f || 'Connection')));
  end if;
  return jsonb_build_object('data', null, 'errors', jsonb_build_array(jsonb_build_object('message', format('Unknown field "%s" on type "Query"', f))));
end $g$`
// a resolver that runs and fails INSIDE, as pg_graphql does when the caller cannot use its schema graphql
const INNER_DENIED = `create schema graphql; revoke all on schema graphql from public;
create function graphql.resolve(q text) returns jsonb language sql as $r$ select null::jsonb $r$;
create or replace function graphql_public.graphql("operationName" text default null, query text default null, variables jsonb default null, extensions jsonb default null)
returns jsonb language plpgsql volatile as $g$ begin return graphql.resolve(query); end $g$`

test('real PostgREST + PG17: the reader boots when it cannot run GraphQL at all (42501, refused_no_graphql_access), and still refuses a GraphQL that reflects net or answers otherwise', { skip, timeout: 300_000 }, async (t) => {
  const server = await pgNetServer()
  process.env.AGENT_PG_TEST_DB_URL = server.url // before the harness modules read it
  const { freshDb, applyInTransaction } = await import('../../../apps/api/tests/pg/agent-pg-harness.mjs')
  const { buildApp } = await import('../src/app.mjs')
  const dir = tmpDir('lc-gql-e2e-')
  const secret = crypto.randomBytes(32).toString('base64url')
  const anon = mintJwt(secret, { role: 'anon', iss: 'supabase', iat: now(), exp: now() + 3600 })
  const roToken = mintJwt(secret, { role: 'lc_mcp_reader', iss: 'supabase', iat: now(), exp: now() + 3600 })
  const GRAPHQL_FIXTURE = fs.readFileSync(path.join(EMULATION_DIR, 'graphql_public_emulation.sql'), 'utf8') // + USAGE / EXECUTE to PUBLIC
  const PREFLIGHT = fs.readFileSync(path.join(REPO_DIR, 'scripts/db/lc_mcp_reader_prod_dry_preflight.sql'), 'utf8')
  let db = null
  let edge = null
  try {
    db = await freshDb({ apply: false })
    await db.pool.query(fs.readFileSync(path.join(REPO_DIR, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_supabase_emulation.sql'), 'utf8'))
    await installPgNet(db.pool)
    await installPlatformShape(db.pool)
    await setExposedSchemas(db.pool, null)
    await db.pool.query(GRAPHQL_FIXTURE)
    await applyInTransaction(db.pool, path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql'))
    edge = await startSupabaseEdge({ postgrestBin: PGRST_BIN, dbUrl: db.url, schemas: 'public,graphql_public', secret })

    /** Reset the resolver + ACL, then apply the scenario's SQL. */
    const world = async (sql) => {
      await db.pool.query('drop schema if exists graphql cascade')
      await db.pool.query(GRAPHQL_FIXTURE)
      if (sql) await db.pool.query(sql)
    }
    const boot = async () => {
      const audit = []
      const env = {
        LEADCOMMAND_MCP_DATA: 'live', LEADCOMMAND_MCP_SUPABASE_URL: edge.url,
        LEADCOMMAND_MCP_READER_JWT_FILE: writeSecret(dir, `ro-${crypto.randomUUID()}`, roToken),
        LEADCOMMAND_MCP_API_KEY_FILE: writeSecret(dir, `anon-${crypto.randomUUID()}`, anon),
      }
      let error = null
      try { const app = await buildApp({ env, scrub: false, auditSink: (r) => audit.push(r) }); await app.close() } catch (e) { error = e }
      return { error, check: audit.find((a) => a.event === 'credential_self_check') }
    }
    const rawGraphql = async (token) => {
      const r = await fetch(`${edge.url}/graphql/v1`, { method: 'POST', headers: { apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: `{ ${GRAPHQL_FIELDS[0]}(first: 1) { __typename } }` }) })
      return { status: r.status, body: await r.json() }
    }
    const bootProbeRow = async () => {
      const c = await db.pool.connect()
      try {
        await c.query('begin read only')
        return (await c.query(PREFLIGHT)).rows.filter((r) => r.section === 'boot_probe')
      } finally { await c.query('rollback').catch(() => {}); c.release() }
    }
    const expectBoots = async (variant) => {
      const p = await probePlatformExposure({ origin: edge.url, apiKey: anon, token: roToken })
      assert.equal(p.ok, true, JSON.stringify(p.checks))
      assert.equal(p.graphql_variant, variant)
      assert.deepEqual(p.checks.filter((c) => c.name.startsWith('rest_')).map((c) => c.code), REST_PROBES.map(() => 'PGRST106'), 'REST still refuses net / extensions / cron')
      const b = await boot()
      assert.equal(b.error, null, String(b.error?.message))
      assert.equal(b.check.outcome, 'ok', JSON.stringify(b.check.findings))
      assert.equal(b.check.running_as, 'lc_mcp_reader')
      assert.equal(b.check.platform_exceptions[0].status, 'applied', 'the pg_net exception is applied: the probe was mandatory')
      assert.equal(b.check.exposure_probe_graphql, variant)
      assert.deepEqual(b.check.exposure_probe, [...REST_PROBES.map((r) => `${r.name}:refused_as_required:pgrst106`), ...GRAPHQL_FIELDS.map((f) => `graphql:${f}:refused_as_required:${variant}`)])
      return b
    }
    const expectRefused = async (re) => {
      const b = await boot()
      assert.equal(b.error?.code, 'CREDENTIAL_SELF_CHECK_FAILED', String(b.error?.message))
      assert.equal(b.check.outcome, 'refused')
      assert.equal(b.check.exposure_probe_graphql, null)
      assert.ok(b.check.findings.length && b.check.findings.every((f) => /^exposure_probe_failed:graphql/.test(f)), `ONLY the GraphQL leg refuses: ${JSON.stringify(b.check.findings)}`)
      assert.match(b.check.findings.join(' | '), re)
      assert.ok(b.check.exposure_probe.filter((x) => x.startsWith('graphql:')).every((x) => x.endsWith(':EXPOSED_OR_UNPROVEN')), JSON.stringify(b.check.exposure_probe))
    }

    await t.test('PUBLIC lacks USAGE on graphql_public (the production ACL): PostgREST\'s exact 42501 → the boot SUCCEEDS, refused_no_graphql_access; the preflight says info', async () => {
      await world(PROD_ACL)
      assert.equal((await db.pool.query(`select has_schema_privilege('lc_mcp_reader', 'graphql_public', 'USAGE') u`)).rows[0].u, false)
      // the actual response shape PostgREST gives the probe AS the reader (and the resolver is live for the platform roles)
      assert.deepEqual(await rawGraphql(roToken), { status: 403, body: { code: '42501', details: null, hint: null, message: 'permission denied for schema graphql_public' } })
      const asAnon = await rawGraphql(anon)
      assert.equal(asAnon.status, 200)
      assert.match(asAnon.body.errors[0].message, /^Unknown field/)
      await expectBoots('refused_no_graphql_access')
      const row = await bootProbeRow()
      assert.deepEqual(row.map((r) => r.verdict), ['info'])
      assert.match(row[0].item, /refused_no_graphql_access/)
    })

    await t.test('USAGE but no EXECUTE on graphql_public.graphql: 42501 on the function → the boot SUCCEEDS, refused_no_graphql_access; the preflight says info', async () => {
      await world('revoke execute on function graphql_public.graphql(text,text,jsonb,jsonb) from public; grant execute on function graphql_public.graphql(text,text,jsonb,jsonb) to anon, authenticated, service_role')
      assert.deepEqual(await rawGraphql(roToken), { status: 403, body: { code: '42501', details: null, hint: null, message: 'permission denied for function graphql' } })
      await expectBoots('refused_no_graphql_access')
      assert.deepEqual((await bootProbeRow()).map((r) => r.verdict), ['info'])
    })

    await t.test('the resolver runs AS the reader: "Unknown field" → the boot SUCCEEDS, unknown_field; the preflight says info', async () => {
      await world(null)
      await expectBoots('unknown_field')
      assert.deepEqual((await bootProbeRow()).map((r) => r.verdict), ['info'])
    })

    await t.test('the resolver REFLECTS net (invisible to the SQL self-check) → the boot is REFUSED', async () => {
      await world(REFLECTING)
      const r = await rawGraphql(roToken)
      assert.equal(r.status, 200)
      assert.ok(r.body.data?.[GRAPHQL_FIELDS[0]], JSON.stringify(r.body))
      await expectRefused(/exposure_probe_failed:graphql:http_request_queueCollection:HTTP 200/)
    })

    await t.test('the no-access variant is the READER\'s own privilege, never a blanket pass: grant USAGE back and a reflecting resolver refuses', async () => {
      await world(`${PROD_ACL}; ${REFLECTING}`)
      await expectBoots('refused_no_graphql_access')
      await db.pool.query('grant usage on schema graphql_public to public')
      await expectRefused(/exposure_probe_failed:graphql:http_request_queueCollection:HTTP 200/)
    })

    await t.test('the resolver runs and fails INSIDE (42501 on pg_graphql\'s schema graphql) → the boot is REFUSED; the preflight says BOOT_BLOCKER', async () => {
      await world(INNER_DENIED)
      assert.deepEqual(await rawGraphql(roToken), { status: 403, body: { code: '42501', details: null, hint: null, message: 'permission denied for schema graphql' } })
      await expectRefused(/exposure_probe_failed:graphql:http_request_queueCollection:HTTP 403 42501/)
      assert.deepEqual((await bootProbeRow()).map((r) => r.verdict), ['BOOT_BLOCKER'])
    })
  } finally {
    if (edge) await edge.stop().catch(() => {})
    if (db) await db.drop().catch(() => {})
    await server.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
