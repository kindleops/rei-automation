#!/usr/bin/env node
// LIVE ACCEPTANCE: LeadCommand MCP 1.0 on the role-enforced read-only credential.
//
// THE OWNER RUNS THIS, after approving and applying
// supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql and minting the token
// (docs/LEADCOMMAND-MCP-1.0.md §4.2). It is never run by automation against production.
//
//   LEADCOMMAND_MCP_SUPABASE_URL=https://<ref>.supabase.co \
//   LEADCOMMAND_MCP_READER_JWT_FILE=~/.leadcommand/lc_mcp_reader.jwt \
//   LEADCOMMAND_MCP_API_KEY_FILE=~/.leadcommand/anon.key \
//   LEADCOMMAND_MCP_PRINCIPAL_USER_ID=<owner uuid> LEADCOMMAND_MCP_ORG_ID=<org uuid> \
//   node scripts/live-acceptance.mjs --zip 55401          (or --market "Minneapolis, MN")
//
// What it does, in order. It stops at the first failed stage and exits 1. Exit 0 = PASS.
//   0. PREFLIGHT (local, no network): the launch env holds no writable app credential.
//      The token's role claim is lc_mcp_reader (a service-role token is refused). The
//      public key is anon / publishable.
//   1. DATABASE REFUSES WRITES. Raw PostgREST requests with the reader token BYPASS the
//      MCP and its client-side guard, so only the DATABASE can refuse them:
//        INSERT  POST   /<t>?columns=<pk>  body []        (zero rows even if it were permitted)
//        UPDATE  PATCH  /<t>?<pk>=is.null  body {<pk>:null} (a primary key is never null: zero rows)
//        DELETE  DELETE /<t>?<pk>=is.null                  (zero rows)
//      on send_queue, sms_templates, system_control, properties and campaigns. Each must
//      fail with SQLSTATE 42501 (401/403). It also checks: SELECT on send_queue (outside
//      the inventory) → 42501; SELECT on automation_holds and followup_intents (read ONLY
//      through the definer projections) → 42501; schema agent → refused (42501, or PGRST106 when the schema
//      is not exposed); and the database's own privilege report for the role
//      (lc_mcp_reader_self_check, read AS the role) → ok, running_as lc_mcp_reader, no
//      reachable write / egress function, no BYPASSRLS. TRUNCATE has no PostgREST
//      surface; the role holds no TRUNCATE grant (migration test).
//   2. EVERY CAPABILITY, live. The real server (bin/leadcommand-mcp.mjs) starts as a
//      subprocess over loopback Streamable HTTP, with a CLEAN environment (only
//      LEADCOMMAND_MCP_*), a fresh bearer token and an audit file. An SDK client connects
//      the way Agntau does (Authorization: Bearer) and calls every granted tool with bounded
//      reads: anchors from --zip / --market, limit ≤ 5, radius 0.5 mi, ≤ MAX_CALLS calls.
//      The four operations tools (supervisor status, action center, thread hold status,
//      follow-up health) run when their opt-in scope is granted (the acceptance grants
//      every scope unless LEADCOMMAND_MCP_SCOPES narrows it; a narrowed run reports the
//      skipped tools by name). The hold status uses a thread id from the action center
//      page; with no conversation there it probes a nil id and expects not_found.
//      Every result must: validate against the tool's outputSchema (the SDK Client checks
//      it); be data_mode=live with no fixture notice; carry provenance (kind ∈ fact |
//      derived | inferred | stale | missing); and contain no phone or email shape.
//   3. AUDIT. The audit file has one credential_self_check (boot, ok, running_as
//      lc_mcp_reader) and one tool_call per call, all ok. No credential appears in it.
// Output: a JSON summary with ids, counts, latencies and provenance kinds. It never
// contains a name, phone, address, message text or credential.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readCredentialFile, assertReaderJwt, assertPublicApiKey, ambientCredentialNames, RETIRED_LIVE_ENV } from '../src/data/credential.mjs'
import { RELATION_NAMES, RPC_SIGNATURES } from '../src/data/inventory.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
export const MAX_CALLS = 24
/** Every tool of the catalog, with its scope (the script runs without the @/ loader, so it cannot import the catalog). */
export const TOOL_SCOPES = Object.freeze({
  leadcommand_search_leads: 'leadcommand.leads.read', leadcommand_get_lead: 'leadcommand.leads.read',
  leadcommand_search_properties: 'leadcommand.properties.read', leadcommand_get_property: 'leadcommand.properties.read',
  leadcommand_get_acquisition_score: 'leadcommand.scores.read', leadcommand_get_market_intelligence: 'leadcommand.market.read',
  leadcommand_search_comps: 'leadcommand.comps.read', leadcommand_get_campaign_metrics: 'leadcommand.campaigns.read',
  leadcommand_get_lead_contact_status: 'leadcommand.contact_status.read',
  leadcommand_get_ops_supervisor_status: 'leadcommand.ops_supervisor.read', leadcommand_search_action_center: 'leadcommand.action_center.read',
  leadcommand_get_thread_hold_status: 'leadcommand.holds.read', leadcommand_get_followup_intent_health: 'leadcommand.followups.read',
  // 1.1 conversation intelligence (opt-in; SOURCE_NOT_APPLIED is an accepted answer until its migration is applied)
  leadcommand_get_lead_conversation: 'leadcommand.conversations.read', leadcommand_search_conversation_worklist: 'leadcommand.conversations.read',
  leadcommand_get_opportunity_ranking: 'leadcommand.conversations.read', leadcommand_get_pipeline_summary: 'leadcommand.pipeline.read',
})
export const ACCEPTANCE_SCOPES = [...new Set(Object.values(TOOL_SCOPES))].join(' ')
const PROVENANCE_KINDS = new Set(['fact', 'derived', 'inferred', 'stale', 'missing'])
const PHONE = /(?<![0-9A-Za-z])\+?1?[-. (]*[2-9][0-9]{2}[-. )]*[0-9]{3}[-. ]*[0-9]{4}(?![0-9])/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

