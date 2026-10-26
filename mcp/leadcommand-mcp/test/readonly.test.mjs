// READ-ONLY enforcement: no write tool can be registered, and the adapters'
// whole static import graph (MCP sources + every LeadCommand module they reach)
// contains no write function, no write-capable module, and no DB mutation call.
// Plus: the live transport refuses writes before any network request.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, assertCatalogReadOnly, NOT_IMPLEMENTED } from '../src/tools/catalog.mjs'
import { createLiveSource } from '../src/data/sources.mjs'
import { connect, call } from './helpers.mjs'
import { createFakePostgrest, READER_TOKEN, ANON_KEY } from './support/fake-postgrest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const API_SRC = path.resolve(PKG, '../../apps/api/src')
const RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

function resolveSpec(spec, from) {
  let p
  if (spec.startsWith('@/')) p = path.join(API_SRC, spec.slice(2))
  else if (spec.startsWith('.')) p = path.resolve(path.dirname(from), spec)
  else return null
  for (const c of [p, `${p}.js`, `${p}.mjs`, path.join(p, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  throw new Error(`unresolved import ${spec} from ${from}`)
}

/** Static import closure (static AND dynamic import specifiers). */
function closure(entries) {
  const seen = new Set()
  const stack = [...entries]
  const external = new Set()
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    for (const m of fs.readFileSync(f, 'utf8').matchAll(RE)) {
      const spec = m[1] || m[2] || m[3]
      const r = resolveSpec(spec, f)
      if (r) stack.push(r)
      else external.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'))
    }
  }
  return { files: [...seen], external: [...external].sort() }
}

const SRC_FILES = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? SRC_FILES(path.join(dir, d.name)) : d.name.endsWith('.mjs') ? [path.join(dir, d.name)] : []))
const GRAPH = closure(SRC_FILES(path.join(PKG, 'src')))
const API_FILES = GRAPH.files.filter((f) => f.startsWith(API_SRC)).map((f) => path.relative(API_SRC, f))

