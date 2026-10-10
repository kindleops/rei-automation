// Agent S1 — tool registry: permission contracts, tier enforcement, T4 unregisterable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineTool } from '../../src/lib/agent/tools/define-tool.js'
import { createToolRegistry, authorizeToolCall, createToolExecutor } from '../../src/lib/agent/tools/registry.js'
import { ADAPTER_TOOL_SPECS, createDefaultToolRegistry } from '../../src/lib/agent/tools/adapters/index.js'
import { createInMemoryAgentStore } from '../../src/lib/agent/runtime/store.js'
import { createRunService } from '../../src/lib/agent/runtime/run-service.js'
import { resolveAgentMode } from '../../src/lib/agent/config/agent-config.js'
import { createStubIdentityProvider } from '../../src/lib/agent/security/identity.js'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

const obj = (properties = {}) => ({ type: 'object', additionalProperties: false, properties })

function baseSpec(over = {}) {
  return {
    name: 'test.read_thing',
    version: 1,
    capability: 1,
    label: 'Reading a test thing',
    description: 'test',
    input_schema: obj({ id: { type: 'string', maxLength: 40 } }),
    output_schema: { type: 'object' },
    side_effect: 'read',
    permission: { min_role: 'operator', apps: ['entity-graph'] },
    cost_class: 'db_light',
    limits: { rows_to_model: 2, max_rows: 10, timeout_ms: 1000, per_run: 5 },
    disclosure: { to_model: ['id'], never: ['phone', 'email'] },
    wraps: { module: '@/lib/domain/test/fake.js', export: 'readFake', route: 'GET /x' },
    execute: async () => ({ rows: [{ id: 'a', phone: '+15555550100' }, { id: 'b' }, { id: 'c' }] }),
    audit: () => ({ summary: 'read' }),
    failure: { retry: 'none', surface: 'tool_error' },
    ...over,
  }
}

const t2Extras = {
  side_effect: 'reversible_write',
  idempotency: (input, ctx) => `${ctx.run_id}:x`,
  touches: ['lead_state.temperature'],
  readback: async () => ({}),
  undo: { kind: 'inverse', build: () => ({}), window_h: 24 },
  intent_family: 'pipeline',
  action_fields: ['temperature'],
  risk_assessment: { consumers: ['follow-up scheduler'], undo_restores_all: false, approved_by: 'owner', approved_at: '2026-10-08' },
  failure: { retry: 'none', surface: 'tool_error' },
}

const t3Extras = {
  side_effect: 'consequential',
  idempotency: (input, ctx) => `${ctx.run_id}:y`,
  touches: ['campaign_targets'],
  readback: async () => ({}),
  approval_class: 'default',
  effects: () => [{ summary: 'Builds targets', kind: 'materialize', reversible: false, undo_note: null }],
  preconditions: async () => ({ campaign_status: 'draft' }),
  failure: { retry: 'none', surface: 'tool_error' },
}

test('tier is derived from side_effect and cannot be declared otherwise', () => {
  assert.equal(defineTool(baseSpec()).tier, 'T0')
  assert.equal(defineTool(baseSpec({ name: 'test.draft_x', side_effect: 'draft', idempotency: () => 'k' })).tier, 'T1')
  assert.equal(defineTool(baseSpec({ name: 'pipeline.set_temp', ...t2Extras })).tier, 'T2')
  assert.equal(defineTool(baseSpec({ name: 'campaigns.build_targets_x', ...t3Extras })).tier, 'T3')
  assert.throws(() => defineTool(baseSpec({ tier: 'T1' })), /tier is derived/)
})

test('approval can never be lowered below the tier default', () => {
  assert.throws(() => defineTool(baseSpec({ name: 'campaigns.build_targets_x', ...t3Extras, approval: 'none' })), (e) => e.code === 'TOOL_APPROVAL_DOWNGRADE')
  assert.throws(() => defineTool(baseSpec({ name: 'pipeline.set_temp', ...t2Extras, approval: 'none' })), (e) => e.code === 'TOOL_APPROVAL_DOWNGRADE')
  assert.equal(defineTool(baseSpec({ approval: 'token' })).approval, 'token') // raising is allowed
})