function arg(argv, name, dflt = null) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : dflt
}

class StageFailed extends Error {}
const fail = (stage, msg) => { throw new StageFailed(`${stage}: ${msg}`) }

/** Stage 0: local checks only. */
export function preflight(env) {
  for (const k of RETIRED_LIVE_ENV) if (env[k]) fail('preflight', `${k} is set; live mode no longer accepts it`)
  const ambient = ambientCredentialNames(env)
  if (ambient.length) fail('preflight', `writable app credentials are in this shell's environment (${ambient.join(', ')}); run from a clean environment (env -i …)`)
  const url = String(env.LEADCOMMAND_MCP_SUPABASE_URL || '').replace(/\/$/, '')
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(url)) fail('preflight', 'LEADCOMMAND_MCP_SUPABASE_URL must be https (or a loopback http PostgREST)')
  const reader = readCredentialFile(env.LEADCOMMAND_MCP_READER_JWT_FILE, 'LEADCOMMAND_MCP_READER_JWT_FILE')
  const token = assertReaderJwt(reader)
  const apiKey = readCredentialFile(env.LEADCOMMAND_MCP_API_KEY_FILE, 'LEADCOMMAND_MCP_API_KEY_FILE')
  const key = assertPublicApiKey(apiKey)
  for (const k of ['LEADCOMMAND_MCP_PRINCIPAL_USER_ID', 'LEADCOMMAND_MCP_ORG_ID']) if (!/^[0-9a-f-]{36}$/i.test(String(env[k] || ''))) fail('preflight', `${k} must be a UUID`)
  return { url, reader, apiKey, token, key }
}

const PROBE_TABLES = Object.freeze([['send_queue', 'id'], ['sms_templates', 'id'], ['system_control', 'key'], ['properties', 'property_id'], ['campaigns', 'id']])

