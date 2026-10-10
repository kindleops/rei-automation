#!/usr/bin/env node
// Pre-deploy check of the agent's DB credential, with the EXACT production pool rules
// (live-agent.js agentPgPoolConfig with NODE_ENV=production: agent_api only, verified TLS
// against the Supabase CA, no host override, no loopback).
//
//   AGENT_DATABASE_URL_FILE=/secure/agent_database_url AGENT_DATABASE_CA_FILE=/secure/supabase-ca.crt \
//     node --import ./apps/api/tests/_alias_only.mjs apps/api/scripts/agent/agent-db-connect-check.mjs
//   (run from the repo root; or from apps/api with ./tests/_alias_only.mjs)
//
// Prints only: role name, privilege flags, TLS state, and whether the agent tables are visible.
// Never prints the URL, the password or the certificate. Read-only (selects only).
import fs from 'node:fs'
import pg from 'pg'
import { agentPgPoolConfig } from '@/lib/agent/live/live-agent.js'

const urlFile = process.env.AGENT_DATABASE_URL_FILE
if (!urlFile || !process.env.AGENT_DATABASE_CA_FILE) {
  console.error('set AGENT_DATABASE_URL_FILE and AGENT_DATABASE_CA_FILE')
  process.exit(2)
}
const env = { NODE_ENV: 'production', AGENT_DATABASE_URL: fs.readFileSync(urlFile, 'utf8').trim(), AGENT_DATABASE_CA_FILE: process.env.AGENT_DATABASE_CA_FILE }
let cfg
try {
  cfg = agentPgPoolConfig(env)
} catch (e) {
  console.error(`REFUSED by the production pool rules: ${e.message}`)
  process.exit(1)
}
const client = new pg.Client({ ...cfg, connectionTimeoutMillis: 15_000, statement_timeout: 15_000 })
try {
  await client.connect()
  const r = await client.query(`select current_user as role, r.rolsuper, r.rolbypassrls, r.rolinherit, (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as tls,
    has_table_privilege('agent.spend_ledger', 'INSERT') as can_reserve, has_table_privilege('agent.research_limits', 'UPDATE') as can_raise_limits,
    has_table_privilege('public.properties', 'SELECT') as reads_app_tables
    from pg_roles r where r.rolname = current_user`)
  console.log(JSON.stringify(r.rows[0]))
  const ok = r.rows[0].role === 'agent_api' && !r.rows[0].rolsuper && !r.rows[0].rolbypassrls && r.rows[0].tls === true && r.rows[0].can_reserve === true && r.rows[0].can_raise_limits === false && r.rows[0].reads_app_tables === false
  console.log(ok ? 'AGENT DB CREDENTIAL OK' : 'AGENT DB CREDENTIAL NOT OK')
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.error(`CONNECT FAILED: ${String(e.code || e.message).slice(0, 200)}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
