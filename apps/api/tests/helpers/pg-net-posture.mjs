// The Supabase pg_net posture world (docs/SUPABASE-PG-NET-POSTURE.md), DISPOSABLE PostgreSQL 17 only.
//
// Supabase creates pg_net AS supabase_admin: supabase_admin owns schema net and every object in it, all of them
// members of extension pg_net, and PUBLIC holds USAGE on net, all privileges on the net tables / sequences and
// EXECUTE on the functions (https://supabase.com/docs/guides/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16).
// This helper reproduces exactly that with a REAL `CREATE EXTENSION pg_net` run AS a superuser role named
// supabase_admin, from the shape-only emulation in apps/api/tests/pg/pg_net_emulation (no C code, no worker, no
// network). PostgreSQL 17 reads extension control files only from its own share directory, so the server runs from
// a CLONE of the LC_PG_BIN tree with the two emulation files added (APFS clone where available: no copy cost).
//
//   pgNetServer()        a loopback-only cluster of its own (LC_PG_BIN; preferred: the platform role never touches a
//                        shared server), else AGENT_PG_TEST_DB_URL when that server already offers the emulation,
//                        else null (the caller skips)
//   installPgNet(pool)   CREATE EXTENSION pg_net AS supabase_admin + the platform's USAGE grants, as Supabase has it
//   setExposedSchemas()  authenticator's pgrst.db_schemas role setting (IN DATABASE: never cluster-wide), or none
//
// The migration-test runner and the MCP local stack REFUSE a server that carries supabase_admin (a production
// guard); that is why this world is a cluster of its own.
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_DIR = path.resolve(HERE, '../../../..')
export const EMULATION_DIR = path.resolve(HERE, '../pg/pg_net_emulation')
export const PG_NET_FILES = ['pg_net.control', 'pg_net--0.20.0.sql', 'postgis.control', 'postgis--3.3.7.sql']

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG/.test(k)))

/** Clone the PostgreSQL tree of `pgBin` (its parent dir) into `dest` and add the pg_net emulation to its share dir. */
export function clonePgTreeWithPgNet(pgBin, dest) {
  const root = path.resolve(pgBin, '..')
  const r = process.platform === 'darwin' ? spawnSync('cp', ['-cR', root, dest], { encoding: 'utf8' }) : { status: 1 }
  if (r.status !== 0) fs.cpSync(root, dest, { recursive: true, verbatimSymlinks: true })
  const ext = path.join(dest, 'share/postgresql/extension')
  if (!fs.existsSync(ext)) throw new Error(`no share/postgresql/extension under ${root}`)
  for (const f of PG_NET_FILES) fs.copyFileSync(path.join(EMULATION_DIR, f), path.join(ext, f))
  return path.join(dest, 'bin')
}

async function hasPgNet(url) {
  const c = new pg.Client({ connectionString: url })
  try {
    await c.connect()
    return (await c.query(`select 1 from pg_available_extensions where name = 'pg_net'`)).rowCount === 1
  } catch {
    return false
  } finally {
    await c.end().catch(() => {})
  }
}

