// Service principals + campaign drafts, unit proofs (no database): ONE service credential acting for its delegate
// agents. The acting agent comes ONLY from the X-LC-Acting-Agent header (call({ actingAgent })); identity in arguments
// stays refused; the agent's own grants apply with the effective ceiling min(agent, service); a missing / malformed /
// unknown / non-delegated / disabled acting agent is refused with its own code; revocation answers on the next request;
// the audit names the service. The database half (authorization_guard, the delegate registry, the draft writer) is
// proven in action-gateway-service-principal-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createActionGateway } from '../../src/lib/domain/action-gateway/gateway.js'
import { createActionCatalog, CAMPAIGN_TOOLS, ACTIONS, READS } from '../../src/lib/domain/action-gateway/catalog.js'
import { credentialDigest, serviceCredentialDigest, mintServiceCredential, mintAgentCredential, credentialKind, SERVICE_CREDENTIAL_RE, AGENT_CREDENTIAL_RE } from '../../src/lib/domain/action-gateway/credentials.js'
import { FORGED_CONTEXT_KEYS, ACTING_AGENT_HEADER } from '../../src/lib/domain/action-gateway/constants.js'
import { classifyGatewayError } from '../../src/lib/domain/action-gateway/errors.js'
import { STRATEGY_STAGE, campaignView, CREATE_DRAFT_SPEC } from '../../src/lib/domain/action-gateway/actions/campaigns/index.js'
import { newAssertionKeyPair, signActingAssertion } from '../../src/lib/domain/action-gateway/acting-assertion.js'

/** Each delegate's registered key pair (the integration holds the private half and signs every call with it). */
const KEYS = Object.fromEntries(['agt_sterling', 'agt_scout', 'agt_outsider', 'agt_paused'].map((a) => [a, newAssertionKeyPair()]))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PEPPER = 'p'.repeat(40)
const ORG = '00000000-0000-4000-8000-0000000000c1'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c2'
const CAMPAIGN = '7b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'
const future = () => new Date(Date.now() + 86_400_000).toISOString()
const past = () => new Date(Date.now() - 1000).toISOString()

function grant(capability, max_tier = 1, extra = {}) {
  return { grant_id: `g-${capability}`, capability, grant_version: 1, max_tier, scope: {}, envelope: {}, valid_from: past(), expires_at: future(), suspended_reason: null, ...extra }
}
function agent(agent_id, { tier_ceiling = 2, grants = [], read_scopes = ['conversation_context.read'], status = 'active', org_id = ORG, sponsor_is_member = true } = {}) {
  return { agent_id, org_id, display_name: agent_id, sponsor_user_id: 'u', tier_ceiling, read_scopes, status, credential_expires_at: future(), sponsor_is_member, grants }
}

