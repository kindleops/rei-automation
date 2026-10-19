// A LOCAL, DISPOSABLE PostgreSQL 17 + real PostgREST stack (tests only, never production).
//
//   cluster    scripts/db/run-migration-test.mjs#startCluster: a fresh initdb on a unix
//              socket only (no TCP), behind the runner's disposable-target guard;
//   schema     apps/api/tests/pg/supabase-shim.sql (anon / authenticated / service_role /
//              authenticator), the lc_mcp_reader emulation, a WIDENING generated at runtime
//              from the columns the real services select (captured over the fake PostgREST,
//              so it cannot drift from the code), then THE role migration under test;
//   PostgREST  the real binary, 127.0.0.1 only, connecting AS authenticator, with a random
//              per-run JWT secret. Tokens are minted HS256 with that secret, as the owner
//              mints the production token with the project's JWT secret.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startCluster } from '../../../../scripts/db/run-migration-test.mjs'
import { assertDisposableTarget, sanitizedPgEnv } from '../../../../scripts/db/db-target-guard.mjs'
import { buildApp } from '../../src/app.mjs'
import { createFakePostgrest, b64url } from './fake-postgrest.mjs'
import { liveEnv, LIVE_MEMBERSHIP } from './live-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const MIG = (f) => path.join(REPO, 'supabase/migrations', f)

export const COVERAGE_CALLS = Object.freeze([
  ['leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 5 }],
  ['leadcommand_get_lead', { property_id: 'P1' }],
  ['leadcommand_search_properties', { zip: '75001', limit: 5 }],
  ['leadcommand_search_properties', { address: '1 Fixture St', state: 'TX' }],
  ['leadcommand_get_property', { property_id: 'P1' }],
  ['leadcommand_get_acquisition_score', { property_id: 'P1' }],
  ['leadcommand_get_market_intelligence', { property_id: 'P1' }],
  ['leadcommand_search_comps', { property_id: 'P1' }],
  ['leadcommand_get_campaign_metrics', { limit: 5 }],
  ['leadcommand_get_campaign_metrics', { campaign_id: '00000000-0000-4000-8000-0000000000c1' }],
  ['leadcommand_get_lead_contact_status', { property_id: 'P1' }],
  // rc-8.5.21 operations reads (the emulation seeds org a1, threads …101-103)
  ['leadcommand_get_ops_supervisor_status', {}],
  ['leadcommand_search_action_center', { limit: 5 }],
  ['leadcommand_search_action_center', { lost_only: false, limit: 1 }],
  ['leadcommand_get_thread_hold_status', { thread_id: '00000000-0000-4000-8000-000000000101' }],
  ['leadcommand_get_thread_hold_status', { thread_id: '00000000-0000-4000-8000-000000000102' }],
  ['leadcommand_get_thread_hold_status', { thread_id: '00000000-0000-4000-8000-000000000103' }],
  ['leadcommand_get_followup_intent_health', {}],
])

/** The columns the real services select / filter / order on, per relation (run over the fake PostgREST). */
export async function captureColumns() {
  const pg = createFakePostgrest({ membership: LIVE_MEMBERSHIP })
  const cols = {}
  const f = async (input, init) => {
    const u = new URL(String(input))
    const m = /^\/rest\/v1\/([a-z_0-9]+)$/.exec(u.pathname)
    if (m) {
      const s = (cols[m[1]] ||= new Set())
      for (const c of String(u.searchParams.get('select') || '').split(',')) if (c.trim() && c.trim() !== '*') s.add(c.trim())
      for (const [k, v] of u.searchParams) {
        if (['select', 'limit', 'offset'].includes(k)) continue
        if (k === 'order') { for (const p of v.split(',')) s.add(p.split('.')[0]); continue }
        if (k === 'or') { for (const x of v.replace(/^\(|\)$/g, '').matchAll(/([a-z_0-9]+)\.(eq|cs|ilike|in)\./g)) s.add(x[1]); continue }
        s.add(k)
      }
    }
    return pg.fetch(input, init)
  }
  const app = await buildApp({ env: liveEnv(), baseFetch: f, scrub: false, auditSink: () => {} })
  try { for (const [n, a] of COVERAGE_CALLS) await app.gateway.call(n, a) } finally { await app.close() }
  return Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, [...v].sort()]))
}

