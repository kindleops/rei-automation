// Service principals with delegated agents + campaign drafts (PROPOSED_20261105120000_action_gateway_service_principals)
// END TO END on a DISPOSABLE PostgreSQL 17: the whole gateway chain (#26 to link 10) + this link, every call through the
// database entry points AS lc_action_gateway, every write through a lease-bound definer function. Proven against the rows:
//   * ONE service credential acts for its ENABLED delegates with each agent's OWN grants (record sync, campaign drafts);
//     the authorization row names the agent AND the service (via_service_id); the audit trail names both;
//   * a missing / unknown / non-delegated / disabled acting agent is refused; identity in arguments stays refused;
//   * the effective tier is min(agent, service), in the gateway AND in the database's authorization guard (which also
//     re-verifies the delegation itself: a delegate disabled between the gateway's check and the authorization is refused);
//   * disabling a delegate or revoking the service answers on the very next request; a delegate-only agent (no credential
//     of its own) acts only through the service;
//   * create_campaign_draft makes ONE draft (replay = same campaign), read back by get_campaign; nothing is built,
//     scheduled, queued or sent, and no gateway entry point can launch a campaign;
//   * the owner script mints the credential once and administers delegates; the rollback refuses over delegated evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pgAvailable, skipReason, applyInTransaction } from '../pg/agent-pg-harness.mjs'
import { servicePrincipalDb, registerService, SP_ROLLBACK, SP_LINK } from '../helpers/service-principal-pg.mjs'
import { makeGateway, seedThread, sel, registerAgent, PEPPER, ORG, OWNER, OPERATOR } from '../helpers/action-gateway-pg.mjs'
import { seedT34, setControls, crypto } from '../helpers/action-gateway-t34-world.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { main as mintService, WARNING } from '../../../../mcp/leadcommand-action-mcp/scripts/mint-service-credential.mjs'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const RECORD_GRANTS = [['records.read', 1], ['records.apply_change', 2]]
const CAMPAIGN_GRANTS = [['campaigns.create_draft', 1], ['campaigns.read', 1]]
const key = (p) => `${p}-${crypto.randomUUID().slice(0, 8)}`
const as = (gateway, credential, actingAgent) => (tool, args) => gateway.call({ credential, ...(actingAgent === undefined ? {} : { actingAgent }), tool, args })

async function world({ serviceCeiling = 2 } = {}) {
  const env = await servicePrincipalDb()
  await seedT34(env)
  await setControls(env.owner, {})
  const own = {
    sterling: await registerAgent(env.owner, { agent_id: 'agt_sterling', grants: [...RECORD_GRANTS, ...CAMPAIGN_GRANTS], tier_ceiling: 3, read_scopes: ['conversation_context.read'] }),
    scout: await registerAgent(env.owner, { agent_id: 'agt_scout', grants: [['records.read', 1]], tier_ceiling: 1, read_scopes: ['conversation_context.read'] }),
    outsider: await registerAgent(env.owner, { agent_id: 'agt_outsider', grants: [...RECORD_GRANTS, ...CAMPAIGN_GRANTS], tier_ceiling: 2, read_scopes: ['conversation_context.read'] }),
  }
  const svc = await registerService(env.owner, { tier_ceiling: serviceCeiling, delegates: ['agt_sterling', 'agt_scout'] })
  const t = await seedThread(env.owner, { phone: '+13125550150', property: 'p150' })
  await env.owner.query(`insert into public.acquisition_opportunities (dedupe_key, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, market) values ($1, 'p150', $2, 'ownership_confirmation', 'active', 'Chicago')`, [`opp:${t.phone}`, t.phone])
  await env.owner.query(`insert into public.properties (property_id, property_type) values ('2128263281', 'SFR'), ('2128263282', 'SFR') on conflict do nothing`)
  const g = makeGateway(env)
  return { env, own, svc, t, ...g }
}
const version = async (env, thread, field) => Number((await sel(env.owner, `select version from lc_sync.field_versions where entity = 'thread' and entity_id = $1 and field = $2`, [thread, field]))[0]?.version ?? 0)
const RC = (t, field, value, expected_version) => ({ client_request_id: key('rc'), thread_id: t.thread_id, field, value, expected_version, evidence: { source: 'seller_message', quote: 'I might sell', at: new Date().toISOString() }, reason: 'routine pipeline maintenance' })

