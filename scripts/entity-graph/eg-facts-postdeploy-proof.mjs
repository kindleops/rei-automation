#!/usr/bin/env node
/**
 * RC 8.5.5 · Entity Graph sort + header filters — POST-DEPLOY PROOF (read-only).
 *
 * Proves, on the COMPLETE property universe, with latency:
 *   S1  sort by SMS eligible ascending      (sort_by=sms_sort, ascending=1)
 *   S2  sort by SMS eligible descending     (sort_by=sms_sort, ascending=0)
 *   S3  page 2 of S2 continues page 1 exactly (keyset nextAfter; no repeats)
 *   H1  header filter: Company status = dissolved, sorted by SMS eligible ↓
 *   H2  header filter: SMS eligible = Yes, sorted by last contact ↓
 *   HV  header values for SMS eligibility: value counts sum to the universe
 * Each check: HTTP 200, pagination.sort.mode === 'facts_table', total === the
 * SQL count of the same predicate on eg_property_facts, and latency (cold + warm)
 * ≤ --budget-ms (default 1500).
 *
 * SQL half (when LC_RO_ENTITY_GRAPH_DB_URL_FILE is set — the role-enforced read-only diagnostics
 * credential, scripts/lib/prod-db-credentials.mjs): the exact tablePage() statements,
 * READ ONLY, statement_timeout 15 s, serial; EXPLAIN must use the (col, property_id)
 * index with no Sort node.
 * API half (when --operator=<allowlisted email> is given): mints an operator
 * session with a one-time magic link via the Supabase admin API (no password
 * read or changed, no email sent — same method as
 * apps/dashboard/scripts/proof/mobile/production-auth-proof.mjs), then calls
 * https://ops.leadcommand.ai/api/cockpit/entity-graph/{browse,header-values}.
 * Env (Supabase URL / anon / service key) is READ from --env-dir (default: the
 * main checkout's apps/api/.env.local + apps/dashboard/.env.local). Nothing is printed
 * but counts, modes, timings and PASS/FAIL — no names, phones, addresses or secrets.
 *
 *   cd apps/api && node ../../scripts/entity-graph/eg-facts-postdeploy-proof.mjs [--operator=<email>] [--base=https://ops.leadcommand.ai]
 * Exit 0 = every check PASS.
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (k, d) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d
const BASE = opt('base', 'https://ops.leadcommand.ai')
const OPERATOR = opt('operator', '')
const BUDGET = Number(opt('budget-ms', 1500))
const ENV_DIR = opt('env-dir', '/Users/ryankindle/rei-automation/apps')

const results = []
const record = (label, ok, detail = {}) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${JSON.stringify(detail)}`)
}

/* ── SQL half ─────────────────────────────────────────────────────────────── */
const CASES = [
  { id: 'S1', label: 'universe · SMS eligible ↑', col: 'sms_sort', asc: true, where: '', ff: null },
  { id: 'S2', label: 'universe · SMS eligible ↓', col: 'sms_sort', asc: false, where: '', ff: null },
  { id: 'H1', label: 'company status = dissolved · SMS eligible ↓', col: 'sms_sort', asc: false, where: `"company_status_class" = any(array['dissolved'])`, ff: [{ field_key: 'facts.company_status_class', operator: 'is_any_of', value: ['dissolved'] }] },
  { id: 'H2', label: 'SMS eligible = yes · last contact ↓', col: 'last_contact_at', asc: false, where: `"sms_eligible" is true`, ff: [{ field_key: 'facts.sms_eligible', operator: 'is_true' }] },
]
const sqlTotals = {}
let universe = null
if (process.env.LC_RO_ENTITY_GRAPH_DB_URL_FILE) {
  const { connectReadOnlyDiagnostics } = await import('../lib/prod-db-credentials.mjs')
  const c = await connectReadOnlyDiagnostics({ purpose: 'entity_graph', applicationName: 'eg_facts_proof', statementTimeoutMs: 15_000 })
  try {
    const present = (await c.query(`select to_regclass('public.eg_property_facts') is not null as t`)).rows[0].t
    if (!present) {
      record('SQL · eg_property_facts exists', false, { reason: 'not applied' })
    } else {
      const ok = (await c.query(`select finished_at, rows from public.eg_refresh_log where name = 'eg_property_facts' and status = 'ok' order by finished_at desc limit 1`)).rows[0]
      const u = (await c.query(`select (select count(*)::int from public.eg_property_facts) as facts, (select count(*)::int from public.v_entity_graph_properties) as universe`)).rows[0]
      universe = u.universe
      record('SQL · facts rows == property universe, ok refresh logged', Boolean(ok) && u.facts === u.universe, { facts: u.facts, universe: u.universe, asOf: ok?.finished_at ?? null })
      for (const k of CASES) {
        const w = k.where ? `where ${k.where}` : ''
        const and = k.where ? `${k.where} and` : ''
        const dir = k.asc ? 'asc' : 'desc'
        const page = `select "property_id" from public.eg_property_facts where ${and} "${k.col}" is not null order by "${k.col}" ${dir}, "property_id" ${dir} limit 26`
        let t = Date.now()
        await c.query(page)
        const pageMs = Date.now() - t
        t = Date.now()
        const n = Number((await c.query(`select count(*)::bigint as n from public.eg_property_facts ${w}`)).rows[0].n)
        const countMs = Date.now() - t
        sqlTotals[k.id] = n
        const plan = (await c.query(`explain (costs off) ${page}`)).rows.map((r) => r['QUERY PLAN']).join(' | ')
        const indexed = /Index (Only )?Scan( Backward)? using egpf_/.test(plan) && !/\bSort\b/.test(plan.replace(/Sort Key/g, ''))
        record(`SQL · ${k.id} ${k.label}`, indexed && pageMs + countMs <= BUDGET, { total: n, pageMs, countMs, indexed })
      }
    }
  } finally {
    await c.end().catch(() => {})
  }
} else {
  console.log('SKIP  SQL half (LC_RO_ENTITY_GRAPH_DB_URL_FILE not set)')
}

