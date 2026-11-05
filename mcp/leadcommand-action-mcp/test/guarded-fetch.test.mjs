// The transport guard in front of PostgREST (inside the database-role enforcement): inventory reads and
// gateway RPCs only, credentials attached here and nowhere else, no other origin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuardedFetch } from '../src/data/guarded-fetch.mjs'

const ORIGIN = 'https://abcd.supabase.co'
function guard() {
  const seen = []
  const refused = []
  const f = createGuardedFetch({ origin: ORIGIN, apiKey: 'anon-key', gatewayJwt: 'gw-token', base: async (url, init) => { seen.push({ url, method: init.method, auth: init.headers.get('authorization'), apikey: init.headers.get('apikey') }); return new Response('[]') }, onRefused: (r) => refused.push(r) })
  return { f, seen, refused }
}

test('allowed: GET an inventory table, POST a gateway entry point / automation_hold_for; the gateway credentials overwrite any header', async () => {
  const g = guard()
  await g.f(`${ORIGIN}/rest/v1/inbox_thread_state?select=id&id=eq.x`, { headers: { authorization: 'Bearer service-role-key' } })
  await g.f(`${ORIGIN}/rest/v1/rpc/action_gateway_claim`, { method: 'POST', body: '{}' })
  await g.f(`${ORIGIN}/rest/v1/rpc/automation_hold_for`, { method: 'POST', body: '{}' })
  assert.equal(g.seen.length, 3)
  for (const s of g.seen) assert.deepEqual([s.auth, s.apikey], ['Bearer gw-token', 'anon-key'])
})

test('refused before the network: table writes, tables outside the inventory, other RPCs, other origins, other schemas, write Prefer headers, other paths', async () => {
  const g = guard()
  const cases = [
    [`${ORIGIN}/rest/v1/automation_holds`, { method: 'POST' }, 'WRITE_REFUSED'],
    [`${ORIGIN}/rest/v1/send_queue?id=eq.1`, { method: 'PATCH' }, 'WRITE_REFUSED'],
    [`${ORIGIN}/rest/v1/system_control?key=eq.x`, { method: 'DELETE' }, 'WRITE_REFUSED'],
    [`${ORIGIN}/rest/v1/agent_principals`, {}, 'RELATION_NOT_IN_INVENTORY'],
    [`${ORIGIN}/rest/v1/sms_templates`, {}, 'RELATION_NOT_IN_INVENTORY'],
    [`${ORIGIN}/rest/v1/rpc/lc_mcp_reader_self_check`, { method: 'POST' }, 'RPC_NOT_ALLOWLISTED'],
    [`${ORIGIN}/rest/v1/rpc/set_config`, { method: 'POST' }, 'RPC_NOT_ALLOWLISTED'],
    ['https://evil.example.com/rest/v1/properties', {}, 'EGRESS_REFUSED'],
    [`${ORIGIN}/rest/v1/properties`, { headers: { 'accept-profile': 'action_gateway' } }, 'SCHEMA_REFUSED'],
    [`${ORIGIN}/rest/v1/properties`, { headers: { prefer: 'return=representation' } }, 'WRITE_REFUSED'],
    [`${ORIGIN}/auth/v1/admin/users`, {}, 'WRITE_REFUSED'],
    [`${ORIGIN}/storage/v1/object/x`, {}, 'WRITE_REFUSED'],
  ]
  for (const [url, init, code] of cases) await assert.rejects(g.f(url, init), (e) => e.code === code, `${url} ${JSON.stringify(init)}`)
  assert.equal(g.seen.length, 0)
  assert.equal(g.refused.length, cases.length)
})