test('PG service principal: ONE service credential + an enabled delegate acts with THAT agent\'s own grants; authorization and audit name the agent AND the service; record sync tools work through it', { skip }, async () => {
  const { env, svc, own, t, gateway } = await world()
  try {
    const sterling = as(gateway, svc, 'agt_sterling')
    const s = await sterling('get_record_state', { thread_id: t.thread_id })
    assert.equal(s.ok, true, JSON.stringify(s))
    const r = await sterling('apply_record_change', RC(t, 'temperature', 'warm', await version(env, t.thread_id, 'temperature')))
    assert.equal(r.status, 'succeeded', JSON.stringify(r))
    const auth = (await sel(env.owner, 'select * from action_gateway.action_authorizations where intent_id = $1', [r.intent_id]))[0]
    assert.deepEqual([auth.agent_id, auth.via_service_id, auth.sponsor_user_id], ['agt_sterling', 'svc_agntei', OPERATOR], 'the ledger names the acting agent, the service and the agent\'s sponsor')
    const intent = (await sel(env.owner, 'select agent_id from action_gateway.action_intents where intent_id = $1', [r.intent_id]))[0]
    assert.equal(intent.agent_id, 'agt_sterling')
    const ev = await sel(env.owner, 'select event_type, agent_id, detail from action_gateway.action_audit_events where intent_id = $1 order by event_id', [r.intent_id])
    const del = ev.find((e) => e.event_type === 'delegated_intent')
    assert.deepEqual([del.agent_id, del.detail.via_service_id], ['agt_sterling', 'svc_agntei'])
    for (const e of ['intent_opened', 'authorized', 'claimed', 'intent_succeeded']) assert.ok(ev.some((x) => x.event_type === e && x.agent_id === 'agt_sterling'), e)
    const reads = await sel(env.owner, `select agent_id, detail from action_gateway.action_audit_events where event_type = 'action_read'`)
    assert.ok(reads.some((x) => x.agent_id === 'agt_sterling' && x.detail.via_service_id === 'svc_agntei'), 'reads name the service too')
    // the agent's own grants, nothing more: scout holds records.read only
    const scoutWrite = await as(gateway, svc, 'agt_scout')('apply_record_change', RC(t, 'temperature', 'hot', await version(env, t.thread_id, 'temperature')))
    assert.equal(scoutWrite.error?.code, 'TIER_ABOVE_CEILING', 'scout\'s own T1 ceiling holds through a T2 service')
    assert.equal((await as(gateway, svc, 'agt_scout')('create_campaign_draft', { client_request_id: key('draft'), name: 'Not granted', property_ids: ['2128263281'] })).error.code, 'CAPABILITY_NOT_GRANTED')
    // the agent's own credential keeps working beside the service (not via a service: via_service_id null)
    const direct = await gateway.call({ credential: own.sterling, tool: 'apply_record_change', args: RC(t, 'temperature', 'hot', await version(env, t.thread_id, 'temperature')) })
    assert.equal(direct.status, 'succeeded', JSON.stringify(direct))
    assert.equal((await sel(env.owner, 'select via_service_id from action_gateway.action_authorizations where intent_id = $1', [direct.intent_id]))[0].via_service_id, null)
    // whoami: kind service, the service and the acting agent with its effective ceiling
    const who = await gateway.whoami(svc, { actingAgent: 'agt_sterling' })
    assert.deepEqual([who.kind, who.service.service_id, who.agent_id, who.tier_ceiling, who.acting_agent.agent_tier_ceiling], ['service', 'svc_agntei', 'agt_sterling', 'T2', 'T3'])
    const bare = await gateway.whoami(svc)
    assert.deepEqual([bare.kind, bare.acting_agent, bare.service.delegates], ['service', null, ['agt_scout', 'agt_sterling']])
  } finally { await env.db.drop() }
})

