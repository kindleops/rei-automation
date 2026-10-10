// Agent S1 — human approval contracts: exact hash, scoped, expiring, single-use,
// verified named identity required (stub provider refuses every grant).
import test from 'node:test'
import assert from 'node:assert/strict'

import { createApprovalService, computePayloadHash } from '../../src/lib/agent/approvals/approval-service.js'
import { createStubIdentityProvider } from '../../src/lib/agent/security/identity.js'
import { createInMemoryAgentStore } from '../../src/lib/agent/runtime/store.js'
import { createRunService } from '../../src/lib/agent/runtime/run-service.js'
import { createToolRegistry, createToolExecutor } from '../../src/lib/agent/tools/registry.js'

const SECRET = 'test-approval-secret-0123456789'
const obj = (properties = {}) => ({ type: 'object', additionalProperties: false, properties })

function clock(start = Date.parse('2026-10-08T15:00:00Z')) {
  let t = start
  return { now: () => new Date(t), advance: (ms) => { t += ms } }
}

// Test-only verifier (S7 will provide the real Supabase-JWT verifier).
function testIdentityProvider({ user_id = 'u-lead', authenticated_at = null, verified = true, named = true } = {}, c) {
  return {
    available: true,
    async verify(session) {
      if (!session?.ok) return { verified: false, named: false, user_id: null, method: 'test', reason: 'no_session' }
      return { verified, named, user_id: session.user_id || user_id, display_name: 'Test Lead', authenticated_at: session.authenticated_at || authenticated_at || c.now().toISOString(), method: 'test', reason: null }
    },
  }
}

let counter = 0
function t3Spec(over = {}) {
  counter += 1
  return {
    name: `campaigns.build_targets_t${counter}`,
    version: 1,
    capability: 6,
    label: 'Building campaign targets',
    description: 'test',
    input_schema: obj({ campaign_id: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
    output_schema: { type: 'object' },
    side_effect: 'consequential',
    permission: { min_role: 'operator', apps: ['campaign-command'] },
    cost_class: 'db_heavy',
    limits: { rows_to_model: 10, max_rows: 10, timeout_ms: 1000, per_run: 5 },
    disclosure: { to_model: ['counts'], never: ['phone', 'email'] },
    wraps: { module: '@/lib/domain/campaigns/campaign-composer.js', export: 'prepareComposerLaunch', route: 'POST /x' },
    execute: async () => ({ built: 2 }),
    audit: () => ({ summary: 'built' }),
    failure: { retry: 'none', surface: 'tool_error' },
    idempotency: (input, ctx) => `${ctx.run_id}:${input.campaign_id}`,
    touches: ['campaign_targets'],
    readback: async () => ({}),
    approval_class: 'default',
    effects: (input) => [{ summary: `Builds targets for campaign ${input.campaign_id}`, kind: 'materialize', reversible: false, undo_note: null }],
    preconditions: async () => ({ campaign_status: 'draft' }),
    target_refs: (input) => [`campaign:${input.campaign_id}`],
    ...over,
  }
}

async function setup({ identity = 'stub', roleFor = () => 'lead', spec = t3Spec(), preconditions = null } = {}) {
  const c = clock()
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store, now: c.now })
  const run = await runs.createRun({ kind: 'task', operator_id: 'op-1' })
  const identityProvider = identity === 'stub' ? createStubIdentityProvider() : testIdentityProvider({}, c)
  const approvals = createApprovalService({ store, identityProvider, secret: SECRET, now: c.now, roleFor })
  const registry = createToolRegistry()
  let pre = { campaign_status: 'draft' }
  const def = registry.register({ ...spec, preconditions: preconditions || (async () => pre) })
  const exec = createToolExecutor({ registry, store, approvals, now: c.now })
  const verified = { verified: true, named: true, user_id: 'op-1' }
  const ctx = { mode: 'full', enabled_capabilities: [6], session_user_id: 'op-1', identity: verified, role: 'operator' }
  return { c, store, runs, run, approvals, registry, def, exec, ctx, setPre: (p) => { pre = p } }
}

test('payload hash is exact: any change to tool, version, input, targets or preconditions changes it', () => {
  const base = { tool: 't', tool_version: 1, input: { a: 1, b: [1, 2] }, resolved_targets: ['x:1', 'x:2'], preconditions: { s: 'draft' } }
  const h = computePayloadHash(base)
  assert.match(h, /^[0-9a-f]{64}$/)
  assert.equal(computePayloadHash({ ...base, input: { b: [1, 2], a: 1 } }), h, 'key order is canonical')
  assert.equal(computePayloadHash({ ...base, resolved_targets: ['x:2', 'x:1'] }), h, 'target set order is canonical')
  for (const v of [{ tool: 'u' }, { tool_version: 2 }, { input: { a: 2, b: [1, 2] } }, { input: { a: 1, b: [2, 1] } }, { resolved_targets: ['x:1'] }, { preconditions: { s: 'live' } }]) {
    assert.notEqual(computePayloadHash({ ...base, ...v }), h, JSON.stringify(v))
  }
})

