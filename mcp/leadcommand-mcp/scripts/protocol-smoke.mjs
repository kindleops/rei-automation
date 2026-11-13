#!/usr/bin/env node
// Local protocol validation with a REAL MCP client: the official SDK Client
// launches bin/leadcommand-mcp.mjs as a subprocess over stdio, lists tools and
// calls them.
//
//   node scripts/protocol-smoke.mjs                 FIXTURE data (default)
//   node scripts/protocol-smoke.mjs --live          bounded live read (host env must
//        provide LEADCOMMAND_MCP_* incl. key / DB-URL FILE paths; this script never
//        reads or prints a credential itself)
//
// Output is a redacted summary: tool, outcome, error class, row counts,
// provenance kinds, latency, ≤ 5 identifiers. Never names, phones, addresses,
// message text or secrets. Live mode makes AT MOST 10 tool calls.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { residualContact } from '../../../apps/api/src/lib/agent/research/pii.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = process.argv.includes('--live')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null
const ONLY_ARGS = JSON.parse((process.argv.find((a) => a.startsWith('--args=')) || '--args={}').slice(7))
const MAX_LIVE_CALLS = 10

const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME || '' }
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LEADCOMMAND_MCP_')) childEnv[k] = v
if (!LIVE) Object.assign(childEnv, { LEADCOMMAND_MCP_DATA: 'fixture', LEADCOMMAND_MCP_PRINCIPAL_USER_ID: '00000000-0000-4000-8000-0000000000b1', LEADCOMMAND_MCP_ORG_ID: '00000000-0000-4000-8000-0000000000a1', LEADCOMMAND_MCP_SCOPES: 'leadcommand.leads.read leadcommand.properties.read leadcommand.scores.read leadcommand.market.read leadcommand.comps.read leadcommand.campaigns.read leadcommand.contact_status.read' })
if (LIVE && childEnv.LEADCOMMAND_MCP_DATA !== 'live') throw new Error('--live needs LEADCOMMAND_MCP_DATA=live in the host env')

const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'bin/leadcommand-mcp.mjs')], env: childEnv, cwd: ROOT, stderr: 'pipe' })
const auditLines = []
transport.stderr?.on('data', (b) => { for (const l of String(b).split('\n')) if (l.trim()) auditLines.push(l) })
const client = new Client({ name: 'leadcommand-protocol-smoke', version: '1.0.0' })
const t0 = Date.now()
await client.connect(transport)
const out = { mode: LIVE ? 'live' : 'fixture', server: client.getServerVersion(), protocol_ok: true, init_ms: Date.now() - t0, tools: [], calls: [] }
const { tools } = await client.listTools()
out.tools = tools.map((t) => `${t.name} [${t._meta?.['leadcommand/scope']}]`)

let calls = 0
const kinds = (v, acc = new Set()) => {
  if (v && typeof v === 'object') {
    if (typeof v.kind === 'string' && 'source' in v && 'as_of' in v) acc.add(v.kind)
    for (const x of Object.values(v)) kinds(x, acc)
  }
  return acc
}
async function run(name, args, summarize = () => ({})) {
  if (LIVE && calls >= MAX_LIVE_CALLS) throw new Error('live call budget exhausted')
  calls += 1
  const s = Date.now()
  const r = await client.callTool({ name, arguments: args })
  const sc = r.structuredContent
  const rec = { n: calls, tool: name, ok: !r.isError, ms: Date.now() - s, data_mode: sc?.data_mode ?? null }
  if (r.isError) rec.error = { class: sc.error.class, code: sc.error.code }
  // self-check: nothing phone- or email-shaped (outside returned ids) and nothing secret-shaped
  const known = new Set(JSON.stringify(sc).match(/"(?:property_id|lead_id)":"([0-9]{5,20})"/g)?.map((m) => m.replace(/[^0-9]/g, '')) || [])
  rec.pii_residual = residualContact(JSON.stringify(r.content), { knownIds: known })
  rec.secret_shaped = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|sb_secret_|postgres:\/\/|BEGIN [A-Z ]*KEY/.test(JSON.stringify(r))
  if (!r.isError) Object.assign(rec, { provenance_kinds: [...kinds(sc.result)].sort(), bytes: Buffer.byteLength(JSON.stringify(sc)) }, summarize(sc))
  out.calls.push(rec)
  return r.isError ? null : sc
}