test('PG service principal: missing header, unknown agent, non-delegate, disabled delegate and identity in arguments are refused; nothing is opened', { skip }, async () => {
  const { env, svc, t, gateway } = await world()
  try {
    const intents = async () => Number((await sel(env.owner, 'select count(*) n from action_gateway.action_intents'))[0].n)
    const args = () => RC(t, 'temperature', 'warm', 0)
    assert.equal((await as(gateway, svc)('apply_record_change', args())).error.code, 'ACTING_AGENT_REQUIRED')
    assert.equal((await as(gateway, svc)('get_record_state', { thread_id: t.thread_id })).error.code, 'ACTING_AGENT_REQUIRED')
    assert.equal((await as(gateway, svc, 'agt_nobody')('apply_record_change', args())).error.code, 'ACTING_AGENT_UNKNOWN')
    assert.equal((await as(gateway, svc, 'agt_outsider')('apply_record_change', args())).error.code, 'ACTING_AGENT_NOT_DELEGATED')
    assert.equal((await as(gateway, svc, 'agt_sterling, agt_scout')('apply_record_change', args())).error.code, 'ACTING_AGENT_MALFORMED')
    for (const k of ['agent_id', 'acting_agent', 'principal_id', 'on_behalf_of']) {
      const r = await as(gateway, svc, 'agt_sterling')('apply_record_change', { ...args(), [k]: 'agt_outsider' })
      assert.equal(r.error.code, 'FORGED_CONTEXT', k)
    }
    await env.owner.query(`update action_gateway.service_delegates set enabled = false, disabled_at = now(), disabled_by = $1 where agent_principal_id = 'agt_sterling'`, [OWNER])
    assert.equal((await as(gateway, svc, 'agt_sterling')('apply_record_change', args())).error.code, 'DELEGATE_DISABLED')
    assert.equal(await intents(), 0)
    const refused = await sel(env.owner, `select agent_id, code, detail from action_gateway.action_audit_events where event_type = 'call_refused'`)
    assert.ok(refused.length >= 9 && refused.every((e) => e.detail.via_service_id === 'svc_agntei'), 'every refusal is audited with the service')
  } finally { await env.db.drop() }
})

test('PG service principal: effective tier = min(agent, service) in the gateway; the DATABASE guard re-verifies the delegation and the service ceiling at authorization', { skip }, async () => {
  const low = await world({ serviceCeiling: 1 })
  try {
    const r = await as(low.gateway, low.svc, 'agt_sterling')('apply_record_change', RC(low.t, 'temperature', 'warm', 0))
    assert.equal(r.error.code, 'TIER_ABOVE_CEILING', 'a T2 write of a T3 agent through a T1 service')
    assert.equal((await as(low.gateway, low.svc, 'agt_sterling')('get_record_state', { thread_id: low.t.thread_id })).ok, true, 'T1 reads still pass')
  } finally { await low.env.db.drop() }
  const w = await world({ serviceCeiling: 2 })
  try {
    // the gateway's own checks pass; the delegation is disabled before the database authorizes: refused BY THE DATABASE
    let flip = null
    const g1 = makeGateway(w.env, { wrapStore: (s) => ({ ...s, authorize: async (...a) => { if (flip) await flip(); return s.authorize(...a) } }) })
    flip = () => w.env.owner.query(`update action_gateway.service_delegates set enabled = false, disabled_at = now(), disabled_by = $1 where agent_principal_id = 'agt_sterling'`, [OWNER])
    const r1 = await as(g1.gateway, w.svc, 'agt_sterling')('apply_record_change', RC(w.t, 'temperature', 'warm', 0))
    assert.deepEqual([r1.error?.class, r1.error?.code], ['forbidden', 'DELEGATE_NOT_ENABLED'], JSON.stringify(r1))
    const i1 = (await sel(w.env.owner, 'select state, result_code from action_gateway.action_intents order by created_at desc limit 1'))[0]
    assert.deepEqual([i1.state, i1.result_code], ['refused', 'AUTHORIZATION_DELEGATE_NOT_ENABLED'])
    await w.env.owner.query(`update action_gateway.service_delegates set enabled = true, disabled_at = null, disabled_by = null where agent_principal_id = 'agt_sterling'`)
    // the service ceiling lowered between the gateway's check and the authorization: the DATABASE refuses the tier
    flip = () => w.env.owner.query(`update action_gateway.service_principals set tier_ceiling = 1 where service_id = 'svc_agntei'`)
    const r2 = await as(g1.gateway, w.svc, 'agt_sterling')('apply_record_change', RC(w.t, 'temperature', 'warm', 0))
    assert.deepEqual([r2.error?.class, r2.error?.code], ['forbidden', 'TIER_ABOVE_CEILING'], JSON.stringify(r2))
    assert.equal(Number((await sel(w.env.owner, 'select count(*) n from action_gateway.action_authorizations'))[0].n), 0, 'nothing was authorized')
  } finally { await w.env.db.drop() }
})

