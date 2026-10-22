// The READ-ONLY LeadCommand MCP (mcp/leadcommand-mcp) on the SAME disposable database as the Workforce world, as its
// role-enforced lc_mcp_reader (the LIVE milestone, 2026-10-22). Test setup, disposable DB only:
//   1. the migration chain's own composition file (lc_mcp_reader_chain_baseline.sql: ONLY the inventory relations still
//      missing after the chain, idempotently);
//   2. a widening of those stand-ins to the columns the real read services select (captured over the fake PostgREST by
//      the MCP's own test support, so it cannot drift from the code); the comps materialized view over a private synthetic
//      table; probate / preforeclosure owner-rights views over empty tables;
//   3. pg_net's PUBLIC grants revoked when a `net` schema exists (production's open item; on this disposable DB it is
//      arranged, as the owner directed), then THE migration PROPOSED_20261019150000_lc_mcp_reader.sql, whose apply runs
//      the role's privilege self-check and refuses atomically on any finding;
//   4. the synthetic inventory rows (book.mjs readerRows), and the server: bin/leadcommand-mcp.mjs, live data mode,
//      streamable-http on 127.0.0.1 with its own Bearer file, the reader JWT minted HS256 with this stack's secret.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as S from '../e2e-agntei/stack.mjs'

const T_NUM = /(_count|_score|_pct|_percent|_value|_amount|_amt|_balance|_cap|_pts|_year|_years|_income|_rate)$|^(price|lat|lng|latitude|longitude|beds|baths|sqft|units|units_count|year_built|ppsf|per_door|confidence|comp_count|build_id|source_year|building_square_feet|lot_square_feet|total_bedrooms|total_baths|recommended_cash_offer|estimated_repairs|estimated_value|estimated_repair_cost|aos_score|score|median_[a-z_]+|valuation_[a-z]+|investor_ceiling_[a-z]+|transaction_probability_[0-9]+|sale_count|investor_count|buyer_known_count|cash_known_count|cash_count|mf_sale_count|equity_amount|total_loan_balance|equity_percent|priority_score|urgency_score|tax_amt|campaign_count|distress_signal_count|scores_aos_score|sale_price|assd_total_value|total_loan_payment|market_status_value)$/
const T_BOOL = /^(is_|has_)|(^|_)(wrong_number|active_lien|tax_delinquent|sms_eligible|queue_eligible|never_contacted|likely_owner|likely_renting|listed_mls|exclude_targeting|reachable_living_dm|only_deceased_reachable|auto_send_enabled|true_post_contact_suppression|pending_prior_touch|active_queue_item|requires_review|out_of_state_owner|investor_inferred_current_owner)$/
const T_TIME = /(_at|_date|^sold_on|^latest_sale|^last_sale_on|^sale_date|^date_of_death)$/
const T_JSON = /(_json$|^metadata$|^evidence$|^signal_labels$)/
const typeOf = (c) => (c === 'zips' ? 'text[]' : T_BOOL.test(c) ? 'boolean' : T_TIME.test(c) ? 'timestamptz' : T_JSON.test(c) ? 'jsonb' : T_NUM.test(c) ? 'numeric' : 'text')
const VIEWS = new Set(['probate_status', 'preforeclosure_status_v2', 'mv_map_market_sales', 'eg_buyer_index'])

