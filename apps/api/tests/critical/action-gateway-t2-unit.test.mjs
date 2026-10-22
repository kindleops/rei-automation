// Action Gateway TIER-2, unit + static proofs (no database): the T2 catalog / standing-list mirror of link #27, the
// human-path capabilities (registrable, never model-facing, D1 in the production registry), the shared drift
// snapshot ≡ the decide path's, R1 (the stage route never takes a source / actor / offer event from the body),
// the pipeline capability's server-derived source, and the owner's pure rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACTIONS } from '../../src/lib/domain/action-gateway/catalog.js'
import { T2_SPECS, T2_STANDING } from '../../src/lib/domain/action-gateway/actions/t2/index.js'
import { normalizedStageRow, stageSnapshotOf, buildHumanRequest, REQUEST_CAPABILITIES } from '../../src/lib/domain/action-gateway/actions/t2/requests.js'
import { neverReviveCode, requestApprovalId, AGENT_DISPOSITIONS } from '../../src/lib/domain/action-gateway/actions/t2/shared.js'
import { planAdjustmentVerdict } from '../../src/lib/domain/action-gateway/actions/t2/adjust-campaign-plan.js'
import { dispositionRuleVerdict } from '../../src/lib/domain/action-gateway/actions/t2/update-lead-disposition.js'
import { createDefaultCapabilityRegistry, capabilityToolDefs, FIRST_CAPABILITIES } from '../../src/lib/agent/capabilities/index.js'
import { pipelineCapabilities } from '../../src/lib/agent/capabilities/defs/pipeline.js'
import { normalizeOpportunityRow } from '../../src/lib/domain/opportunity/opportunity-service.js'
import { stageTransitionInput, SERVER_OWNED_STAGE_FIELDS } from '../../src/lib/domain/opportunity/stage-route-input.js'
import { classifyProhibited } from '../../src/lib/agent/tools/prohibited.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const T2_SQL = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261020100000_action_gateway_t2.sql'), 'utf8')

test('T2 catalog: nine tools, all T2 and implemented; reversible = pause / cancel / schedule / deal action; request_only = the five human requests; none prohibited', () => {
  assert.equal(T2_SPECS.length, 9)
  for (const s of T2_SPECS) {
    const a = ACTIONS.find((x) => x.name === s.name)
    assert.ok(a && a.implemented !== false && a.tier === 2, s.name)
    assert.ok((a.reversible === true) !== (a.request_only === true), `${s.name}: exactly one standing basis`)
    assert.equal(classifyProhibited({ name: a.capability, touches: a.touches, wraps: a.wraps, input_schema: a.input }).prohibited, false, s.name)
  }
  assert.deepEqual(T2_STANDING.reversible, ['cancel_followup', 'create_deal_action', 'pause_campaign', 'schedule_followup'])
  assert.deepEqual(T2_STANDING.request_only, ['adjust_campaign_plan', 'request_campaign_resume', 'request_thread_hold_release', 'update_lead_disposition', 'update_lead_stage'])
  assert.deepEqual(Object.keys(REQUEST_CAPABILITIES).sort(), T2_STANDING.request_only)
})