test('incomplete permission contracts are refused', () => {
  const missing = ['label', 'input_schema', 'permission', 'cost_class', 'limits', 'disclosure', 'wraps', 'execute', 'audit', 'failure']
  for (const k of missing) {
    const s = baseSpec()
    delete s[k]
    assert.throws(() => defineTool(s), (e) => e.code === 'TOOL_SPEC_INVALID', `missing ${k} must be refused`)
  }
  assert.throws(() => defineTool(baseSpec({ input_schema: { type: 'object', properties: {} } })), /additionalProperties/)
  assert.throws(() => defineTool(baseSpec({ input_schema: obj({ q: { type: 'string' } }) })), /maxLength/)
  assert.throws(() => defineTool(baseSpec({ disclosure: { to_model: [], never: ['email'] } })), /phone/)
  assert.throws(() => defineTool(baseSpec({ name: 'test.draft_x', side_effect: 'draft' })), /idempotency/)
})

test('T2 requires an owner-approved risk assessment, undo, readback and touches (O5)', () => {
  const noRa = { ...t2Extras }
  delete noRa.risk_assessment
  assert.throws(() => defineTool(baseSpec({ name: 'pipeline.set_temp', ...noRa })), (e) => e.code === 'TOOL_RISK_ASSESSMENT_REQUIRED')
  assert.throws(() => defineTool(baseSpec({ name: 'pipeline.set_temp', ...t2Extras, risk_assessment: { ...t2Extras.risk_assessment, approved_by: null } })), (e) => e.code === 'TOOL_RISK_ASSESSMENT_REQUIRED')
  assert.throws(() => defineTool(baseSpec({ name: 'pipeline.set_temp', ...t2Extras, undo: null })), /undo/)
  assert.throws(() => defineTool(baseSpec({ name: 'pipeline.set_temp', ...t2Extras, readback: null })), /readback/)
  assert.throws(() => defineTool(baseSpec({ name: 'pipeline.set_temp', ...t2Extras, touches: [] })), /touches/)
})

test('T3 requires approval_class, effects and preconditions', () => {
  for (const k of ['approval_class', 'effects', 'preconditions']) {
    const s = baseSpec({ name: 'campaigns.build_targets_x', ...t3Extras })
    delete s[k]
    assert.throws(() => defineTool(s), (e) => e.code === 'TOOL_SPEC_INVALID', k)
  }
})