/** Stage 1: the DATABASE refuses writes from this token (raw PostgREST, no MCP in the path). */
export async function databaseRefusesWrites({ url, reader, apiKey, fetchImpl = globalThis.fetch }) {
  const h = (extra = {}) => ({ apikey: apiKey, authorization: `Bearer ${reader}`, 'content-type': 'application/json', prefer: 'return=minimal', ...extra })
  const body = async (r) => { try { return await r.json() } catch { return {} } }
  const out = []
  const expect42501 = async (label, req) => {
    const r = await req()
    const b = await body(r)
    const ok = (r.status === 401 || r.status === 403) && b?.code === '42501'
    out.push({ probe: label, status: r.status, code: b?.code ?? null, refused_by_database: ok })
    if (!ok) fail('database', `${label} was NOT refused by the database (HTTP ${r.status}, code ${b?.code ?? 'none'})`)
  }
  for (const [t, pk] of PROBE_TABLES) {
    await expect42501(`INSERT ${t}`, () => fetchImpl(`${url}/rest/v1/${t}?columns=${pk}`, { method: 'POST', headers: h(), body: '[]' }))
    await expect42501(`UPDATE ${t}`, () => fetchImpl(`${url}/rest/v1/${t}?${pk}=is.null`, { method: 'PATCH', headers: h(), body: JSON.stringify({ [pk]: null }) }))
    await expect42501(`DELETE ${t}`, () => fetchImpl(`${url}/rest/v1/${t}?${pk}=is.null`, { method: 'DELETE', headers: h() }))
  }
  await expect42501('SELECT send_queue (outside the inventory)', () => fetchImpl(`${url}/rest/v1/send_queue?select=id&limit=1`, { headers: h({ prefer: 'count=none' }) }))
  // the operations sources are reachable ONLY through the lc_mcp_* definer projections
  await expect42501('SELECT automation_holds (definer projection only)', () => fetchImpl(`${url}/rest/v1/automation_holds?select=id&limit=1`, { headers: h({ prefer: 'count=none' }) }))
  await expect42501('SELECT followup_intents (definer projection only)', () => fetchImpl(`${url}/rest/v1/followup_intents?select=id&limit=1`, { headers: h({ prefer: 'count=none' }) }))
  {
    const r = await fetchImpl(`${url}/rest/v1/operator_membership?columns=user_id`, { method: 'POST', headers: h({ 'content-profile': 'agent' }), body: '[]' })
    const b = await body(r)
    const ok = ((r.status === 401 || r.status === 403) && b?.code === '42501') || (r.status === 406 && b?.code === 'PGRST106')
    out.push({ probe: 'INSERT agent.operator_membership', status: r.status, code: b?.code ?? null, refused_by_database: b?.code === '42501', refused: ok })
    if (!ok) fail('database', `agent.operator_membership insert was not refused (HTTP ${r.status}, code ${b?.code ?? 'none'})`)
  }
  const r = await fetchImpl(`${url}/rest/v1/rpc/lc_mcp_reader_self_check`, { method: 'POST', headers: h({ prefer: 'count=none' }), body: JSON.stringify({ p_relations: RELATION_NAMES, p_functions: RPC_SIGNATURES }) })
  const rep = await body(r)
  if (r.status !== 200) fail('database', `the privilege report could not be read as the role (HTTP ${r.status}, code ${rep?.code ?? 'none'})`)
  if (rep.current_user !== 'lc_mcp_reader') fail('database', `requests run as ${rep.current_user}, not lc_mcp_reader`)
  if (rep.ok !== true) fail('database', `the database reports findings for the role: ${JSON.stringify(rep.findings).slice(0, 400)}`)
  return {
    probes: out,
    privilege_report: {
      running_as: rep.current_user, session_user: rep.session_user, ok: rep.ok, findings: rep.findings,
      bypassrls: rep.attributes?.bypassrls, write_privileges: rep.write_privileges?.length, reachable_definer_functions: rep.reachable_definer_functions?.length,
      reachable_egress_functions: rep.reachable_egress_functions?.length, select_outside_inventory: rep.select_outside_inventory?.length,
    },
  }
}