const ids = (rows, k = 'property_id') => (rows || []).slice(0, 5).map((x) => x[k])
if (ONLY) {
  await run(ONLY, ONLY_ARGS, (sc) => ({ result_keys: Object.keys(sc.result || {}).length }))
} else if (!LIVE) {
  await run('leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 3 }, (sc) => ({ rows: sc.result.rows.length, ids: ids(sc.result.rows), has_more: sc.page.has_more }))
  await run('leadcommand_get_property', { property_id: 'FX1001' }, (sc) => ({ owner_kind: sc.result.ownership.owner_kind, inconsistencies: sc.result.distress.inconsistencies.length }))
  await run('leadcommand_get_acquisition_score', { property_id: 'FX1002' }, (sc) => ({ available: sc.result.available, status: sc.result.status }))
  await run('leadcommand_search_comps', { property_id: 'FX1001', limit: 5 }, (sc) => ({ rows: sc.result.rows.length, ids: ids(sc.result.rows, 'comp_id'), buyer_basis: sc.result.rows.map((x) => x.buyer.basis) }))
  await run('leadcommand_get_lead_contact_status', { property_id: 'FX1003' }, (sc) => ({ contacts: sc.result.contacts.map((c) => `${c.contact}:${c.suppression.state}`) }))
} else {
  // 1 recent campaigns → a market label
  const camps = await run('leadcommand_get_campaign_metrics', { limit: 3 }, (sc) => ({ campaigns: sc.result.campaigns.length, ids: sc.result.campaigns.map((c) => c.campaign_id.slice(0, 8)), statuses: sc.result.campaigns.map((c) => c.status) }))
  const market = camps?.result?.campaigns?.map((c) => c.market).find(Boolean) || 'Minneapolis, MN'
  // 2 leads in that market (anchor = market)
  const leads = await run('leadcommand_search_leads', { market, limit: 5 }, (sc) => ({ rows: sc.result.rows.length, ids: ids(sc.result.rows), has_more: sc.page.has_more, scored: sc.result.rows.filter((r) => r.decision_engine.aos_score != null).length }))
  const rows = leads?.result?.rows || []
  const pick = (rows.find((r) => r.decision_engine.aos_score != null) || rows[0])?.property_id
  if (pick) {
    await run('leadcommand_get_lead', { property_id: pick }, (sc) => ({ stage_source: sc.result.outreach?.stage?.source ?? null, readiness: sc.result.outreach?.contact_readiness?.state ?? null }))
    const prop = await run('leadcommand_get_property', { property_id: pick }, (sc) => ({ owner_kind: sc.result.ownership.owner_kind, recorded: sc.result.recorded_documents.available !== false, inconsistencies: sc.result.distress.inconsistencies?.length ?? null }))
    await run('leadcommand_get_acquisition_score', { property_id: pick }, (sc) => ({ available: sc.result.available, status: sc.result.status }))
    await run('leadcommand_get_market_intelligence', { property_id: pick }, (sc) => ({ available: sc.result.available, build_id: sc.result.build_id, has_sales_1y: sc.result.metrics?.sales_1y != null }))
    await run('leadcommand_search_comps', { property_id: pick, radius_miles: 0.5, months: 12, limit: 5 }, (sc) => ({ rows: sc.result.rows.length, rows_read: sc.result.search.rows_read, buyer_basis: sc.result.rows.map((x) => x.buyer.basis) }))
    await run('leadcommand_get_lead_contact_status', { property_id: pick }, (sc) => ({ contacts_total: sc.result.summary.contacts_total, states: sc.result.contacts.map((c) => c.suppression.state), eligible: sc.result.eligibility.eligible ?? null }))
    const zip = prop?.result?.facts?.property_address_zip
    if (zip && /^[0-9]{5}$/.test(String(zip))) await run('leadcommand_search_properties', { zip: String(zip), limit: 3 }, (sc) => ({ rows: sc.result.rows.length, ids: ids(sc.result.rows), has_more: sc.page.has_more }))
  }
}

const audit = auditLines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((x) => x?.event === 'tool_call')
out.audit = { records: audit.length, upstream_timeout_pref: [...new Set(audit.map((a) => a.upstream_timeout_pref ?? null))], outcomes: audit.map((a) => `${a.tool.replace('leadcommand_', '')}:${a.outcome}${a.error_class ? `/${a.error_class}` : ''}`), principal_hashed: audit.every((a) => /^#[0-9a-f]{12}$/.test(a.principal || '')) }
out.live_calls = LIVE ? calls : 0
await client.close()
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
