// The transport inventory is the migration's, exactly: the read relations (action_gateway.read_inventory()) and
// the RPCs (every public function the migration grants to lc_action_gateway + automation_hold_for).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELATIONS, RPCS, T2_RPCS, T34_RPCS } from '../src/data/inventory.mjs'
import { ACTIONS, READS, REQUESTED_TOOLS, NEVER_EXPOSED } from '@/lib/domain/action-gateway/catalog.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261019160000_action_gateway.sql'), 'utf8')
const T2_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261020100000_action_gateway_t2.sql'), 'utf8')
const T34_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261020110000_action_gateway_t34.sql'), 'utf8')

test('read relations = action_gateway.read_inventory()', () => {
  const m = /-- lc-action-inventory:relations\n\s*select array\[([^\]]+)\]/.exec(SQL)
  assert.ok(m, 'inventory marker present')
  const fromSql = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
  assert.deepEqual([...RELATIONS].sort(), fromSql)
})

test('RPC allowlist = the public functions granted to lc_action_gateway (+ the hold lookup)', () => {
  const created = [...SQL.matchAll(/create function public\.(action_gateway_[a-z_]+)\(/g)].map((x) => x[1])
  const t2 = [...T2_SQL.matchAll(/create or replace function public\.(action_gateway_[a-z_]+)\(/g)].map((x) => x[1]).filter((n) => n !== 'action_gateway_complete')
  assert.deepEqual([...T2_RPCS].sort(), [...new Set(t2)].sort(), 'link #27 RPCs')
  const t34 = [...T34_SQL.matchAll(/create function public\.(action_gateway_[a-z_]+)\(/g)].map((x) => x[1])
  assert.deepEqual([...T34_RPCS].sort(), [...new Set(t34)].sort(), 'link #28 RPCs')
  // LeadCommand-side functions of #28 (lc_seller_action_*, the budget consumer) are never in the gateway's allowlist
  assert.ok(!RPCS.some((r) => /^lc_seller_action|negotiation_send_authorization_consume/.test(r)))
  assert.deepEqual([...RPCS].filter((r) => r !== 'automation_hold_for').sort(), [...new Set([...created, ...t2, ...t34])].sort())
  assert.ok(RPCS.includes('automation_hold_for'))
})

test('catalog: every requested tool is registered exactly once (prepare_acquisition_offer as a scoped read); nothing never-exposed is; T3 / T4 tools never run on a standing grant alone', () => {
  const names = ACTIONS.map((a) => a.name)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual([...names, ...READS.filter((r) => r.name === 'prepare_acquisition_offer').map((r) => r.name)].sort(), [...REQUESTED_TOOLS].sort())
  for (const n of NEVER_EXPOSED) assert.ok(!names.includes(n) && !READS.some((r) => r.name === n), n)
  for (const a of ACTIONS.filter((x) => x.tier >= 3)) assert.ok(a.reversible !== true && a.request_only !== true, a.name)
})
