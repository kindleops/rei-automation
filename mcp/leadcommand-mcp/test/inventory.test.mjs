// THE READ INVENTORY is one list, enforced in three places that must agree:
//   1. the role migration's SQL lists (grants, policies, verification, rollback, fixtures);
//   2. the MCP transport guard (src/data/read-fetch.mjs);
//   3. what the REAL services read. All 24 tools run over the live transport against the
//      fake PostgREST. The relations requested must EQUAL the inventory: nothing read
//      outside it, nothing granted that is never read. The RPCs called must equal the 9
//      allowlisted ones (2 app RPCs + the MCP's self-check, membership and 5 operations reads).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.mjs'
import { RELATIONS, RELATION_NAMES, OPTIONAL_RELATIONS, RPCS, MCP_RPCS, RPC_SIGNATURES, RPC_NAMES, DEFINER_READS, DEFINER_ONLY_SOURCES } from '../src/data/inventory.mjs'
import { READ_ONLY_RPC_ALLOWLIST } from '@/lib/agent/quick-scan/read-client.js'
import { createFakePostgrest } from './support/fake-postgrest.mjs'
import { liveEnv, LIVE_MEMBERSHIP } from './support/live-env.mjs'
import { FIXTURE_CAMPAIGN, FIXTURE_THREADS } from '../fixtures/dataset.mjs'
import { FIXTURE_CONV } from '../fixtures/conversations.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.resolve(HERE, '../../../supabase/migrations')
const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const arr = (literal) => [...literal.matchAll(/'([^']*)'/g)].map((m) => m[1])

/** Every `-- lc-inventory:<label>` array in a file, in order. */
function labelled(src) {
  const out = []
  for (const m of src.matchAll(/--\s*lc-inventory:([a-z-]+)\s*\n\s*[a-z_]+ text\[\] := array\[(.*)\];\s*$/gm)) out.push([m[1], arr(m[2])])
  return out
}
const named = (src, name) => [...src.matchAll(new RegExp(`\\b${name} text\\[\\] := array\\[(.*)\\];\\s*$`, 'gm'))].map((m) => arr(m[1]))

test('the role migration grants exactly the code inventory (apply, rollback, pretest, posttest)', () => {
  const apply = labelled(read('PROPOSED_20261019150000_lc_mcp_reader.sql'))
  const rollback = labelled(read('PROPOSED_20261019150000_lc_mcp_reader_rollback.sql'))
  const existing = Object.keys(RPCS).map((s) => s.replace(/\s+/g, '')).sort()
  const all = RPC_SIGNATURES.map((s) => s.replace(/\s+/g, '')).sort()
  assert.deepEqual(apply.map(([l]) => l), ['relations', 'optional', 'existing-rpcs', 'relations', 'functions'])
  for (const [label, list] of [...apply, ...rollback]) {
    const want = { relations: RELATION_NAMES, optional: [...OPTIONAL_RELATIONS], 'existing-rpcs': existing, functions: all }[label]
    assert.deepEqual([...list].sort(), [...want].sort(), `${label} list drifted from src/data/inventory.mjs`)
  }
  assert.deepEqual(rollback.map(([l]) => l), ['relations', 'existing-rpcs'])
  const post = read('PROPOSED_20261019150000_lc_mcp_reader_posttest.sql')
  assert.deepEqual(named(post, 'rels')[0].sort(), RELATION_NAMES)
  assert.deepEqual(named(post, 'fns')[0].sort(), all)
  const pre = read('PROPOSED_20261019150000_lc_mcp_reader_pretest.sql')
  assert.deepEqual(named(pre, 'rels')[0].sort(), RELATION_NAMES.filter((r) => !OPTIONAL_RELATIONS.includes(r)))
})