/** A memory store: the service registry + delegates + agents, every audit row, every opened intent. */
function world({ serviceCeiling = 2 } = {}) {
  const svc = mintServiceCredential(PEPPER)
  const own = mintAgentCredential(PEPPER)
  const agents = {
    agt_sterling: agent('agt_sterling', { tier_ceiling: 3, grants: [grant('campaigns.read'), grant('campaigns.create_draft'), grant('records.apply_change', 2), grant('conversation.queue_agent_text', 3, { standing_seller_facing: true })] }),
    agt_scout: agent('agt_scout', { tier_ceiling: 1, grants: [grant('tasks.create_operator_task')] }),
    agt_outsider: agent('agt_outsider', { grants: [grant('campaigns.read')] }),
    agt_paused: agent('agt_paused', { grants: [grant('campaigns.read')] }),
  }
  const service = { service_id: 'svc_agntei', org_id: ORG, display_name: 'agntei', sponsor_user_id: 'u', tier_ceiling: serviceCeiling, status: 'active', credential_expires_at: future(), sponsor_is_member: true }
  const delegates = { agt_sterling: true, agt_scout: true, agt_paused: false }
  const audits = []
  const intents = []
  const store = {
    async controls() { return { enabled: true, tiers: new Set(['T1', 'T2', 'T3']), killed: new Set(), org: ORG } },
    async principal(digest) { return digest === credentialDigest(PEPPER, own.token) ? { ...agents.agt_scout } : null },
    async servicePrincipal(digest, acting) {
      if (digest !== serviceCredentialDigest(PEPPER, svc.token)) return null
      const s = { ...service, delegates: Object.keys(delegates).filter((k) => delegates[k]) }
      if (acting == null) return { service: s, acting_status: 'none', agent: null }
      if (!agents[acting]) return { service: s, acting_status: 'unknown_agent', agent: null }
      if (!(acting in delegates)) return { service: s, acting_status: 'not_delegated', agent: null }
      if (!delegates[acting]) return { service: s, acting_status: 'delegate_disabled', agent: null }
      return { service: s, acting_status: 'ok', agent: { ...agents[acting] }, assertion_key: KEYS[acting].publicKey }
    },
    async audit(ev) { audits.push(ev); return true },
    async openIntent(row) {
      intents.push(row)
      // a recorded terminal outcome: the call ends as a replay (the PG suite runs the whole path)
      return { inserted: true, intent: { intent_id: `i-${intents.length}`, params_hash: row.params_hash, state: 'succeeded' } }
    },
    async getIntent(id) { return { intent: { intent_id: id, state: 'succeeded' }, outcome: { code: 'CAMPAIGN_DRAFT_CREATED', result: { campaign_id: CAMPAIGN, status: 'draft' } } } },
  }
  const reads = {
    async thread(id) { return id === '11111111-1111-4111-8111-111111111111' ? { id, thread_key: '+13125550150', property_id: '2128263281', market: 'Chicago' } : null },
    async properties(ids) { return ids.filter((x) => ['2128263281', 'p150'].includes(x)).map((property_id) => ({ property_id })) },
    async audienceEligibility(ids) { return ids.map((property_id) => ({ property_id, thread_id: null, reasons: [] })) },
    async permission() { return { blocked: false, reasons: [] } },
    async campaign(id) { return id === CAMPAIGN ? { id, name: 'Oak St pinned', status: 'draft', created_at: past(), metadata: { template_use_case: 'ownership_check', stage_code: 'S1', target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: ['2128263281'] }] }, composer_source: { kind: 'action_gateway', agent_id: 'agt_sterling' } } } : null },
  }
  const raw = createActionGateway({ store, reads, services: { holdCheck: async () => ({ held: false }) }, pepper: PEPPER, dataOrgId: ORG })
  // the integration's side: a service call naming a delegate is signed with that delegate's key over the exact call
  const gateway = { ...raw, call: (o) => raw.call(o.credential === svc.token && typeof o.actingAgent === 'string' && KEYS[o.actingAgent] && o.actingAssertion === undefined
    ? { ...o, actingAssertion: signActingAssertion({ privateKey: KEYS[o.actingAgent].privateKey, agent: o.actingAgent, tool: o.tool, args: o.args }) } : o) }
  return { gateway, svc: svc.token, own: own.token, agents, service, delegates, audits, intents }
}
const READ = { tool: 'get_campaign', args: { campaign_id: CAMPAIGN } }
const DRAFT = (k = 'draft-0000001') => ({ tool: 'create_campaign_draft', args: { client_request_id: k, name: 'Oak St pinned', property_ids: ['2128263281'], thread_ids: ['11111111-1111-4111-8111-111111111111'] } })

test('credentials: a service credential is lcsvc_ + 43 base64url chars, digested with the same pepper; never an agent credential (and vice versa)', () => {
  const s = mintServiceCredential(PEPPER)
  assert.match(s.token, SERVICE_CREDENTIAL_RE)
  assert.ok(!AGENT_CREDENTIAL_RE.test(s.token))
  assert.equal(s.digest, serviceCredentialDigest(PEPPER, s.token))
  assert.match(s.digest, /^[0-9a-f]{64}$/)
  assert.equal(credentialDigest(PEPPER, s.token), null, 'a service credential is not accepted as an agent credential')
  const a = mintAgentCredential(PEPPER)
  assert.equal(serviceCredentialDigest(PEPPER, a.token), null)
  assert.deepEqual([credentialKind(s.token), credentialKind(a.token), credentialKind('x'), credentialKind(null)], ['service', 'agent', null, null])
  assert.equal(ACTING_AGENT_HEADER, 'x-lc-acting-agent')
  for (const k of ['agent', 'agent_id', 'acting_agent', 'principal', 'on_behalf_of', 'actor']) assert.ok(FORGED_CONTEXT_KEYS.test(k), k)
})

