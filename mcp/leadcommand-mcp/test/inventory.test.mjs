// THE READ INVENTORY is one list, enforced in three places that must agree:
//   1. the role migration's SQL lists (grants, policies, verification, rollback, fixtures);
//   2. the MCP transport guard (src/data/read-fetch.mjs);
//   3. what the REAL services read. All 9 tools run over the live transport against the
//      fake PostgREST. The relations requested must EQUAL the inventory: nothing read
//      outside it, nothing granted that is never read. The RPCs called must equal the 4
//      allowlisted ones.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.mjs'
import { RELATIONS, RELATION_NAMES, OPTIONAL_RELATIONS, RPCS, MCP_RPCS, RPC_SIGNATURES, RPC_NAMES } from '../src/data/inventory.mjs'
import { READ_ONLY_RPC_ALLOWLIST } from '@/lib/agent/quick-scan/read-client.js'
import { createFakePostgrest } from './support/fake-postgrest.mjs'
import { liveEnv, LIVE_MEMBERSHIP } from './support/live-env.mjs'
import { FIXTURE_CAMPAIGN } from '../fixtures/dataset.mjs'

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
  assert.equal(RPC_NAMES.length, 4)
})

test('live coverage: all 9 tools over the live transport read EXACTLY the inventory and call EXACTLY the 4 RPCs', async () => {
  const pg = createFakePostgrest({ membership: LIVE_MEMBERSHIP })
  const app = await buildApp({ env: liveEnv(), baseFetch: pg.fetch, scrub: false, auditSink: () => {} })
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
    ]
    for (const [name, args] of calls) {
      const r = await app.gateway.call(name, args)
      outcomes[`${name} ${JSON.stringify(args)}`] = r.ok ? 'ok' : r.structured.error.code
    }
  } finally { await app.close() }
  assert.deepEqual(Object.values(outcomes).filter((x) => x !== 'ok'), [], JSON.stringify(outcomes, null, 1))
  assert.deepEqual(pg.relationsRead(), RELATION_NAMES, 'relations read == the inventory')
  assert.deepEqual(pg.rpcsCalled(), [...RPC_NAMES].sort(), 'RPCs called == the 4 allowlisted')
  assert.ok(pg.requests.every((r) => r.method === 'GET' || r.method === 'HEAD' || (r.method === 'POST' && r.rpc)), 'only reads and read RPCs reached the network')
  assert.ok(pg.requests.every((r) => r.role === 'lc_mcp_reader'), 'every request ran as lc_mcp_reader')
})
