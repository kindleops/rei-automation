// The Supabase pg_net PLATFORM EXCEPTION of the two privilege self-checks (docs/SUPABASE-PG-NET-POSTURE.md), proven
// on a DISPOSABLE PostgreSQL 17 where pg_net is installed exactly as Supabase has it: a REAL `CREATE EXTENSION pg_net`
// run AS supabase_admin (shape-only emulation, apps/api/tests/pg/pg_net_emulation), the documented ACL (PUBLIC: USAGE
// on net, all privileges on the net tables / sequence, EXECUTE on the functions; USAGE on net to postgres, anon,
// authenticated, service_role), then the REAL migrations:
//   action_gateway.self_check('lc_action_gateway')   PROPOSED_20261019160000_action_gateway.sql (#26, its real chain)
//   public.lc_mcp_reader_self_check(…)               PROPOSED_20261019150000_lc_mcp_reader.sql (#25, its emulation)
// Every mutation case runs in a transaction that is rolled back. Whenever the exception must NOT apply, the findings
// are asserted EQUAL to the pre-exception functions (frozen verbatim as *_strict_reference): never a silent weakening.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { pgNetServer, SKIP_REASON, installPgNet, installPlatformShape, setExposedSchemas, inRolledBackTx, dropPlatformRole, LC_MCP_RELATIONS, LC_MCP_FUNCTIONS, REPO_DIR, EMULATION_DIR, POSTGIS_PINNED, POSTGIS_DYNAMIC } from '../helpers/pg-net-posture.mjs'
import { platformExceptionBlock, namedBlock, SOURCE as GW_SQL, TARGET as RO_SQL } from '../../../../scripts/db/sync-platform-exception-block.mjs'
import { PG_NET_FINGERPRINT_VERSION } from '../../../../mcp/leadcommand-mcp/src/data/platform-exposure.mjs'

const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const T2_SQL = MIG('PROPOSED_20261020100000_action_gateway_t2.sql')
const T2_ROLLBACK_SQL = MIG('PROPOSED_20261020100000_action_gateway_t2_rollback.sql')