/** Steps 1–3 on the world's database (BEFORE PostgREST starts, so its schema cache has the new functions). */
export async function applyReader({ world, repo, log = () => {} }) {
  const { captureColumns } = await import(path.join(repo, 'mcp/leadcommand-mcp/test/support/local-stack.mjs'))
  const cols = await captureColumns()
  const pool = world.db.pool
  const h = world.harness
  await h.runSqlFile(pool, path.join(repo, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_chain_baseline.sql'))
  const kinds = Object.fromEntries((await pool.query(`select c.relname, c.relkind from pg_class c where c.relnamespace = 'public'::regnamespace`)).rows.map((r) => [r.relname, r.relkind]))
  const sql = ['create schema if not exists synthetic', 'revoke all on schema synthetic from public',
    'create table if not exists public.probate_case (property_id text primary key, status text)', 'create table if not exists public.preforeclosure_case (property_id text primary key, status text)',
    "alter table public.probate_case enable row level security", "alter table public.preforeclosure_case enable row level security", 'revoke all on public.probate_case, public.preforeclosure_case from anon']
  const widened = []
  for (const [rel, list] of Object.entries(cols)) {
    if (VIEWS.has(rel)) continue
    if (kinds[rel] !== 'r' && kinds[rel] !== 'p') continue
    for (const c of list) { sql.push(`alter table public.${rel} add column if not exists ${c} ${typeOf(c)}`); widened.push(`${rel}.${c}`) }
  }
  for (const c of cols.probate_status || []) sql.push(`alter table public.probate_case add column if not exists ${c} ${typeOf(c)}`)
  for (const c of cols.preforeclosure_status_v2 || []) sql.push(`alter table public.preforeclosure_case add column if not exists ${c} ${typeOf(c)}`)
  sql.push('drop view if exists public.probate_status', 'drop view if exists public.preforeclosure_status_v2', 'drop materialized view if exists public.mv_map_market_sales', 'drop materialized view if exists public.eg_buyer_index')
  sql.push('create view public.probate_status as select * from public.probate_case', 'create view public.preforeclosure_status_v2 as select * from public.preforeclosure_case')
  const salesCols = [...new Set(['comp_id', 'property_id', 'sold_on', 'price', 'lat', 'lng', ...(cols.mv_map_market_sales || [])])]
  sql.push(`create table if not exists synthetic.market_sales (${salesCols.map((c) => `${c} ${c === 'sold_on' ? 'date' : typeOf(c)}`).join(', ')})`)
  sql.push('create materialized view public.mv_map_market_sales as select * from synthetic.market_sales')
  sql.push("create materialized view public.eg_buyer_index as select 'SYN-B1'::text as buyer_id, array['75216','75217','75227']::text[] as zips, 'active'::text as activity_status")
  sql.push("do $$ begin if exists (select 1 from pg_namespace where nspname = 'net') then execute 'revoke all on schema net from public'; end if; end $$")
  for (const s of sql) await pool.query(s)
  log(`reader widening: ${widened.length} columns`)
  await h.applyInTransaction(pool, path.join(repo, 'supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql'))
  const { RELATION_NAMES, RPC_SIGNATURES } = await import(path.join(repo, 'mcp/leadcommand-mcp/src/data/inventory.mjs'))
  const self = (await pool.query(`select public.lc_mcp_reader_self_check($1::text[], $2::text[], 'lc_mcp_reader') r`, [RELATION_NAMES, RPC_SIGNATURES]).catch((e) => ({ rows: [{ r: { error: e.message } }] }))).rows[0]?.r
  return { widened: widened.length, self_check: self ? { ok: self.ok ?? null, findings: (self.findings || []).slice(0, 10), current_user: self.current_user ?? null } : null }
}

/** Step 4: the synthetic inventory rows (owner). Only columns that exist are written; existing property rows are updated. */
export async function seedReader(pool, rows) {
  const colsOf = async (t, schema = 'public') => new Set((await pool.query('select column_name from information_schema.columns where table_schema = $1 and table_name = $2', [schema, t])).rows.map((r) => r.column_name))
  const put = async (table, list, { key = 'property_id', schema = 'public' } = {}) => {
    const have = await colsOf(table, schema)
    let n = 0
    for (const r of list) {
      const ks = Object.keys(r).filter((k) => have.has(k))
      const vals = ks.map((k) => (r[k] !== null && typeof r[k] === 'object' && !(r[k] instanceof Date) ? JSON.stringify(r[k]) : r[k]))
      if (key) await pool.query(`delete from ${schema}.${table} where ${key} = $1`, [r[key]]).catch(() => {})
      await pool.query(`insert into ${schema}.${table} (${ks.join(', ')}) values (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, vals)
      n += 1
    }
    return n
  }
  // properties already hold the conversation rows' minimal columns: update in place (other tables reference them)
  const pc = await colsOf('properties')
  for (const r of rows.properties) {
    const ks = Object.keys(r).filter((k) => pc.has(k) && k !== 'property_id')
    const ex = (await pool.query('select 1 from public.properties where property_id = $1', [r.property_id])).rowCount
    if (ex) await pool.query(`update public.properties set ${ks.map((k, i) => `${k} = $${i + 2}`).join(', ')} where property_id = $1`, [r.property_id, ...ks.map((k) => r[k])])
    else await put('properties', [r])
  }
  const out = { properties: rows.properties.length }
  out.property_acquisition_scores = await put('property_acquisition_scores', rows.property_acquisition_scores)
  out.eg_property_facts = await put('eg_property_facts', rows.eg_property_facts)
  out.market_sales = await put('market_sales', rows.sales, { key: null, schema: 'synthetic' })
  await pool.query('refresh materialized view public.mv_map_market_sales')
  // market intelligence: a ready build and one rollup per test-market zip
  const mi = await colsOf('mi_geo_period_rollup')
  await pool.query("insert into public.mi_rollup_builds (build_id, status) values (900, 'ready') on conflict do nothing").catch(() => {})
  for (const zip of ['75216', '75217', '75227', '75228', '75241']) {
    const r = { build_id: 900, geo_key: zip, geo_level: 'zip', period: '1y', asset: 'all', sale_count: 30, median_price: 210000, median_ppsf: 165, investor_count: 9, buyer_known_count: 24, cash_known_count: 24, cash_count: 11, latest_sale: new Date(Date.now() - 12 * 86_400_000).toISOString() }
    const ks = Object.keys(r).filter((k) => mi.has(k))
    await pool.query(`insert into public.mi_geo_period_rollup (${ks.join(', ')}) values (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map((k) => r[k])).catch(() => {})
  }
  return out
}

/** The server (live data mode, streamable-http on loopback, its own Bearer). */
export async function startReaderMcp({ repo, node, dir, log, auditFile, shimUrl, jwtSecret, anonKeyFile, principal, orgId, scopes }) {
  const port = await S.freePort()
  const reader = S.hs256(jwtSecret, { role: 'lc_mcp_reader', iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3 * 86_400 })
  const readerFile = S.writeSecret(path.join(dir, 'secrets', 'lc_mcp_reader.jwt'), reader)
  const bearer = crypto.randomBytes(32).toString('base64url')
  const bearerFile = S.writeSecret(path.join(dir, 'secrets', 'readonly-mcp.bearer'), bearer)
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR || '/tmp',
    LEADCOMMAND_MCP_DATA: 'live', LEADCOMMAND_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_MCP_HTTP_PORT: String(port), LEADCOMMAND_MCP_HTTP_TOKEN_FILE: bearerFile,
    LEADCOMMAND_MCP_SUPABASE_URL: shimUrl, LEADCOMMAND_MCP_READER_JWT_FILE: readerFile, LEADCOMMAND_MCP_API_KEY_FILE: anonKeyFile,
    LEADCOMMAND_MCP_PRINCIPAL_USER_ID: principal, LEADCOMMAND_MCP_ORG_ID: orgId, LEADCOMMAND_MCP_SCOPES: scopes, LEADCOMMAND_MCP_AUDIT_FILE: auditFile,
  }
  const cwd = path.join(repo, 'mcp/leadcommand-mcp')
  const rec = S.startProcess('readonly-mcp', node, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'bin/leadcommand-mcp.mjs'], { cwd, env, log })
  const url = `http://127.0.0.1:${port}/mcp`
  await S.waitFor(async () => {
    if (rec.exited) throw new Error(`the read-only MCP exited (${JSON.stringify(rec.exited)}): ${fs.readFileSync(log, 'utf8').slice(-800)}`)
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }).catch(() => null)
    if (r) await r.arrayBuffer().catch(() => {})
    return r && r.status === 401
  }, { what: 'the read-only LeadCommand MCP', timeoutMs: 90_000 })
  return { url, port, rec, bearer, bearerFile, readerFile, readerToken: reader }
}