/* ── API half ─────────────────────────────────────────────────────────────── */
if (OPERATOR) {
  const env = [path.join(ENV_DIR, 'dashboard/.env.local'), path.join(ENV_DIR, 'api/.env.local')].map((f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }).join('\n')
  const pick = (k) => (new RegExp(`^${k}=(.+)$`, 'm').exec(env)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
  const SUPABASE_URL = pick('VITE_SUPABASE_URL') || pick('SUPABASE_URL')
  const ANON = pick('VITE_SUPABASE_ANON_KEY') || pick('SUPABASE_ANON_KEY')
  const SERVICE = pick('SUPABASE_SERVICE_ROLE_KEY') || pick('VITE_SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !ANON || !SERVICE) throw new Error('supabase url / anon / service key not found in --env-dir')
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: OPERATOR }),
  })
  if (!gen.ok) throw new Error(`generate_link ${gen.status}`)
  const { hashed_token } = await gen.json()
  const ver = await fetch(`${SUPABASE_URL}/auth/v1/verify?token=${hashed_token}&type=magiclink`, { headers: { apikey: ANON }, redirect: 'manual' })
  const loc = ver.headers.get('location') || ''
  const token = loc.includes('#') ? new URLSearchParams(loc.split('#')[1]).get('access_token') : null
  if (!token) throw new Error(`no access_token (status ${ver.status})`)

  const call = async (route, params) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
    const t = Date.now()
    const res = await fetch(`${BASE}/api/cockpit/entity-graph/${route}?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
    const ms = Date.now() - t
    const body = await res.json().catch(() => ({}))
    return { status: res.status, ms, body }
  }
  const browse = (k, extra = {}) => call('browse', { tab: 'properties', page_size: 25, cursor: 0, sort_by: k.col, ascending: k.asc ? '1' : '0', ...(k.ff ? { field_filters: JSON.stringify(k.ff) } : {}), ...extra })

  for (const k of CASES) {
    const cold = await browse(k)
    const warm = await browse(k)
    const p = cold.body?.pagination || {}
    const total = p.total ?? null
    const expect = sqlTotals[k.id] ?? (k.id.startsWith('S') ? universe : null)
    const ok = cold.status === 200 && warm.status === 200 && p.sort?.mode === 'facts_table' && (cold.body.results || []).length > 0
      && (expect === null || total === expect) && cold.ms <= BUDGET && warm.ms <= BUDGET
    record(`API · ${k.id} ${k.label}`, ok, { status: cold.status, mode: p.sort?.mode ?? null, total, expect, rows: (cold.body.results || []).length, coldMs: cold.ms, warmMs: warm.ms, asOf: p.sort?.asOf ?? null })
    if (k.id === 'S2' && p.nextAfter) {
      const page2 = await browse(k, { cursor: 25, after: p.nextAfter })
      const ids1 = new Set((cold.body.results || []).map((r) => String(r.entityId ?? r.id ?? r.property_id)))
      const ids2 = (page2.body.results || []).map((r) => String(r.entityId ?? r.id ?? r.property_id))
      record('API · S3 page 2 continues page 1 (no repeats)', page2.status === 200 && ids2.length > 0 && ids2.every((id) => !ids1.has(id)) && page2.ms <= BUDGET, { status: page2.status, rows: ids2.length, ms: page2.ms })
    }
  }
  const hv = await call('header-values', { tab: 'properties', column: 'sms_status' })
  const sum = (hv.body?.values || []).reduce((s, v) => s + Number(v.count || 0), 0)
  record('API · HV SMS eligibility header values sum to the universe', hv.status === 200 && hv.body?.mode === 'table' && (universe === null || hv.body.total === universe) && (hv.body?.truncated || sum === hv.body?.total) && hv.ms <= BUDGET, { status: hv.status, mode: hv.body?.mode ?? null, total: hv.body?.total ?? null, sum, universe, ms: hv.ms, truncated: hv.body?.truncated ?? null })
} else {
  console.log('SKIP  API half (pass --operator=<allowlisted email> to run it)')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
