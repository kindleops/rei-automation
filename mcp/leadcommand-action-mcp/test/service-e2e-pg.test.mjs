// END TO END on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL, loopback only): the REAL Action MCP app behind the
// loopback HTTP transport, the whole gateway chain (#26 to link 10) + PROPOSED_20261105120000_action_gateway_service_principals.
// ONE service credential, several SDK clients: each names its acting agent in the X-LC-Acting-Agent header; the gateway
// applies that agent's own grants. Campaign drafts and the record-sync tools run through it; identity in arguments,
// a missing header and a non-delegate are refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.mjs'
import { startHttp } from '../src/protocol/http.mjs'
import { baseEnv } from './helpers.mjs'
import { pgAvailable, skipReason } from '../../../apps/api/tests/pg/agent-pg-harness.mjs'
import { pgSupabase } from '../../../apps/api/tests/helpers/pg-supabase.mjs'
import { registerAgent, seedThread, gatewayPool, setControls, sel, ORG } from '../../../apps/api/tests/helpers/action-gateway-pg.mjs'
import { seedT34 } from '../../../apps/api/tests/helpers/action-gateway-t34-world.mjs'
import { servicePrincipalDb, registerService, assertionFor } from '../../../apps/api/tests/helpers/service-principal-pg.mjs'

const skip = pgAvailable() ? false : skipReason
const httpEnv = () => baseEnv({ LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: '0', LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE: '' })
/**
 * An SDK client for one acting agent: every tools/call request is SIGNED with that agent's registered key over the exact
 * call (X-LC-Acting-Assertion), exactly as the integration does; sign: false sends the bare header only.
 */
async function client(url, token, acting, { sign = true, signAs = acting } = {}) {
  const c = new Client({ name: 'e2e-service', version: '1.0.0' })
  const signingFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers)
    if (acting && sign && typeof init.body === 'string') {
      const m = JSON.parse(init.body)
      if (m?.method === 'tools/call') headers.set('X-LC-Acting-Assertion', assertionFor(signAs, m.params.name, m.params.arguments ?? {}))
    }
    return fetch(input, { ...init, headers })
  }
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: signingFetch, requestInit: { headers: { Authorization: `Bearer ${token}`, ...(acting ? { 'X-LC-Acting-Agent': acting } : {}) } } }))
  return c
}
const json = (r) => r.structuredContent