const BOOL = /^(is_|has_)|(^|_)(wrong_number|active_lien|tax_delinquent|sms_eligible|queue_eligible|never_contacted|likely_owner|likely_renting|listed_mls|exclude_targeting|reachable_living_dm|only_deceased_reachable|auto_send_enabled|true_post_contact_suppression|pending_prior_touch|active_queue_item|requires_review|is_suppressed|out_of_state_owner|is_corporate_owner)$/
const TIME = /(_at|_date|^sold_on|^latest_sale|^last_sale_on|^sale_date|^date_of_death)$/
const JSONB = /(_json$|^metadata$|^evidence$|^signal_labels$)/
const NUM = /(_count|_score|_pct|_percent|_value|_amount|_amt|_balance|_cap|_pts|_year|_years|_income|_rate|_id_num)$|^(price|lat|lng|latitude|longitude|beds|baths|sqft|units|units_count|year_built|ppsf|per_door|confidence|comp_count|build_id|source_year|building_square_feet|lot_square_feet|total_bedrooms|total_baths|sort_rank|rank_position|touch_count|recommended_cash_offer|estimated_repairs|estimated_value|estimated_repair_cost|aos_score|acquisition_score|opportunity_score|score|net_asset_value|buying_power|decedent_confidence|acquisition_confidence|daily_cap|total_cap|median_[a-z_]+|valuation_[a-z]+|investor_ceiling_[a-z]+|transaction_probability_[0-9]+|sale_count|investor_count|buyer_known_count|cash_known_count|cash_count|mf_sale_count|equity_amount|total_loan_balance|equity_percent|priority_score|urgency_score|est_household_income|equity_known_pct|tax_amt|campaign_count|distress_signal_count|scores_aos_score)$/
const typeOf = (c) => (c === 'zips' ? 'text[]' : BOOL.test(c) ? 'boolean' : TIME.test(c) ? 'timestamptz' : JSONB.test(c) ? 'jsonb' : NUM.test(c) ? 'numeric' : 'text')