// modules that own a write / outbound / mutation path — none may be reachable
const WRITE_MODULES = [
  /domain\/inbox\/send-now-service/, /domain\/queue\//, /domain\/outbound\/supabase-candidate-feeder/, /supabase\/sms-engine/, /textgrid/i,
  /campaign-automation-service/, /campaign-composer/, /campaign-launch-readiness/, /enqueue-campaign-target/,
  /compliance\/record-phone-suppression/, /lead-state\/patch-universal-lead-state/, /cockpit\/cockpit-service/,
  /opportunity\/opportunity-service/, /acquisition\/acquisitionDecisionEngine/, /acquisition\/decisionAuthority/, /acquisition\/scoringBackfill/,
  /seller-flow\//, /automation\/automation-actions/, /inbound\//, /webhooks\//, /agent\/capabilities\//, /agent\/approvals\//, /agent\/runtime\/(pg-store|job-runtime|runtime-service)/,
  /system-control/, /discord\//, /email/i,
]
// pure helper modules inside a write-owning directory, proven pure below (no imports, no I/O)
const PURE_ALLOW = ['lib/domain/queue/queue-control-safety.js']
const MUTATION = [/\.from\(\s*[^)]*\)[\s\S]{0,160}?\.(insert|upsert|update|delete)\s*\(/, /\.(insert|upsert)\s*\(/, /\b(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from|truncate\s+table|alter\s+table|drop\s+table)\b/i]

test('no write tool is registered: every tool is a get/search read with a .read scope', () => {
  assert.equal(TOOLS.length, 17)
  assert.ok(assertCatalogReadOnly(TOOLS))
  for (const t of TOOLS) assert.match(t.name, /^leadcommand_(get|search)_/)
  assert.ok(NOT_IMPLEMENTED.some((x) => /READ-ONLY/.test(x.reason)))
})

test('the catalog guard refuses write-shaped tools at boot', () => {
  const base = TOOLS[0]
  for (const name of ['leadcommand_send_sms', 'leadcommand_get_and_update_lead', 'leadcommand_launch_campaign', 'leadcommand_search_execute_sql', 'leadcommand_get_unsuppress']) {
    assert.throws(() => assertCatalogReadOnly([{ ...base, name }]), /registrable|write-shaped/, name)
  }
  assert.throws(() => assertCatalogReadOnly([{ ...base, scope: 'leadcommand.sms.send' }]), /\.read scope/)
})

test('static import graph: no write-capable LeadCommand module is reachable from the gateway', () => {
  assert.ok(API_FILES.length > 10, 'closure computed')
  const hits = API_FILES.filter((f) => !PURE_ALLOW.includes(f) && WRITE_MODULES.some((re) => re.test(f)))
  assert.deepEqual(hits, [], `write-capable modules reachable: ${hits.join(', ')}`)
})

test('static import graph: allowlisted helpers are pure (no imports, no network / DB / fs access)', () => {
  for (const f of PURE_ALLOW) {
    if (!API_FILES.includes(f)) continue
    const src = fs.readFileSync(path.join(API_SRC, f), 'utf8')
    assert.equal(/^\s*import\s/m.test(src) || /\bimport\(/.test(src), false, `${f} imports nothing`)
    assert.equal(/\b(fetch|supabase|from\(|rpc\(|query\(|fs\.|process[.]env)\b/.test(src), false, `${f} does no I/O`)
  }
})

test('static import graph: no DB mutation call or mutation SQL exists anywhere in the reachable code', () => {
  const offenders = []
  for (const f of GRAPH.files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const re of MUTATION) if (re.test(src)) offenders.push(`${path.relative(path.resolve(PKG, '../..'), f)} ~ ${re}`)
  }
  assert.deepEqual(offenders, [])
})

test('static import graph: external packages are only the SDK, zod, supabase-js, pg and node built-ins', () => {
  const allowed = new Set(['@modelcontextprotocol/sdk', 'zod', '@supabase/supabase-js', 'pg'])
  const bad = GRAPH.external.filter((e) => !e.startsWith('node:') && !allowed.has(e))
  assert.deepEqual(bad, [])
})

test('live transport refuses every write before the network (PATCH / POST table / DELETE / write Prefer / foreign origin / outside the inventory)', async () => {
  const pg = createFakePostgrest()
  const src = createLiveSource({ supabaseUrl: 'https://fixture-project.supabase.test', apiKey: ANON_KEY, readerJwt: READER_TOKEN, baseFetch: pg.fetch })
  await src.withCall(null, async (svc) => {
    const r1 = await svc.db.from('properties').insert({ property_id: 'x' })
    assert.ok(r1.error, 'insert refused')
    const r2 = await svc.db.from('properties').update({ market: 'x' }).eq('property_id', 'x')
    assert.ok(r2.error, 'update refused')
    const r3 = await svc.db.from('sms_suppression_list').delete().eq('id', 'x')
    assert.ok(r3.error, 'delete refused')
    const r4 = await svc.db.rpc('exec_sql', { q: 'select 1' })
    assert.ok(r4.error, 'non-allowlisted rpc refused')
    const r6 = await svc.db.from('send_queue').select('id').limit(1)
    assert.ok(r6.error, 'a read outside the inventory is refused')
    const r7 = await svc.db.schema('agent').from('operator_membership').select('role').limit(1)
    assert.ok(r7.error, 'a schema profile other than public is refused')
    const r5 = await svc.db.from('properties').select('property_id').eq('property_id', 'FX1').limit(1)
    assert.equal(r5.error, null, 'a read goes through')
  })
  // the network saw: the boot-less first-call credential self-check, then the one read
  assert.deepEqual(pg.requests.map((r) => `${r.method} ${r.path}`), ['POST /rest/v1/rpc/lc_mcp_reader_self_check', 'GET /rest/v1/properties'])
  assert.ok(pg.requests.every((r) => r.role === 'lc_mcp_reader' && r.apikey_role === 'anon'), 'every request carries the reader token and the anon key, nothing else')
})

test('live transport: every live request carries the per-call abort signal and Prefer: timeout=5', async () => {
  const pg = createFakePostgrest()
  const src = createLiveSource({ supabaseUrl: 'https://fixture-project.supabase.test', apiKey: ANON_KEY, readerJwt: READER_TOKEN, baseFetch: pg.fetch })
  const ctl = new AbortController()
  await src.withCall(ctl.signal, (svc) => svc.db.from('campaigns').select('id').limit(1))
  const read = pg.requests.find((r) => r.relation === 'campaigns')
  assert.ok(read.signal)
  assert.match(read.prefer, /timeout=5/)
})

test('a full tool call surface leaves fixture tables unchanged (no write side effects)', async () => {
  const c = await connect()
  const snapshot = JSON.stringify(c.app.source.mode === 'fixture' ? (await import('../fixtures/dataset.mjs')).FIXTURE.tables : null)
  try {
    for (const n of ['leadcommand_get_property', 'leadcommand_get_lead', 'leadcommand_get_lead_contact_status', 'leadcommand_get_acquisition_score', 'leadcommand_search_comps']) await call(c.client, n, { property_id: 'FX1001' })
  } finally { await c.close() }
  assert.equal(JSON.stringify((await import('../fixtures/dataset.mjs')).FIXTURE.tables), snapshot)
})