test('T4 prohibited tools are simply not registerable (names, domains, modules, surfaces)', () => {
  const byName = [
    'suppression.suppress', 'inbox.unsuppress', 'inbox.set_opt_out', 'identity.owner_verify_phone', 'graph.link_phone',
    'contact_history.rewrite', 'system_control.set', 'queue.control', 'queue.run', 'queue.auto_enqueue', 'queue.retry',
    'routing.sender_pool_edit', 'offer.submit', 'pipeline.set_price', 'valuation.recalc', 'deal.current_offer_set',
    'contract.sign', 'closing_desk.execute', 'email.send', 'buyer.blast', 'workflow.publish', 'template.activate',
    'sms_templates.insert', 'records.hard_delete', 'agent.policy_update', 'budget_caps.raise', 'model_route.set',
    'approval.grant', 'db.sql', 'db.execute_sql', 'proxy.call_route', 'net.fetch_url', 'web.web_fetch',
  ]
  for (const name of byName) {
    assert.throws(() => defineTool(baseSpec({ name })), (e) => e.code === 'TOOL_PROHIBITED', `${name} must be prohibited`)
  }
  // innocuous name, prohibited written domain
  for (const d of ['suppression', 'system_control', 'canonical_price', 'offer', 'contact_history', 'sms_templates', 'approval_grant', 'budget_caps']) {
    assert.throws(() => defineTool(baseSpec({ name: 'pipeline.innocent', ...t3Extras, touches: [d] })), (e) => e.code === 'TOOL_PROHIBITED', d)
  }
  // innocuous name, prohibited module
  for (const m of ['@/lib/providers/textgrid.js', '@/lib/domain/queue/process-send-queue.js', '@/lib/domain/outbound/x.js', '@/lib/domain/seller-flow/y.js', '@/lib/system-control.js']) {
    assert.throws(() => defineTool(baseSpec({ name: 'x.innocent', wraps: { module: m, export: 'f', route: 'x' } })), (e) => e.code === 'TOOL_PROHIBITED', m)
  }
  // SQL / proxy / egress input surfaces
  for (const k of ['sql', 'url', 'route', 'endpoint', 'table', 'rpc']) {
    assert.throws(() => defineTool(baseSpec({ name: 'x.innocent', input_schema: obj({ [k]: { type: 'string', maxLength: 10 } }) })), (e) => e.code === 'TOOL_PROHIBITED', k)
  }
  assert.throws(() => defineTool(baseSpec({ name: 'x.innocent', wraps: { kind: 'sql', module: 'x', export: 'y' } })), (e) => e.code === 'TOOL_PROHIBITED')
  assert.throws(() => defineTool(baseSpec({ name: 'x.innocent', side_effect: 'prohibited' })), (e) => e.code === 'TOOL_PROHIBITED')
  // and the registry surfaces the same refusal
  const reg = createToolRegistry()
  assert.throws(() => reg.register(baseSpec({ name: 'suppression.suppress' })), (e) => e.code === 'TOOL_PROHIBITED')
  assert.equal(reg.list().length, 0)
})

test('architecture-allowed names are NOT caught by the T4 net', () => {
  for (const name of ['inbox.check_opt_out', 'suppression.flag_candidate', 'offer.recommend_range', 'valuation.read', 'eg.list', 'queue.range_aggregates', 'record.propose_change']) {
    assert.doesNotThrow(() => defineTool(baseSpec({ name })), name)
  }
})

test('registry: duplicates refused, sealed after boot', () => {
  const reg = createToolRegistry()
  reg.register(baseSpec())
  assert.throws(() => reg.register(baseSpec()), (e) => e.code === 'TOOL_DUPLICATE')
  reg.seal()
  assert.throws(() => reg.register(baseSpec({ name: 'test.other' })), (e) => e.code === 'REGISTRY_SEALED')
})

test('S1 default registry: only T0 read tools, one adapter set per app, all wrap existing service exports', () => {
  const reg = createDefaultToolRegistry()
  assert.equal(reg.sealed, true)
  const apps = Object.keys(ADAPTER_TOOL_SPECS)
  assert.deepEqual(apps.sort(), ['campaigns', 'entity-graph', 'inbox', 'map', 'market-intel', 'notifications', 'pipeline', 'queue'].sort())
  for (const t of reg.list()) {
    assert.equal(t.tier, 'T0', `${t.name} must be T0 in S1`)
    assert.equal(t.side_effect, 'read')
    assert.ok(!/sql/i.test(t.name))
    const file = `${SRC}${t.wraps.module.replace('@/', '')}`
    assert.ok(existsSync(file), `${t.name} wraps missing module ${t.wraps.module}`)
    const src = readFileSync(file, 'utf8')
    assert.match(src, new RegExp(`export\\s+(async\\s+)?function\\s+${t.wraps.export}\\b`), `${t.name}: ${t.wraps.export} not exported by ${t.wraps.module}`)
  }
})

test('adapter files import no service code at module load (lazy references only)', () => {
  const dir = `${SRC}lib/agent/tools/adapters/`
  for (const f of ['entity-graph.js', 'campaigns.js', 'inbox.js', 'pipeline.js', 'map.js', 'market-intel.js', 'queue.js', 'notifications.js', '_read-tool.js']) {
    const src = readFileSync(dir + f, 'utf8')
    for (const m of src.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)) assert.ok(m[1].startsWith('./') || m[1].startsWith('../'), `${f} statically imports ${m[1]}`)
  }
})

