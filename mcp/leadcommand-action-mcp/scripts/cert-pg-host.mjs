#!/usr/bin/env node
// CERTIFICATION HOST — DISPOSABLE DATABASES ONLY. Never a production entry point.
//
// The REAL Action MCP (src/app.mjs buildApp + src/protocol/http.mjs startHttp, behind this package's credential-fencing
// loader), with ONE substitution: the data client. Production reaches PostgreSQL through PostgREST under the
// lc_action_gateway JWT; this host connects to a LOOPBACK disposable database as `authenticator` (the login role
// PostgREST itself uses, no superuser) with `role=lc_action_gateway` + the `lc_org` tenant claim, and speaks the PostgREST
// builder subset through apps/api/tests/helpers/pg-supabase.mjs (the same substitution the Action MCP e2e-pg test makes).
// So the gateway, its grants, kill switches, definer functions, RLS and the database role's privileges all run for real;
// what is NOT exercised here is PostgREST's own HTTP / JWT layer (the e2e with the real binary covers that separately).
//
//   LC_CERT_DB_URL=postgres://authenticator@127.0.0.1:<port>/<db>  (refused unless loopback + disposable-shaped)
//   + the usual LEADCOMMAND_ACTION_MCP_* variables (transport streamable-http, bind 127.0.0.1, port, org, files, audit)
import '../src/loader/register.mjs'
import pg from 'pg'

const url = process.env.LC_CERT_DB_URL || ''
const { assertDisposableTarget } = await import('../../../scripts/db/db-target-guard.mjs')
assertDisposableTarget(url)
const u = new URL(url)
if (u.username !== 'authenticator') throw new Error('cert host: connect as authenticator (the PostgREST login role), never a superuser')

const { pgSupabase } = await import('../../../apps/api/tests/helpers/pg-supabase.mjs')
const { buildApp } = await import('../src/app.mjs')
const { startHttp } = await import('../src/protocol/http.mjs')

const org = process.env.LEADCOMMAND_ACTION_MCP_ORG_ID
const TS = new Set([1184, 1114])
const types = { getTypeParser: (oid, format) => (TS.has(oid) ? (v) => (v == null ? v : String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : pg.types.getTypeParser(oid, format)) }
const pool = new pg.Pool({ connectionString: url, max: 6, types, options: `-c role=lc_action_gateway -c request.jwt.claim.lc_org=${org}` })
pool.on('error', () => {})

const env = { ...process.env }
delete env.LC_CERT_DB_URL
let app
try {
  app = await buildApp({ env, db: pgSupabase(pool) })
} catch (e) {
  process.stderr.write(`${JSON.stringify({ event: 'server_boot_failed', message: String(e?.message || e).slice(0, 300) })}\n`)
  await pool.end().catch(() => {})
  process.exit(2)
}
app.startRecovery(20_000)
const listener = await startHttp({ app })
process.stderr.write(`${JSON.stringify({ event: 'cert_host_listening', url: listener.url, data_path: 'disposable-pg-as-authenticator(role=lc_action_gateway)' })}\n`)
const shutdown = async (code = 0) => { await listener.close().catch(() => {}); await app.close().catch(() => {}); await pool.end().catch(() => {}); process.exit(code) }
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