test('E2E (PG) service principal: one lcsvc_ credential, the acting agent per request header; campaign draft + read-back and record sync through it; refusals for no header, a non-delegate and identity in arguments', { skip }, async () => {
  const env = await servicePrincipalDb()
  const events = []
  let listener
  let app
  try {
    await seedT34(env)
    await setControls(env.owner, {})
    await registerAgent(env.owner, { agent_id: 'agt_sterling', grants: [['campaigns.create_draft', 1], ['campaigns.read', 1], ['records.read', 1], ['records.apply_change', 2]], tier_ceiling: 2, read_scopes: ['conversation_context.read'] })
    await registerAgent(env.owner, { agent_id: 'agt_scout', grants: [['records.read', 1]], tier_ceiling: 1, read_scopes: ['conversation_context.read'] })
    await registerAgent(env.owner, { agent_id: 'agt_outsider', grants: [['campaigns.read', 1]], tier_ceiling: 1 })
    const svc = await registerService(env.owner, { delegates: ['agt_sterling', 'agt_scout'] })
    const t = await seedThread(env.owner, { phone: '+13125550150', property: 'p150' })
    await env.owner.query(`insert into public.properties (property_id, property_type) values ('2128263281', 'SFR') on conflict do nothing`)
    const db = pgSupabase(env.db.trackPool(gatewayPool(env.url, ORG)))
    app = await buildApp({ env: httpEnv(), db, scrub: false, auditSink: (r) => events.push(r) })
    listener = await startHttp({ app })
    const sterling = await client(listener.url, svc, 'agt_sterling')
    const scout = await client(listener.url, svc, 'agt_scout')
    const bare = await client(listener.url, svc)

    const d = await sterling.callTool({ name: 'create_campaign_draft', arguments: { client_request_id: 'e2e-draft-0001', name: 'E2E pinned', property_ids: ['2128263281'], thread_ids: [t.thread_id] } })
    assert.equal(d.isError, false, JSON.stringify(json(d)))
    assert.deepEqual([json(d).code, json(d).result.status, json(d).result.pinned_properties], ['CAMPAIGN_DRAFT_CREATED', 'draft', 2])
    const id = json(d).result.campaign_id
    const back = await sterling.callTool({ name: 'get_campaign', arguments: { campaign_id: id } })
    assert.deepEqual([json(back).result.campaign.campaign_id, json(back).result.campaign.status, json(back).result.campaign.drafted_by_agent], [id, 'draft', 'agt_sterling'])
    const again = await sterling.callTool({ name: 'create_campaign_draft', arguments: { client_request_id: 'e2e-draft-0001', name: 'E2E pinned', property_ids: ['2128263281'], thread_ids: [t.thread_id] } })
    assert.deepEqual([json(again).status, json(again).result.campaign_id], ['replayed', id])

    const st = await scout.callTool({ name: 'get_record_state', arguments: { thread_id: t.thread_id } })
    assert.equal(st.isError, false, JSON.stringify(json(st)))
    const ch = await sterling.callTool({ name: 'apply_record_change', arguments: { client_request_id: 'e2e-rc-000001', thread_id: t.thread_id, field: 'temperature', value: 'warm', expected_version: 0, evidence: { source: 'seller_message' }, reason: 'seller engaged' } })
    assert.equal(json(ch).status, 'succeeded', JSON.stringify(json(ch)))
    assert.equal((await sel(env.owner, 'select via_service_id from action_gateway.action_authorizations where intent_id = $1', [json(ch).intent_id]))[0].via_service_id, 'svc_agntei')

    // scout's OWN grants: no draft capability
    assert.equal(json(await scout.callTool({ name: 'create_campaign_draft', arguments: { client_request_id: 'e2e-draft-0002', name: 'Scout tries', property_ids: ['2128263281'] } })).error.code, 'CAPABILITY_NOT_GRANTED')
    // the header alone (no signature) and a header naming sterling signed by scout's key: both refused over real HTTP
    const unsigned = await client(listener.url, svc, 'agt_sterling', { sign: false })
    assert.equal(json(await unsigned.callTool({ name: 'get_campaign', arguments: { campaign_id: id } })).error.code, 'ACTING_ASSERTION_REQUIRED')
    const impostor = await client(listener.url, svc, 'agt_sterling', { signAs: 'agt_scout' })
    assert.equal(json(await impostor.callTool({ name: 'get_campaign', arguments: { campaign_id: id } })).error.code, 'ACTING_ASSERTION_INVALID')
    await unsigned.close(); await impostor.close()
    // no header: the service never acts as itself
    assert.equal(json(await bare.callTool({ name: 'get_campaign', arguments: { campaign_id: id } })).error.code, 'ACTING_AGENT_REQUIRED')
    // identity in arguments stays refused
    assert.equal(json(await sterling.callTool({ name: 'get_campaign', arguments: { campaign_id: id, agent_id: 'agt_scout' } })).error.code, 'FORGED_CONTEXT')
    // a non-delegate cannot even open a session with the service credential
    await assert.rejects(client(listener.url, svc, 'agt_outsider'), /401|Unauthorized/)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.campaigns`))[0].n, 1)
    assert.ok(events.some((e) => e.via_service_id === 'svc_agntei'), 'the host audit names the service')
    assert.ok(!JSON.stringify(events).includes(svc), 'the service credential never reaches an audit line')
    for (const c of [sterling, scout, bare]) await c.close()
  } finally {
    await listener?.close()
    await app?.close()
    await env.db.drop()
  }
})