test('PG service principal: revocation answers on the next request (delegate disabled, re-enabled, service revoked); a delegate-only agent (no credential of its own) acts only through the service', { skip }, async () => {
  const { env, svc, t, gateway } = await world()
  try {
    const read = () => as(gateway, svc, 'agt_sterling')('get_record_state', { thread_id: t.thread_id })
    assert.equal((await read()).ok, true)
    await env.owner.query(`update action_gateway.service_delegates set enabled = false, disabled_at = now(), disabled_by = $1 where agent_principal_id = 'agt_sterling'`, [OWNER])
    assert.equal((await read()).error.code, 'DELEGATE_DISABLED')
    await env.owner.query(`update action_gateway.service_delegates set enabled = true, disabled_at = null, disabled_by = null where agent_principal_id = 'agt_sterling'`)
    assert.equal((await read()).ok, true)
    // a delegate-only agent: its own digest cleared; the service still acts for it, its old credential is dead
    const ownCred = await registerAgent(env.owner, { agent_id: 'agt_closer', grants: RECORD_GRANTS, tier_ceiling: 2, read_scopes: ['conversation_context.read'] })
    await env.owner.query(`update action_gateway.agent_principals set credential_digest = null, credential_rotated_at = clock_timestamp() where agent_id = 'agt_closer'`)
    await env.owner.query('insert into action_gateway.service_delegates (service_principal_id, agent_principal_id, org_id, created_by) values ($1, $2, $3, $4)', ['svc_agntei', 'agt_closer', ORG, OWNER])
    assert.equal((await gateway.call({ credential: ownCred, tool: 'get_record_state', args: { thread_id: t.thread_id } })).error.code, 'CREDENTIAL_UNKNOWN')
    const c = await as(gateway, svc, 'agt_closer')('apply_record_change', RC(t, 'temperature', 'warm', await version(env, t.thread_id, 'temperature')))
    assert.equal(c.status, 'succeeded', JSON.stringify(c))
    assert.equal((await sel(env.owner, 'select via_service_id from action_gateway.action_authorizations where intent_id = $1', [c.intent_id]))[0].via_service_id, 'svc_agntei')
    // the service revoked: the very next request is refused, for every delegate
    await env.owner.query(`update action_gateway.service_principals set status = 'revoked', revoked_at = now(), revoked_by = $1 where service_id = 'svc_agntei'`, [OWNER])
    for (const a of ['agt_sterling', 'agt_closer']) {
      const r = await as(gateway, svc, a)('get_record_state', { thread_id: t.thread_id })
      assert.deepEqual([r.error.class, r.error.code], ['unauthenticated', 'SERVICE_PRINCIPAL_REVOKED'], a)
    }
    assert.deepEqual([(await gateway.whoami(svc)).ok, (await gateway.whoami(svc)).error.code], [false, 'SERVICE_PRINCIPAL_REVOKED'])
    // registry rules: a revoked service is final; a delegate is never deleted; another org's agent is never a delegate
    await assert.rejects(env.owner.query(`update action_gateway.service_principals set status = 'active', revoked_at = null, revoked_by = null where service_id = 'svc_agntei'`), /REVOKED/)
    await assert.rejects(env.owner.query(`delete from action_gateway.service_delegates where agent_principal_id = 'agt_scout'`), /never deleted/)
    await assert.rejects(env.owner.query('insert into action_gateway.service_delegates (service_principal_id, agent_principal_id, org_id, created_by) values ($1, $2, $3, $4)', ['svc_agntei', 'agt_scout', ORG, OPERATOR]), /OWNER_ONLY|duplicate key/)
    // the gateway role reads neither registry
    const gwPool = makeGateway(env).pool
    for (const tbl of ['service_principals', 'service_delegates']) await assert.rejects(gwPool.query(`select * from action_gateway.${tbl}`), /permission denied/, tbl)
  } finally { await env.db.drop() }
})