test('a service credential + an ENABLED delegate acts with THAT agent\'s own grants; the intent is the agent\'s; the audit names the service', async () => {
  const w = world()
  const r = await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.result.campaign.campaign_id, CAMPAIGN)
  assert.equal(r.result.campaign.status, 'draft')
  const d = await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...DRAFT() })
  assert.equal(d.ok, true, JSON.stringify(d))
  assert.equal(w.intents.length, 1)
  assert.equal(w.intents[0].agent_id, 'agt_sterling', 'the intent belongs to the acting agent')
  assert.deepEqual(w.intents[0].params.property_refs, ['pid_ihioimjioh'], 'the lead and the property collapse to one pinned property, stored encoded')
  assert.equal(w.intents[0].params.status, 'draft')
  const read = w.audits.find((a) => a.event_type === 'action_read')
  assert.equal(read.agent_id, 'agt_sterling')
  assert.equal(read.detail.via_service_id, 'svc_agntei')
  const del = w.audits.find((a) => a.event_type === 'delegated_intent')
  assert.deepEqual([del.agent_id, del.detail.via_service_id, del.intent_id], ['agt_sterling', 'svc_agntei', 'i-1'])
  // a scout grant does not leak: sterling has no tasks grant
  const t = await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', tool: 'create_operator_task', args: { client_request_id: 'task-0000001', title: 'hello there' } })
  assert.equal(t.error.code, 'CAPABILITY_NOT_GRANTED')
})

test('refusals: missing header, malformed header, unknown agent, non-delegate, disabled delegate, another tenant\'s service; each with its own code and audited with the service', async () => {
  const w = world()
  const code = async (actingAgent, x = READ) => (await w.gateway.call({ credential: w.svc, ...(actingAgent === undefined ? {} : { actingAgent }), ...x })).error?.code
  assert.equal(await code(undefined), 'ACTING_AGENT_REQUIRED')
  assert.equal(await code(undefined, DRAFT()), 'ACTING_AGENT_REQUIRED', 'a service never acts as itself for a write')
  assert.equal(await code(''), 'ACTING_AGENT_REQUIRED')
  assert.equal(await code('agt_sterling, agt_scout'), 'ACTING_AGENT_MALFORMED', 'a repeated header is refused')
  assert.equal(await code('svc_agntei'), 'ACTING_AGENT_MALFORMED', 'the service cannot name itself')
  assert.equal(await code('agt_nobody'), 'ACTING_AGENT_UNKNOWN')
  assert.equal(await code('agt_outsider'), 'ACTING_AGENT_NOT_DELEGATED')
  assert.equal(await code('agt_paused'), 'DELEGATE_DISABLED')
  assert.equal(w.intents.length, 0)
  const refused = w.audits.filter((a) => a.event_type === 'call_refused')
  assert.ok(refused.length >= 7 && refused.every((a) => a.detail.via_service_id === 'svc_agntei'), 'every refusal names the service')
  // an unknown service credential
  const fake = mintServiceCredential(PEPPER).token
  assert.equal((await w.gateway.call({ credential: fake, actingAgent: 'agt_sterling', ...READ })).error.code, 'SERVICE_CREDENTIAL_UNKNOWN')
  // another tenant's service
  w.service.org_id = OTHER_ORG
  assert.equal(await code('agt_sterling'), 'CROSS_TENANT')
})

test('identity in arguments stays refused for a service credential (FORGED_CONTEXT), header or not', async () => {
  const w = world()
  for (const k of ['agent_id', 'agent', 'acting_agent', 'principal_id', 'on_behalf_of']) {
    const r = await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', tool: 'create_campaign_draft', args: { ...DRAFT().args, [k]: 'agt_scout' } })
    assert.equal(r.error.code, 'FORGED_CONTEXT', k)
  }
  assert.equal(w.intents.length, 0)
})

