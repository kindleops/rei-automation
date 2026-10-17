// Intelligence Command 2.0 (increment B) — capability registry, first
// capabilities, approvals and the red-team suite. No network, no database:
// domain services are injected doubles with the real names/shapes
// (helpers/agent-capabilities-fake.mjs). The Postgres store is proven against
// the PROPOSED migration in agent-capabilities-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OP, OTHER, ORG, ORG_B, THREAD, CAMPAIGN_ID, OPP_ID, ENV, IDENTITY, makePlane, makeWorld } from '../helpers/agent-capabilities-fake.mjs'
import { defineCapability, ALLOWED_TIERS } from '../../src/lib/agent/capabilities/contracts.js'
import { createCapabilityRegistry, createSession, capabilityGate, writeCeiling } from '../../src/lib/agent/capabilities/registry.js'
import { createDefaultCapabilityRegistry, capabilityToolDefs, toApiName, FIRST_CAPABILITIES } from '../../src/lib/agent/capabilities/index.js'
import { createThreadRefCodec } from '../../src/lib/agent/capabilities/thread-ref.js'
import { createCapabilityAskHook } from '../../src/lib/agent/capabilities/ask-hook.js'
import { APPROVAL_TRANSITIONS } from '../../src/lib/agent/capabilities/stores.js'
import { PROHIBITED_INPUT_KEYS } from '../../src/lib/agent/tools/prohibited.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CAP_DIR = path.resolve(here, '../../src/lib/agent/capabilities')
const PHONE_SHAPE = /(?<![0-9])\+?1?[\s().-]{0,2}[0-9]{3}[\s().-]{0,2}[0-9]{3}[\s.-]?[0-9]{4}(?![0-9])/
// hashes / uuids are digit-dense by nature: removed before looking for phone shapes
const PHONE_RE = { test: (text) => PHONE_SHAPE.test(String(text).replace(/[0-9a-f]{32,128}/g, '#').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')) }

const ctx = (extra = {}) => ({ org_id: ORG, identity: IDENTITY, source: 'model', session: createSession(), ...extra })
const inv = (plane, capability_id, input = {}, extra = {}) => plane.invoker.invoke({ capability_id, input, ctx: ctx(extra) })
const decide = (plane, approval, decision = 'approve', identity = IDENTITY, org_id = ORG) => plane.approvals.decide({ org_id, identity, approval_id: approval.approval_id, decision, payload_hash: approval.payload_hash })
const getApproval = async (plane, id) => (await plane.approvals.get({ org_id: ORG, identity: IDENTITY, approval_id: id })).approval

async function aThreadRef(plane) {
  const r = await inv(plane, 'inbox.find_conversations', { bucket: 'priority', limit: 5 })
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.result.rows[0].thread_ref
}

// ── registry + contracts ─────────────────────────────────────────────────────
test('matrix: the first capabilities, typed + versioned, with tier, side effect and the service they wrap', () => {
  const { plane } = makePlane()
  const m = Object.fromEntries(plane.matrix().map((c) => [c.id, c]))
  const expect = {
    'campaigns.search': ['read', 'autonomous_internal'],
    'campaigns.inspect': ['read', 'autonomous_internal'],
    'campaigns.create_draft': ['internal_write', 'autonomous_internal'],
    'campaigns.build_proposed_cohort': ['read', 'autonomous_internal'],
    'campaigns.prepare_launch_approval': ['outbound_prepare', 'requires_explicit_approval'],
    'inbox.find_conversations': ['read', 'autonomous_internal'],
    'inbox.read_thread': ['read', 'autonomous_internal'],
    'inbox.prepare_reply': ['outbound_prepare', 'requires_explicit_approval'],
    // rc-8.5.21: the canonical runtime's review draft (read, never sends)
    'inbox.draft_ai_reply': ['read', 'autonomous_internal'],
    'pipeline.inspect_stage_evidence': ['read', 'autonomous_internal'],
    'pipeline.propose_stage_change': ['internal_write', 'requires_explicit_approval'],
    'platform.health': ['read', 'autonomous_internal'],
    'missions.create': ['internal_write', 'autonomous_internal'],
  }
  assert.deepEqual(Object.keys(m).sort(), Object.keys(expect).sort())
  for (const [id, [se, tier]] of Object.entries(expect)) {
    assert.equal(m[id].side_effect, se, id)
    assert.equal(m[id].tier, tier, id)
    assert.ok(m[id].version >= 1 && m[id].service && m[id].limits.per_day > 0, id)
    if (se !== 'read') assert.ok(m[id].compensation?.kind, `${id} declares a compensation`)
  }
})

test('contracts: never-tier, direct outbound, wrong tier for a side effect, raw SQL inputs and prohibited names are unregistrable', () => {
  const base = { version: 1, domain: 'inbox', title: 't', description: 'd', input_schema: { type: 'object', additionalProperties: false, properties: {} }, output_schema: {}, cost_class: 'db_light', limits: { per_min: 1, per_day: 1, timeout_ms: 1000, rows_to_model: 1 }, wraps: { service: 'x' }, audit: () => ({}), execute: async () => ({}), idempotency: () => 'k', compensation: { kind: 'none' } }
  assert.throws(() => defineCapability({ ...base, id: 'inbox.override_stop', side_effect: 'internal_write', tier: 'never' }), (e) => e.code === 'CAPABILITY_NEVER_TIER')
  assert.throws(() => defineCapability({ ...base, id: 'inbox.send_reply', side_effect: 'internal_write', tier: 'autonomous_internal' }), (e) => e.code === 'CAPABILITY_OUTBOUND_DIRECT')
  assert.throws(() => defineCapability({ ...base, id: 'campaigns.launch', side_effect: 'internal_write', tier: 'autonomous_internal' }), (e) => e.code === 'CAPABILITY_OUTBOUND_DIRECT')
  assert.throws(() => defineCapability({ ...base, id: 'inbox.prepare_x', side_effect: 'outbound_prepare', tier: 'autonomous_internal' }), (e) => e.code === 'CAPABILITY_SPEC_INVALID' && /not allowed/.test(e.message))
  assert.throws(() => defineCapability({ ...base, id: 'platform.lookup', side_effect: 'read', tier: 'autonomous_internal', input_schema: { type: 'object', additionalProperties: false, properties: { sql: { type: 'string', maxLength: 10 } } } }), (e) => e.code === 'CAPABILITY_PROHIBITED')
  assert.throws(() => defineCapability({ ...base, id: 'platform.raw_sql', side_effect: 'read', tier: 'autonomous_internal' }), (e) => e.code === 'CAPABILITY_PROHIBITED')
  assert.throws(() => defineCapability({ ...base, id: 'inbox.unsuppress', side_effect: 'internal_write', tier: 'requires_explicit_approval' }), (e) => e.code === 'CAPABILITY_PROHIBITED')
  assert.throws(() => defineCapability({ ...base, id: 'platform.lookup', side_effect: 'read', tier: 'autonomous_internal', input_schema: { type: 'object', properties: {} } }), (e) => /additionalProperties/.test(e.message))
  assert.deepEqual(ALLOWED_TIERS.outbound_prepare, ['requires_explicit_approval'])
  const r = createDefaultCapabilityRegistry()
  assert.throws(() => r.register({ ...base, id: 'platform.extra', side_effect: 'read', tier: 'autonomous_internal' }), (e) => e.code === 'REGISTRY_SEALED')
})

test('gates: default OFF; writes need the writes flag and AGENT_READ_ONLY lifted (frozen ON in production)', async () => {
  assert.equal(capabilityGate({ NODE_ENV: 'test' }).enabled, false)
  assert.equal(capabilityGate({ NODE_ENV: 'production', AGENT_CAPABILITIES_ENABLED: '1' }).enabled, false, 'production needs AGENT_ENABLED=1 too')
  assert.equal(writeCeiling({ NODE_ENV: 'production', AGENT_ENABLED: '1', AGENT_CAPABILITIES_ENABLED: '1', AGENT_CAPABILITIES_WRITES_ENABLED: '1', AGENT_READ_ONLY: '0', AGENT_MAX_MODE: 'full' }).write_ok, false, 'production read-only is a code ceiling')
  const off = makePlane({ env: { ...ENV, AGENT_CAPABILITIES_ENABLED: '0' } })
  assert.equal((await inv(off.plane, 'platform.health')).code, 'AGENT_CAPABILITIES_ENABLED_off')
  const ro = makePlane({ env: { ...ENV, AGENT_READ_ONLY: '1' } })
  assert.equal((await inv(ro.plane, 'platform.health')).ok, true, 'reads pass under read-only')
  const w = await inv(ro.plane, 'campaigns.create_draft', { name: 'Dallas', template_use_case: 'ownership_check', filters: { properties: [{ field_key: 'market', operator: 'is_any_of', values: ['Dallas, TX'] }] } })
  assert.equal(w.code, 'AGENT_READ_ONLY')
  assert.equal(ro.world.called('campaigns.saveDraft').length, 0)
  const nf = makePlane({ env: { ...ENV, AGENT_CAPABILITIES_WRITES_ENABLED: '' } })
  assert.equal((await inv(nf.plane, 'missions.create', { kind: 'ops.health_check' })).code, 'CAPABILITY_WRITES_DISABLED')
  const offMode = makePlane({ env: { ...ENV, AGENT_MAX_MODE: 'off' } })
  assert.equal((await inv(offMode.plane, 'platform.health')).code, 'AGENT_MODE_CEILING')
})

// ── campaigns ────────────────────────────────────────────────────────────────
test('campaigns.search + inspect: composition, launch readiness and feeder_last through the campaign service', async () => {
  const { plane, world } = makePlane()
  const s = await inv(plane, 'campaigns.search', { query: 'dallas', statuses: ['draft'] })
  assert.equal(s.ok, true)
  assert.equal(s.result.rows[0].campaign_id, CAMPAIGN_ID)
  const i = await inv(plane, 'campaigns.inspect', { campaign_id: CAMPAIGN_ID })
  assert.equal(i.result.campaign.status, 'draft')
  assert.equal(i.result.sending_health.launch_readiness.state, 'not_ready')
  assert.deepEqual(i.result.sending_health.launch_readiness.blocker_codes, ['no_targets_built'])
  assert.equal(i.result.feeder_last.reason, 'global_auto_enqueue_disabled')
  assert.equal(i.result.composition.filters[0].field, 'market')
  assert.equal(world.called('campaigns.get').length, 1)
  assert.equal((await inv(plane, 'campaigns.inspect', { campaign_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).code, 'CAMPAIGN_NOT_FOUND')
})

test('campaigns.create_draft: a real draft through the Composer, read back as draft; a repeat replays; never active; no targets built', async () => {
  const { plane, world, store } = makePlane()
  const input = { name: 'Agent Dallas SFR', template_use_case: 'ownership_check', filters: { properties: [{ field_key: 'market', operator: 'is_any_of', values: ['Dallas, TX'] }, { field_key: 'equity_percent', operator: 'gte', number: 40 }] }, campaign_size: 'custom', total_cap: 200 }
  const r = await inv(plane, 'campaigns.create_draft', input)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.status, 'executed')
  assert.equal(r.result.status, 'draft')
  assert.deepEqual(r.result.readback, { exists: true, status: 'draft', active: false })
  const saved = world.called('campaigns.saveDraft')[0].args
  assert.match(saved.composer_key, /^agent:[0-9a-f]{32}$/)
  assert.deepEqual(saved.composition.target_filters.properties[1], { field_key: 'equity_percent', operator: 'gte', value: 40 })
  assert.equal(saved.composition.status, undefined, 'status is never sent: the composer writes draft')
  assert.equal(world.campaigns.get(r.result.campaign_id).status, 'draft')
  assert.equal(world.called('campaigns.prepare').length, 0, 'no targets built unless requested')
  assert.equal(world.called('campaigns.launch').length, 0)
  const again = await inv(plane, 'campaigns.create_draft', input)
  assert.equal(again.status, 'replayed')
  assert.equal(again.result.campaign_id, r.result.campaign_id)
  assert.equal(world.called('campaigns.saveDraft').length, 1, 'idempotent: the service is not called twice')
  assert.ok(store._audit.some((a) => a.capability_id === 'campaigns.create_draft' && a.decision === 'executed'))
  assert.equal((await inv(plane, 'campaigns.create_draft', { ...input, name: 'Other draft', filters: {} })).code, 'AUDIENCE_REQUIRED')
})

test('campaigns.build_proposed_cohort: the planner cohort in dry-run, aggregates only, no writes', async () => {
  const { plane, world } = makePlane()
  const r = await inv(plane, 'campaigns.build_proposed_cohort', { campaign_id: CAMPAIGN_ID })
  assert.equal(r.ok, true)
  assert.equal(r.result.dry_run, true)
  assert.equal(r.result.ready, 90)
  assert.deepEqual(r.result.held_by_reason, { no_sender_route: 12, language_hold: 8 })
  assert.deepEqual(world.called('campaigns.cohort')[0].args.filters.properties[0].field_key, 'market')
  for (const w of ['campaigns.saveDraft', 'campaigns.prepare', 'campaigns.launch']) assert.equal(world.called(w).length, 0)
})

test('campaigns.prepare_launch_approval: only a pending approval; approval launches through the Composer once; replay is idempotent; drift refuses', async () => {
  const { plane, world } = makePlane()
  const r = await inv(plane, 'campaigns.prepare_launch_approval', { campaign_id: CAMPAIGN_ID, start: 'now' })
  assert.equal(r.status, 'approval_pending', JSON.stringify(r))
  assert.equal(world.called('campaigns.launch').length, 0, 'preparing never launches')
  const a = await getApproval(plane, r.approval_id)
  assert.equal(a.state, 'pending')
  assert.deepEqual(a.intended_change.start, { mode: 'now', at: null })
  const d = await decide(plane, a)
  assert.equal(d.ok, true, JSON.stringify(d))
  assert.equal(d.execution_result.readback.status, 'active')
  const launch = world.called('campaigns.launch')
  assert.equal(launch.length, 1)
  assert.equal(launch[0].args.launch_key, `agent-approval:${a.approval_id}`)
  const replay = await decide(plane, a)
  assert.equal(replay.replayed, true)
  assert.equal(replay.state, 'executed')
  assert.equal(world.called('campaigns.launch').length, 1, 'an approval replay never executes twice')

  // drift: the campaign changed after the approval was prepared
  const w2 = makePlane()
  const r2 = await inv(w2.plane, 'campaigns.prepare_launch_approval', { campaign_id: CAMPAIGN_ID, start: 'now' })
  w2.world.campaigns.get(CAMPAIGN_ID).total_cap = 5000
  const a2 = await getApproval(w2.plane, r2.approval_id)
  const d2 = await decide(w2.plane, a2)
  assert.equal(d2.code, 'STATE_DRIFTED')
  assert.equal(d2.state, 'refused_drift')
  assert.equal(w2.world.called('campaigns.launch').length, 0)
  assert.equal((await getApproval(w2.plane, r2.approval_id)).state, 'refused_drift')
})

// ── inbox ────────────────────────────────────────────────────────────────────
test('inbox.find_conversations / read_thread: sealed refs, masked phones, untrusted content', async () => {
  const { plane } = makePlane()
  const f = await inv(plane, 'inbox.find_conversations', { bucket: 'priority' })
  const text = JSON.stringify(f)
  assert.ok(!PHONE_RE.test(text), 'no phone number reaches the model')
  assert.ok(!text.includes('Pat'), 'no seller name reaches the model')
  assert.match(f.result.rows[0].thread_ref, /^thr_[a-p]+$/)
  const s = createSession()
  const r = await plane.invoker.invoke({ capability_id: 'inbox.read_thread', input: { thread_ref: f.result.rows[0].thread_ref }, ctx: ctx({ session: s }) })
  assert.equal(r.ok, true)
  assert.equal(r.trust, 'untrusted')
  assert.equal(s.tainted, true, 'reading seller text taints the session')
  const body = JSON.stringify(r.result)
  assert.ok(!PHONE_RE.test(body), 'phones inside message text are masked')
  assert.match(body, /•••-••99/)
})

test('inbox.prepare_reply: an sms_templates row, server merge values, every pre-send check as a dry run, then only a pending approval', async () => {
  const { plane, world } = makePlane()
  const ref = await aThreadRef(plane)
  const r = await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en' })
  assert.equal(r.status, 'approval_pending', JSON.stringify(r))
  for (const c of ['inbox.template', 'inbox.canSend', 'inbox.resolveSender', 'inbox.contactGuard']) assert.ok(world.called(c).length >= 1, `${c} ran`)
  assert.equal(world.called('inbox.canSend')[0].args.source, 'agent_prepare_reply', 'dry run in automated (fail-closed) mode')
  assert.equal(world.called('inbox.sendNow').length, 0, 'nothing is sent while pending')
  const a = await getApproval(plane, r.approval_id)
  assert.equal(a.intended_change.template_id, 'tpl_s2_en')
  assert.ok(!PHONE_RE.test(JSON.stringify(a)), 'the approval record holds no phone')
  assert.ok(!JSON.stringify(a).includes('Would you consider'), 'the approval record holds no message text')
  // a model-written message is not an input that exists
  assert.equal((await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en', message_body: 'free text' })).code, 'INPUT_INVALID')
  // code-registry / unknown templates and monetary offers are refused
  assert.equal((await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'local-template:s2' })).code, 'TEMPLATE_NOT_IN_SUPABASE')
  assert.equal((await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_missing' })).code, 'TEMPLATE_NOT_IN_SUPABASE')
  assert.equal((await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_offer' })).code, 'MONETARY_OFFER_REFUSED')
  // unresolvable merge field fails closed (agent_name has no server value)
  const fresh = makePlane()
  assert.equal((await inv(fresh.plane, 'inbox.prepare_reply', { thread_ref: await aThreadRef(fresh.plane), template_id: 'tpl_agent' })).code, 'TEMPLATE_RENDER_FAILED')
})

test('inbox.prepare_reply approval: executes the manual send-now path with the template id and records the real outcome', async () => {
  const { plane, world } = makePlane()
  const ref = await aThreadRef(plane)
  const r = await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en' })
  const a = await getApproval(plane, r.approval_id)
  const d = await decide(plane, a)
  const sends = world.called('inbox.sendNow')
  assert.equal(sends.length, 1)
  assert.deepEqual(sends[0].args, { template_id: 'tpl_s2_en', source: 'manual_inbox', approval: a.approval_id, body_chars: 'Thanks Pat. Would you consider an offer on 12 Elm St?'.length })
  // P0 outbound pause: the send-now authority refuses; the approval records that truthfully
  assert.equal(d.ok, false)
  assert.equal(d.state, 'failed')
  assert.equal(d.execution_result.code, 'queue_execution_mode_off')
  assert.equal(d.execution_result.provider_accepted, false)
  // and a provider-accepted send is recorded as executed
  const w2 = makePlane()
  w2.world.state.sendResult = { ok: true, queue_status: 'sent', queue_id: 'q-1', message_event_id: 'me-1', provider_message_id: 'SMxyz', delivery_status_display: 'sent' }
  const ref2 = await aThreadRef(w2.plane)
  const r2 = await inv(w2.plane, 'inbox.prepare_reply', { thread_ref: ref2, template_id: 'tpl_s2_en' })
  const d2 = await decide(w2.plane, await getApproval(w2.plane, r2.approval_id))
  assert.equal(d2.ok, true)
  assert.deepEqual({ status: d2.execution_result.status, accepted: d2.execution_result.provider_accepted, provider_status: d2.execution_result.provider_status }, { status: 'sent', accepted: true, provider_status: 'sent' })
})

// ── pipeline / platform / missions ───────────────────────────────────────────
test('pipeline: evidence is a projection (no message text, no valuations); a stage change is only proposed, then runs the pipeline service', async () => {
  const { plane, world } = makePlane()
  const e = await inv(plane, 'pipeline.inspect_stage_evidence', { opportunity_id: OPP_ID })
  assert.equal(e.result.current.stage, 'contacted')
  assert.deepEqual(e.result.offer_events[0], { direction: 'outbound', status: 'sent', has_price: true, sent_at: '2026-10-11T00:00:00Z', accepted_at: null })
  const t = JSON.stringify(e.result)
  assert.ok(!t.includes('secret text') && !t.includes('200000') && !t.includes('150000') && !PHONE_RE.test(t))
  assert.equal((await inv(plane, 'pipeline.propose_stage_change', { opportunity_id: OPP_ID, to_stage: 'closed', reason: 'seller signed' })).code, 'CLOSING_AUTHORITY_ONLY')
  assert.equal((await inv(plane, 'pipeline.propose_stage_change', { opportunity_id: OPP_ID, to_stage: 'bogus_stage', reason: 'x y z' })).code, 'INVALID_STAGE')
  assert.equal((await inv(plane, 'pipeline.propose_stage_change', { opportunity_id: OPP_ID, to_stage: 'negotiating', reason: 'asked for price', offer_event: { price: 1 } })).code, 'INPUT_INVALID', 'an offer event is never an agent input')
  const p = await inv(plane, 'pipeline.propose_stage_change', { opportunity_id: OPP_ID, to_stage: 'negotiating', reason: 'Seller asked for a number; call 214 555 0101' })
  assert.equal(p.status, 'approval_pending')
  assert.equal(world.called('pipeline.transition').length, 0)
  const a = await getApproval(plane, p.approval_id)
  assert.ok(!PHONE_RE.test(a.intended_change.reason), 'reason text is masked')
  const d = await decide(plane, a)
  assert.equal(d.ok, true, JSON.stringify(d))
  assert.equal(world.called('pipeline.transition')[0].args.input.source, 'agent_approval')
  assert.equal(d.execution_result.readback.stage, 'negotiating')
})

test('platform.health: heartbeats from stored timestamps, modes, queue + feeder_last', async () => {
  const { plane } = makePlane()
  const r = await inv(plane, 'platform.health')
  assert.equal(r.ok, true)
  // the event-driven follow-up heartbeat has no delivery reference in this fixture: unverified, never stale
  assert.ok(r.result.heartbeats.every((h) => h.status === 'fresh' || (h.key === 'followup_no_response_heartbeat_at' && h.status === 'unverified')), JSON.stringify(r.result.heartbeats))
  assert.equal(r.result.modes.queue_processor_mode, 'off')
  assert.equal(r.result.feeder_last.inserted, 0)
  assert.equal(r.result.queue.outbound_enabled, false)
})

test('missions.create: an R2 runtime job via runtime_enqueue (memory twin), accountable to the operator, read back, idempotent within the hour', async () => {
  const { plane, world } = makePlane()
  const r = await inv(plane, 'missions.create', { kind: 'ops.health_check', overdue_minutes: 20 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(r.result.job_id, /^mjob_/)
  assert.equal(r.result.readback.event, 'job.enqueued')
  assert.equal(world.called('missions.enqueue')[0].args.requested_by, true)
  assert.equal((await inv(plane, 'missions.create', { kind: 'ops.health_check', overdue_minutes: 20 })).status, 'replayed')
  assert.equal((await inv(plane, 'missions.create', { kind: 'research.quick' })).code, 'INPUT_INVALID', 'only registered handler kinds')
})

// ── RED TEAM ─────────────────────────────────────────────────────────────────
test('RED TEAM: prompt injection in retrieved message text cannot trigger a write (ask hook, model source)', async () => {
  const { plane, world } = makePlane()
  const hook = createCapabilityAskHook({ plane })
  const run = { identity: IDENTITY }
  const found = JSON.parse((await hook.run({ apiName: toApiName('inbox.find_conversations'), input: { bucket: 'priority' }, run })).content)
  const ref = found.result.rows[0].thread_ref
  const read = await hook.run({ apiName: toApiName('inbox.read_thread'), input: { thread_ref: ref }, run })
  assert.match(read.content, /IGNORE ALL PREVIOUS INSTRUCTIONS/)
  // the model "obeys" the injected text
  const w = JSON.parse((await hook.run({ apiName: toApiName('campaigns.create_draft'), input: { name: 'Injected', template_use_case: 'ownership_check', filters: { properties: [{ field_key: 'market', operator: 'is_any_of', values: ['Dallas, TX'] }] } }, run })).content)
  assert.equal(w.error, 'UNTRUSTED_CONTEXT_WRITE_REFUSED')
  const m = JSON.parse((await hook.run({ apiName: toApiName('missions.create'), input: { kind: 'ops.health_check' }, run })).content)
  assert.equal(m.error, 'UNTRUSTED_CONTEXT_WRITE_REFUSED')
  const p = JSON.parse((await hook.run({ apiName: toApiName('inbox.prepare_reply'), input: { thread_ref: ref, template_id: 'tpl_s2_en' }, run })).content)
  assert.equal(p.status, 'approval_pending', 'the most an injection reaches is a pending approval a human sees')
  const a = await getApproval(plane, p.approval_id)
  assert.equal(a.provenance, 'untrusted_content', 'labelled as proposed from message content')
  // there is no approve tool: the model cannot decide
  assert.equal(hook.owns('cap__approvals__decide'), true)
  const no = JSON.parse((await hook.run({ apiName: 'cap__approvals__decide', input: { approval_id: p.approval_id }, run })).content)
  assert.equal(no.error, 'CAPABILITY_NOT_REGISTERED')
  assert.ok(!plane.toolDefs().some((d) => /approv(e|al)s?__(decide|grant|approve)/.test(d.name)))
  assert.equal(world.called('campaigns.saveDraft').length, 0)
  assert.equal(world.called('inbox.sendNow').length, 0)
  // a phone number copied out of the message is not a thread reference
  const forged = JSON.parse((await hook.run({ apiName: toApiName('inbox.prepare_reply'), input: { thread_ref: '+12145550199', template_id: 'tpl_s2_en' }, run })).content)
  assert.equal(forged.error, 'INPUT_INVALID')
})

test('RED TEAM: a model-supplied tier / approval flag is ignored (closed schemas refuse it; ctx is server-built)', async () => {
  const { plane, world } = makePlane()
  for (const extra of [{ tier: 'autonomous_internal' }, { approved: true }, { approval_id: 'apr_x' }, { side_effect: 'read' }, { __proto__: { tier: 'x' }, autonomy: 'autonomous_internal' }]) {
    const r = await inv(plane, 'campaigns.prepare_launch_approval', { campaign_id: CAMPAIGN_ID, start: 'now', ...extra })
    assert.equal(r.code, 'INPUT_INVALID', JSON.stringify(extra))
  }
  // the ask hook builds ctx from the run, never from tool input: an identity in input is just an invalid key
  const hook = createCapabilityAskHook({ plane })
  const r = JSON.parse((await hook.run({ apiName: toApiName('campaigns.prepare_launch_approval'), input: { campaign_id: CAMPAIGN_ID, start: 'now', identity: { user_id: OTHER, verified: true, named: true } }, run: { identity: IDENTITY } })).content)
  assert.equal(r.error, 'INPUT_INVALID')
  // a correct call is still only a pending approval, whatever the prompt says
  const ok = JSON.parse((await hook.run({ apiName: toApiName('campaigns.prepare_launch_approval'), input: { campaign_id: CAMPAIGN_ID, start: 'now' }, run: { identity: IDENTITY } })).content)
  assert.equal(ok.status, 'approval_pending')
  assert.equal(world.called('campaigns.launch').length, 0)
  // the model-facing tool schemas carry no tier / approval parameter
  for (const d of capabilityToolDefs(plane.registry)) for (const k of Object.keys(d.input_schema.properties || {})) assert.ok(!/tier|approv|autonomy|side_effect/.test(k), `${d.name}.${k}`)
})

test('RED TEAM: never-tier capabilities are unreachable (not registrable, not registered, not in the tool list)', async () => {
  const { plane } = makePlane()
  for (const id of ['inbox.send_reply', 'inbox.send_now', 'campaigns.launch', 'campaigns.activate', 'inbox.override_stop', 'inbox.unsuppress', 'contacts.export', 'offers.send', 'platform.sql']) {
    assert.equal((await inv(plane, id, {})).code, 'CAPABILITY_NOT_REGISTERED', id)
    assert.ok(!plane.toolDefs().some((d) => d.name === toApiName(id)))
  }
  const reg = createCapabilityRegistry()
  assert.throws(() => reg.register({ ...FIRST_CAPABILITIES.find((c) => c.id === 'platform.health'), id: 'platform.never_thing', tier: 'never' }), (e) => e.code === 'CAPABILITY_NEVER_TIER')
})

test('RED TEAM: an approval replay is idempotent (sequential and concurrent decide → exactly one execution)', async () => {
  const { plane, world } = makePlane()
  world.state.sendResult = { ok: true, queue_status: 'sent', provider_message_id: 'SMx' }
  const ref = await aThreadRef(plane)
  const r = await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en' })
  // re-proposing the identical change returns the same pending approval
  const again = await inv(plane, 'inbox.prepare_reply', { thread_ref: await aThreadRef(plane), template_id: 'tpl_s2_en' })
  assert.equal(again.approval_id, r.approval_id)
  assert.equal(again.deduped, true)
  const a = await getApproval(plane, r.approval_id)
  const results = await Promise.all([decide(plane, a), decide(plane, a), decide(plane, a)])
  assert.equal(world.called('inbox.sendNow').length, 1, 'exactly one send')
  assert.equal(results.filter((x) => x.ok && !x.replayed).length, 1)
  const later = await decide(plane, a)
  assert.equal(later.replayed, true)
  assert.equal(later.state, 'executed')
  assert.equal(world.called('inbox.sendNow').length, 1)
  // a decided identical proposal is not silently re-opened
  const re = await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en' })
  assert.equal(re.code, 'IDENTICAL_PROPOSAL_ALREADY_DECIDED', 'the same change against the same state is never re-opened')
})

test('RED TEAM: a drifted state refuses (new inbound message / edited template / wrong payload hash / expiry)', async () => {
  for (const mutate of [
    (w) => w.messages.push({ id: 'm3', direction: 'inbound', message_body: 'STOP', created_at: '2026-10-12T09:30:00Z', is_opt_out: true }),
    (w) => { w.templates.get('tpl_s2_en').template_body = 'Changed {{seller_first_name}} {{property_address}}' },
  ]) {
    const { plane, world } = makePlane()
    const ref = await aThreadRef(plane)
    const r = await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en' })
    mutate(world)
    const d = await decide(plane, await getApproval(plane, r.approval_id))
    assert.equal(d.code, 'STATE_DRIFTED')
    assert.equal(world.called('inbox.sendNow').length, 0)
  }
  const { plane, world } = makePlane()
  const ref = await aThreadRef(plane)
  const r = await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en' })
  const a = await getApproval(plane, r.approval_id)
  assert.equal((await plane.approvals.decide({ org_id: ORG, identity: IDENTITY, approval_id: a.approval_id, decision: 'approve', payload_hash: '0'.repeat(64) })).code, 'HASH_MISMATCH')
  let t = Date.parse('2026-10-13T12:00:00Z')
  const late = makePlane({ now: () => t })
  const lr = await inv(late.plane, 'inbox.prepare_reply', { thread_ref: await aThreadRef(late.plane), template_id: 'tpl_s2_en' })
  t += 16 * 60 * 1000
  const la = await getApproval(late.plane, lr.approval_id)
  assert.equal((await decide(late.plane, la)).code, 'APPROVAL_EXPIRED')
  assert.equal(late.world.called('inbox.sendNow').length + world.called('inbox.sendNow').length, 0)
})

test('RED TEAM: STOP / suppression blocks inbox.prepare_reply (no approval is created)', async () => {
  const s = makePlane()
  s.world.state.suppressed = true
  const r = await inv(s.plane, 'inbox.prepare_reply', { thread_ref: await aThreadRef(s.plane), template_id: 'tpl_s2_en' })
  assert.equal(r.code, 'SUPPRESSED')
  assert.equal((await s.plane.approvals.list({ org_id: ORG, identity: IDENTITY, states: null })).approvals.length, 0)
  const g = makePlane()
  g.world.state.guard = { ok: false, reason: 'opt_out_reply' }
  const r2 = await inv(g.plane, 'inbox.prepare_reply', { thread_ref: await aThreadRef(g.plane), template_id: 'tpl_s2_en' })
  assert.equal(r2.code, 'CONTACT_GUARD_OPT_OUT_REPLY')
  assert.equal((await g.plane.approvals.list({ org_id: ORG, identity: IDENTITY, states: null })).approvals.length, 0)
  // suppression that appears AFTER approval was prepared: drift (guard state is in the snapshot) refuses the send
  const late = makePlane()
  const lr = await inv(late.plane, 'inbox.prepare_reply', { thread_ref: await aThreadRef(late.plane), template_id: 'tpl_s2_en' })
  late.world.state.guard = { ok: false, reason: 'suppression_list' }
  const d = await decide(late.plane, await getApproval(late.plane, lr.approval_id))
  assert.equal(d.code, 'STATE_DRIFTED')
  assert.equal(late.world.called('inbox.sendNow').length, 0)
})

test('RED TEAM: no raw SQL path exists (no SQL/table/url inputs, no query surface in services or capability code)', () => {
  const { plane } = makePlane()
  const walkKeys = (schema, out = []) => { for (const [k, v] of Object.entries(schema?.properties || {})) { out.push(k); if (v.type === 'object') walkKeys(v, out); if (v.items?.type === 'object') walkKeys(v.items, out) } return out }
  for (const c of plane.registry.list()) for (const k of walkKeys(c.input_schema)) assert.ok(!PROHIBITED_INPUT_KEYS.includes(k.toLowerCase()), `${c.id}.${k}`)
  const svc = plane.services
  for (const [domain, fns] of Object.entries(svc)) for (const name of Object.keys(fns)) assert.ok(!/^(from|rpc|query|sql|raw|execute)$/i.test(name), `${domain}.${name}`)
  // static: capability definitions + services never build a query; only stores.js speaks SQL (fixed statements, agent schema)
  const files = []
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p) } }
  walk(CAP_DIR)
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')
    if (f.endsWith('stores.js')) {
      for (const m of src.matchAll(/q\(\s*[`'"]([\s\S]*?)[`'"]\s*,/g)) assert.match(m[1], /agent\.(operator_membership|capability_audit|approval_request|capability_approval_insert|capability_approval_transition)|^select rolsuper, rolbypassrls from pg_roles where rolname = current_user$/, 'stores.js statements are fixed and confined to schema agent')
      continue
    }
    assert.ok(!/(?<!Buffer|Array)\.from\(|\.rpc\(|\.query\(|\bselect\s+[\w*]+\s+from\b|insert\s+into|update\s+\w+\s+set|delete\s+from/i.test(src), `${path.basename(f)} builds no query`)
  }
})

test('RED TEAM: cross-org access is refused (invoke, list, get, decide; a foreign org cannot open a thread ref)', async () => {
  const world = makeWorld()
  const { plane } = makePlane({ world, members: [{ org_id: ORG, user_id: OP, role: 'owner' }, { org_id: ORG_B, user_id: OTHER, role: 'owner' }] })
  const ref = await aThreadRef(plane)
  const r = await inv(plane, 'inbox.prepare_reply', { thread_ref: ref, template_id: 'tpl_s2_en' })
  const a = await getApproval(plane, r.approval_id)
  const outsider = { verified: true, named: true, user_id: OTHER, method: 'test' }
  assert.equal((await plane.invoker.invoke({ capability_id: 'platform.health', input: {}, ctx: { org_id: ORG, identity: outsider, source: 'operator' } })).code, 'NOT_A_MEMBER')
  assert.equal((await plane.approvals.list({ org_id: ORG, identity: outsider })).code, 'NOT_A_MEMBER')
  assert.equal((await plane.approvals.get({ org_id: ORG_B, identity: outsider, approval_id: a.approval_id })).code, 'APPROVAL_NOT_FOUND')
  assert.equal((await plane.approvals.decide({ org_id: ORG_B, identity: outsider, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash })).code, 'APPROVAL_NOT_FOUND')
  assert.equal((await plane.approvals.decide({ org_id: ORG, identity: outsider, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash })).code, 'NOT_A_MEMBER')
  // a ref minted for ORG does not open in ORG_B (org is the AEAD additional data)
  const bRead = await plane.invoker.invoke({ capability_id: 'inbox.read_thread', input: { thread_ref: ref }, ctx: { org_id: ORG_B, identity: outsider, source: 'model', session: createSession() } })
  assert.equal(bRead.code, 'THREAD_REF_INVALID')
  assert.equal(world.called('inbox.sendNow').length, 0)
  // unverified identities never act
  assert.equal((await plane.invoker.invoke({ capability_id: 'platform.health', input: {}, ctx: { org_id: ORG, identity: { ...IDENTITY, verified: false }, source: 'operator' } })).code, 'IDENTITY_REQUIRED')
  assert.equal((await plane.approvals.decide({ org_id: ORG, identity: { user_id: OP }, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash })).code, 'IDENTITY_REQUIRED')
})

test('thread refs: opaque, unforgeable, org-bound, never phone-shaped', () => {
  const c = createThreadRefCodec({ secret: 'x'.repeat(32) })
  const ref = c.seal(THREAD, ORG)
  assert.match(ref, /^thr_[a-p]+$/)
  assert.equal(c.open(ref, ORG), THREAD)
  assert.equal(c.open(ref, ORG_B), null)
  assert.equal(c.open(`${ref.slice(0, -2)}aa`, ORG), null)
  assert.equal(createThreadRefCodec({ secret: 'y'.repeat(32) }).open(ref, ORG), null)
  assert.throws(() => createThreadRefCodec({ secret: 'short' }), (e) => e.code === 'THREAD_REF_SECRET_REQUIRED')
})

test('rate + daily caps are enforced server-side per actor', async () => {
  const { plane } = makePlane()
  const results = []
  for (let i = 0; i < 4; i += 1) results.push(await inv(plane, 'campaigns.prepare_launch_approval', { campaign_id: CAMPAIGN_ID, start: 'now', expected_eligible: i + 1 }))
  assert.deepEqual(results.map((r) => r.ok ? 'ok' : r.code), ['ok', 'ok', 'RATE_LIMITED', 'RATE_LIMITED'])
})

test('state graph: JS approval transitions equal the SQL agent.capability_approval_transition_ok graph', () => {
  const sql = fs.readFileSync(path.resolve(here, '../../../../supabase/migrations/PROPOSED_20261013120000_agent_capabilities.sql'), 'utf8')
  const body = /function agent\.capability_approval_transition_ok[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(sql)[1]
  const fromSql = {}
  for (const m of body.matchAll(/when '([a-z_]+)'\s+then p_to in \(([^)]*)\)/g)) fromSql[m[1]] = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
  const fromJs = Object.fromEntries(Object.entries(APPROVAL_TRANSITIONS).filter(([, v]) => v.length).map(([k, v]) => [k, [...v].sort()]))
  assert.deepEqual(fromSql, fromJs)
})

test('ask-service registration hook: capability tools are offered after the read tools and dispatched through the plane (model source)', async () => {
  const { createAskService } = await import('../../src/lib/agent/research/ask-service.js')
  const { createResearchMemoryStore } = await import('../../src/lib/agent/research/research-store.js')
  const { createResearchToolRegistry } = await import('../../src/lib/agent/research/research-tools.js')
  const { createModelResolver } = await import('../../src/lib/agent/research/models.js')
  const { OWNER, makeTables, fakeDb, fakeServices, fakeProvider, toolUse, reply, answer } = await import('../helpers/agent-research-fake.mjs')
  const env = { NODE_ENV: 'development', AGENT_ENABLED: '1', AGENT_LIVE_ROUTES: '1', AGENT_RESEARCH_ENABLED: '1', AGENT_MAX_MODE: 'read', AGENT_SPEND_GLOBAL_DAILY_USD: '10', AGENT_SPEND_USER_DAILY_USD: '10', AGENT_SPEND_CYCLE_USD: '150' }
  const identity = { verified: true, named: true, user_id: OWNER, method: 'supabase_jwt' }
  const { plane, world } = makePlane({ members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
  const seen = { tools: false, results: false }
  const provider = fakeProvider([
    (body) => {
      const names = body.tools.map((t) => t.name)
      assert.ok(names.includes('cap__platform__health') && names.includes('cap__inbox__prepare_reply'))
      assert.equal(body.tools.filter((t) => t.cache_control).length, 1, 'one cache breakpoint, on the last tool')
      assert.equal(body.tools[body.tools.length - 1].cache_control?.type, 'ephemeral')
      seen.tools = true
      return reply([toolUse('cap__platform__health', {}), toolUse('cap__campaigns__prepare_launch_approval', { campaign_id: CAMPAIGN_ID, start: 'now' })])
    },
    (body) => {
      const last = JSON.stringify(body.messages[body.messages.length - 1])
      assert.match(last, /heartbeats/)
      assert.match(last, /approval_pending/)
      seen.results = true
      return answer('Health is fresh; a launch approval is pending your decision.')
    },
  ])
  const ask = createAskService({ store: createResearchMemoryStore(), registry: createResearchToolRegistry(), provider, resolver: createModelResolver({ provider, env }), createServices: () => fakeServices(fakeDb(makeTables())), env, capabilityHook: createCapabilityAskHook({ plane }) })
  const r = await (await ask.ask({ operator_id: OWNER, identity, question: 'How is the platform, and prepare the Dallas launch?' })).done
  void r
  assert.deepEqual(seen, { tools: true, results: true })
  assert.equal(provider.calls.length, 2)
  assert.equal(world.called('campaigns.launch').length, 0)
  assert.equal((await plane.approvals.list({ org_id: ORG, identity, states: ['pending'] })).approvals.length, 1)
  // without the hook the ask service is exactly the read-only research agent
  const p2 = fakeProvider([(body) => { assert.ok(!body.tools.some((t) => t.name.startsWith('cap__'))); return answer('ok') }])
  const ask2 = createAskService({ store: createResearchMemoryStore(), registry: createResearchToolRegistry(), provider: p2, resolver: createModelResolver({ provider: p2, env }), createServices: () => fakeServices(fakeDb(makeTables())), env })
  await (await ask2.ask({ operator_id: OWNER, identity, question: 'hello there' })).done
  assert.equal(p2.calls.length, 1)
})

test('routes: gate 404 → ops auth → verified named user → rate limit → membership; decide executes once, replay 200', async () => {
  const { handleActionsCatalog, handleActionsInvoke, handleApprovalsList, handleApprovalGet, handleApprovalDecide } = await import('../../src/lib/agent/actions/routes.js')
  const { plane, world } = makePlane()
  const okAuth = () => ({ ok: true })
  const identity = { authenticate: async (req) => (req.headers.get('authorization') === 'Bearer good' ? { ok: true, identity: IDENTITY } : { ok: false, status: 401, code: 'SESSION_REQUIRED' }) }
  const limiter = { check: () => ({ ok: true }) }
  const opts = { env: ENV, auth: okAuth, identity, limiter, plane }
  const req = (url, init = {}) => new Request(`http://x${url}`, { ...init, headers: { authorization: 'Bearer good', 'content-type': 'application/json', ...(init.headers || {}) } })
  assert.equal((await handleActionsCatalog(req('/a'), { ...opts, env: { ...ENV, AGENT_CAPABILITIES_ENABLED: '0' } })).status, 404)
  assert.equal((await handleActionsCatalog(req('/a'), { ...opts, auth: () => ({ ok: false, response: new Response(null, { status: 401 }) }) })).status, 401)
  assert.equal((await handleActionsCatalog(req('/a', { headers: { authorization: 'Bearer bad' } }), opts)).status, 401)
  assert.equal((await handleActionsCatalog(req('/a'), { ...opts, limiter: { check: () => ({ ok: false, code: 'RATE_LIMITED', retry_after_s: 5 }) } })).status, 429)
  const cat = await (await handleActionsCatalog(req('/a'), opts)).json()
  assert.equal(cat.capabilities.length, 13)
  const inv1 = await handleActionsInvoke(req('/a/invoke', { method: 'POST', body: JSON.stringify({ capability_id: 'campaigns.prepare_launch_approval', input: { campaign_id: CAMPAIGN_ID, start: 'now' } }) }), opts)
  const out = await inv1.json()
  assert.equal(out.status, 'approval_pending')
  const list = await (await handleApprovalsList(req('/a/approvals?state=pending'), opts)).json()
  assert.equal(list.approvals.length, 1)
  const one = await (await handleApprovalGet(req('/a/approvals/x'), out.approval_id, opts)).json()
  assert.equal(one.approval.state, 'pending')
  const bad = await handleApprovalDecide(req('/d', { method: 'POST', body: JSON.stringify({ decision: 'approve', payload_hash: 'f'.repeat(64) }) }), out.approval_id, opts)
  assert.equal(bad.status, 409)
  const good = await handleApprovalDecide(req('/d', { method: 'POST', body: JSON.stringify({ decision: 'approve', payload_hash: one.approval.payload_hash }) }), out.approval_id, opts)
  assert.equal(good.status, 200)
  assert.equal((await good.json()).state, 'executed')
  const again = await handleApprovalDecide(req('/d', { method: 'POST', body: JSON.stringify({ decision: 'approve', payload_hash: one.approval.payload_hash }) }), out.approval_id, opts)
  assert.equal(again.status, 200)
  assert.equal((await again.json()).replayed, true)
  assert.equal(world.called('campaigns.launch').length, 1)
  // no plane configured (secret unset) ⇒ 503, never a silent fallback
  assert.equal((await handleActionsCatalog(req('/a'), { ...opts, plane: null, env: { ...ENV, AGENT_CAPABILITY_SECRET: '' } })).status, 503)
})