test('S1 stub identity: approvals can be requested and shown, but every grant is IDENTITY_REQUIRED', async () => {
  const s = await setup({ identity: 'stub' })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  assert.equal(r.status, 'approval_required')
  assert.equal(r.approval.ok, true)
  assert.equal(r.approval.identity_available, false)
  const g = await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true, user_id: 'anyone' } })
  assert.deepEqual([g.ok, g.code], [false, 'IDENTITY_REQUIRED'])
  assert.equal(s.approvals.get(r.approval.approval_id).state, 'requested')
  const card = s.store.read().events.find((e) => e.type === 'approval.requested').payload.approval
  assert.equal(card.identity_available, false)
  assert.ok(!('token_digest' in card) && !('preconditions' in card))
})

test('grant requires the exact hash shown, an allowed role, and an unexpired pending approval', async () => {
  const s = await setup({ identity: 'test', roleFor: (u) => (u === 'u-op' ? 'operator' : 'lead') })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  const id = r.approval.approval_id
  assert.equal((await s.approvals.grant({ approval_id: id, payload_hash: 'f'.repeat(64), session: { ok: true } })).code, 'HASH_MISMATCH')
  assert.equal((await s.approvals.grant({ approval_id: id, payload_hash: r.approval.payload_hash, session: { ok: true, user_id: 'u-op' } })).code, 'ROLE_NOT_ALLOWED')
  assert.equal((await s.approvals.grant({ approval_id: id, payload_hash: r.approval.payload_hash, session: null })).code, 'IDENTITY_REQUIRED')
  const g = await s.approvals.grant({ approval_id: id, payload_hash: r.approval.payload_hash, session: { ok: true } })
  assert.equal(g.ok, true)
  assert.match(g.token, /^apr_[^.]+\.[0-9a-f]{64}$/)
  assert.equal((await s.approvals.grant({ approval_id: id, payload_hash: r.approval.payload_hash, session: { ok: true } })).code, 'APPROVAL_NOT_PENDING')
})

test('approvals expire (default 10 min) and an expired approval cannot be granted or consumed', async () => {
  const s = await setup({ identity: 'test' })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  assert.equal(Date.parse(r.approval.expires_at) - s.c.now().getTime(), 10 * 60 * 1000)
  s.c.advance(10 * 60 * 1000 + 1)
  const g = await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true } })
  assert.equal(g.code, 'APPROVAL_EXPIRED')
  assert.equal(s.approvals.get(r.approval.approval_id).state, 'expired')
  assert.ok(s.store.read().events.some((e) => e.type === 'approval.expired'))

  // granted-then-expired cannot be consumed either
  const r2 = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c2' }, ctx: s.ctx })
  const g2 = await s.approvals.grant({ approval_id: r2.approval.approval_id, payload_hash: r2.approval.payload_hash, session: { ok: true } })
  s.c.advance(10 * 60 * 1000 + 1)
  const x = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c2' }, ctx: { ...s.ctx, approval_token: g2.token, tool_call_id: r2.tool_call_id } })
  assert.equal(x.status, 'refused')
  assert.equal(x.code, 'APPROVAL_EXPIRED')
})

test('SMS approvals use the 5 min TTL; campaign launch 30 min', async () => {
  const sms = await setup({ identity: 'test', spec: t3Spec({ approval_class: 'sms' }) })
  const a = await sms.exec.execute({ run_id: sms.run.id, tool: sms.def.name, input: { campaign_id: 'c' }, ctx: sms.ctx })
  assert.equal(Date.parse(a.approval.expires_at) - sms.c.now().getTime(), 5 * 60 * 1000)
  const launch = await setup({ identity: 'test', spec: t3Spec({ approval_class: 'campaign_launch' }) })
  const b = await launch.exec.execute({ run_id: launch.run.id, tool: launch.def.name, input: { campaign_id: 'c' }, ctx: launch.ctx })
  assert.equal(Date.parse(b.approval.expires_at) - launch.c.now().getTime(), 30 * 60 * 1000)
})

test('single-use: the token executes exactly once; replay is refused', async () => {
  const s = await setup({ identity: 'test' })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  const g = await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true } })
  const ok = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: { ...s.ctx, approval_token: g.token, tool_call_id: r.tool_call_id } })
  assert.equal(ok.status, 'succeeded')
  assert.equal(s.approvals.get(r.approval.approval_id).state, 'consumed')
  const again = await s.approvals.consume({ token: g.token, tool_call_id: r.tool_call_id, tool: s.def.name, tool_version: 1, input: { campaign_id: 'c1' }, resolved_targets: ['campaign:c1'], preconditions: { campaign_status: 'draft' } })
  assert.equal(again.code, 'APPROVAL_ALREADY_CONSUMED')
  const types = s.store.read().events.map((e) => e.type)
  assert.ok(types.indexOf('approval.consumed') < types.lastIndexOf('tool.started'))
  assert.equal(s.store.read().audit.length, 1, 'T3 execution is audited')
})

