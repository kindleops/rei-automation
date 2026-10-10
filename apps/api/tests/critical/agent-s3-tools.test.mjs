// Agent S3 — live Quick Scan T0 tools: each returns data identical to the
// AUTHORITATIVE app service for fixture inputs; full S1 permission contracts;
// PII never projected; the guarded read client allows only reads to the app's
// own data host.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeReadDb, fixtureTables, FIXTURE_PII } from '../helpers/agent-s3-fake-db.mjs'
import { getEntityGraphDossier } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import { getEntityGraphOutreachState } from '../../src/lib/domain/entity-graph/entity-graph-outreach-state.js'
import { getEntityGraphZipContext, __zipContextTest } from '../../src/lib/domain/entity-graph/entity-graph-zip-context.js'
import { getEntityGraphColumnEnrichment } from '../../src/lib/domain/entity-graph/entity-graph-column-enrichment.js'
import { equityTruth } from '../../src/lib/domain/entity-graph/entity-graph-truth.js'
import { createQuickScanServices, VALUATION_ENRICHMENT_FIELDS } from '../../src/lib/agent/quick-scan/services.js'
import { createQuickScanToolRegistry, QUICK_SCAN_TOOL_SPECS, QUICK_SCAN_TOOL_NAMES, PROPERTY_FACT_KEYS } from '../../src/lib/agent/quick-scan/tools.js'
import { authorizeToolCall, projectOutput } from '../../src/lib/agent/tools/registry.js'
import { classifyProhibited } from '../../src/lib/agent/tools/prohibited.js'
import { createGuardedReadFetch, READ_ONLY_RPC_ALLOWLIST } from '../../src/lib/agent/quick-scan/read-client.js'
import { QUICK_SCAN_SOURCES } from '../../src/lib/agent/quick-scan/sources.js'

const PID = '9000000001'
const db = () => createFakeReadDb(fixtureTables({ propertyId: PID }))

async function runTool(name, input, services) {
  const registry = createQuickScanToolRegistry()
  const spec = registry.get(name)
  const raw = await spec.execute(input, { services })
  return projectOutput(spec, raw).projected
}