test('the exception is ONE reviewed block: #25 inlines exactly #26\'s, every self_check copy calls it, and the fingerprint version is the JS pin', () => {
  const gw = fs.readFileSync(GW_SQL, 'utf8')
  assert.equal(platformExceptionBlock(fs.readFileSync(RO_SQL, 'utf8')), platformExceptionBlock(gw), 'run node scripts/db/sync-platform-exception-block.mjs --write')
  for (const f of [GW_SQL, RO_SQL]) {
    const m = /-- lc-platform-exception:fingerprint-version\n\s*fp_version constant text := '([^']+)'/.exec(fs.readFileSync(f, 'utf8'))
    assert.equal(m?.[1], PG_NET_FINGERPRINT_VERSION, path.basename(f))
  }
  const block = platformExceptionBlock(gw)
  assert.match(block, /https:\/\/supabase\.com\/docs\/guides\/troubleshooting\/revoking-access-to-pg_net-objects-has-no-effect-0bbc16/, 'the fingerprint cites the Supabase doc')
  // the fingerprint never names an LC role, never grants CREATE, never names a column
  const fp = /fingerprint constant text\[\] := array\[([\s\S]*?)\];/.exec(block)[1]
  assert.doesNotMatch(fp, /lc_action_gateway|lc_mcp_reader|\|CREATE'|column\|/)
  // every copy of action_gateway.self_check (#26, #27 and #27's rollback restore) reads the exception
  for (const f of [GW_SQL, T2_SQL, T2_ROLLBACK_SQL]) {
    const body = /function action_gateway\.self_check\([\s\S]*?\n\$fn\$;/.exec(fs.readFileSync(f, 'utf8'))[0]
    assert.match(body, /pe := action_gateway\.platform_egress_exceptions\(r\);/, path.basename(f))
    assert.match(body, /'platform_exceptions', pe -> 'platform_exceptions'/, path.basename(f))
    assert.match(body, /'platform_allowlists', public\.lc_egress_platform_allowlists\(\) -> 'allowlists'/, `${path.basename(f)} reports the platform allowlists`)
  }
  assert.match(/function public\.lc_mcp_reader_self_check\([\s\S]*?\n\$fn\$;/.exec(fs.readFileSync(RO_SQL, 'utf8'))[0], /'platform_allowlists', public\.lc_egress_platform_allowlists\(\) -> 'allowlists'/)
  // the PostGIS allowlist is ONE pinned list: the synced block, the production verify script and the dry preflight carry exactly the same 26 signatures
  const sigsOf = (txt) => [...txt.matchAll(/'(public\.[a-z_]+\([a-z ,]*\))'/g)].map((m) => m[1]).filter((x) => POSTGIS_PINNED.includes(x) || /^public\.(addgeometrycolumn|checkauth|disablelongtransactions|dropgeometrycolumn|dropgeometrytable|enablelongtransactions|lockrow|populate_geometry_columns|postgis_extensions_upgrade|st_findextent|unlockrows|updategeometrysrid)\(/.test(x))
  const blockSigs = sigsOf(/pg_sigs constant text\[\] := array\[([\s\S]*?)\];/.exec(gw)[1])
  assert.deepEqual(blockSigs, [...POSTGIS_PINNED], 'the block pins exactly the 26 PostGIS 3.3.7 overloads')
  for (const f of ['scripts/db/pg_net_indirect_egress_prod_verify.sql', 'scripts/db/lc_mcp_reader_prod_dry_preflight.sql']) {
    const txt = fs.readFileSync(path.join(REPO_DIR, f), 'utf8')
    assert.deepEqual(sigsOf(/pg_sig\(sig\) as \(values\n([\s\S]*?)\),\npg_fn/.exec(txt)[1]), [...POSTGIS_PINNED], f)
    assert.match(txt, /'3\.3\.7'/, f)
    assert.match(txt, /evttags is distinct from array\['CREATE EXTENSION'\]::text\[\]/, f)
    assert.match(txt, /p\.proname = 'grant_pg_net_access' and p\.pronargs = 0/, f)
  }
  assert.match(gw, /pg_version constant text := 'supabase_postgis_dynamic_sql\.v1';/)
  assert.match(gw, /et_version constant text := 'supabase_pg_net_access_event_trigger\.v1';/)
  // the indirect-egress helper is ONE synced block, and EVERY self-check copy AND both frozen strict references call it,
  // so a 'not applied' pg_net exception reports exactly the same transitive findings (never a silent weakening).
  const STRICT_GW = path.join(REPO_DIR, 'apps/api/tests/pg/pg_net_emulation/strict_reference_action_gateway_self_check.sql')
  const STRICT_RO = path.join(REPO_DIR, 'apps/api/tests/pg/pg_net_emulation/strict_reference_lc_mcp_reader_self_check.sql')
  assert.equal(namedBlock(fs.readFileSync(RO_SQL, 'utf8'), '-- lc-indirect-egress:block-begin', '-- lc-indirect-egress:block-end'),
               namedBlock(gw, '-- lc-indirect-egress:block-begin', '-- lc-indirect-egress:block-end'), 'run node scripts/db/sync-platform-exception-block.mjs --write')
  for (const f of [GW_SQL, RO_SQL, T2_SQL, T2_ROLLBACK_SQL, STRICT_GW, STRICT_RO]) {
    assert.match(fs.readFileSync(f, 'utf8'), /findings := findings \|\| public\.lc_reachable_egress_indirect\(r\);/, `${path.basename(f)} calls the indirect-egress helper`)
  }
})

const server = await pgNetServer()
if (server) process.env.AGENT_PG_TEST_DB_URL = server.url // before the harness modules read it
const skip = server ? false : SKIP_REASON
const H = server ? await import('../helpers/action-gateway-pg.mjs') : null
const HARNESS = server ? await import('../pg/agent-pg-harness.mjs') : null

const dbs = []
test.after(async () => {
  for (const d of dbs) await d.drop().catch(() => {})
  if (server && !server.own) await dropPlatformRole(server.url)
  await server?.stop()
})

/** A world: the migration applied ON TOP of Supabase-shaped pg_net (the production order), + the strict reference. */
async function gatewayWorld() {
  // the critical-suite environment resets process.env between tests; the gateway bootstrap lock reads it per call
  process.env.AGENT_PG_TEST_DB_URL = server.url
  const env = await H.gatewayDb({ apply: false })
  dbs.push(env.db)
  const pool = env.db.pool
  await installPgNet(pool)
  await installPlatformShape(pool) // PostGIS 3.3.7, the pg_net access event trigger, the pg_cron ACL shape (production 2026-10-23)
  await setExposedSchemas(pool, 'public, graphql_public')
  await HARNESS.applyInTransaction(pool, H.GATEWAY_MIGRATION) // the apply's own final self-check must pass here
  await pool.query(fs.readFileSync(path.join(EMULATION_DIR, 'strict_reference_action_gateway_self_check.sql'), 'utf8'))
  await pool.query('revoke all on function action_gateway.self_check_strict_reference(name) from public, anon, authenticated, service_role')
  return {
    name: 'action_gateway.self_check', role: 'lc_action_gateway', pool,
    check: async (c) => (await c.query(`select action_gateway.self_check('lc_action_gateway') j`)).rows[0].j,
    strict: async (c) => (await c.query(`select action_gateway.self_check_strict_reference('lc_action_gateway') j`)).rows[0].j,
    asRole: async (c) => { await c.query(`set local role lc_action_gateway`); return (await c.query(`select public.action_gateway_self_check() j`)).rows[0].j },
  }
}

async function readerWorld() {
  const db = await HARNESS.freshDb({ apply: false })
  dbs.push(db)
  const pool = db.pool
  await pool.query(fs.readFileSync(path.join(REPO_DIR, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_supabase_emulation.sql'), 'utf8'))
  await installPgNet(pool)
  await installPlatformShape(pool) // PostGIS 3.3.7, the pg_net access event trigger, the pg_cron ACL shape (production 2026-10-23)
  await setExposedSchemas(pool, 'public, graphql_public')
  await HARNESS.applyInTransaction(pool, MIG('PROPOSED_20261019150000_lc_mcp_reader.sql'))
  await pool.query(fs.readFileSync(path.join(EMULATION_DIR, 'strict_reference_lc_mcp_reader_self_check.sql'), 'utf8'))
  await pool.query('revoke all on function public.lc_mcp_reader_self_check_strict_reference(text[], text[], name) from public, anon, authenticated, service_role')
  const args = [LC_MCP_RELATIONS, LC_MCP_FUNCTIONS]
  return {
    name: 'lc_mcp_reader_self_check', role: 'lc_mcp_reader', pool,
    check: async (c) => (await c.query(`select public.lc_mcp_reader_self_check($1, $2, 'lc_mcp_reader') j`, args)).rows[0].j,
    strict: async (c) => (await c.query(`select public.lc_mcp_reader_self_check_strict_reference($1, $2, 'lc_mcp_reader') j`, args)).rows[0].j,
    asRole: async (c) => { await c.query(`set local role lc_mcp_reader`); return (await c.query(`select public.lc_mcp_reader_self_check($1, $2) j`, args)).rows[0].j },
  }
}

const pgNetEntry = (j) => (j.platform_exceptions || []).find((e) => e.id === 'supabase_pg_net')
const has = (j, re) => (j.findings || []).some((f) => re.test(f))
const asSupabaseAdmin = async (c, sql) => { await c.query('set local role supabase_admin'); await c.query(sql); await c.query('reset role') }

/** Not applied: the reasons name the cause, and the findings are EXACTLY the pre-exception findings (refused). */
async function assertStrict(w, c, reason, label) {
  const cur = await w.check(c)
  const ref = await w.strict(c)
  const e = pgNetEntry(cur)
  assert.equal(e?.status, 'not_applied', `${w.name} ${label}: ${JSON.stringify(e?.reasons)}`)
  assert.ok(e.reasons.some((r) => reason.test(r)), `${w.name} ${label}: reasons ${JSON.stringify(e.reasons)}`)
  assert.equal(cur.ok, false, `${w.name} ${label}: refused`)
  assert.deepEqual(cur.findings, ref.findings, `${w.name} ${label}: the SAME findings as without the exception`)
  assert.ok(has(cur, /net\./), `${w.name} ${label}: the net objects count again`)
  return cur
}

for (const make of [gatewayWorld, readerWorld]) {
  test(`PG pg_net posture (${make === gatewayWorld ? 'action_gateway.self_check' : 'lc_mcp_reader_self_check'}): Supabase's default pg_net + every control → ok, the exception listed apart; each deviation refuses`, { skip, timeout: 240_000 }, async (t) => {
    const w = await make()
    const tx = (fn) => inRolledBackTx(w.pool, fn)

    await t.test('default Supabase grants + all controls: ok:true, findings [], platform_exceptions lists what was excepted (the pre-exception rule refuses)', () => tx(async (c) => {
      const j = await w.check(c)
      assert.equal(j.ok, true, JSON.stringify(j.findings))
      assert.deepEqual(j.findings, [])
      const e = pgNetEntry(j)
      assert.equal(e.status, 'applied')
      assert.equal(e.fingerprint_version, PG_NET_FINGERPRINT_VERSION)
      assert.deepEqual(e.reasons, [])
      for (const o of ['schema:net', 'table:net.http_request_queue', 'table:net._http_response', 'sequence:net.http_request_queue_id_seq', 'function:net.http_get', 'function:net.http_post', 'function:net.http_delete']) assert.ok(e.objects.includes(o), o)
      for (const a of ['schema|net|PUBLIC|USAGE', 'table|net.http_request_queue|PUBLIC|INSERT', 'function|net.http_post|PUBLIC|EXECUTE']) assert.ok(e.acl.includes(a), a)
      assert.deepEqual(e.controls, { a_role_posture: true, b_exposed_schemas: 'verified', c_live_exposure_probe: 'required', d_role_search_path: true, e_egress_rule_outside_exception: 'enforced', f_no_create: true })
      assert.equal(e.live_exposure_probe_required, true)
      assert.equal(e.extension_version, '0.20.0')
      const ref = await w.strict(c)
      assert.equal(ref.ok, false, 'without the exception the same database refuses')
      assert.ok(has(ref, /net\.http_(get|post)|net\.http_request_queue/), JSON.stringify(ref.findings))
    }))

    await t.test('AS the role itself (the server\'s path): the same verdict', () => tx(async (c) => {
      const j = await w.asRole(c)
      assert.equal(j.ok, true, JSON.stringify(j.findings))
      assert.equal(j.current_user, w.role)
      assert.equal(pgNetEntry(j).status, 'applied')
    }))

    await t.test('pgrst.db_schemas absent: still ok, recorded exposed_schemas_from_dashboard_unverified_in_sql, the live probe required', () => tx(async (c) => {
      await setExposedSchemas(c, null)
      const j = await w.check(c)
      assert.equal(j.ok, true, JSON.stringify(j.findings))
      const e = pgNetEntry(j)
      assert.deepEqual(e.notes, ['exposed_schemas_from_dashboard_unverified_in_sql'])
      assert.equal(e.controls.b_exposed_schemas, 'unverified_in_sql')
      assert.equal(e.live_exposure_probe_required, true)
    }))

    for (const s of ['net', 'extensions', 'cron']) {
      await t.test(`${s} in authenticator's pgrst.db_schemas → finding`, () => tx(async (c) => {
        await setExposedSchemas(c, `public, graphql_public, ${s}`)
        const j = await w.check(c)
        assert.equal(j.ok, false)
        assert.ok(j.findings.includes(`platform_exception_control_b:exposed_schema:${s}`), JSON.stringify(j.findings))
        assert.equal(pgNetEntry(j).controls.b_exposed_schemas, 'failed')
      }))
    }
    await t.test('net exposed through a cluster-wide (all databases) authenticator setting → finding too', () => tx(async (c) => {
      await setExposedSchemas(c, null)
      await c.query(`alter role authenticator set pgrst.db_schemas = '"public","net"'`)
      const j = await w.check(c)
      assert.ok(j.findings.includes('platform_exception_control_b:exposed_schema:net'), JSON.stringify(j.findings))
    }))

    await t.test('an extra grant on net (supabase_admin grants the ROLE itself SELECT) → not applied, the strict findings', () => tx(async (c) => {
      await asSupabaseAdmin(c, `grant select on net._http_response to ${w.role}`)
      await assertStrict(w, c, new RegExp(`^acl_outside_fingerprint:table\\|net\\._http_response\\|${w.role}\\|SELECT$`), 'extra grantee')
    }))
    await t.test('an extra privilege for a documented grantee (CREATE on net to anon) → not applied, the strict findings', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'grant create on schema net to anon')
      await assertStrict(w, c, /^acl_outside_fingerprint:schema\|net\|anon\|CREATE$/, 'extra privilege')
    }))
    await t.test('a grant from a grantor other than supabase_admin → not applied, the strict findings', () => tx(async (c) => {
      await c.query('create role lc_posture_grantor nologin')
      await asSupabaseAdmin(c, 'grant select on net.http_request_queue to lc_posture_grantor with grant option')
      await c.query('set local role lc_posture_grantor')
      await c.query('grant select on net.http_request_queue to public')
      await c.query('reset role')
      const j = await assertStrict(w, c, /^acl_grantor:table\|net\.http_request_queue\|PUBLIC\|SELECT:lc_posture_grantor$/, 'grantor')
      assert.ok(pgNetEntry(j).reasons.includes('acl_grant_option:table|net.http_request_queue|lc_posture_grantor|SELECT'))
    }))
    await t.test('a column-level grant on a net table → not applied, the strict findings', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'grant select (url) on net.http_request_queue to anon')
      await assertStrict(w, c, /^acl_outside_fingerprint:column\|net\.http_request_queue\.url\|anon\|SELECT$/, 'column grant')
    }))
    await t.test('a non-extension TABLE added in net (even by supabase_admin) → not applied, the strict findings', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'create table net.lc_side_channel (id int)')
      await assertStrict(w, c, /^not_extension_member:table:net\.lc_side_channel$/, 'non-extension table')
    }))
    await t.test('a non-extension FUNCTION added in net → not applied, the strict findings', () => tx(async (c) => {
      await asSupabaseAdmin(c, `create function net.lc_side_call(u text) returns bigint language sql as $f$ select net.http_get(u) $f$`)
      await assertStrict(w, c, /^not_extension_member:function:net\.lc_side_call$/, 'non-extension function')
    }))
    await t.test('a net object with a different owner → not applied, the strict findings', () => tx(async (c) => {
      await c.query('alter table net._http_response owner to postgres')
      await assertStrict(w, c, /^owner:table:net\._http_response:postgres$/, 'owner')
    }))
    await t.test('a SECURITY DEFINER net function stays a finding (the definer rule has no exception)', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'alter function net.http_get(text, jsonb, jsonb, integer) security definer')
      const j = await w.check(c)
      assert.equal(pgNetEntry(j).status, 'applied')
      assert.equal(j.ok, false)
      assert.ok(has(j, /reachable_definer_function.*net\.http_get/), JSON.stringify(j.findings))
    }))

    await t.test('the role\'s search_path including net / unset → finding', () => tx(async (c) => {
      await c.query(`alter role ${w.role} set search_path = public, net`)
      let j = await w.check(c)
      assert.equal(j.ok, false)
      assert.ok(j.findings.includes('platform_exception_control_d:search_path_includes:net'), JSON.stringify(j.findings))
      await c.query(`alter role ${w.role} set search_path = "$user", public, extensions`)
      j = await w.check(c)
      assert.ok(j.findings.includes('platform_exception_control_d:search_path_includes:extensions'), JSON.stringify(j.findings))
      await c.query(`alter role ${w.role} reset search_path`)
      j = await w.check(c)
      assert.ok(j.findings.includes('platform_exception_control_d:search_path_unset'), JSON.stringify(j.findings))
      assert.equal(pgNetEntry(j).controls.d_role_search_path, false)
    }))

    await t.test('the role given LOGIN / INHERIT / BYPASSRLS / a membership → finding', () => tx(async (c) => {
      for (const [sql, f] of [[`alter role ${w.role} login`, 'platform_exception_control_a:canlogin'], [`alter role ${w.role} inherit`, 'platform_exception_control_a:inherit'],
        [`alter role ${w.role} bypassrls`, 'platform_exception_control_a:bypassrls'], [`grant anon to ${w.role}`, 'platform_exception_control_a:member_of:anon']]) {
        await c.query('savepoint s')
        await c.query(sql)
        const j = await w.check(c)
        assert.equal(j.ok, false, sql)
        assert.ok(j.findings.includes(f), `${sql}: ${JSON.stringify(j.findings)}`)
        assert.equal(pgNetEntry(j).controls.a_role_posture, false)
        await c.query('rollback to savepoint s')
      }
    }))

    await t.test('a public wrapper calling net.http_post, executable by the role → finding (the egress rule outside the exception is unchanged)', () => tx(async (c) => {
      await c.query(`create function public.lc_posture_webhook(p_body text) returns void language plpgsql security invoker as $w$ begin perform net.http_post('https://example.invalid', jsonb_build_object('b', p_body)); end $w$`)
      const j = await w.check(c)
      assert.equal(pgNetEntry(j).status, 'applied')
      assert.equal(j.ok, false)
      assert.ok(has(j, /reachable_egress_function.*public\.lc_posture_webhook/), JSON.stringify(j.findings))
      // and through PUBLIC alone (the role's own grants are not needed): the wrapper is still reachable and named
      assert.ok(has(await w.strict(c), /public\.lc_posture_webhook/))
    }))

    // ── indirect / transitive egress (public.lc_reachable_egress_indirect), the paths the per-function grep misses ──
    await t.test('a TRANSITIVE wrapper A→B→net.http_post, A executable by the role (A\'s own body names no egress) → indirect_egress_function', () => tx(async (c) => {
      await c.query(`create function public.lc_ind_b(u text) returns void language plpgsql security invoker as $b$ begin perform net.http_post(u, '{}'::jsonb); end $b$`)
      await c.query(`create function public.lc_ind_a(u text) returns void language plpgsql security invoker as $a$ begin perform public.lc_ind_b(u); end $a$`)
      await c.query(`grant execute on function public.lc_ind_a(text) to ${w.role}`)
      const j = await w.check(c)
      assert.equal(pgNetEntry(j).status, 'applied')
      assert.equal(j.ok, false)
      assert.ok(has(j, /indirect_egress_function:public\.lc_ind_a\(text\)/), JSON.stringify(j.findings))
      // the strict (no-exception) reference carries the SAME transitive rule
      assert.ok(has(await w.strict(c), /indirect_egress_function:public\.lc_ind_a\(text\)/))
    }))

    await t.test('a DYNAMIC-SQL wrapper (plpgsql EXECUTE) executable by the role → dynamic_sql_function (it can reach net.* via PUBLIC)', () => tx(async (c) => {
      await c.query(`create function public.lc_ind_dyn(q text) returns void language plpgsql security invoker as $d$ begin execute q; end $d$`)
      await c.query(`grant execute on function public.lc_ind_dyn(text) to ${w.role}`)
      const j = await w.check(c)
      assert.equal(j.ok, false)
      assert.ok(has(j, /dynamic_sql_function:public\.lc_ind_dyn\(text\)/), JSON.stringify(j.findings))
    }))

    await t.test('the role granted pg_read_server_files (COPY-to-program / server-file egress) → dangerous_role_membership', () => tx(async (c) => {
      await c.query('savepoint sp')
      await c.query(`grant pg_read_server_files to ${w.role}`)
      const j = await w.check(c)
      assert.equal(j.ok, false)
      assert.ok(j.findings.includes('dangerous_role_membership:pg_read_server_files'), JSON.stringify(j.findings))
      await c.query('rollback to savepoint sp')
    }))

    await t.test('USAGE on schema cron granted to the role → cron_schema_access (usage + the cron.job / cron.* grants it makes usable)', () => tx(async (c) => {
      await c.query(`grant usage on schema cron to ${w.role}`)
      const j = await w.check(c)
      assert.equal(j.ok, false)
      assert.ok(j.findings.includes('cron_schema_access:usage'), JSON.stringify(j.findings))
      assert.ok(j.findings.includes('cron_schema_access:cron.job'), 'PUBLIC SELECT on cron.job becomes usable')
      assert.ok(j.findings.includes('cron_schema_access:execute:cron.schedule(text,text)'), JSON.stringify(j.findings))
    }))
    await t.test('USAGE on schema cron granted to PUBLIC → cron_schema_access too', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'grant usage on schema cron to public')
      const j = await w.check(c)
      assert.equal(j.ok, false)
      assert.ok(j.findings.includes('cron_schema_access:usage') && j.findings.includes('cron_schema_access:cron.job'), JSON.stringify(j.findings))
    }))

    // ── the pinned platform allowlists (public.lc_egress_platform_allowlists, docs/SUPABASE-PG-NET-POSTURE.md §4b) ──
    const allow = (j, id) => (j.platform_allowlists || []).find((e) => e.id === id)
    await t.test('production shape: both allowlists applied and REPORTED; PUBLIC SELECT on cron.job without USAGE is not a path', () => tx(async (c) => {
      const j = await w.check(c)
      assert.equal(j.ok, true, JSON.stringify(j.findings))
      const pgis = allow(j, 'supabase_postgis_dynamic_sql')
      assert.equal(pgis.version, 'supabase_postgis_dynamic_sql.v1')
      assert.equal(pgis.status, 'applied', JSON.stringify(pgis.reasons))
      assert.deepEqual(pgis.reasons, [])
      assert.equal(pgis.extension_version, '3.3.7')
      assert.equal(pgis.extension_owner, 'supabase_admin')
      assert.deepEqual([...pgis.objects].sort(), [...POSTGIS_PINNED].sort())
      assert.deepEqual(pgis.absent, [])
      const et = allow(j, 'supabase_pg_net_access_event_trigger')
      assert.equal(et.version, 'supabase_pg_net_access_event_trigger.v1')
      assert.equal(et.status, 'applied', JSON.stringify(et.reasons))
      assert.deepEqual(et.objects, ['event:issue_pg_net_access -> extensions.grant_pg_net_access()'])
      assert.ok(!has(j, /cron_schema_access/), JSON.stringify(j.findings))
      // AS the role (the server's path) the same report
      await c.query('savepoint r')
      const k = await w.asRole(c)
      assert.equal(k.ok, true, JSON.stringify(k.findings))
      assert.equal(allow(k, 'supabase_postgis_dynamic_sql').status, 'applied')
      await c.query('rollback to savepoint r')
    }))
    const assertPostgisRefused = async (c, reason, label) => {
      const j = await w.check(c)
      const pgis = allow(j, 'supabase_postgis_dynamic_sql')
      assert.equal(pgis.status, 'not_applied', `${label}: ${JSON.stringify(pgis)}`)
      assert.ok(pgis.reasons.some((r) => reason.test(r)), `${label}: ${JSON.stringify(pgis.reasons)}`)
      assert.equal(j.ok, false, label)
      for (const sig of POSTGIS_DYNAMIC) assert.ok(j.findings.includes(`dynamic_sql_function:${sig}`), `${label}: ${sig} is a finding again`)
      return j
    }
    await t.test('a different PostGIS version → allowlist not_applied, all 13 dynamic-SQL functions are findings', () => tx(async (c) => {
      await c.query(`update pg_extension set extversion = '3.3.8' where extname = 'postgis'`)
      await assertPostgisRefused(c, /^extension_version:3\.3\.8$/, 'version')
    }))
    await t.test('a different PostGIS extension owner → not_applied', () => tx(async (c) => {
      await c.query(`update pg_extension set extowner = 'postgres'::regrole where extname = 'postgis'`)
      await assertPostgisRefused(c, /^extension_owner:postgres$/, 'extension owner')
    }))
    await t.test('a pinned function owned by another role → not_applied', () => tx(async (c) => {
      await c.query(`alter function public.unlockrows(text) owner to postgres`)
      await assertPostgisRefused(c, /^owner:public\.unlockrows\(text\):postgres$/, 'function owner')
    }))
    await t.test('a pinned function made SECURITY DEFINER → not_applied (and a definer finding)', () => tx(async (c) => {
      await asSupabaseAdmin(c, `alter function public.lockrow(text,text,text,text,timestamp) security definer`)
      const j = await assertPostgisRefused(c, /^security_definer:public\.lockrow/, 'definer')
      assert.ok(has(j, /reachable_definer_functions?:.*lockrow/), JSON.stringify(j.findings))
    }))
    await t.test('a pinned function granted outside the platform default ACL → not_applied', () => tx(async (c) => {
      await c.query('create role lc_posture_extra nologin')
      await asSupabaseAdmin(c, `grant execute on function public.checkauth(text,text,text) to lc_posture_extra`)
      await assertPostgisRefused(c, /^acl_outside_default:public\.checkauth\(text,text,text\):lc_posture_extra:EXECUTE$/, 'acl')
    }))
    await t.test('a pinned function dropped from the extension → not_applied', () => tx(async (c) => {
      await asSupabaseAdmin(c, `alter extension postgis drop function public.unlockrows(text)`)
      await assertPostgisRefused(c, /^not_extension_member:public\.unlockrows\(text\)$/, 'membership')
    }))
    await t.test('an UNPINNED dynamic-SQL function inside the postgis extension → finding (the allowlist stays applied for the pinned ones)', () => tx(async (c) => {
      await asSupabaseAdmin(c, `create function public.postgis_lc_extra(q text) returns void language plpgsql as $d$ begin execute q; end $d$; alter extension postgis add function public.postgis_lc_extra(text)`)
      const j = await w.check(c)
      assert.equal(allow(j, 'supabase_postgis_dynamic_sql').status, 'applied')
      assert.equal(j.ok, false)
      assert.deepEqual(j.findings.filter((f) => f.startsWith('dynamic_sql_function:')), ['dynamic_sql_function:public.postgis_lc_extra(text)'])
    }))
    await t.test('an extra non-PostGIS dynamic-SQL function PUBLIC can execute → finding', () => tx(async (c) => {
      await c.query(`create function public.lc_extra_raw(q text) returns void language plpgsql security invoker as $d$ begin execute q; end $d$`)
      const j = await w.check(c)
      assert.equal(j.ok, false)
      assert.deepEqual(j.findings.filter((f) => f.startsWith('dynamic_sql_function:')), ['dynamic_sql_function:public.lc_extra_raw(text)'])
    }))
    await t.test('the pg_net access event trigger without its tag filter → not_applied, event_trigger_egress finding', () => tx(async (c) => {
      await asSupabaseAdmin(c, `drop event trigger issue_pg_net_access; create event trigger issue_pg_net_access on ddl_command_end execute function extensions.grant_pg_net_access()`)
      const j = await w.check(c)
      const et = allow(j, 'supabase_pg_net_access_event_trigger')
      assert.equal(et.status, 'not_applied')
      assert.ok(et.reasons.includes('tags:ALL'), JSON.stringify(et.reasons))
      assert.equal(j.ok, false)
      assert.ok(j.findings.includes('event_trigger_egress:event:issue_pg_net_access -> extensions.grant_pg_net_access()'), JSON.stringify(j.findings))
    }))
    await t.test('the pg_net access event trigger owned by another role → not_applied, finding', () => tx(async (c) => {
      await c.query(`alter event trigger issue_pg_net_access owner to postgres`)
      const j = await w.check(c)
      assert.ok(allow(j, 'supabase_pg_net_access_event_trigger').reasons.includes('owner:postgres'))
      assert.ok(has(j, /^event_trigger_egress:event:issue_pg_net_access/), JSON.stringify(j.findings))
    }))
    await t.test('the pinned event trigger name pointing at another egress function → not_applied, finding', () => tx(async (c) => {
      await asSupabaseAdmin(c, `create function extensions.lc_other_hook() returns event_trigger language plpgsql as $e$ begin perform net.http_get('https://evt.invalid'); end $e$;
        drop event trigger issue_pg_net_access; create event trigger issue_pg_net_access on ddl_command_end when tag in ('CREATE EXTENSION') execute function extensions.lc_other_hook()`)
      const j = await w.check(c)
      assert.ok(allow(j, 'supabase_pg_net_access_event_trigger').reasons.some((r) => r.startsWith('function:')))
      assert.ok(has(j, /^event_trigger_egress:event:issue_pg_net_access -> extensions\.lc_other_hook\(\)/), JSON.stringify(j.findings))
    }))
    await t.test('no PostGIS and no event trigger: both allowlists not_present, nothing excepted', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'drop event trigger issue_pg_net_access; drop extension postgis')
      const j = await w.check(c)
      assert.equal(allow(j, 'supabase_postgis_dynamic_sql').status, 'not_present')
      assert.equal(allow(j, 'supabase_pg_net_access_event_trigger').status, 'not_present')
      assert.equal(j.ok, true, JSON.stringify(j.findings))
    }))

    await t.test('an event trigger whose function reaches net → event_trigger_egress', () => tx(async (c) => {
      await c.query(`create function public.lc_ind_evt() returns event_trigger language plpgsql as $e$ begin perform net.http_get('https://evt.invalid'); end $e$`)
      await c.query(`create event trigger lc_ind_evt_trg on ddl_command_end execute function public.lc_ind_evt()`)
      const j = await w.check(c)
      assert.equal(j.ok, false)
      assert.ok(has(j, /event_trigger_egress:event:lc_ind_evt_trg/), JSON.stringify(j.findings))
    }))

    // a Database-Webhook / pg_net trigger on a table the role can WRITE — gateway only (the reader writes nothing)
    if (make === gatewayWorld) {
      await t.test('a pg_net trigger (Supabase Database Webhook shape) on a role-writable table → egress_trigger', () => tx(async (c) => {
        await c.query(`create function action_gateway.lc_ind_hook() returns trigger language plpgsql as $h$ begin perform net.http_post('https://hook.invalid', row_to_json(new)::jsonb); return new; end $h$`)
        await c.query(`create trigger lc_ind_hook_trg after insert on action_gateway.action_intents for each row execute function action_gateway.lc_ind_hook()`)
        const j = await w.check(c)
        assert.equal(j.ok, false)
        assert.ok(has(j, /egress_trigger:action_gateway\.action_intents:lc_ind_hook_trg/), JSON.stringify(j.findings))
      }))
    }

    // reader-only: the real dynamic-SQL hole the posture closes — run_sql re-granted to PUBLIC must refuse again
    if (make === readerWorld) {
      await t.test('re-granting PUBLIC EXECUTE on the raw-SQL invoker public.run_sql → dynamic_sql_function (the emulation revoked it as the remediation)', () => tx(async (c) => {
        await c.query('grant execute on function public.run_sql(text) to public')
        const j = await w.check(c)
        assert.equal(j.ok, false)
        assert.ok(has(j, /dynamic_sql_function:public\.run_sql\(text\)/), JSON.stringify(j.findings))
      }))
      await t.test('with run_sql PUBLIC revoked (the default emulation state) the indirect rule is clean', () => tx(async (c) => {
        const j = await w.check(c)
        assert.ok(!has(j, /dynamic_sql_function:public\.run_sql/), JSON.stringify(j.findings))
      }))
    }

    await t.test('no exception context — net built by postgres, not an extension (the pre-platform shape) → EXACTLY the old findings', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'drop extension pg_net')
      await c.query(`create schema net; grant usage on schema net to public;
        create table net.http_request_queue (id bigserial primary key, url text); grant all on net.http_request_queue to public;
        create function net.http_get(url text) returns bigint language sql volatile as $n$ select 1::bigint $n$;
        create function net.http_post(url text, body jsonb) returns bigint language sql volatile as $n$ select 1::bigint $n$;`)
      const cur = await assertStrict(w, c, /^extension_pg_net_missing$/, 'postgres-built net')
      assert.ok(pgNetEntry(cur).reasons.includes('owner:schema:net:postgres'))
    }))

    await t.test('no pg_net at all (a non-Supabase database): platform_exceptions [] and EXACTLY the old findings', () => tx(async (c) => {
      await asSupabaseAdmin(c, 'drop extension pg_net')
      const cur = await w.check(c)
      const ref = await w.strict(c)
      assert.deepEqual(cur.platform_exceptions, [])
      assert.deepEqual(cur.findings, ref.findings)
      assert.equal(cur.ok, ref.ok)
      assert.equal(cur.ok, true, JSON.stringify(cur.findings))
    }))
  })
}