/** Walk a result: collect provenance kinds; refuse phone / email shapes anywhere in the text. */
function inspect(name, structured, text) {
  if (structured?.data_mode !== 'live') fail('capability', `${name}: data_mode is ${structured?.data_mode}`)
  if (structured?.fixture_notice) fail('capability', `${name}: a fixture notice on a live result`)
  if (!/^[0-9a-f-]{36}$/.test(String(structured?.correlation_id || ''))) fail('capability', `${name}: no correlation id`)
  if (structured?.trust?.content !== 'data_only') fail('capability', `${name}: no trust envelope`)
  const kinds = new Set()
  const walk = (v) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach(walk)
    if (v.provenance && typeof v.provenance === 'object' && 'kind' in v.provenance) {
      if (!PROVENANCE_KINDS.has(v.provenance.kind)) fail('capability', `${name}: provenance kind ${v.provenance.kind}`)
      kinds.add(v.provenance.kind)
    }
    Object.values(v).forEach(walk)
  }
  walk(structured.result)
  if (!kinds.size) fail('capability', `${name}: no provenance anywhere in the result`)
  const scrubbed = text.replace(/"(property_id|lead_id|comp_id|campaign_id|correlation_id|build_id|[a-z_]*_at|generated_at|as_of|sold_on|sold_on_or_after|last_sale_on|job_id)":"[^"]*"/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '') // record ids (conversation / thread / opportunity uuids)
    .replace(/"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)?"/g, '""')
  if (PHONE.test(scrubbed)) fail('capability', `${name}: a phone-shaped value in the result`)
  if (EMAIL.test(scrubbed)) fail('capability', `${name}: an email-shaped value in the result`)
  return [...kinds].sort()
}

/** Start the real server (clean env) on a loopback port; resolves with { url, token, audit, stop }. */
async function startServer(env, work) {
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenFile = path.join(work, 'http-token')
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  const audit = path.join(work, 'audit.jsonl')
  const port = 20000 + crypto.randomInt(20000)
  const clean = {
    PATH: process.env.PATH, HOME: work,
    LEADCOMMAND_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_MCP_HTTP_PORT: String(port), LEADCOMMAND_MCP_HTTP_TOKEN_FILE: tokenFile,
    LEADCOMMAND_MCP_AUDIT_FILE: audit, LEADCOMMAND_MCP_DATA: 'live',
    ...Object.fromEntries(Object.entries(env).filter(([k]) => /^LEADCOMMAND_MCP_(SUPABASE_URL|READER_JWT_FILE|API_KEY_FILE|PRINCIPAL_USER_ID|ORG_ID|DATA_ORG_ID|SCOPES)$/.test(k))),
  }
  if (!clean.LEADCOMMAND_MCP_SCOPES) clean.LEADCOMMAND_MCP_SCOPES = ACCEPTANCE_SCOPES
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(PKG, 'bin/leadcommand-mcp.mjs')], { cwd: PKG, env: clean, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(audit) && fs.readFileSync(audit, 'utf8').includes('"http_listen"')) break
    const done = await Promise.race([exited.then((c) => ({ c })), new Promise((r) => setTimeout(() => r(null), 100))])
    if (done) fail('server', `the server exited (${done.c}) during boot: ${(stderr.match(/"message":"([^"]{0,300})/) || [])[1] || stderr.slice(-300)}`)
  }
  return { url: `http://127.0.0.1:${port}/mcp`, token, audit, scopes: clean.LEADCOMMAND_MCP_SCOPES.split(/[\s,]+/).filter(Boolean), stop: async () => { child.kill('SIGTERM'); await exited } }
}