/** @returns {Promise<null | { url: string, own: boolean, stop: () => Promise<void> }>} */
export async function pgNetServer() {
  const bin = String(process.env.LC_PG_BIN || '').trim()
  if (bin) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pgnet-'))
    const tree = path.join(work, 'pg')
    const b = clonePgTreeWithPgNet(bin, tree)
    const data = path.join(work, 'data')
    const env = cleanEnv()
    const init = spawnSync(path.join(b, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--no-locale', '--no-instructions'], { encoding: 'utf8', env })
    if (init.status !== 0) throw new Error(`initdb failed: ${(init.stderr || init.stdout).slice(0, 600)}`)
    const port = await freePort()
    const opts = `-c listen_addresses=127.0.0.1 -c port=${port} -k ${work} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200`
    const start = spawnSync(path.join(b, 'pg_ctl'), ['-D', data, '-o', opts, '-l', path.join(work, 'server.log'), '-w', '-t', '60', 'start'], { encoding: 'utf8', env })
    if (start.status !== 0) throw new Error(`pg_ctl start failed: ${(start.stderr || start.stdout).slice(0, 600)}`)
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`
    return {
      url,
      own: true,
      async stop() {
        spawnSync(path.join(b, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8', env })
        fs.rmSync(work, { recursive: true, force: true })
      },
    }
  }
  const shared = String(process.env.AGENT_PG_TEST_DB_URL || '').trim()
  if (shared && (await hasPgNet(shared))) return { url: shared, own: false, async stop() {} }
  return null
}

export const SKIP_REASON = 'needs LC_PG_BIN (a PostgreSQL 17 tree: the test clones it, adds the pg_net emulation and runs its own loopback cluster) or an AGENT_PG_TEST_DB_URL server that already offers the pg_net emulation'

/** CREATE EXTENSION pg_net AS supabase_admin, then the platform's extra USAGE grants (Supabase's documented ACL). */
export async function installPgNet(pool, { platformUsage = ['postgres', 'anon', 'authenticated', 'service_role'] } = {}) {
  await pool.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin superuser nologin; end if; end $$`)
  const c = await pool.connect()
  try {
    await c.query('set role supabase_admin')
    await c.query('create extension pg_net')
    if (platformUsage.length) await c.query(`grant usage on schema net to ${platformUsage.join(', ')}`)
    await c.query('reset role')
  } finally {
    c.release()
  }
}

/** The 26 pinned PostGIS 3.3.7 overloads (supabase_postgis_dynamic_sql.v1), exactly as the migrations list them. */
export const POSTGIS_PINNED = Object.freeze([
  'public.addgeometrycolumn(character varying,character varying,character varying,character varying,integer,character varying,integer,boolean)',
  'public.addgeometrycolumn(character varying,character varying,character varying,integer,character varying,integer,boolean)',
  'public.addgeometrycolumn(character varying,character varying,integer,character varying,integer,boolean)',
  'public.checkauth(text,text,text)', 'public.checkauth(text,text)', 'public.disablelongtransactions()', 'public.enablelongtransactions()',
  'public.dropgeometrycolumn(character varying,character varying,character varying,character varying)',
  'public.dropgeometrycolumn(character varying,character varying,character varying)', 'public.dropgeometrycolumn(character varying,character varying)',
  'public.dropgeometrytable(character varying,character varying,character varying)', 'public.dropgeometrytable(character varying,character varying)',
  'public.dropgeometrytable(character varying)', 'public.lockrow(text,text,text,text,timestamp without time zone)', 'public.lockrow(text,text,text,text)',
  'public.lockrow(text,text,text)', 'public.lockrow(text,text,text,timestamp without time zone)', 'public.populate_geometry_columns(boolean)',
  'public.populate_geometry_columns(oid,boolean)', 'public.postgis_extensions_upgrade()', 'public.st_findextent(text,text,text)', 'public.st_findextent(text,text)',
  'public.unlockrows(text)', 'public.updategeometrysrid(character varying,character varying,character varying,character varying,integer)',
  'public.updategeometrysrid(character varying,character varying,character varying,integer)', 'public.updategeometrysrid(character varying,character varying,integer)'])
/** The 13 of them whose bodies run plpgsql EXECUTE (the production verify returned exactly these as dynamic_sql_function). */
export const POSTGIS_DYNAMIC = Object.freeze([POSTGIS_PINNED[0], POSTGIS_PINNED[3], POSTGIS_PINNED[5], POSTGIS_PINNED[6], POSTGIS_PINNED[7], POSTGIS_PINNED[10],
  POSTGIS_PINNED[13], POSTGIS_PINNED[18], POSTGIS_PINNED[19], POSTGIS_PINNED[20], POSTGIS_PINNED[21], POSTGIS_PINNED[22], POSTGIS_PINNED[23]])

/**
 * The rest of the production platform shape the 2026-10-23 read-only verification found (scripts/db/pg_net_indirect_egress_prod_verify.sql):
 *   PostGIS 3.3.7 in schema public, owned by supabase_admin, its functions EXECUTE to PUBLIC + postgres / anon / authenticated / service_role;
 *   the event trigger issue_pg_net_access -> extensions.grant_pg_net_access() (Supabase's body: it re-GRANTs / ALTERs net.http_*);
 *   pg_cron's ACL shape: schema cron {supabase_admin=UC, postgres=U*} (NO PUBLIC USAGE), PUBLIC SELECT on cron.job, PUBLIC EXECUTE on cron.*.
 */
export async function installPlatformShape(pool) {
  const c = await pool.connect()
  try {
    await c.query('set role supabase_admin')
    await c.query('create extension postgis schema public')
    for (const sig of POSTGIS_PINNED) await c.query(`grant execute on function ${sig} to postgres, anon, authenticated, service_role`)
    await c.query(`create schema cron;
      create table cron.job (jobid bigserial primary key, schedule text not null, command text not null, username text not null default current_user, active boolean not null default true);
      grant select on cron.job to public;
      create function cron.schedule(schedule text, command text) returns bigint language sql as $f$ select 1::bigint $f$;
      create function cron.unschedule(job_id bigint) returns boolean language sql as $f$ select true $f$;
      revoke all on schema cron from public;
      grant usage on schema cron to postgres with grant option;`)
    await c.query('create schema if not exists extensions')
    await c.query(`create or replace function extensions.grant_pg_net_access() returns event_trigger language plpgsql as $f$
      begin
        if exists (select 1 from pg_event_trigger_ddl_commands() as ev join pg_extension as ext on ev.objid = ext.oid where ext.extname = 'pg_net') then
          if not exists (select 1 from pg_roles where rolname = 'supabase_functions_admin') then
            create user supabase_functions_admin noinherit createrole login noreplication;
          end if;
          grant usage on schema net to supabase_functions_admin, postgres, anon, authenticated, service_role;
          if exists (select from pg_extension where extname = 'pg_net' and extversion in ('0.2', '0.6', '0.7', '0.7.1', '0.8', '0.10.0', '0.11.0')) then
            alter function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) security definer;
            alter function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) security definer;
            alter function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) set search_path = net;
            alter function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) set search_path = net;
            revoke all on function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) from public;
            revoke all on function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) from public;
            grant execute on function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) to supabase_functions_admin, postgres, anon, authenticated, service_role;
            grant execute on function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) to supabase_functions_admin, postgres, anon, authenticated, service_role;
          end if;
        end if;
      end
      $f$`)
    await c.query(`create event trigger issue_pg_net_access on ddl_command_end when tag in ('CREATE EXTENSION') execute function extensions.grant_pg_net_access()`)
    await c.query('reset role')
  } finally {
    c.release()
  }
}

/** authenticator's pgrst.db_schemas for THIS database only (the role is cluster-global; the setting stays per database). */
export async function setExposedSchemas(pool, schemas) {
  const db = (await pool.query('select current_database() d')).rows[0].d
  if (schemas == null) await pool.query(`alter role authenticator in database ${pg.escapeIdentifier(db)} reset pgrst.db_schemas`)
  else await pool.query(`alter role authenticator in database ${pg.escapeIdentifier(db)} set pgrst.db_schemas = ${pg.escapeLiteral(schemas)}`)
}

/** Drop the platform role after every database that holds its objects is gone (own cluster: the cluster goes anyway). */
export async function dropPlatformRole(adminUrl) {
  const c = new pg.Client({ connectionString: adminUrl })
  await c.connect()
  try { await c.query('drop role if exists supabase_admin') } catch { /* still owns objects in a live database: left for the cluster teardown */ } finally { await c.end().catch(() => {}) }
}

/** Run `fn(client)` inside a transaction that is ALWAYS rolled back (a mutation case leaves no trace). */
export async function inRolledBackTx(pool, fn) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    return await fn(c)
  } finally {
    await c.query('rollback').catch(() => {})
    c.release()
  }
}

/** The read-only server's inventory (what its boot self-check passes): the SAME lists the migration grants. */
export { RELATION_NAMES as LC_MCP_RELATIONS, RPC_SIGNATURES as LC_MCP_FUNCTIONS } from '../../../../mcp/leadcommand-mcp/src/data/inventory.mjs'