test('PG campaign draft: create_campaign_draft (through the service) makes ONE draft pinned to the named properties and leads; a replay returns the same campaign; get_campaign reads it back; nothing is built, scheduled, queued or sent', { skip }, async () => {
  const { env, svc, t, gateway } = await world()
  try {
    const sterling = as(gateway, svc, 'agt_sterling')
    const queueBefore = Number((await sel(env.owner, 'select count(*) n from public.send_queue'))[0].n)
    const args = { client_request_id: key('draft'), name: 'Chicago pinned owners', template_use_case: 'consider_selling', property_ids: ['2128263281', '2128263282'], thread_ids: [t.thread_id], campaign_size: 'custom', total_cap: 3, daily_cap: 2 }
    const r = await sterling('create_campaign_draft', args)
    assert.equal(r.status, 'succeeded', JSON.stringify(r))
    assert.equal(r.code, 'CAMPAIGN_DRAFT_CREATED')
    const id = r.result.campaign_id
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.deepEqual([r.result.status, r.result.created, r.result.pinned_properties, r.result.stage_code, r.result.launch], ['draft', true, 3, 'S2', 'human_only'])
    const row = (await sel(env.owner, 'select * from public.campaigns where id = $1', [id]))[0]
    assert.deepEqual([row.name, row.status, row.objective, row.total_cap, row.daily_cap, row.auto_send_enabled, row.auto_reply_mode], ['Chicago pinned owners', 'draft', 'consider_selling', 3, 2, false, 'disabled'])
    assert.deepEqual(row.metadata.target_filters.properties, [{ field_key: 'properties.property_id', operator: 'is_any_of', value: ['2128263281', '2128263282', 'p150'] }])
    assert.deepEqual([row.metadata.composer_source.kind, row.metadata.composer_source.agent_id, row.metadata.composer_source.via_service_id, row.metadata.composer_campaign_size], ['action_gateway', 'agt_sterling', 'svc_agntei', 'custom'])
    assert.equal((await sel(env.owner, 'select count(*)::int n from public.campaign_filters where campaign_id = $1', [id]))[0].n, 1)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.campaign_events where campaign_id = $1 and event_type = 'campaign.created'`, [id]))[0].n, 1)
    // replay: same client_request_id -> the recorded outcome, the same campaign, no second row
    const again = await sterling('create_campaign_draft', args)
    assert.deepEqual([again.status, again.replayed, again.result.campaign_id], ['replayed', true, id])
    assert.equal((await sel(env.owner, `select count(*)::int n from public.campaigns where metadata ->> 'composer_key' like 'gateway:%'`))[0].n, 1)
    // the same key with other parameters is a conflict
    assert.equal((await sterling('create_campaign_draft', { ...args, name: 'Something else entirely' })).error.code, 'IDEMPOTENCY_KEY_REUSED')
    // read-back
    const back = await sterling('get_campaign', { campaign_id: id })
    assert.equal(back.ok, true, JSON.stringify(back))
    assert.deepEqual([back.result.campaign.campaign_id, back.result.campaign.status, back.result.campaign.is_draft, back.result.campaign.pinned_properties, back.result.campaign.drafted_by_agent, back.result.campaign.launch],
      [id, 'draft', true, 3, 'agt_sterling', 'human_only'])
    assert.equal((await sterling('get_campaign', { campaign_id: crypto.randomUUID() })).error.code, 'CAMPAIGN_NOT_FOUND')
    // refusals: an unknown property, no audience, custom size without a number
    assert.equal((await sterling('create_campaign_draft', { client_request_id: key('draft'), name: 'Nope list', property_ids: ['9999999999'] })).error.code, 'PROPERTY_NOT_FOUND')
    assert.equal((await sterling('create_campaign_draft', { client_request_id: key('draft'), name: 'Nope list' })).error.code, 'AUDIENCE_REQUIRED')
    const custom = await sterling('create_campaign_draft', { client_request_id: key('draft'), name: 'Custom size', property_ids: ['2128263281'], campaign_size: 'custom' })
    assert.deepEqual([custom.state, custom.code], ['refused', 'CAMPAIGN_SIZE_NUMBER_REQUIRED'])
    // nothing reached a seller: no queue row, no target, still a draft
    assert.equal(Number((await sel(env.owner, 'select count(*) n from public.send_queue'))[0].n), queueBefore)
    assert.equal((await sel(env.owner, 'select status from public.campaigns where id = $1', [id]))[0].status, 'draft')
    // a T1 draft writer, recorded; the outcome stores ids and counts only (no property ids, no phones)
    const out = (await sel(env.owner, 'select result from action_gateway.action_outcomes where intent_id = $1', [r.intent_id]))[0].result
    assert.ok(!JSON.stringify(out).includes('2128263281'))
  } finally { await env.db.drop() }
})

test('PG campaign draft: exactly once per intent inside the writer (a re-execution finds its draft); no gateway entry point launches, schedules or activates a campaign', { skip }, async () => {
  const { env, svc, gateway } = await world()
  try {
    const r = await as(gateway, svc, 'agt_sterling')('create_campaign_draft', { client_request_id: key('draft'), name: 'Once only', property_ids: ['2128263281'] })
    assert.equal(r.status, 'succeeded', JSON.stringify(r))
    // the writer's own idempotency: a second draft with the same composer key is found, not duplicated
    const keyOf = (await sel(env.owner, 'select metadata ->> \'composer_key\' k from public.campaigns where id = $1', [r.result.campaign_id]))[0].k
    const iKey = (await sel(env.owner, 'select idempotency_key from action_gateway.action_intents where intent_id = $1', [r.intent_id]))[0].idempotency_key
    assert.equal(keyOf, `gateway:${iKey.slice(0, 32)}`)
    // what the gateway role may execute: the draft writer and the pause writer are its ONLY definer campaign writers;
    // anything else campaign-shaped it can name runs with ITS rights (invoker) and it holds no write on public.campaigns
    const fns = await sel(env.owner, `select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where has_function_privilege('lc_action_gateway', p.oid, 'EXECUTE') and n.nspname in ('public', 'action_gateway') and p.proname ~ 'campaign'`)
    assert.deepEqual(fns.filter((f) => f.prosecdef).map((f) => f.proname).sort(), ['action_gateway_dw_campaign_draft', 'action_gateway_dw_campaign_pause'])
    for (const priv of ['INSERT', 'UPDATE', 'DELETE']) assert.equal((await sel(env.owner, `select has_table_privilege('lc_action_gateway', 'public.campaigns', $1) v`, [priv]))[0].v, false, priv)
    // and the Action MCP's transport allowlist names no campaign function but those two
    const { RPCS } = await import('../../../../mcp/leadcommand-action-mcp/src/data/inventory.mjs')
    assert.deepEqual(RPCS.filter((x) => /campaign/.test(x)).sort(), ['action_gateway_dw_campaign_draft', 'action_gateway_dw_campaign_pause'])
    // the lifecycle writer itself, called AS the gateway role on its own draft: refused by the database
    const gw = makeGateway(env).pool
    await assert.rejects(gw.query(`select public.campaign_transition_status($1::uuid, 'active', 'agent tries', null)`, [r.result.campaign_id]), /permission denied/)
    assert.equal((await sel(env.owner, 'select status from public.campaigns where id = $1', [r.result.campaign_id]))[0].status, 'draft')
    assert.ok(!(await sel(env.owner, `select 1 from pg_proc where proname = 'action_gateway_dw_campaign_draft' and prosrc ~* '(campaign_transition_status|send_queue|campaign_targets|campaign_launch|activated_at)'`)).length, 'the draft writer touches no lifecycle / queue / target')
    const self = (await sel(env.owner, `select action_gateway.self_check('lc_action_gateway') v`))[0].v
    assert.equal(self.ok, true, JSON.stringify(self.findings))
  } finally { await env.db.drop() }
})

test('PG mint-service-credential: creates the service + delegates (by id and by name), prints the credential ONCE with a warning; --list, --add-delegate, --disable-delegate, --revoke each answer on the next request', { skip }, async () => {
  const env = await servicePrincipalDb()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-svc-mint-'))
  try {
    await seedT34(env)
    await setControls(env.owner, {})
    await registerAgent(env.owner, { agent_id: 'agt_sterling', grants: CAMPAIGN_GRANTS, tier_ceiling: 2 })
    const ownScout = await registerAgent(env.owner, { agent_id: 'agt_scout', grants: CAMPAIGN_GRANTS, tier_ceiling: 2 })
    await env.owner.query(`update action_gateway.agent_principals set display_name = 'Scout Agent' where agent_id = 'agt_scout'`)
    await env.owner.query(`insert into public.properties (property_id, property_type) values ('2128263281', 'SFR') on conflict do nothing`)
    const pepperFile = path.join(dir, 'pepper')
    fs.writeFileSync(pepperFile, PEPPER, { mode: 0o600 })
    const run = async (...argv) => { const lines = []; await mintService(['--org', ORG, '--owner', OWNER, ...argv], { db: env.owner, out: (s) => lines.push(s) }); return lines.join('') }
    const printed = await run('--create', '--service-id', 'svc_agntei', '--sponsor', OPERATOR, '--tier-ceiling', '2', '--pepper-file', pepperFile, '--display-name', 'agntei acquisitions',
      '--delegate', 'agt_sterling', '--delegate', 'scout agent', '--days', '30')
    const tokens = printed.match(/lcsvc_[A-Za-z0-9_-]{43}/g)
    assert.equal(tokens.length, 1, 'the credential is printed exactly once')
    const token = tokens[0]
    assert.ok(printed.includes(WARNING))
    const summary = JSON.parse(printed.split('\n')[0])
    assert.deepEqual([summary.service_id, summary.tier_ceiling, summary.delegates.map((d) => d.agent_id)], ['svc_agntei', 'T2', ['agt_sterling', 'agt_scout']])
    assert.ok(!printed.split('\n')[0].includes(token), 'the JSON summary never carries the credential')
    const stored = (await sel(env.owner, 'select credential_digest from action_gateway.service_principals where service_id = $1', ['svc_agntei']))[0].credential_digest
    assert.match(stored, /^[0-9a-f]{64}$/)
    assert.notEqual(stored, token)
    // it works at once, for both delegates
    const { gateway } = makeGateway(env)
    const draft = (a) => as(gateway, token, a)('create_campaign_draft', { client_request_id: key('mint'), name: 'Minted draft', property_ids: ['2128263281'] })
    assert.equal((await draft('agt_sterling')).status, 'succeeded')
    assert.equal((await draft('agt_scout')).status, 'succeeded')
    // --list: no secrets, no digests
    const list = await run('--list')
    assert.ok(!list.includes(token) && !list.includes(stored))
    assert.deepEqual(JSON.parse(list).services[0].delegates.map((d) => [d.agent_id, d.enabled]), [['agt_scout', true], ['agt_sterling', true]])
    // --disable-delegate by name: refused on the next request; --add-delegate re-enables (and detaches the agent's own credential)
    assert.equal(JSON.parse(await run('--disable-delegate', 'Scout Agent', '--service-id', 'svc_agntei')).disabled, true)
    assert.equal((await draft('agt_scout')).error.code, 'DELEGATE_DISABLED')
    const added = JSON.parse(await run('--add-delegate', 'agt_scout', '--service-id', 'svc_agntei', '--detach-agent-credentials'))
    assert.deepEqual([added.delegate.agent_id, added.delegate.enabled, added.delegate.own_credential], ['agt_scout', true, false])
    assert.equal((await draft('agt_scout')).status, 'succeeded')
    assert.equal((await gateway.call({ credential: ownScout, tool: 'get_campaign', args: { campaign_id: crypto.randomUUID() } })).error.code, 'CREDENTIAL_UNKNOWN', 'the detached agent credential is dead')
    const scoutRow = (await sel(env.owner, `select credential_digest, credential_expires_at from action_gateway.agent_principals where agent_id = 'agt_scout'`))[0]
    const svcRow = (await sel(env.owner, `select credential_expires_at from action_gateway.service_principals where service_id = 'svc_agntei'`))[0]
    assert.deepEqual([scoutRow.credential_digest, scoutRow.credential_expires_at], [null, svcRow.credential_expires_at], 'a delegate-only agent is valid exactly as long as the service credential')
    // --revoke: final, the next request is refused
    assert.equal(JSON.parse(await run('--revoke', '--service-id', 'svc_agntei')).revoked, true)
    assert.equal((await draft('agt_sterling')).error.code, 'SERVICE_PRINCIPAL_REVOKED')
    // refusals: bad ids, unknown delegate, ambiguous usage
    await assert.rejects(run('--create', '--service-id', 'agntei', '--sponsor', OPERATOR, '--tier-ceiling', '2', '--pepper-file', pepperFile), /svc_/)
    await assert.rejects(run('--create', '--service-id', 'svc_two', '--sponsor', OPERATOR, '--tier-ceiling', '5', '--pepper-file', pepperFile), /tier-ceiling/)
    await assert.rejects(run('--create', '--service-id', 'svc_two', '--sponsor', OPERATOR, '--tier-ceiling', '2', '--pepper-file', pepperFile, '--delegate', 'agt_ghost'), /no agent principal/)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.service_principals where service_id = 'svc_two'`))[0].n, 0, 'a refused create leaves nothing behind')
    await assert.rejects(run('--list', '--revoke'), /usage/)
    await assert.rejects(mintService(['--org', ORG, '--owner', OWNER, '--list', '--database-url-file', path.resolve('x.url')]), /outside the repository|repository/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await env.db.drop() }
})