/** Stage 2: every granted tool (all 17 by default), bounded, through the real server over Streamable HTTP. */
export async function everyCapability(env, { zip = null, market = null, work }) {
  if (!zip && !market) fail('capability', 'give an anchor: --zip <5 digits> or --market "<label>"')
  const srv = await startServer(env, work)
  const client = new Client({ name: 'leadcommand-live-acceptance', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${srv.token}` } } })
  const results = []
  let calls = 0
  const call = async (name, args, { expectError = null } = {}) => {
    if (++calls > MAX_CALLS) fail('capability', `call budget (${MAX_CALLS}) exceeded`)
    const t0 = Date.now()
    const r = await client.callTool({ name, arguments: args })
    const text = JSON.stringify(r.structuredContent ?? null)
    if (r.isError && expectError && r.structuredContent?.error?.code === expectError) {
      results.push({ tool: name, ms: Date.now() - t0, rows: null, provenance: [], bytes: Buffer.byteLength(text), expected_error: expectError })
      return null
    }
    if (r.isError) fail('capability', `${name} failed: ${r.structuredContent?.error?.class}/${r.structuredContent?.error?.code}`)
    const kinds = inspect(name, r.structuredContent, text)
    const rows = Array.isArray(r.structuredContent?.result?.rows) ? r.structuredContent.result.rows.length : null
    results.push({ tool: name, ms: Date.now() - t0, rows, provenance: kinds, bytes: Buffer.byteLength(text) })
    return r.structuredContent.result
  }
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const expected = Object.keys(TOOL_SCOPES).length
    if (tools.length !== expected || !tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)) fail('capability', `expected ${expected} read-only tools, got ${tools.length}`)
    const granted = (tool) => srv.scopes.includes(TOOL_SCOPES[tool])
    const anchor = zip ? { zip } : { market }
    const props = await call('leadcommand_search_properties', { ...anchor, limit: 3 })
    const pid = props.rows?.[0]?.property_id
    if (!pid) fail('capability', 'search_properties returned no row for the anchor; pick a --zip / --market with properties')
    await call('leadcommand_search_leads', { ...anchor, limit: 3 })
    await call('leadcommand_get_property', { property_id: pid })
    await call('leadcommand_get_lead', { property_id: pid })
    await call('leadcommand_get_acquisition_score', { property_id: pid })
    await call('leadcommand_get_market_intelligence', { property_id: pid })
    await call('leadcommand_search_comps', { property_id: pid, radius_miles: 0.5, months: 12, limit: 5 })
    const camps = await call('leadcommand_get_campaign_metrics', { limit: 3 })
    const cid = camps.campaigns?.[0]?.campaign_id
    if (cid) await call('leadcommand_get_campaign_metrics', { campaign_id: cid })
    if (granted('leadcommand_get_lead_contact_status')) await call('leadcommand_get_lead_contact_status', { property_id: pid })
    // rc-8.5.21 operations reads (opt-in scopes)
    if (granted('leadcommand_get_ops_supervisor_status')) await call('leadcommand_get_ops_supervisor_status', {})
    let threadId = null
    if (granted('leadcommand_search_action_center')) {
      const ac = await call('leadcommand_search_action_center', { lost_only: false, limit: 3 })
      threadId = ac?.rows?.[0]?.conversation_id || null
    }
    if (granted('leadcommand_get_thread_hold_status')) {
      if (threadId) await call('leadcommand_get_thread_hold_status', { thread_id: threadId })
      else await call('leadcommand_get_thread_hold_status', { thread_id: '00000000-0000-0000-0000-000000000000' }, { expectError: 'NOT_FOUND' })
    }
    if (granted('leadcommand_get_followup_intent_health')) await call('leadcommand_get_followup_intent_health', {})
    // 1.1 conversation intelligence: bounded reads; an unapplied migration answers SOURCE_NOT_APPLIED (recorded, not a failure)
    const NA = { expectError: 'SOURCE_NOT_APPLIED' }
    if (granted('leadcommand_get_lead_conversation')) await call('leadcommand_get_lead_conversation', { property_id: pid, window_days: 365, limit: 10 }, NA)
    if (granted('leadcommand_search_conversation_worklist')) await call('leadcommand_search_conversation_worklist', { category: 'unanswered_inbound', window_days: 30, limit: 3 }, NA)
    if (granted('leadcommand_get_opportunity_ranking')) await call('leadcommand_get_opportunity_ranking', { window_days: 14, max_threads: 25, top: 5 }, NA)
    if (granted('leadcommand_get_pipeline_summary')) await call('leadcommand_get_pipeline_summary', { dimension: 'market', limit: 10 }, NA)
    const covered = new Set(results.map((x) => x.tool))
    const want = Object.keys(TOOL_SCOPES).filter(granted)
    const skipped = Object.keys(TOOL_SCOPES).filter((t) => !granted(t))
    if (want.some((t) => !covered.has(t))) fail('capability', `granted tools that did not run: ${want.filter((t) => !covered.has(t)).join(', ')}`)
    return { property_id: pid, campaign_id: cid || null, calls, results, skipped_not_granted: skipped, audit: srv.audit, tokenForCheck: srv.token }
  } finally {
    await client.close().catch(() => {})
    await srv.stop()
  }
}

/** Stage 3: the audit file. */
export function auditMatches(file, { calls, secrets }) {
  const raw = fs.readFileSync(file, 'utf8')
  for (const s of secrets) if (s && raw.includes(s)) fail('audit', 'a credential appears in the audit file')
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
  const check = lines.find((l) => l.event === 'credential_self_check')
  if (!check || check.stage !== 'boot' || check.outcome !== 'ok' || check.running_as !== 'lc_mcp_reader') fail('audit', `boot self-check not audited as ok (${JSON.stringify(check)?.slice(0, 200)})`)
  const tc = lines.filter((l) => l.event === 'tool_call')
  if (tc.length !== calls) fail('audit', `${tc.length} tool_call records for ${calls} calls`)
  // expected refusals, audited as failed with their code: a nil-id hold probe (NOT_FOUND); a 1.1 conversation read
  // before its migration is applied (SOURCE_NOT_APPLIED)
  const expected = (l) => (l.tool === 'leadcommand_get_thread_hold_status' && l.error_code === 'NOT_FOUND')
    || (TOOL_SCOPES[l.tool] && /^leadcommand\.(conversations|pipeline)\.read$/.test(TOOL_SCOPES[l.tool]) && l.error_code === 'SOURCE_NOT_APPLIED')
  if (!tc.every((l) => (l.outcome === 'ok' || expected(l)) && l.data_mode === 'live' && /^#[0-9a-f]{12}$/.test(l.principal))) fail('audit', 'a tool_call record is not ok / live / hashed')
  return { self_check: { stage: check.stage, outcome: check.outcome, running_as: check.running_as, expires_at: check.expires_at }, tool_calls: tc.length }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const summary = { acceptance: 'leadcommand-mcp live (lc_mcp_reader)', started_at: new Date().toISOString(), stages: {} }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lcmcp-acceptance-'))
  try {
    const pf = preflight(env)
    summary.stages.preflight = { ok: true, role: pf.token.role, token_days_left: pf.token.days_left, api_key: pf.key.kind, data_service: new URL(pf.url).host }
    summary.stages.database = { ok: true, ...(await databaseRefusesWrites(pf)) }
    const cap = await everyCapability(env, { zip: arg(argv, '--zip'), market: arg(argv, '--market'), work })
    summary.stages.capability = { ok: true, property_id: cap.property_id, campaign_id: cap.campaign_id, calls: cap.calls, results: cap.results, skipped_not_granted: cap.skipped_not_granted }
    summary.stages.audit = { ok: true, ...auditMatches(cap.audit, { calls: cap.calls, secrets: [pf.reader, pf.apiKey, cap.tokenForCheck] }) }
    summary.result = 'PASS'
  } catch (e) {
    summary.result = 'FAIL'
    summary.error = e instanceof StageFailed ? e.message : `${e?.code || e?.name || 'error'}: ${String(e?.message || e).slice(0, 300)}`
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  return summary.result === 'PASS' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (e) => { process.stderr.write(`live-acceptance: ${e?.message || e}\n`); process.exitCode = 2 })
}