function ctxFor(over = {}) {
  return { mode: 'read', enabled_capabilities: [1, 2, 5, 7, 9, 10, 11, 12], session_user_id: 'op-1', identity: null, role: 'operator', ...over }
}

test('authorization: mode ceiling (default off refuses everything)', () => {
  const reg = createDefaultToolRegistry()
  assert.equal(resolveAgentMode({ env: {} }), 'off')
  assert.equal(resolveAgentMode({ env: { AGENT_MAX_MODE: 'read' }, systemControlMode: 'full' }), 'read') // runtime can't exceed env ceiling
  assert.equal(resolveAgentMode({ env: { AGENT_MAX_MODE: 'full' }, systemControlMode: 'off' }), 'off')
  assert.equal(resolveAgentMode({ env: { AGENT_MAX_MODE: 'bogus' } }), 'off')
  assert.equal(authorizeToolCall({ registry: reg, tool: 'eg.counts', input: {}, ctx: ctxFor({ mode: 'off' }) }).code, 'AGENT_MODE_CEILING')
  assert.equal(authorizeToolCall({ registry: reg, tool: 'eg.counts', input: {}, ctx: ctxFor() }).decision, 'allow')
})

test('authorization: unregistered, invalid input, capability, role, session', () => {
  const reg = createDefaultToolRegistry()
  assert.equal(authorizeToolCall({ registry: reg, tool: 'suppression.suppress', input: {}, ctx: ctxFor() }).code, 'TOOL_NOT_REGISTERED')
  assert.equal(authorizeToolCall({ registry: reg, tool: 'eg.list', input: { scope: 'nope' }, ctx: ctxFor() }).code, 'INPUT_INVALID')
  assert.equal(authorizeToolCall({ registry: reg, tool: 'eg.list', input: { scope: 'properties', extra: 1 }, ctx: ctxFor() }).code, 'INPUT_INVALID')
  assert.equal(authorizeToolCall({ registry: reg, tool: 'eg.counts', input: {}, ctx: ctxFor({ enabled_capabilities: [5] }) }).code, 'CAPABILITY_DISABLED')
  assert.equal(authorizeToolCall({ registry: reg, tool: 'eg.counts', input: {}, ctx: ctxFor({ session_user_id: null }) }).code, 'SESSION_REQUIRED')
})

test('authorization: T2/T3 refused without verified named identity; bulk > N escalates T2 → T3', () => {
  const reg = createToolRegistry()
  reg.register(baseSpec({ name: 'pipeline.set_temp', ...t2Extras, input_schema: obj({ ids: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 40 } }, temperature: { type: 'string', maxLength: 10 } }), target_refs: (i) => (i.ids || []).map((x) => `opportunity:${x}`) }))
  reg.register(baseSpec({ name: 'campaigns.build_targets_x', ...t3Extras }))
  const full = ctxFor({ mode: 'full', enabled_capabilities: [1] })
  assert.equal(authorizeToolCall({ registry: reg, tool: 'pipeline.set_temp', input: { ids: ['1'], temperature: 'hot' }, ctx: full }).code, 'IDENTITY_REQUIRED')
  assert.equal(authorizeToolCall({ registry: reg, tool: 'campaigns.build_targets_x', input: {}, ctx: full }).code, 'IDENTITY_REQUIRED')
  // the stub identity provider never produces a verified identity
  const stub = createStubIdentityProvider()
  assert.equal(stub.available, false)
  const verifiedLooking = { verified: true, named: true, user_id: 'u1' }
  const bulk = authorizeToolCall({ registry: reg, tool: 'pipeline.set_temp', input: { ids: Array.from({ length: 26 }, (_, i) => String(i)), temperature: 'hot' }, ctx: { ...full, identity: verifiedLooking } })
  assert.equal(bulk.tier, 'T3')
  assert.equal(bulk.decision, 'approval_required')
  // mode=write cannot run T3
  assert.equal(authorizeToolCall({ registry: reg, tool: 'campaigns.build_targets_x', input: {}, ctx: { ...full, mode: 'write', identity: verifiedLooking } }).code, 'AGENT_MODE_CEILING')
})