// ── the owner's READ-ONLY production scripts, proven against the production shape BEFORE the apply (the order the owner runs them) ──
test('PG the dry preflight predicts the apply EXACTLY, and the indirect verify reports only allowlisted rows (production shape)', { skip, timeout: 240_000 }, async (t) => {
  const db = await HARNESS.freshDb({ apply: false })
  dbs.push(db)
  const pool = db.pool
  await pool.query(fs.readFileSync(path.join(REPO_DIR, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_supabase_emulation.sql'), 'utf8'))
  // production 2026-10-23: the opt-in operations sources are ABSENT (the 5 lc_mcp_* plpgsql functions must still create)
  await pool.query(`drop function if exists public.automation_hold_for(text,uuid,text,uuid,text,text); drop view if exists public.v_followup_intent_reasons, public.v_followup_intent_health;
    drop table if exists public.followup_intents cascade; drop table if exists agent.conversation_action_state cascade; drop function if exists agent.ops_research_valuation_snapshot(timestamptz)`)
  await installPgNet(pool)
  await installPlatformShape(pool)
  await setExposedSchemas(pool, null) // production: the exposed schemas come from the dashboard
  const PREFLIGHT = fs.readFileSync(path.join(REPO_DIR, 'scripts/db/lc_mcp_reader_prod_dry_preflight.sql'), 'utf8')
  const VERIFY = fs.readFileSync(path.join(REPO_DIR, 'scripts/db/pg_net_indirect_egress_prod_verify.sql'), 'utf8')
  const MIGRATION = fs.readFileSync(MIG('PROPOSED_20261019150000_lc_mcp_reader.sql'), 'utf8')
  const verdict = (rows) => rows.find((r) => r.section === 'verdict').verdict
  const blockers = (rows) => rows.filter((r) => r.verdict === 'BLOCKER').map((r) => `${r.section}:${r.item}`)
  const ro = async (c, sql) => { await c.query('set transaction read only'); return (await c.query(sql)).rows }

  await t.test('the verify script: 13 PostGIS dynamic-SQL rows + the event trigger, all allowlisted; no cron row; zero blockers', () => inRolledBackTx(pool, async (c) => {
    const rows = await ro(c, VERIFY)
    assert.deepEqual(rows.filter((r) => r.allowlisted_by == null), [], JSON.stringify(rows))
    assert.deepEqual(rows.filter((r) => r.kind === 'dynamic_sql_function').map((r) => r.allowlisted_by), Array(13).fill('supabase_postgis_dynamic_sql.v1'))
    assert.deepEqual(rows.filter((r) => r.kind === 'event_trigger_egress').map((r) => [r.detail, r.allowlisted_by]), [['event:issue_pg_net_access -> extensions.grant_pg_net_access()', 'supabase_pg_net_access_event_trigger.v1']])
    assert.equal(rows.filter((r) => r.kind === 'cron_schema_access').length, 0)
  }))
  await t.test('the verify script with an extra raw-SQL function and cron USAGE: blockers', () => inRolledBackTx(pool, async (c) => {
    await c.query(`create function public.lc_extra_raw(q text) returns void language plpgsql as $d$ begin execute q; end $d$; grant usage on schema cron to public`)
    const rows = (await c.query(VERIFY)).rows
    const bad = rows.filter((r) => r.allowlisted_by == null).map((r) => `${r.kind}:${r.detail}`)
    assert.ok(bad.includes('dynamic_sql_function:lc_extra_raw(text)') || bad.includes('dynamic_sql_function:public.lc_extra_raw(text)'), JSON.stringify(bad))
    assert.ok(bad.includes('cron_schema_access:usage') && bad.includes('cron_schema_access:cron.job'), JSON.stringify(bad))
  }))

  await t.test('preflight on the production shape: apply_would_pass true; the exceptions and allowlists listed', () => inRolledBackTx(pool, async (c) => {
    const rows = await ro(c, PREFLIGHT)
    assert.deepEqual(blockers(rows), [])
    assert.match(verdict(rows), /^true /)
    assert.ok(rows.some((r) => r.verdict === 'excepted:supabase_postgis_dynamic_sql.v1'))
    assert.ok(rows.some((r) => r.verdict === 'excepted:supabase_pg_net_access_event_trigger.v1'))
    assert.ok(rows.some((r) => r.verdict === 'excepted:supabase_pg_net_default_acl.v1'))
    assert.ok(rows.some((r) => r.section === 'optional_source' && /agent\.conversation_action_state ABSENT/.test(r.item)))
  }))
  const cases = [
    ['an extra raw-SQL function PUBLIC can execute', `create function public.lc_extra_raw(q text) returns void language plpgsql as $d$ begin execute q; end $d$`, /dynamic_sql_function:.*lc_extra_raw/],
    ['USAGE on schema cron to PUBLIC', 'grant usage on schema cron to public', /cron_schema_access/],
    ['a different PostGIS version', `update pg_extension set extversion = '3.3.8' where extname = 'postgis'`, /dynamic_sql_function:.*addgeometrycolumn/],
    ['the event trigger without its tag filter', `set role supabase_admin; drop event trigger issue_pg_net_access; create event trigger issue_pg_net_access on ddl_command_end execute function extensions.grant_pg_net_access(); reset role`, /event_trigger_egress/],
    ['a PUBLIC-executable SECURITY DEFINER function', `create function public.lc_extra_definer() returns int language sql security definer as $d$ select 1 $d$`, /reachable_definer_functions:.*lc_extra_definer/],
    ['a PUBLIC write grant', 'grant insert on public.sms_templates to public', /write_privileges:.*sms_templates/],
    ['PUBLIC SELECT on a non-inventory public table', 'grant select on public.send_queue to public', /exposed_select_outside_inventory:.*send_queue/],
  ]
  for (const [label, sql, expectRefusal] of cases) {
    await t.test(`preflight + apply agree: ${label}`, () => inRolledBackTx(pool, async (c) => {
      await c.query(sql)
      await c.query('savepoint pf')
      const rows = (await c.query(PREFLIGHT)).rows
      await c.query('rollback to savepoint pf')
      assert.match(verdict(rows), /^false /, `${label}: predicted refusal`)
      assert.ok(blockers(rows).length > 0)
      await c.query('savepoint ap')
      let err = null
      try { await c.query(MIGRATION) } catch (e) { err = e }
      await c.query('rollback to savepoint ap')
      assert.ok(err, `${label}: the apply refused`)
      assert.match(String(err.message), expectRefusal, `${label}: ${err.message.slice(0, 400)}`)
    }))
  }
  await t.test('the apply itself on the production shape passes (prediction true → ok) and the opt-in functions were created', () => inRolledBackTx(pool, async (c) => {
    await c.query(MIGRATION)
    const j = (await c.query(`select public.lc_mcp_reader_self_check($1, $2, 'lc_mcp_reader') j`, [LC_MCP_RELATIONS, LC_MCP_FUNCTIONS])).rows[0].j
    assert.equal(j.ok, true, JSON.stringify(j.findings))
    for (const fn of ['public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)', 'public.lc_mcp_thread_hold_status(uuid)', 'public.lc_mcp_followup_intent_health()', 'public.lc_mcp_ops_research_valuation_snapshot()']) {
      assert.ok((await c.query('select to_regprocedure($1) p', [fn])).rows[0].p, fn)
    }
    // an absent source answers at CALL time (42P01 / 42883), the MCP tool reports "unavailable"
    await c.query('savepoint call')
    await assert.rejects(c.query(`select public.lc_mcp_followup_intent_health()`), (e) => ['42P01', '42883'].includes(e.code))
    await c.query('rollback to savepoint call')
  }))
})