test('scoped: a token cannot be used for a different payload, target or tool call', async () => {
  const s = await setup({ identity: 'test' })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  const g = await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true } })
  const other = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: { ...s.ctx, approval_token: g.token } })
  assert.equal(other.code, 'APPROVAL_SCOPE_MISMATCH')
  const widened = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1', limit: 500 }, ctx: { ...s.ctx, approval_token: g.token, tool_call_id: r.tool_call_id } })
  assert.equal(widened.status, 'refused')
  assert.equal(s.approvals.get(r.approval.approval_id).state, 'invalidated')
  assert.ok(s.store.read().events.some((e) => e.type === 'approval.invalidated'))
})

test('precondition drift between approval and execution invalidates (with a drift diff)', async () => {
  const s = await setup({ identity: 'test' })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  const g = await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true } })
  s.setPre({ campaign_status: 'live' })
  const x = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: { ...s.ctx, approval_token: g.token, tool_call_id: r.tool_call_id } })
  assert.equal(x.code, 'PRECONDITION_DRIFT')
  const ev = s.store.read().events.find((e) => e.type === 'approval.invalidated')
  assert.equal(ev.payload.drift.preconditions_changed, true)
})

test('forged or tampered tokens are refused', async () => {
  const s = await setup({ identity: 'test' })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true } })
  const forged = `${r.approval.approval_id}.${'0'.repeat(64)}`
  const x = await s.approvals.consume({ token: forged, tool_call_id: r.tool_call_id, tool: s.def.name, tool_version: 1, input: { campaign_id: 'c1' }, resolved_targets: ['campaign:c1'], preconditions: { campaign_status: 'draft' } })
  assert.equal(x.code, 'APPROVAL_TOKEN_INVALID')
  assert.equal((await s.approvals.consume({ token: 'garbage' })).code, 'APPROVAL_TOKEN_INVALID')
  // token for a still-pending (ungranted) approval
  const r2 = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c9' }, ctx: s.ctx })
  assert.equal((await s.approvals.consume({ token: `${r2.approval.approval_id}.${'a'.repeat(64)}` })).code, 'APPROVAL_NOT_GRANTED')
})

test('fresh auth (≤ 5 min) is required for high-impact tools; owner-only tools need an owner', async () => {
  const s = await setup({ identity: 'test', spec: t3Spec({ fresh_auth: true }) })
  const r = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  const stale = new Date(s.c.now().getTime() - 6 * 60 * 1000).toISOString()
  assert.equal((await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true, authenticated_at: stale } })).code, 'FRESH_AUTH_REQUIRED')
  assert.equal((await s.approvals.grant({ approval_id: r.approval.approval_id, payload_hash: r.approval.payload_hash, session: { ok: true } })).ok, true)

  const o = await setup({ identity: 'test', spec: t3Spec({ owner_only: true }), roleFor: (u) => (u === 'u-owner' ? 'owner' : 'lead') })
  const r2 = await o.exec.execute({ run_id: o.run.id, tool: o.def.name, input: { campaign_id: 'c1' }, ctx: o.ctx })
  assert.equal((await o.approvals.grant({ approval_id: r2.approval.approval_id, payload_hash: r2.approval.payload_hash, session: { ok: true } })).code, 'ROLE_NOT_ALLOWED')
  assert.equal((await o.approvals.grant({ approval_id: r2.approval.approval_id, payload_hash: r2.approval.payload_hash, session: { ok: true, user_id: 'u-owner' } })).ok, true)
})

test('denied payload cannot be re-proposed identically in the same run; batch = independent approvals', async () => {
  const s = await setup({ identity: 'test' })
  const a = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  assert.equal((await s.approvals.deny({ approval_id: a.approval.approval_id })).ok, true)
  const again = await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: 'c1' }, ctx: s.ctx })
  assert.equal(again.approval.code, 'IDENTICAL_PROPOSAL_DENIED')
  // a "batch" of 3 is 3 approvals; granting one grants only that one
  const batch = []
  for (const c of ['b1', 'b2', 'b3']) batch.push(await s.exec.execute({ run_id: s.run.id, tool: s.def.name, input: { campaign_id: c }, ctx: s.ctx }))
  assert.equal(new Set(batch.map((b) => b.approval.payload_hash)).size, 3)
  await s.approvals.grant({ approval_id: batch[1].approval.approval_id, payload_hash: batch[1].approval.payload_hash, session: { ok: true } })
  assert.deepEqual(batch.map((b) => s.approvals.get(b.approval.approval_id).state), ['requested', 'granted', 'requested'])
})

test('approval secret must be configured', () => {
  assert.throws(() => createApprovalService({ store: createInMemoryAgentStore(), identityProvider: createStubIdentityProvider(), secret: 'short' }))
})