test('T2 mirror: the migration registers exactly the JS standing list (with its basis) and every domain-write action; each domain-write spec names a registered definer writer', () => {
  const rows = [...T2_SQL.matchAll(/\('(standing_t2_action|domain_write_action|definer_function)', '([^']+)', 'PROPOSED_20261020100000_action_gateway_t2', (null|'(reversible|request_only)')\)/g)]
  const standing = (basis) => rows.filter((r) => r[1] === 'standing_t2_action' && r[4] === basis).map((r) => r[2]).sort()
  assert.deepEqual(standing('reversible'), T2_STANDING.reversible)
  assert.deepEqual(standing('request_only'), T2_STANDING.request_only)
  assert.deepEqual(rows.filter((r) => r[1] === 'domain_write_action').map((r) => r[2]).sort(), T2_SPECS.map((s) => s.name).sort())
  const definers = rows.filter((r) => r[1] === 'definer_function').map((r) => r[2])
  for (const s of T2_SPECS.filter((x) => x.executor.kind === 'domain_write')) assert.ok(definers.includes(`public.${s.executor.fn}(uuid,uuid)`), s.name)
  assert.ok(definers.includes('public.action_gateway_dw_human_request(uuid,uuid,jsonb)'))
})

test('T2 human path: the request capabilities and D1 (agent_actions.authorize_action) are in the PRODUCTION registry, decidable, and never offered to a model; prepare refuses (only the gateway files them)', async () => {
  const reg = createDefaultCapabilityRegistry()
  for (const id of ['agent_actions.authorize_action', ...Object.values(REQUEST_CAPABILITIES).map((c) => c.capability_id)]) assert.ok(reg.get(id), id)
  const tools = capabilityToolDefs(reg).map((t) => t.name)
  for (const id of ['agent_actions.authorize_action', 'inbox.prepare_disposition_change', 'holds.prepare_release_approval', 'campaigns.prepare_resume_approval', 'campaigns.prepare_plan_adjustment_approval']) {
    assert.ok(!tools.includes(`cap__${id.replace(/\./g, '__')}`), `${id} is not model-facing`)
    if (id !== 'agent_actions.authorize_action') assert.equal((await reg.get(id).prepare({}, {})).code, 'FILED_BY_ACTION_GATEWAY_ONLY')
  }
  assert.ok(tools.includes('cap__pipeline__propose_stage_change'), 'the existing operator-session capability is unchanged')
  assert.equal(FIRST_CAPABILITIES.filter((c) => c.id === 'pipeline.propose_stage_change').length, 1)
})

test('T2 drift snapshot: the gateway\'s normalized stage snapshot ≡ the decide path\'s (opportunity-service#normalizeOpportunityRow → stageSnapshot) for canonical, aliased and terminal rows', async () => {
  for (const raw of [{ id: 'o1', acquisition_stage: 'asking_price', opportunity_status: 'active', stage_entered_at: '2026-10-17T12:00:00.123456+00:00' },
    { id: 'o2', acquisition_stage: 'Price Discovery', opportunity_status: 'Active', stage_entered_at: null },
    { id: 'o3', acquisition_stage: 'offer', opportunity_status: 'archived', latest_intent: 'not_interested', automation_state: 'active', stage_entered_at: '2026-10-01T00:00:00+00:00' }]) {
    assert.deepEqual(stageSnapshotOf(await normalizedStageRow(raw)), stageSnapshotOf(normalizeOpportunityRow(raw)), raw.id)
  }
})

test('R1: the pipeline stage route refuses a body carrying source / actor / offer_event / valuation_mid / mao and derives source + actor from the authenticated identity', () => {
  for (const k of SERVER_OWNED_STAGE_FIELDS) {
    const r = stageTransitionInput({ to_stage: 'offer', [k]: k === 'offer_event' ? { amount: 1 } : 'closing_authority' }, { via: 'cookie:x' })
    assert.equal(r.ok, false, k)
    assert.deepEqual(r.fields, [k])
  }
  const ok = stageTransitionInput({ to_stage: 'offer', reason: 'seller asked', idempotency_key: 'k1', junk: 'x' }, { via: 'header:x-ops-dashboard-secret' })
  assert.deepEqual(ok.input, { to_stage: 'offer', reason: 'seller asked', idempotency_key: 'k1', source: 'pipeline', actor: 'ops_dashboard:header:x-ops-dashboard-secret' })
  const route = fs.readFileSync(path.join(REPO, 'apps/api/src/app/api/cockpit/pipeline/opportunities/[id]/stage/route.js'), 'utf8')
  assert.ok(!/transitionOpportunityStage\(params\.id, body\)/.test(route), 'the raw body never reaches the transition')
})

test('R1 (capability): pipeline.propose_stage_change executes a gateway request with the agent source bound in the approved change, plane requests as agent_approval, and never a contract / closing stage', async () => {
  const cap = pipelineCapabilities.find((c) => c.id === 'pipeline.propose_stage_change')
  const calls = []
  const ctx = { approver: 'u1', services: { pipeline: { transition: async (id, input) => { calls.push(input); return { ok: true } }, get: async () => ({ acquisition_stage: 'property_condition' }) } } }
  await cap.executeApproved({ opportunity_id: 'o', to_stage: 'property_condition', reason: 'r', source: 'action_gateway:agt_alpha' }, ctx)
  await cap.executeApproved({ opportunity_id: 'o', to_stage: 'property_condition', reason: 'r' }, ctx)
  await cap.executeApproved({ opportunity_id: 'o', to_stage: 'property_condition', reason: 'r', source: 'closing_authority' }, ctx)
  assert.deepEqual(calls.map((c) => c.source), ['action_gateway:agt_alpha', 'agent_approval', 'agent_approval'])
  assert.equal((await cap.executeApproved({ opportunity_id: 'o', to_stage: 'formal_contract', reason: 'r', source: 'action_gateway:agt_alpha' }, ctx)).code, 'CLOSING_AUTHORITY_ONLY')
  assert.equal(calls.length, 3)
})

test('T2 rules: never revive (Hartford / Maxwell by any identity), the plan-adjustment bounds, the disposition allowlist and the ownership-answer rule', async () => {
  assert.equal(neverReviveCode({ hold_key: 'owner_hold_20261016:hartford' }), 'CLOSED_LOST_NEVER_REVIVE')
  assert.equal(neverReviveCode({ property_id: '225438557' }), 'CLOSED_LOST_NEVER_REVIVE')
  assert.equal(neverReviveCode({ opportunity_id: '47da7121-c39d-425a-b608-046750e35027' }), 'PERMANENT_EXCLUSION')
  assert.equal(neverReviveCode({ property_id: 'x', thread_id: '00000000-0000-4000-8000-000000000001' }), null)
  assert.equal(planAdjustmentVerdict({ contact_window_start: '07:30' }, {})?.code, 'WINDOW_OUTSIDE_POLICY')
  assert.equal(planAdjustmentVerdict({ contact_window_start: '19:00' }, { contact_window_end: '18:00' })?.code, 'WINDOW_EMPTY')
  assert.equal(planAdjustmentVerdict({ market: 'Dallas' }, {})?.code, 'ADJUSTMENT_FIELD_NOT_ALLOWED')
  assert.equal(planAdjustmentVerdict({ daily_cap: 0 }, {}), null)
  for (const d of ['suppressed', 'wrong_number', 'wrong_person', 'opted_out']) assert.ok(!AGENT_DISPOSITIONS.includes(d), d)
  const ownershipQ = { direction: 'outbound', message_body: 'Hi, this is Helen. Do you still own the house on Oak St?', created_at: '2026-10-19T10:00:00Z', use_case: 'ownership_check' }
  const reply = (b) => [ownershipQ, { direction: 'inbound', message_body: b, created_at: '2026-10-19T10:05:00Z' }]
  assert.equal((await dispositionRuleVerdict({ to: 'not_interested', messages: reply('No thanks') }))?.code, 'DECLINED_UNVERIFIED_REQUIRED')
  assert.equal((await dispositionRuleVerdict({ to: 'interested', messages: reply('No') }))?.code, 'PROPERTY_DENIAL_NOT_A_DISPOSITION')
  assert.equal(await dispositionRuleVerdict({ to: 'not_interested', messages: reply('Yes I do, but no plans to sell') }), null, 'an ownership confirmation keeps the 30-day nurture')
  assert.equal((await dispositionRuleVerdict({ to: 'interested', block: { blocked: true, kind: 'property_denial', reason: 'x' } }))?.code, 'PROPERTY_DENIED')
})

test('T2 human request: hashes follow capabilities/approvals.js; the approval id is the database\'s (md5 of the intent); payload carries no phone', () => {
  const r = buildHumanRequest({ action: 'update_lead_stage', org_id: '00000000-0000-4000-8000-0000000000c1', target: { opportunity_id: 'o' }, intended_change: { action: 'stage_change', to_stage: 'offer' }, snapshot: { s: 1 }, idempotency: 'k', summary: ['Call 312-555-0161 now'] })
  assert.match(r.snapshot_hash, /^[0-9a-f]{64}$/)
  assert.match(r.payload_hash, /^[0-9a-f]{64}$/)
  assert.ok(!/555-0161/.test(r.summary[0]))
  assert.match(requestApprovalId('11111111-1111-4111-8111-111111111111'), /^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})