test('PG rollback: refuses over delegated authorization evidence; on a clean database it restores #28\'s guard and the NOT NULL agent digest, and the link re-applies', { skip }, async () => {
  const { env, svc, gateway } = await world()
  try {
    const r = await as(gateway, svc, 'agt_sterling')('create_campaign_draft', { client_request_id: key('draft'), name: 'Evidence draft', property_ids: ['2128263281'] })
    assert.equal(r.status, 'succeeded')
    await assert.rejects(applyInTransaction(env.owner, SP_ROLLBACK), /delegated authorizations exist/)
  } finally { await env.db.drop() }
  const clean = await servicePrincipalDb()
  try {
    await applyInTransaction(clean.owner, SP_ROLLBACK)
    assert.equal((await sel(clean.owner, `select to_regclass('action_gateway.service_principals') r`))[0].r, null)
    assert.equal((await sel(clean.owner, `select is_nullable from information_schema.columns where table_schema = 'action_gateway' and table_name = 'agent_principals' and column_name = 'credential_digest'`))[0].is_nullable, 'NO')
    const def = (await sel(clean.owner, `select pg_get_functiondef('action_gateway.authorization_guard()'::regprocedure) d`))[0].d
    assert.ok(def.includes('envelope_ref_refusal') && !def.includes('DELEGATE_NOT_ENABLED'))
    await applyInTransaction(clean.owner, SP_LINK)
    assert.equal((await sel(clean.owner, `select action_gateway.self_check('lc_action_gateway') ->> 'ok' ok`))[0].ok, 'true')
  } finally { await clean.db.drop() }
})