test('tier = min(agent ceiling, service ceiling): a T2 grant of a T3 agent is refused through a T1 service and runs through a T2 one; a T1-ceiling agent stays T1 through a T2 service', async () => {
  const RC = { tool: 'apply_record_change', args: { client_request_id: 'rc-00000001', thread_id: '11111111-1111-4111-8111-111111111111', field: 'temperature', value: 'warm', expected_version: 0, evidence: { source: 'seller_message' }, reason: 'routine update' } }
  const low = world({ serviceCeiling: 1 })
  const r = await low.gateway.call({ credential: low.svc, actingAgent: 'agt_sterling', ...RC })
  assert.equal(r.error.code, 'TIER_ABOVE_CEILING', JSON.stringify(r.error))
  assert.match(r.error.message, /effective/)
  assert.equal((await low.gateway.whoami(low.svc, { actingAgent: 'agt_sterling' })).tier_ceiling, 'T1')
  const w = world({ serviceCeiling: 2 })
  const who = await w.gateway.whoami(w.svc, { actingAgent: 'agt_sterling' })
  assert.deepEqual([who.kind, who.service.service_id, who.agent_id, who.tier_ceiling, who.acting_agent.agent_tier_ceiling, who.service.tier_ceiling], ['service', 'svc_agntei', 'agt_sterling', 'T2', 'T3', 'T2'])
  const scout = await w.gateway.whoami(w.svc, { actingAgent: 'agt_scout' })
  assert.equal(scout.tier_ceiling, 'T1')
  const r2 = await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...RC })
  assert.equal(r2.ok, true, `a T2 action runs through a T2 service: ${JSON.stringify(r2.error || null)}`)
  assert.equal(w.intents.at(-1).agent_id, 'agt_sterling')
})

test('whoami: kind service without a header (the service and its enabled delegates, no acting agent); kind agent for an agent credential; an agent credential naming ANOTHER agent is refused', async () => {
  const w = world()
  const s = await w.gateway.whoami(w.svc)
  assert.deepEqual([s.ok, s.kind, s.service.service_id, s.acting_agent, s.agent_id], [true, 'service', 'svc_agntei', null, null])
  assert.deepEqual(s.service.delegates, ['agt_sterling', 'agt_scout'])
  assert.ok(!JSON.stringify(s).includes(w.svc), 'the credential never comes back')
  const bad = await w.gateway.whoami(w.svc, { actingAgent: 'agt_outsider' })
  assert.deepEqual([bad.ok, bad.error.code], [false, 'ACTING_AGENT_NOT_DELEGATED'])
  const a = await w.gateway.whoami(w.own)
  assert.deepEqual([a.ok, a.kind, a.agent_id], [true, 'agent', 'agt_scout'])
  assert.equal((await w.gateway.whoami(w.own, { actingAgent: 'agt_scout' })).ok, true, 'naming itself is fine')
  const other = await w.gateway.call({ credential: w.own, actingAgent: 'agt_sterling', tool: 'create_operator_task', args: { client_request_id: 'task-0000002', title: 'hello there' } })
  assert.equal(other.error.code, 'ACTING_AGENT_NOT_ALLOWED')
})

test('revocation answers on the NEXT request: disabling the delegate, then suspending / revoking / expiring the service, or the sponsor leaving', async () => {
  const w = world()
  assert.equal((await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })).ok, true)
  w.delegates.agt_sterling = false
  assert.equal((await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })).error.code, 'DELEGATE_DISABLED')
  w.delegates.agt_sterling = true
  assert.equal((await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })).ok, true)
  w.service.sponsor_is_member = false
  assert.equal((await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })).error.code, 'SERVICE_SPONSOR_NOT_MEMBER')
  w.service.sponsor_is_member = true
  w.service.credential_expires_at = past()
  assert.equal((await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })).error.code, 'SERVICE_CREDENTIAL_EXPIRED')
  w.service.credential_expires_at = future()
  w.service.status = 'revoked'
  const r = await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })
  assert.deepEqual([r.error.class, r.error.code], ['unauthenticated', 'SERVICE_PRINCIPAL_REVOKED'])
  // the acting agent's own state still counts: a suspended agent is refused through the service too
  w.service.status = 'active'
  w.agents.agt_sterling.status = 'suspended'
  assert.equal((await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', ...READ })).error.code, 'PRINCIPAL_SUSPENDED')
})

test('the Workforce tools bind the employee to the agent\'s own credential: refused through a service (SERVICE_DELEGATION_UNSUPPORTED)', async () => {
  const w = world()
  const r = await w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', tool: 'workforce_whoami', args: {} })
  assert.equal(r.error.code, 'SERVICE_DELEGATION_UNSUPPORTED')
})