test('registry: exactly the nine Quick Scan tools, all T0, sealed, full contracts, none prohibited, all non-billable', () => {
  const registry = createQuickScanToolRegistry()
  assert.equal(registry.sealed, true)
  assert.deepEqual(registry.list().map((t) => t.name), [...QUICK_SCAN_TOOL_NAMES])
  assert.equal(QUICK_SCAN_TOOL_NAMES.length, 9)
  for (const t of registry.list()) {
    assert.equal(t.tier, 'T0', t.name)
    assert.equal(t.approval, 'none')
    assert.equal(t.side_effect, 'read')
    assert.ok(['db_light', 'db_heavy', 'free'].includes(t.cost_class), `${t.name} is not billable`)
    assert.ok(t.disclosure.never.includes('phone') && t.disclosure.never.includes('email'))
    assert.ok(t.wraps.module && t.wraps.export && t.wraps.route, `${t.name} wraps an existing service`)
    assert.ok(/^@\/lib\/domain\/entity-graph\//.test(t.wraps.module), `${t.name} wraps an Entity Graph service`)
    assert.equal(t.limits.timeout_ms, 30_000)
    assert.ok(t.sources.length && t.sources.every((s) => QUICK_SCAN_SOURCES[s]?.billable === false && QUICK_SCAN_SOURCES[s].access_mode === 'supabase'))
    assert.equal(classifyProhibited(t).prohibited, false)
    assert.equal(t.s1_stub, false)
  }
  assert.throws(() => registry.register(QUICK_SCAN_TOOL_SPECS[0]), (e) => e.code === 'REGISTRY_SEALED')
})

test('authorization: refused when AGENT_MAX_MODE is off, without a session, or with a capability outside Quick Scan', () => {
  const registry = createQuickScanToolRegistry()
  const ok = { mode: 'read', enabled_capabilities: [2, 4, 10], session_user_id: 'op' }
  assert.equal(authorizeToolCall({ registry, tool: 'eg.property_core', input: { property_id: PID }, ctx: ok }).decision, 'allow')
  assert.equal(authorizeToolCall({ registry, tool: 'eg.property_core', input: { property_id: PID }, ctx: { ...ok, mode: 'off' } }).code, 'AGENT_MODE_CEILING')
  assert.equal(authorizeToolCall({ registry, tool: 'eg.property_core', input: { property_id: PID }, ctx: { ...ok, session_user_id: null } }).code, 'SESSION_REQUIRED')
  assert.equal(authorizeToolCall({ registry, tool: 'mi.zip_context', input: { zip: '55411' }, ctx: { ...ok, enabled_capabilities: [2] } }).code, 'CAPABILITY_DISABLED')
  assert.equal(authorizeToolCall({ registry, tool: 'eg.property_core', input: { property_id: "1' or 1=1" }, ctx: ok }).code, 'INPUT_INVALID')
  assert.equal(authorizeToolCall({ registry, tool: 'eg.property_core', input: { property_id: PID, sql: 'x' }, ctx: ok }).code, 'INPUT_INVALID')
})

test('eg.property_core / eg.ownership / eg.street_view_availability ≡ getEntityGraphDossier for the fixture', async () => {
  const d = db()
  const service = await getEntityGraphDossier('property', PID, { supabase: d })
  const services = createQuickScanServices({ db: d })
  const core = await runTool('eg.property_core', { property_id: PID }, services)
  for (const k of PROPERTY_FACT_KEYS) assert.deepEqual(core.facts[k], service.summary[k] ?? null, k)
  assert.equal(core.display_address, service.summary.property_address_full)
  assert.equal(core.provenance.source_updated_at, service.summary.updated_at)
  assert.equal(core.provenance.vendor_as_of, service.summary.valuation_date)
  const own = await runTool('eg.ownership', { property_id: PID }, services)
  assert.equal(own.owner_linked, Boolean(service.owner))
  assert.equal(own.owner_portfolio_count, service.owner.property_count)
  assert.equal(own.ownership_years, service.summary.ownership_years)
  assert.equal(own.out_of_state_owner, service.summary.out_of_state_owner)
  assert.equal(own.owner_kind, 'individual')
  const sv = await runTool('eg.street_view_availability', { property_id: PID }, services)
  assert.equal(sv.image_reference_on_record, /^https:\/\//.test(service.summary.streetview_image))
  assert.equal(sv.image_host, 'maps.googleapis.com')
  assert.equal(sv.fetched, false)
})

test('eg.recorded_documents / eg.sales_history ≡ the dossier records (entity_graph_property_records → shapeRecords)', async () => {
  const d = db()
  const service = await getEntityGraphDossier('property', PID, { supabase: d })
  const services = createQuickScanServices({ db: d })
  const rec = await runTool('eg.recorded_documents', { property_id: PID }, services)
  assert.equal(rec.available, true)
  assert.equal(rec.mortgages.length, service.records.mortgages.length)
  service.records.mortgages.forEach((m, i) => {
    assert.deepEqual([rec.mortgages[i].recorded, rec.mortgages[i].amount, rec.mortgages[i].open, rec.mortgages[i].position, rec.mortgages[i].est_balance, rec.mortgages[i].lender], [m.recorded, m.amount, m.open, m.position, m.balance, m.lender])
  })
  assert.deepEqual(rec.totals, service.records.totals)
  for (const k of ['tax_delinquent', 'active_lien', 'open_mortgage_count', 'updated_at']) assert.deepEqual(rec.parcel[k], service.records.parcel[k] ?? null, k)
  const sales = await runTool('eg.sales_history', { property_id: PID }, services)
  service.records.sales.forEach((s, i) => {
    assert.deepEqual([sales.sales[i].date, sales.sales[i].price, sales.sales[i].doc_type, sales.sales[i].cash, sales.sales[i].arms_length], [s.date, s.price, s.docType, s.cash, s.armsLength])
    assert.equal(sales.sales[i].buyer.kind, s.buyer.kind)
  })
})

test('valuation.read ≡ column enrichment (scores.*, rec.*) + dossier, and equity is the shared equityTruth rule', async () => {
  const d = db()
  const dossier = await getEntityGraphDossier('property', PID, { supabase: d })
  const enr = await getEntityGraphColumnEnrichment({ property_ids: PID, fields: VALUATION_ENRICHMENT_FIELDS.join(',') }, { supabase: d })
  const out = await runTool('valuation.read', { property_id: PID }, createQuickScanServices({ db: d }))
  const v = enr.values[PID]
  assert.equal(out.engine.valuation_mid, v['scores.valuation_mid'])
  assert.equal(out.engine.comp_count, v['scores.comp_count'])
  assert.equal(out.vendor.estimated_value, dossier.summary.estimated_value)
  assert.deepEqual(out.equity, equityTruth({ estimated_value: dossier.summary.estimated_value, total_loan_balance: dossier.summary.total_loan_balance, property_flags_text: dossier.summary.property_flags_text, rec_mortgage_balance: v['rec.mortgage_balance'], rec_mortgage_count: v['rec.mortgage_count'] }))
})

test('eg.outreach_state / eg.sms_eligibility ≡ getEntityGraphOutreachState (no message text, no candidate names)', async () => {
  const d = db()
  const service = await getEntityGraphOutreachState({ property_ids: PID }, { supabase: d })
  const st = service.states[PID]
  const services = createQuickScanServices({ db: d })
  const o = await runTool('eg.outreach_state', { property_id: PID }, services)
  assert.deepEqual(o.stage, st.stage)
  assert.deepEqual(o.status, st.status)
  assert.equal(o.last_contact.at, st.lastContact.at)
  assert.equal(o.campaigns.count, st.campaigns.count)
  assert.equal(o.conversation.preview, undefined)
  const s = await runTool('eg.sms_eligibility', { property_id: PID }, services)
  assert.deepEqual([s.eligible, s.reason, s.rows, s.ready], [st.sms.eligible, st.sms.reason, st.sms.rows, st.sms.ready])
})

test('mi.zip_context ≡ getEntityGraphZipContext; demographics reported unavailable, never invented', async () => {
  __zipContextTest.reset()
  const d = db()
  const service = await getEntityGraphZipContext({ zips: '55411', buyers: '1' }, { supabase: d })
  __zipContextTest.reset()
  const z = await runTool('mi.zip_context', { zip: '55411' }, createQuickScanServices({ db: d }))
  for (const k of ['sales90d', 'sales1y', 'investorShare1y', 'cashShare1y', 'medianPrice1y', 'buyers', 'activeBuyers']) assert.equal(z[k], service.zips['55411'][k], k)
  assert.equal(z.demographics_available, false)
  assert.equal(z.build_id, service.buildId)
})

test('no tool output carries phones, emails, names, mailing address, message text or the Street View URL/key', async () => {
  const d = db()
  const services = createQuickScanServices({ db: d })
  const outputs = []
  for (const name of QUICK_SCAN_TOOL_NAMES) outputs.push(await runTool(name, name === 'mi.zip_context' ? { zip: '55411' } : { property_id: PID }, services))
  const text = JSON.stringify(outputs)
  for (const pii of [FIXTURE_PII.ownerName, FIXTURE_PII.prospectName, FIXTURE_PII.phoneDigits, FIXTURE_PII.email, FIXTURE_PII.mailing, 'SECRETKEY123', 'call +1', 'PRIOR FIXTURE SELLER']) {
    assert.ok(!text.includes(pii), `leaked ${pii}`)
  }
})

test('the dossier is loaded once per property per run (memo), and a failed read is not cached', async () => {
  const d = db()
  let calls = 0
  let fail = true
  const services = createQuickScanServices({ db: d, impl: { getEntityGraphDossier: async (...a) => { calls += 1; if (fail) { fail = false; throw new Error('transient') } return getEntityGraphDossier(...a) } } })
  await assert.rejects(services.dossier(PID))
  await services.dossier(PID)
  await services.dossier(PID)
  assert.equal(calls, 2)
})

test('guarded read fetch: only the app data host, only reads, only allowlisted STABLE rpcs, 30 s abort', async () => {
  const seen = []
  const base = async (input, init) => { seen.push([String(input), init.method || 'GET']); return new Response('[]', { status: 200 }) }
  const f = createGuardedReadFetch({ allowedHost: 'proj.supabase.co', baseFetch: base })
  await f('https://proj.supabase.co/rest/v1/properties?select=*', { method: 'GET' })
  await f('https://proj.supabase.co/rest/v1/rpc/entity_graph_property_records', { method: 'POST', body: '{}' })
  await assert.rejects(f('https://evil.example/rest/v1/properties', {}), (e) => e.code === 'EGRESS_REFUSED')
  await assert.rejects(f('https://api.anthropic.com/v1/messages', { method: 'POST' }), (e) => e.code === 'EGRESS_REFUSED')
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) await assert.rejects(f('https://proj.supabase.co/rest/v1/properties', { method: m }), (e) => e.code === 'WRITE_REFUSED', m)
  await assert.rejects(f('https://proj.supabase.co/rest/v1/rpc/queue_atomic_claim_send_row', { method: 'POST' }), (e) => e.code === 'RPC_NOT_ALLOWLISTED')
  await assert.rejects(f('https://proj.supabase.co/storage/v1/object/x', { method: 'GET' }), (e) => e.code === 'WRITE_REFUSED')
  await assert.rejects(f('https://proj.supabase.co/rest/v1/properties', { method: 'GET', headers: { Prefer: 'return=representation' } }), (e) => e.code === 'WRITE_REFUSED')
  // L7: scheme + port are part of the check; Prefer / method are read from a Request object too
  await assert.rejects(f('http://proj.supabase.co/rest/v1/properties', {}), (e) => e.code === 'EGRESS_REFUSED')
  await assert.rejects(f('https://proj.supabase.co:8443/rest/v1/properties', {}), (e) => e.code === 'EGRESS_REFUSED')
  await assert.rejects(f(new Request('https://proj.supabase.co/rest/v1/properties', { headers: { Prefer: 'return=minimal' } })), (e) => e.code === 'WRITE_REFUSED')
  await assert.rejects(f(new Request('https://proj.supabase.co/rest/v1/properties', { method: 'DELETE' })), (e) => e.code === 'WRITE_REFUSED')
  assert.equal(seen.length, 2)
  assert.deepEqual([...READ_ONLY_RPC_ALLOWLIST].sort(), ['campaign_entity_contact_evidence', 'campaign_entity_contact_review_flags', 'entity_graph_property_records'])
  const slow = createGuardedReadFetch({ allowedHost: 'proj.supabase.co', timeoutMs: 20, baseFetch: (_i, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) })
  await assert.rejects(slow('https://proj.supabase.co/rest/v1/properties', {}), (e) => e.code === 'READ_TIMEOUT')
})

test('services refuse to write: the fake read db throws on any write and no tool calls one', async () => {
  const d = db()
  assert.throws(() => d.from('properties').insert({}), /WRITE_ATTEMPT/)
  const services = createQuickScanServices({ db: d })
  for (const name of QUICK_SCAN_TOOL_NAMES) await runTool(name, name === 'mi.zip_context' ? { zip: '55411' } : { property_id: PID }, services)
  assert.ok(d.calls.length > 0)
  assert.ok(d.calls.every((c) => c.kind === 'table' || ['entity_graph_property_records', 'campaign_entity_contact_review_flags', 'campaign_entity_contact_evidence'].includes(c.fn)))
})