test('executor: refusal is an event; output projection strips never-fields and caps rows; result is untrusted', async () => {
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store })
  const run = await runs.createRun({ kind: 'conversation', operator_id: 'op-1' })
  const reg = createToolRegistry()
  reg.register(baseSpec())
  const exec = createToolExecutor({ registry: reg, store })
  const off = await exec.execute({ run_id: run.id, tool: 'test.read_thing', input: {}, ctx: ctxFor({ mode: 'off' }) })
  assert.equal(off.status, 'refused')
  assert.equal(off.code, 'AGENT_MODE_CEILING')
  const types = store.read().events.filter((e) => e.run_id === run.id).map((e) => e.type)
  assert.deepEqual(types.slice(-2), ['tool.proposed', 'tool.refused'])

  const ok = await exec.execute({ run_id: run.id, tool: 'test.read_thing', input: {}, ctx: ctxFor() })
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.result.trust, 'untrusted')
  assert.equal(ok.result.content.rows.length, 2) // rows_to_model cap
  assert.equal(ok.truncated, true)
  assert.ok(!('phone' in ok.result.content.rows[0]))
  const started = store.read().events.find((e) => e.type === 'tool.started')
  assert.equal(started.payload.label, 'Reading a test thing')
  assert.equal(started.payload.operation, 'tool.invoke')
})

test('executor: tool context exposes no approval service, store or secrets', async () => {
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store })
  const run = await runs.createRun({ kind: 'conversation', operator_id: 'op-1' })
  let seen
  const reg = createToolRegistry()
  reg.register(baseSpec({ execute: async (input, ctx) => { seen = ctx; return { rows: [] } } }))
  const exec = createToolExecutor({ registry: reg, store, approvals: { requestApproval() {}, grant() {}, consume() {} } })
  await exec.execute({ run_id: run.id, tool: 'test.read_thing', input: {}, ctx: ctxFor() })
  assert.deepEqual(Object.keys(seen).sort(), ['operator', 'run_id', 'services', 'signal', 'tool_call_id'])
  assert.ok(Object.isFrozen(seen))
})

test('executor: domain refusal surfaced verbatim, never as success; timeouts fail honestly', async () => {
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store })
  const run = await runs.createRun({ kind: 'conversation', operator_id: 'op-1' })
  const reg = createToolRegistry()
  reg.register(baseSpec({ name: 'test.refuses', execute: async () => { const e = new Error('Outbound paused by owner'); e.refusal = true; e.code = 'OUTBOUND_PAUSED'; throw e } }))
  reg.register(baseSpec({ name: 'test.slow', limits: { rows_to_model: 2, max_rows: 10, timeout_ms: 20, per_run: 5 }, execute: () => new Promise((r) => setTimeout(r, 200)) }))
  const exec = createToolExecutor({ registry: reg, store })
  const r = await exec.execute({ run_id: run.id, tool: 'test.refuses', input: {}, ctx: ctxFor() })
  assert.equal(r.status, 'refused')
  assert.equal(r.code, 'OUTBOUND_PAUSED')
  const ev = store.read().events.find((e) => e.type === 'tool.refused' && e.payload.refusal_code === 'OUTBOUND_PAUSED')
  assert.equal(ev.payload.message, 'Outbound paused by owner')
  const s = await exec.execute({ run_id: run.id, tool: 'test.slow', input: {}, ctx: ctxFor() })
  assert.equal(s.status, 'failed')
  assert.equal(s.code, 'TOOL_TIMEOUT')
})