test('campaign drafts: T1 internal write of the ONE draft writer; closed schema; draft-only params; validation refusals; no launch / schedule / send path anywhere in the catalog', async () => {
  const c = createActionCatalog()
  assert.deepEqual([...CAMPAIGN_TOOLS].sort(), ['create_campaign_draft', 'get_campaign'])
  const d = c.get('create_campaign_draft')
  assert.deepEqual([d.tier, d.capability, d.executor.kind, d.executor.fn, d.reversible ?? null, d.standing_reply ?? null], [1, 'campaigns.create_draft', 'domain_write', 'action_gateway_dw_campaign_draft', null, null])
  assert.equal(d, c.get(CREATE_DRAFT_SPEC.name))
  assert.equal(d.input.additionalProperties, false)
  for (const k of Object.keys(d.input.properties)) assert.ok(!/(status|launch|start|schedule|send|activate|auto_)/.test(k), `no launch-ish argument: ${k}`)
  const g = c.get('get_campaign')
  assert.deepEqual([g.tier, g.capability, g.scope, c.isRead('get_campaign')], [1, 'campaigns.read', null, true])
  // nothing in the gateway catalog launches, schedules, activates or resumes a campaign by itself
  for (const s of [...ACTIONS, ...READS]) assert.ok(!/(launch|activate|schedule_campaign|start_campaign|send_campaign)/.test(s.name), s.name)
  // the only other campaign writes: pause (a safety stop) and a resume REQUEST a human decides
  assert.equal(c.get('request_campaign_resume').request_only, true)
  // the strategies and stage codes are the Composer's own
  const composer = fs.readFileSync(path.resolve(HERE, '../../src/lib/domain/campaigns/campaign-composer.js'), 'utf8')
  for (const [uc, stage] of Object.entries(STRATEGY_STAGE)) assert.ok(composer.includes(`{ use_case: '${uc}', stage_code: '${stage}'`), uc)
  const w = world()
  const call = (args) => w.gateway.call({ credential: w.svc, actingAgent: 'agt_sterling', tool: 'create_campaign_draft', args: { client_request_id: 'draft-0000009', name: 'Oak St pinned', ...args } })
  assert.equal((await call({})).error.code, 'AUDIENCE_REQUIRED')
  assert.equal((await call({ property_ids: ['999'] })).error.code, 'PROPERTY_NOT_FOUND')
  assert.equal((await call({ thread_ids: ['22222222-2222-4222-8222-222222222222'] })).error.code, 'THREAD_NOT_FOUND')
  assert.equal((await call({ property_ids: Array.from({ length: 201 }, (_, i) => `p${i}`) })).error.code, 'INPUT_INVALID')
  assert.equal((await call({ property_ids: ['p150'], status: 'active' })).error.code, 'INPUT_INVALID', 'no status argument exists')
  assert.equal(w.intents.length, 0)
  // the read-back projection: ids, codes and counts only
  const v = campaignView({ id: CAMPAIGN, name: 'Call 312 555 0161 list', status: 'Draft', metadata: { target_filters: { properties: [{ field_key: 'properties.property_id', value: ['1', '2'] }] }, composer_source: { kind: 'action_gateway', agent_id: 'agt_sterling' } } })
  assert.deepEqual([v.campaign_id, v.status, v.is_draft, v.pinned_properties, v.drafted_through_gateway, v.drafted_by_agent, v.launch], [CAMPAIGN, 'draft', true, 2, true, 'agt_sterling', 'human_only'])
  assert.ok(!/312/.test(v.name), 'a phone in a name is masked')
})

test('classifyGatewayError: the database\'s delegated-authorization refusals keep their class', () => {
  assert.deepEqual(classifyGatewayError(new Error('ACTION_GATEWAY_DELEGATE_NOT_ENABLED: x')).toJSON().class, 'forbidden')
  assert.deepEqual(classifyGatewayError(new Error('ACTION_GATEWAY_SERVICE_INACTIVE')).toJSON().class, 'unauthenticated')
  assert.deepEqual(classifyGatewayError(new Error('ACTION_GATEWAY_SERVICE_SPONSOR_NOT_MEMBER')).toJSON().class, 'unauthenticated')
})
