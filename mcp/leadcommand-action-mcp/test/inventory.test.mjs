// The transport inventory is the migration's, exactly: the read relations (action_gateway.read_inventory()) and
// the RPCs (every public function the migration grants to lc_action_gateway + automation_hold_for).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELATIONS, RPCS, T2_RPCS, T34_RPCS, OHG_RPCS, WF_RPCS, AGENT_MESSAGE_RPCS } from '../src/data/inventory.mjs'
import { ACTIONS, READS, REQUESTED_TOOLS, NEVER_EXPOSED, WORKFORCE_TOOLS, OHG_TOOLS, AGENT_MESSAGE_TOOLS } from '@/lib/domain/action-gateway/catalog.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261019160000_action_gateway.sql'), 'utf8')
const T2_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261020100000_action_gateway_t2.sql'), 'utf8')
const T34_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261020110000_action_gateway_t34.sql'), 'utf8')
const WF_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261022110000_workforce_agntei.sql'), 'utf8')
const OHG_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261027120000_action_gateway_ohg.sql'), 'utf8')
const AM_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261029100000_action_gateway_agent_message.sql'), 'utf8')

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
  // Workforce × Agntei: exactly the two public functions that migration grants to lc_action_gateway
  const wf = [...WF_SQL.matchAll(/create or replace function public\.(action_gateway_[a-z_]+)\(/g)].map((x) => x[1])
  assert.deepEqual([...WF_RPCS].sort(), [...new Set(wf)].sort(), 'Workforce × Agntei RPCs')
  assert.match(WF_SQL, /grant execute on function public\.action_gateway_workforce_read\(text, text, jsonb\), public\.action_gateway_dw_workforce\(uuid, uuid\) to lc_action_gateway;/)
  // link #29: exactly the three public functions that migration grants to lc_action_gateway
  const ohg = [...OHG_SQL.matchAll(/create function public\.(action_gateway_[a-z_]+)\(/g)].map((x) => x[1])
  assert.deepEqual([...OHG_RPCS].sort(), [...new Set(ohg)].sort(), 'link #29 RPCs')
  for (const f of ['action_gateway_dw_ohg(uuid,uuid)', 'action_gateway_reply_status(uuid,integer)', 'action_gateway_annotations(uuid,integer)']) assert.ok(OHG_SQL.includes(`grant execute on function public.${f} to lc_action_gateway;`), f)
  // link #32: exactly the five public functions that migration creates for (and grants to) lc_action_gateway
  const am = [...AM_SQL.matchAll(/create function public\.(action_gateway_[a-z_]+)\(/g)].map((x) => x[1])
  assert.deepEqual([...AGENT_MESSAGE_RPCS].sort(), [...new Set(am)].sort(), 'link #32 RPCs')
  assert.match(AM_SQL, /grant execute on function public\.action_gateway_agent_message_state\(uuid, uuid, uuid\), public\.action_gateway_message_templates\(\), public\.action_gateway_dw_lead_assignment\(uuid, uuid\),\n  public\.action_gateway_lead_assignment_get\(uuid, uuid\), public\.action_gateway_events_since\(bigint, integer\) to lc_action_gateway;/)
  assert.deepEqual([...RPCS].filter((r) => r !== 'automation_hold_for').sort(), [...new Set([...created, ...t2, ...t34, ...ohg, ...wf, ...am])].sort())
  assert.ok(RPCS.includes('automation_hold_for'))
})

test('catalog: every requested tool is registered exactly once (prepare_acquisition_offer as a scoped read); nothing never-exposed is; T3 / T4 tools never run on a standing grant alone', () => {
  const names = ACTIONS.map((a) => a.name)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual([...names, ...READS.filter((r) => r.name === 'prepare_acquisition_offer' || WORKFORCE_TOOLS.includes(r.name) || OHG_TOOLS.includes(r.name) || AGENT_MESSAGE_TOOLS.includes(r.name)).map((r) => r.name)].sort(), [...REQUESTED_TOOLS, ...WORKFORCE_TOOLS, ...OHG_TOOLS, ...AGENT_MESSAGE_TOOLS].sort())
  // link #32: the agent message is the ONE T3 write of its family, a domain write of the shared handoff, registered as such; the lead writes are standing T2 reversible
  assert.ok(AM_SQL.includes(`('domain_write_action', 'queue_agent_message', 'PROPOSED_20261029100000_action_gateway_agent_message', null)`))
  for (const n of ['assign_lead', 'release_lead']) assert.ok(AM_SQL.includes(`('standing_t2_action', '${n}', 'PROPOSED_20261029100000_action_gateway_agent_message', 'reversible')`), n)
  // Operation Hidden Gold (link #29): four standing T2 reversible writes of the ONE acquisitions writer, registered as domain writes and standing actions; two scoped reads
  for (const a of ACTIONS.filter((x) => OHG_TOOLS.includes(x.name))) {
    assert.equal(a.tier, 2, a.name)
    assert.equal(a.reversible, true, a.name)
    assert.deepEqual([a.executor.kind, a.executor.fn], ['domain_write', 'action_gateway_dw_ohg'], a.name)
    assert.ok(OHG_SQL.includes(`('domain_write_action', '${a.name}', 'PROPOSED_20261027120000_action_gateway_ohg', null)`), `${a.name} is registered as a domain write`)
    assert.ok(OHG_SQL.includes(`('standing_t2_action', '${a.name}', 'PROPOSED_20261027120000_action_gateway_ohg', 'reversible')`), `${a.name} is registered as a standing T2 action`)
  }
  for (const r of READS.filter((x) => OHG_TOOLS.includes(x.name))) assert.deepEqual([r.tier, r.scope], [1, 'conversation_context.read'], r.name)
  // the Workforce tools: T1 only, never seller-facing, every write a domain write of the ONE Workforce writer
  for (const a of ACTIONS.filter((x) => WORKFORCE_TOOLS.includes(x.name))) {
    assert.equal(a.tier, 1, a.name)
    assert.equal(a.executor.kind, 'domain_write', a.name)
    assert.equal(a.executor.fn, 'action_gateway_dw_workforce', a.name)
    assert.ok(WF_SQL.includes(`('domain_write_action', '${a.name}', 'PROPOSED_20261022110000_workforce_agntei', null)`), `${a.name} is registered as a domain write`)
  }
  for (const n of NEVER_EXPOSED) assert.ok(!names.includes(n) && !READS.some((r) => r.name === n), n)
  for (const a of ACTIONS.filter((x) => x.tier >= 3)) assert.ok(a.reversible !== true && a.request_only !== true, a.name)
})