test('every inventory entry names the code that reads it; the app guard allowlists the app RPCs', () => {
  for (const [rel, readers] of Object.entries(RELATIONS)) assert.ok(readers.length > 0, rel)
  for (const sig of Object.keys(RPCS)) assert.ok(READ_ONLY_RPC_ALLOWLIST.includes(sig.replace(/^public\./, '').replace(/\(.*$/, '')), sig)
  for (const sig of Object.keys(MCP_RPCS)) assert.match(sig, /^public\.lc_mcp_/)
  assert.equal(RPC_NAMES.length, 20) // 9 required + 4 conversation reads + 2 census reads + 5 acquisition reads
  // every MCP definer names what it reads as its owner; none of those sources is in the role's SELECT inventory
  for (const sig of Object.keys(MCP_RPCS).filter((x) => !/self_check/.test(x))) assert.ok(DEFINER_READS[sig]?.length > 0, `${sig}: DEFINER_READS`)
  for (const src of DEFINER_ONLY_SOURCES) assert.ok(!RELATION_NAMES.includes(src.replace(/^public\./, '')), `${src} must not be granted to the role`)
})

test('live coverage: all 24 tools over the live transport read EXACTLY the inventory and call EXACTLY the 20 RPCs', async () => {
  const pg = createFakePostgrest({ membership: LIVE_MEMBERSHIP })
  const audit = []
  const app = await buildApp({ env: liveEnv(), baseFetch: pg.fetch, scrub: false, auditSink: (r) => audit.push(r) })
  const outcomes = {}
  try {
    const calls = [
      ['leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 5 }],
      ['leadcommand_get_lead', { property_id: 'P1' }],
      ['leadcommand_search_properties', { zip: '75001', limit: 5 }],
      ['leadcommand_search_properties', { address: '1 Fixture St', state: 'TX' }],
      ['leadcommand_get_property', { property_id: 'P1' }],
      ['leadcommand_get_acquisition_score', { property_id: 'P1' }],
      ['leadcommand_get_market_intelligence', { property_id: 'P1' }],
      ['leadcommand_search_comps', { property_id: 'P1' }],
      ['leadcommand_get_campaign_metrics', { limit: 5 }],
      ['leadcommand_get_campaign_metrics', { campaign_id: FIXTURE_CAMPAIGN }],
      ['leadcommand_get_lead_contact_status', { property_id: 'P1' }],
      ['leadcommand_get_ops_supervisor_status', {}],
      ['leadcommand_search_action_center', { limit: 5 }],
      ['leadcommand_get_thread_hold_status', { thread_id: FIXTURE_THREADS.held }],
      ['leadcommand_get_followup_intent_health', {}],
      ['leadcommand_get_lead_conversation', { property_id: 'FX1001' }],
      ['leadcommand_search_conversation_worklist', { category: 'recent_inbound' }],
      ['leadcommand_get_pipeline_summary', {}],
      ['leadcommand_get_opportunity_ranking', {}],
      ['leadcommand_get_corpus_census', {}],
      ['leadcommand_search_lead_screen', { limit: 5 }],
      ['leadcommand_get_thread_followups', { thread_id: FIXTURE_CONV.a }],
      ['leadcommand_get_thread_execution_log', { thread_id: FIXTURE_CONV.a, limit: 5 }],
      ['leadcommand_get_thread_offers', { thread_id: FIXTURE_CONV.a }],
      ['leadcommand_get_thread_contact_eligibility', { thread_id: FIXTURE_CONV.a }],
      ['leadcommand_search_operator_tasks', { limit: 5 }],
    ]
    for (const [name, args] of calls) {
      const r = await app.gateway.call(name, args)
      outcomes[`${name} ${JSON.stringify(args)}`] = r.ok ? 'ok' : r.structured.error.code
    }
  } finally { await app.close() }
  assert.deepEqual(Object.values(outcomes).filter((x) => x !== 'ok'), [], JSON.stringify(outcomes, null, 1))
  // a reused service that swallows a refused read would hide an inventory gap: nothing may be refused
  assert.deepEqual(app.source.refusals, [], `reads refused by the inventory guard: ${JSON.stringify(app.source.refusals)}`)
  assert.deepEqual(audit.filter((a) => a.event === 'transport_refused'), [], 'no transport_refused audit line')
  assert.deepEqual(pg.relationsRead(), RELATION_NAMES, 'relations read == the inventory')
  assert.deepEqual(pg.rpcsCalled(), [...RPC_NAMES].sort(), 'RPCs called == the 20 allowlisted')
  assert.ok(pg.requests.every((r) => r.method === 'GET' || r.method === 'HEAD' || (r.method === 'POST' && r.rpc)), 'only reads and read RPCs reached the network')
  assert.ok(pg.requests.every((r) => r.role === 'lc_mcp_reader'), 'every request ran as lc_mcp_reader')
})

test('a read outside the inventory is refused before the network, recorded and audited (by name only)', async () => {
  const pg = createFakePostgrest({ membership: LIVE_MEMBERSHIP })
  const audit = []
  const app = await buildApp({ env: liveEnv(), baseFetch: pg.fetch, scrub: false, auditSink: (r) => audit.push(r) })
  try {
    const before = pg.requests.length
    const r = await app.source.withCall(undefined, (svc) => svc.db.from('send_queue').select('id').limit(1).retry(false))
    assert.ok(r.error, 'the read failed')
    assert.equal(pg.requests.length, before, 'nothing reached the network')
    // (supabase-js may retry a GET whose fetch threw: every attempt is refused the same way)
    assert.ok(app.source.refusals.length >= 1)
    assert.deepEqual([...new Set(app.source.refusals.map((x) => [x.code, x.kind, x.target].join(' ')))], ['RELATION_NOT_IN_INVENTORY table_read send_queue'])
    const line = audit.find((a) => a.event === 'transport_refused')
    assert.ok(line, 'audited')
    assert.equal(line.target, 'send_queue')
    assert.doesNotMatch(JSON.stringify(line), /select=|limit=/, 'no query string in the audit')
  } finally { await app.close() }
})
