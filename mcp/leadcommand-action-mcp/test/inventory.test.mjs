// The transport inventory is the migration's, exactly: the read relations (action_gateway.read_inventory()) and
// the RPCs (every public function the migration grants to lc_action_gateway + automation_hold_for).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELATIONS, RPCS } from '../src/data/inventory.mjs'
import { ACTIONS, READS, REQUESTED_TOOLS, NEVER_EXPOSED } from '@/lib/domain/action-gateway/catalog.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261019160000_action_gateway.sql'), 'utf8')

test('read relations = action_gateway.read_inventory()', () => {
  const m = /-- lc-action-inventory:relations\n\s*select array\[([^\]]+)\]/.exec(SQL)
  assert.ok(m, 'inventory marker present')
  const fromSql = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
  assert.deepEqual([...RELATIONS].sort(), fromSql)
})

test('RPC allowlist = the public functions granted to lc_action_gateway (+ the hold lookup)', () => {
  const created = [...SQL.matchAll(/create function public\.(action_gateway_[a-z_]+)\(/g)].map((x) => x[1])
  assert.deepEqual([...RPCS].filter((r) => r !== 'automation_hold_for').sort(), [...new Set(created)].sort())
  assert.ok(RPCS.includes('automation_hold_for'))
})

test('catalog: every requested tool is registered exactly once; nothing never-exposed is; T3 / T4 tools are unavailable in phase 1', () => {
  const names = ACTIONS.map((a) => a.name)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual([...names].sort(), [...REQUESTED_TOOLS].sort())
  for (const n of NEVER_EXPOSED) assert.ok(!names.includes(n) && !READS.some((r) => r.name === n), n)
  for (const a of ACTIONS.filter((x) => x.tier >= 3)) assert.equal(a.implemented, false, a.name)
})