/** Widening SQL for the emulation: every captured column, typed; views / matviews rebuilt; richer seeds. */
export function wideningSql(cols) {
  const out = ['-- GENERATED (test/support/local-stack.mjs): disposable e2e widening of the lc_mcp_reader emulation']
  const base = { probate_status: 'probate_case', preforeclosure_status_v2: 'preforeclosure_case' }
  out.push('drop view if exists public.probate_status; drop view if exists public.preforeclosure_status_v2;')
  out.push('drop materialized view if exists public.mv_map_market_sales; drop materialized view if exists public.eg_buyer_index;')
  for (const [rel, list] of Object.entries(cols)) {
    if (['mv_map_market_sales', 'eg_buyer_index'].includes(rel)) continue
    const t = base[rel] || rel
    for (const c of list) out.push(`alter table public.${t} add column if not exists ${c} ${typeOf(c)};`)
  }
  out.push('create view public.probate_status as select * from public.probate_case;')
  out.push('create view public.preforeclosure_status_v2 as select * from public.preforeclosure_case;')
  const mv = (cols.mv_map_market_sales || []).filter((c) => !['comp_id', 'property_id', 'sold_on', 'price', 'lat', 'lng'].includes(c))
  out.push(`create materialized view public.mv_map_market_sales as select 'C1'::text as comp_id, 'P2'::text as property_id, (current_date - 30)::timestamptz as sold_on, 250000::numeric as price, 32.901::numeric as lat, -96.801::numeric as lng${mv.map((c) => `, null::${typeOf(c)} as ${c}`).join('')};`)
  out.push("create materialized view public.eg_buyer_index as select 'B1'::text as buyer_id, array['75001']::text[] as zips, 'active'::text as activity_status;")
  out.push("update public.mi_geo_period_rollup set geo_level = 'zip', asset = 'all', median_price = 240000, investor_count = 4, buyer_known_count = 10, cash_known_count = 10, cash_count = 3, latest_sale = now() - interval '20 days';")
  out.push("update public.eg_property_facts set property_address_state = 'TX', property_address_city = 'Fixture', refreshed_at = now(), units_count = 1, asset_type = 'sfr';")
  out.push("update public.properties set property_address_city = 'Fixture', property_address_state = 'TX', property_type = 'Single Family', building_square_feet = 1500;")
  out.push("update public.campaigns set updated_at = now(), created_at = now(), progress_synced_at = now();")
  out.push("update public.property_acquisition_scores set evidence = '{}'::jsonb, decision_tier = 'A', created_at = now();")
  return out.join('\n')
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** HS256 JWT signed with the stack's secret (real signature). */
export function mintHs256(secret, payload) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' })
  const body = b64url(payload)
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/**
 * @param {{ pgBin: string, postgrestBin: string, psql?: string, log?: Function }} o
 * @returns {Promise<{ url, secret, mint, sql, stop }>}
 */
export async function startLocalStack({ pgBin, postgrestBin, psql = process.env.LC_PSQL || 'psql', log = () => {} }) {
  const columns = await captureColumns()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lcmcp-stack-'))
  const widen = path.join(work, 'widening.sql')
  fs.writeFileSync(widen, wideningSql(columns))
  const cluster = startCluster({ bin: pgBin, log })
  let pgrst = null
  let gateway = null
  const stop = async () => {
    if (gateway) await new Promise((r) => gateway.close(r))
    if (pgrst) { pgrst.kill('SIGTERM'); await new Promise((r) => pgrst.once('exit', r)) }
    cluster.stop()
    fs.rmSync(work, { recursive: true, force: true })
  }
  try {
    assertDisposableTarget(cluster.url)
    const run = (url, args) => {
      assertDisposableTarget(url)
      const r = spawnSync(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, ...args], { encoding: 'utf8', env: sanitizedPgEnv(process.env) })
      if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).slice(-800)}`)
      return r.stdout
    }
    const roles = run(cluster.url, ['-At', '-c', "select coalesce(string_agg(rolname, ','), '') from pg_roles where rolname in ('supabase_admin','supabase_auth_admin','supabase_storage_admin','pgbouncer')"]).trim()
    if (roles) throw new Error(`refused: the server carries Supabase platform roles (${roles})`)
    run(cluster.url, ['-c', 'create database lc_mcp_e2e'])
    const dbUrl = cluster.url.replace('/postgres?', '/lc_mcp_e2e?')
    for (const f of [path.join(REPO, 'apps/api/tests/pg/supabase-shim.sql'), path.join(REPO, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_supabase_emulation.sql'), widen, MIG('PROPOSED_20261019150000_lc_mcp_reader.sql')]) {
      run(dbUrl, ['--single-transaction', '-f', f])
      log(`applied ${path.basename(f)}`)
    }
    const secret = crypto.randomBytes(32).toString('base64url')
    const port = await freePort()
    const sock = decodeURIComponent(/[?&]host=([^&]+)/.exec(cluster.url)[1]) // a host-less libpq URL: not a WHATWG URL
    pgrst = spawn(postgrestBin, [], {
      env: {
        PATH: process.env.PATH,
        PGRST_DB_URI: `postgresql://authenticator@/lc_mcp_e2e?host=${encodeURIComponent(sock)}&port=5432`,
        PGRST_DB_SCHEMAS: 'public,graphql_public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_JWT_SECRET: secret,
        PGRST_SERVER_HOST: '127.0.0.1',
        PGRST_SERVER_PORT: String(port),
        PGRST_DB_POOL: '4',
        PGRST_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errOut = ''
    pgrst.stderr.on('data', (d) => { errOut = (errOut + d).slice(-2000) })
    const upstream = `http://127.0.0.1:${port}`
    for (let i = 0; ; i++) {
      try { const r = await fetch(`${upstream}/`); if (r.status < 500) break } catch { /* not up yet */ }
      if (i > 100) throw new Error(`PostgREST did not start: ${errOut}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    // the Supabase API gateway, minimally: /rest/v1/* → PostgREST /*, and no apikey → 401 (as Kong answers)
    gateway = http.createServer(async (req, res) => {
      try {
        if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404).end(); return }
        if (!req.headers.apikey) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'No API key found in request' })); return }
        const chunks = []
        for await (const c of req) chunks.push(c)
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'apikey'].includes(k)))
        const r = await fetch(`${upstream}${req.url.slice('/rest/v1'.length)}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
        const out = Buffer.from(await r.arrayBuffer())
        res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k))))
        res.end(out)
      } catch (e) {
        res.writeHead(502).end(String(e?.message || e))
      }
    })
    const gwPort = await new Promise((resolve) => gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port)))
    const url = `http://127.0.0.1:${gwPort}`
    log(`PostgREST on ${upstream}, gateway on ${url}`)
    return {
      url,
      secret,
      columns,
      mint: (payload) => mintHs256(secret, payload),
      sql: (text) => run(dbUrl, ['-At', '-c', text]).trim(),
      stop,
    }
  } catch (e) {
    await stop()
    throw e
  }
}
