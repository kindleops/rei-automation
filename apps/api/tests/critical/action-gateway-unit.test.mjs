// Action Gateway phase 1, unit + static proofs (no database): the catalog's invariants, the standing-grant scope /
// envelope mirrors, approval judging, free-text cleaning, credentials, and that the gateway can never reach the
// send stack (no import path to a queue writer, the R3 executor or a provider transport).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACTIONS, READS, REQUESTED_TOOLS, NEVER_EXPOSED, WORKFORCE_TOOLS, createActionCatalog, OHG_TOOLS, AGENT_MESSAGE_TOOLS, RECORD_TOOLS, CAMPAIGN_TOOLS } from '../../src/lib/domain/action-gateway/catalog.js'
import { scopeCovers, envelopeRefusal } from '../../src/lib/domain/action-gateway/gateway.js'
import { judgeApproval, buildApprovalRequest, agentActionApprovalCapability, approvalSnapshotOf } from '../../src/lib/domain/action-gateway/approvals.js'
import { cleanText } from '../../src/lib/domain/action-gateway/actions.js'
import { credentialDigest, mintAgentCredential, AGENT_CREDENTIAL_RE } from '../../src/lib/domain/action-gateway/credentials.js'
import { FORGED_CONTEXT_KEYS, ESCALATION_KEYS, TIERS } from '../../src/lib/domain/action-gateway/constants.js'
import { defineCapability } from '../../src/lib/agent/capabilities/contracts.js'
import { classifyProhibited } from '../../src/lib/agent/tools/prohibited.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_DIR = path.resolve(HERE, '../../src/lib/domain/action-gateway')
const PEPPER = 'p'.repeat(40)

test('catalog: the 22 requested tools + the scoped reads; implemented = the T1 set + set_thread_hold + the T2 family (reversible or request-only) + the report-only reconciliation + the T3 / T4 family; a T3 / T4 tool is never standing-grant-only; nothing never-exposed exists', () => {
  // (the record-sync family, link 10, and the campaign drafts of the service principals link are their own families)
  const FAMILIES = [...WORKFORCE_TOOLS, ...OHG_TOOLS, ...AGENT_MESSAGE_TOOLS, ...RECORD_TOOLS, ...CAMPAIGN_TOOLS]
  const all = [...ACTIONS.map((a) => a.name), ...READS.filter((r) => r.name !== 'read_conversation_context').map((r) => r.name)].filter((n) => !FAMILIES.includes(n))
  assert.deepEqual([...all].sort(), [...REQUESTED_TOOLS].sort())
  // + the agent-text family (link #32, owner architecture correction 2026-10-29): ONE T3 seller-facing write — the agent's
  //   EXACT text (standing-grantable like the reply) —, the RETIRED brief-based agent message (AGENT_COMPOSES_TEXT), three
  //   standing T2 reversible lead-ownership writes (assign, release, transfer), four reads
  assert.deepEqual([...AGENT_MESSAGE_TOOLS].sort(), ['agent_lead_pool', 'assign_lead', 'events_since', 'get_lead_assignment', 'list_message_templates', 'queue_agent_message', 'queue_agent_text', 'release_lead', 'send_controls', 'transfer_lead'])
  const qat = createActionCatalog().get('queue_agent_text')
  assert.deepEqual([qat.tier, qat.capability, qat.standing_reply, qat.executor.fn, qat.retired ?? null], [TIERS.T3, 'conversation.queue_agent_text', true, 'action_gateway_dw_handoff', null])
  assert.deepEqual(qat.input.required, ['client_request_id', 'purpose', 'body', 'attribution'])
  assert.ok(!Object.keys(qat.input.properties).some((k) => /(phone|e164|sender|^from_|^to_|persona)/i.test(k)), 'the agent never supplies routing: LeadCommand resolves the number and the sender')
  for (const n of ['queue_agent_message', 'queue_authorized_reply']) assert.equal(createActionCatalog().get(n).retired?.code, 'AGENT_COMPOSES_TEXT', n)
  assert.deepEqual([createActionCatalog().get('agent_lead_pool').tier, createActionCatalog().get('agent_lead_pool').capability], [TIERS.T1, 'leads.read_pool'])
  assert.deepEqual([createActionCatalog().get('send_controls').tier, createActionCatalog().get('send_controls').capability], [TIERS.T1, 'controls.read'])
  const qam = createActionCatalog().get('queue_agent_message')
  assert.deepEqual([qam.tier, qam.capability, qam.standing_reply, qam.executor.fn], [TIERS.T3, 'conversation.queue_agent_message', true, 'action_gateway_dw_handoff'])
  assert.ok(!Object.keys(qam.input.properties).some((k) => /(phone|e164|sender|from_|to_|persona|body|text|message)/i.test(k)), 'the agent never supplies routing or text (a brief only)')
  for (const n of ['assign_lead', 'release_lead', 'transfer_lead']) assert.deepEqual([createActionCatalog().get(n).tier, createActionCatalog().get(n).reversible, createActionCatalog().get(n).executor.fn], [TIERS.T2, true, 'action_gateway_dw_lead_assignment'], n)
  // + the Operation Hidden Gold family (link #29): four standing T2 reversible writes through ONE domain write, two scoped reads
  assert.deepEqual([...OHG_TOOLS].sort(), ['get_lead_annotations', 'get_reply_delivery_status', 'record_conversation_note', 'record_seller_statement', 'set_lead_temperature', 'update_lead_status'])
  for (const n of OHG_TOOLS) {
    const s = createActionCatalog().get(n)
    assert.ok(s && /^acquisitions\.[a-z_]+$/.test(s.capability), n)
    if (READS.some((r) => r.name === n)) assert.ok(s.tier === TIERS.T1 && s.scope === 'conversation_context.read', n)
    else assert.ok(s.tier === TIERS.T2 && s.reversible === true && s.executor.fn === 'action_gateway_dw_ohg', n)
  }
  // + the 11 Workforce tools (docs/WORKFORCE-AGNTEI.md §2): T1, internal, the ONE Workforce writer / the principal-bound read
  assert.equal(WORKFORCE_TOOLS.length, 11)
  for (const n of WORKFORCE_TOOLS) {
    const s = createActionCatalog().get(n)
    assert.ok(s && s.tier === TIERS.T1 && /^workforce\.[a-z_]+$/.test(s.capability), n)
    if (!READS.some((r) => r.name === n)) assert.equal(s.executor.fn, 'action_gateway_dw_workforce', n)
  }
  const impl = ACTIONS.filter((a) => a.implemented !== false)
  for (const n of ['create_operator_task', 'create_research_job', 'draft_seller_reply', 'request_property_valuation', 'run_authorized_reconciliation', 'set_thread_hold', 'update_operator_task',
    'update_lead_disposition', 'update_lead_stage', 'create_deal_action', 'request_thread_hold_release', 'schedule_followup', 'cancel_followup', 'pause_campaign', 'request_campaign_resume', 'adjust_campaign_plan',
    'queue_authorized_reply', 'submit_offer_for_approval', 'execute_authorized_offer', 'record_seller_counteroffer']) {
    assert.ok(impl.some((a) => a.name === n), `${n} implemented`)
  }
  for (const a of impl) assert.ok(a.tier === TIERS.T1 || (a.tier === TIERS.T2 && (a.reversible === true || a.request_only === true)) || a.tier >= TIERS.T3 || a.name === 'record_seller_counteroffer', a.name)
  // T3 / T4 always need a per-use authority: a human approval, or (execute_authorized_offer only) a verified envelope ref
  for (const a of impl.filter((x) => x.tier >= TIERS.T3)) assert.ok(a.envelope_authorized !== true || a.name === 'execute_authorized_offer', a.name)
  for (const a of impl) assert.equal(classifyProhibited({ name: a.capability, touches: a.touches, wraps: a.wraps, input_schema: a.input }).prohibited, false, a.name)
  assert.deepEqual(READS.map((r) => r.name).filter((n) => !FAMILIES.includes(n)).sort(), ['prepare_acquisition_offer', 'read_conversation_context'])
  for (const n of NEVER_EXPOSED) assert.equal(createActionCatalog().get(n), null, n)
  for (const a of [...ACTIONS, ...READS]) for (const k of Object.keys(a.input.properties)) {
    assert.ok(!FORGED_CONTEXT_KEYS.test(k), `${a.name}.${k} would be refused as forged context`)
    assert.ok(!ESCALATION_KEYS.test(k), `${a.name}.${k} would be refused as escalation`)
    if (['queue_authorized_reply', 'execute_authorized_offer', 'submit_offer_for_approval', 'record_seller_counteroffer', 'prepare_acquisition_offer'].includes(a.name)) {
      assert.ok(!/(phone|e164|sender|from_|to_|persona|body|text)/i.test(k), `${a.name}.${k}: the agent never supplies routing or text`)
    }
  }
})

test('standing-grant scope mirror: absent axes are unrestricted; markets / campaigns / resource types restrict', () => {
  const thread = { type: 'thread', id: 'x', refs: { market: 'Chicago' } }
  assert.equal(scopeCovers({}, thread), true)
  assert.equal(scopeCovers({ markets: ['chicago'] }, thread), true)
  assert.equal(scopeCovers({ markets: ['Dallas'] }, thread), false)
  assert.equal(scopeCovers({ markets: ['Chicago'] }, { type: 'system', id: 'tasks', refs: {} }), false, 'a system resource is in no market')
  assert.equal(scopeCovers({ resource_types: ['property'] }, thread), false)
  assert.equal(scopeCovers({ campaign_ids: ['C1'] }, { type: 'campaign', id: 'c1', refs: {} }), true)
  assert.equal(scopeCovers({ campaign_ids: ['c1'] }, thread), false)
})

test('standing-grant envelope mirror: max / allow over the stored params; absent params are not constrained', () => {
  const env = { max: { budget_usd: 0.5, priority: 300 }, allow: { reason_code: ['operator_review'] } }
  assert.equal(envelopeRefusal(env, { budget_usd: 0.5, reason_code: 'operator_review' }), null)
  assert.equal(envelopeRefusal(env, { budget_usd: 0.51 }), 'ARGUMENT_OUTSIDE_ENVELOPE')
  assert.equal(envelopeRefusal(env, { budget_usd: '0.1' }), 'ARGUMENT_OUTSIDE_ENVELOPE', 'a non-number never satisfies a max')
  assert.equal(envelopeRefusal(env, { reason_code: 'other' }), 'ARGUMENT_OUTSIDE_ENVELOPE')
  assert.equal(envelopeRefusal(env, { title: 'x' }), null)
  assert.equal(envelopeRefusal({}, { anything: 1 }), null)
})

test('approvals: the decide-path capability is registrable; a gateway approval binds intent + params + agent; judging refuses pending / denied / mismatched / tampered / lapsed records', () => {
  assert.equal(defineCapability(agentActionApprovalCapability).id, 'agent_actions.authorize_action')
  const intent = { intent_id: '11111111-1111-4111-8111-111111111111', agent_id: 'agt_a', action: 'create_research_job', capability: 'research.create_job', tier: 1, resource_type: 'property', resource_id: '2128263281', params_hash: 'a'.repeat(64), state: 'received' }
  const principal = { org_id: '00000000-0000-4000-8000-0000000000c1', sponsor_user_id: '22222222-2222-4222-8222-222222222222' }
  const now = Date.parse('2026-10-19T12:00:00Z')
  const row = buildApprovalRequest({ intent, principal, now })
  assert.match(row.intended_change.resource_id, /^pid_[g-p]+$/, 'property ids are never raw in the approval payload')
  // every UUID in the payload sits under an id-named key (payload_is_clean exempts UUIDs from the phone-run rule only there)
  const walk = (o, k = '') => Object.entries(o || {}).forEach(([kk, v]) => { if (v && typeof v === 'object') walk(v, kk); else if (/[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(v))) assert.match(kk, /(^id$|_id$|_ids$|^requested_by$)/, `uuid under ${kk}`) })
  walk(buildApprovalRequest({ intent: { ...intent, resource_type: 'thread', resource_id: '700474ee-bd20-4d2a-a895-58797158f778' }, principal, now }))
  assert.equal(row.requested_by, principal.sponsor_user_id)
  assert.deepEqual(approvalSnapshotOf({ ...intent, state: 'awaiting_approval' }), approvalSnapshotOf(intent), 'the snapshot does not drift when the intent starts waiting')
  const executed = { ...row, state: 'executed', decision: 'approve', decided_by: '33333333-3333-4333-8333-333333333333' }
  assert.equal(judgeApproval(executed, intent, { now }).usable, true)
  assert.equal(judgeApproval({ ...row, state: 'pending' }, intent, { now }).pending, true)
  assert.equal(judgeApproval({ ...executed, state: 'denied' }, intent, { now }).code, 'APPROVAL_DENIED')
  assert.equal(judgeApproval(executed, { ...intent, params_hash: 'b'.repeat(64) }, { now }).code, 'APPROVAL_BINDING_MISMATCH')
  assert.equal(judgeApproval({ ...executed, intended_change: { ...executed.intended_change, grant_expires_at: '2099-01-01T00:00:00Z' } }, intent, { now }).code, 'APPROVAL_PAYLOAD_TAMPERED')
  assert.equal(judgeApproval(executed, intent, { now: now + 2 * 3600_000 }).code, 'APPROVAL_EXPIRED')
  assert.equal(judgeApproval({ ...executed, capability_id: 'pipeline.propose_stage_change' }, intent, { now }).code, 'APPROVAL_WRONG_CAPABILITY')
})

test('free text an agent supplies is masked and digit-run-neutralized before it can be stored', () => {
  const t = cleanText('Call 312-555-0161 or dana@example.com on 2026-10-19 10:30, ref 1234567890123', 200)
  assert.ok(!/555-0161|example\.com/.test(t), t)
  assert.ok(!/[0-9](?:[\s().,:/_+-]{0,4}[0-9]){9,14}/.test(t), t)
  assert.equal(cleanText('a\u0000b\u001fc', 10), 'a b c')
})

test('credentials: HMAC digests, never the token; malformed tokens have no digest; a short pepper is refused', () => {
  const { token, digest } = mintAgentCredential(PEPPER)
  assert.match(token, AGENT_CREDENTIAL_RE)
  assert.equal(credentialDigest(PEPPER, token), digest)
  assert.notEqual(credentialDigest(`${PEPPER}x`, token), digest)
  assert.equal(credentialDigest(PEPPER, 'lcag_short'), null)
  assert.throws(() => credentialDigest('short', token), /32 bytes/)
})

test('STATIC: the gateway module has no import path to the send stack (queue writers, the R3 executor, sms-engine, providers, cancel paths) and no raw SQL client', () => {
  const FORBIDDEN = /(process-send-queue|canonical-queue-writer|queue-atomic-claim|conversation-ai-r3-executor|conversation-turn-dispatch|supabase\/sms-engine|providers\/textgrid|cancel-supabase-pending-outbound|seller-flow\/|lib\/postgres\/client|send-now-service)/
  for (const f of fs.readdirSync(MODULE_DIR, { recursive: true }).filter((x) => String(x).endsWith('.js'))) {
    const src = fs.readFileSync(path.join(MODULE_DIR, f), 'utf8')
    const imports = [...src.matchAll(/(?:import\s[^'"]*from\s*|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const i of imports) assert.ok(!FORBIDDEN.test(i), `${f} imports ${i}`)
    assert.ok(!/\bfrom\(['"][a-z_]+['"]\)\.(insert|update|upsert|delete)\(/.test(src), `${f} writes a table directly`)
  }
})

// ── agent_lead_pool: every row carries the hold check it was judged on (founder rule 2026-11-27: an active hold always
//    overrides eligibility; missing or unreadable hold data fails closed) ─────────────────────────────────────────────
const POOL_PHONES = { clear: '+13125550301', held: '+13125550302', failed: '+13125550303', noTarget: '+13125550304', outside: '+13125550305' }
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CLEAR_SECTION = { active: 0, blocks_ai_action: false, rows: [] }

function poolHarness({ holdCheck, switches } = {}) {
  const calls = []
  // a chainable fake of the supabase query builder: every read answers no rows
  const chain = () => new Proxy({}, { get: (_, k) => (k === 'then' ? (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej) : () => chain()) })
  const poolRows = [
    { row_key: `ct:${uid(1)}`, campaign_target_id: uid(1), thread_id: uid(11), phone: POOL_PHONES.clear, property_id: '227876901', market: 'Chicago, IL' },
    { row_key: `ct:${uid(2)}`, campaign_target_id: uid(2), thread_id: null, phone: POOL_PHONES.held, property_id: '227876902', market: 'Chicago, IL' },
    { row_key: `ct:${uid(3)}`, campaign_target_id: uid(3), thread_id: null, phone: POOL_PHONES.failed, property_id: '227876903', market: 'Chicago, IL' },
    { row_key: `th:${uid(14)}`, campaign_target_id: null, thread_id: uid(14), phone: POOL_PHONES.noTarget, property_id: '227876904', market: 'Chicago, IL' },
    { row_key: `ct:${uid(5)}`, campaign_target_id: uid(5), thread_id: null, phone: POOL_PHONES.outside, property_id: '227876905', market: 'Elsewhere' },
  ]
  const reads = {
    client: { from: () => chain(), rpc: async (fn) => (fn === 'action_gateway_agent_lead_pool' ? { data: { rows: poolRows, has_more: false }, error: null } : { data: null, error: null }) },
    switches: switches || (async () => ({ ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { market_ids: ['Chicago, IL'] } }) })),
    property: async () => null,
    thread: async () => null,
    // the clear row's thread carries a STOP: the hold check ran clear, then the permission refused
    permission: async () => ({ blocked: true, reasons: ['stop_requested'] }),
  }
  const services = {
    holdCheck: async (a) => {
      calls.push({ key: a.threadKey, capability: a.capability })
      return holdCheck(a)
    },
  }
  return { reads, services, calls }
}
const defaultHoldCheck = async (a) => {
  if (a.threadKey === POOL_PHONES.held && a.capability === 'ai_action') return { held: true, fail_closed: false, hold_type: 'operator_hold', hold_ids: ['hold-1', 'hold-2'], reason: `operator reviewing; owner Sam says call ${POOL_PHONES.held}` }
  if (a.threadKey === POOL_PHONES.failed) throw new Error('registry unreachable')
  return { held: false, fail_closed: false, hold_type: null, hold_ids: [] }
}

test('agent_lead_pool: holdScan reports the hold check it ran (clear / held / failed / malformed), no reason text; holdDeny refusals are unchanged', async () => {
  const { holdScan, holdDeny } = await import('../../src/lib/domain/action-gateway/actions/t34/shared.js')
  const caps = ['ai_action', 'auto_reply']
  const svc = (fn) => ({ holdCheck: fn })
  const clear = await holdScan(svc(async () => ({ held: false })), {}, caps)
  assert.deepEqual(clear, { deny: null, holds: CLEAR_SECTION, hold_lookup_failed: false })
  const held = await holdScan(svc(async (a) => (a.capability === 'auto_reply' ? { held: true, fail_closed: false, hold_type: 'Operator_Hold', hold_ids: ['h1'], reason: 'call Sam at 312 555 0161' } : { held: false })), {}, caps)
  assert.deepEqual(held.holds, { active: 1, blocks_ai_action: true, rows: [{ hold_type: 'operator_hold', blocked_capabilities: ['auto_reply'] }] })
  assert.equal(held.deny.code, 'AUTOMATION_HOLD')
  assert.ok(!JSON.stringify(held.holds).includes('Sam') && !JSON.stringify(held.holds).includes('555'))
  const thrown = await holdScan(svc(async () => { throw new Error('down') }), {}, caps)
  assert.deepEqual([thrown.deny.code, thrown.holds, thrown.hold_lookup_failed], ['AUTOMATION_HOLD_LOOKUP_FAILED', null, true])
  const failClosed = await holdScan(svc(async () => ({ held: true, fail_closed: true })), {}, caps)
  assert.deepEqual([failClosed.deny.code, failClosed.holds, failClosed.hold_lookup_failed], ['AUTOMATION_HOLD_LOOKUP_FAILED', null, true])
  // neither held nor clear: unreadable hold data never reads as clear (the refusal code stays the one holdDeny gave)
  for (const bad of [null, {}, { held: 'no' }, { held: undefined }]) {
    const m = await holdScan(svc(async () => bad), {}, caps)
    assert.deepEqual([m.deny.code, m.holds, m.hold_lookup_failed], ['AUTOMATION_HOLD', null, true], JSON.stringify(bad))
  }
  // hold_type that is not a plain label is dropped, never echoed
  const odd = await holdScan(svc(async () => ({ held: true, fail_closed: false, hold_type: 'reviewing: call 3125550161 please' })), {}, ['ai_action'])
  assert.deepEqual(odd.holds.rows, [{ hold_type: null, blocked_capabilities: ['ai_action'] }])
  // holdDeny (assign_lead, transfer_lead, queue_agent_text) is the same refusal as before
  assert.equal(await holdDeny(svc(async () => ({ held: false })), {}, caps), null)
  assert.deepEqual(await holdDeny(svc(async () => { throw new Error('x') }), {}, caps), { decision: 'deny', code: 'AUTOMATION_HOLD_LOOKUP_FAILED', evidence: { hold: 'lookup_failed', capability: 'ai_action', hold_type: null } })
  assert.deepEqual(await holdDeny(svc(async () => ({ held: true, fail_closed: false, hold_type: 'operator_hold' })), {}, caps), { decision: 'deny', code: 'AUTOMATION_HOLD', evidence: { hold: 'held', capability: 'ai_action', hold_type: 'operator_hold' } })
})

test('agent_lead_pool: every row carries the hold section it was judged on — clear, held, lookup failed, and the rows refused before the check', async () => {
  const { AGENT_MESSAGE_FAMILY_LOGIC } = await import('../../src/lib/domain/action-gateway/actions/agent-message/index.js')
  const { reads, services, calls } = poolHarness({ holdCheck: defaultHoldCheck })
  const res = await AGENT_MESSAGE_FAMILY_LOGIC.agent_lead_pool.read({ input: { market: 'Chicago, IL' }, reads, services, principal: { agent_id: 'agt_unit_pool' }, now: () => Date.parse('2026-11-27T17:00:00Z') })
  const by = (id) => res.rows.find((r) => r.campaign_target_id === id || r.thread_id === id)
  assert.equal(res.rows.length, 5)
  // clear: the check ran and found none → active 0; the row is then refused by the thread's permission (STOP)
  const clear = by(uid(1))
  assert.deepEqual([clear.eligible, clear.ineligible_reason, clear.holds, clear.hold_lookup_failed], [false, 'STOP_REQUESTED', CLEAR_SECTION, false])
  // held: active >= 1, blocks_ai_action, eligible false; hold types and capabilities only
  const held = by(uid(2))
  assert.deepEqual([held.eligible, held.ineligible_reason, held.holds, held.hold_lookup_failed], [false, 'AUTOMATION_HOLD', { active: 2, blocks_ai_action: true, rows: [{ hold_type: 'operator_hold', blocked_capabilities: ['ai_action'] }] }, false])
  // lookup failed: holds null, hold_lookup_failed true, eligible false
  const failed = by(uid(3))
  assert.deepEqual([failed.eligible, failed.ineligible_reason, failed.holds, failed.hold_lookup_failed], [false, 'AUTOMATION_HOLD_LOOKUP_FAILED', null, true])
  // refused before the hold check: holds null (not checked), eligible false, and the registry was never asked
  const noTarget = by(uid(14))
  assert.deepEqual([noTarget.eligible, noTarget.ineligible_reason, noTarget.holds, noTarget.hold_lookup_failed], [false, 'FIRST_TOUCH_REQUIRES_CAMPAIGN_TARGET', null, false])
  const outside = by(uid(5))
  assert.deepEqual([outside.eligible, outside.ineligible_reason, outside.holds, outside.hold_lookup_failed], [false, 'LEAD_NOT_IN_AI_SEND_SCOPE', null, false])
  assert.ok(!calls.some((c) => c.key === POOL_PHONES.noTarget || c.key === POOL_PHONES.outside), JSON.stringify(calls))
  // the send policy's order: the hold check runs before the permission, every agent-text capability in order until one holds
  assert.deepEqual(calls.filter((c) => c.key === POOL_PHONES.clear).map((c) => c.capability), ['ai_action', 'auto_reply', 'campaign', 'follow_up', 'outbound_send'])
  // no row is eligible without holds.active === 0
  for (const r of res.rows) if (r.eligible) assert.ok(r.holds && r.holds.active === 0 && r.holds.blocks_ai_action === false && r.hold_lookup_failed === false, JSON.stringify(r))
  // privacy: never a phone (nor its digits), a name or the hold's reason text
  const s = JSON.stringify(res)
  for (const p of Object.values(POOL_PHONES)) assert.ok(!s.includes(p.slice(2)), p)
  assert.ok(!/Sam|operator reviewing/.test(s))
  assert.match(res.note, /holds/)

  // the AI send policy unreadable: every row ineligible, holds null (not checked), no hold lookup
  const u = poolHarness({ holdCheck: defaultHoldCheck, switches: async () => { throw new Error('switches down') } })
  const unread = await AGENT_MESSAGE_FAMILY_LOGIC.agent_lead_pool.read({ input: { market: 'Chicago, IL' }, reads: u.reads, services: u.services, principal: { agent_id: 'agt_unit_pool' }, now: () => Date.parse('2026-11-27T17:00:00Z') })
  for (const r of unread.rows) assert.deepEqual([r.eligible, r.ineligible_reason, r.holds, r.hold_lookup_failed], [false, 'AI_SEND_POLICY_UNREADABLE', null, false], JSON.stringify(r))
  assert.equal(u.calls.length, 0)
})

test('agent_lead_pool: holdGatedVerdict — eligible true never leaves without a hold section that shows the check ran clear', async () => {
  const { holdGatedVerdict, holdsClear } = await import('../../src/lib/domain/action-gateway/actions/agent-message/index.js')
  const base = { ineligible_reason: null, ineligible_detail: null, next_purpose: 'first_touch', window: { open: true, next_permitted_at: null } }
  const sections = [undefined, null, CLEAR_SECTION, { active: 1, blocks_ai_action: true, rows: [] }, { active: 0, blocks_ai_action: true, rows: [] }, { active: 3, blocks_ai_action: false, rows: [] }, { active: '0', blocks_ai_action: false, rows: [] }, { blocks_ai_action: false, rows: [] }, {}]
  for (const eligible of [true, false]) for (const holds of sections) for (const hold_lookup_failed of [undefined, false, true]) {
    const v = holdGatedVerdict({ ...base, eligible, ineligible_reason: eligible ? null : 'X', holds, hold_lookup_failed })
    const tag = JSON.stringify({ eligible, holds, hold_lookup_failed })
    if (v.eligible) assert.ok(v.holds?.active === 0 && v.holds.blocks_ai_action === false && v.hold_lookup_failed !== true && holdsClear(v), tag)
    if (eligible && !(holds === CLEAR_SECTION && hold_lookup_failed !== true)) {
      assert.equal(v.eligible, false, tag)
      assert.ok(['AUTOMATION_HOLD', 'AUTOMATION_HOLD_LOOKUP_FAILED'].includes(v.ineligible_reason), tag)
      if (v.ineligible_reason === 'AUTOMATION_HOLD_LOOKUP_FAILED') assert.deepEqual([v.holds, v.hold_lookup_failed], [null, true], tag)
      else assert.ok(v.holds.active > 0 && v.holds.blocks_ai_action === true, tag)
    }
    if (!eligible) assert.equal(v.ineligible_reason, 'X', tag) // an ineligible verdict keeps its own code
  }
})

test('test detector findPhoneLike: catches every real NANP / E.164 rendering, never a UUID / hash / timestamp / pid digit run', async () => {
  const { findPhoneLike } = await import('../helpers/action-gateway-pg.mjs')
  for (const p of ['+13125550161', '13125550161', '3125550161', '312-555-0161', '(312) 555-0161', '312.555.0161', '+1 312 555 0161', '1-312-555-0161', '+442071838750', 'call 312 555 0161 today'])
    assert.ok(findPhoneLike(`{"body":"${p}"}`), p)
  for (const n of ['700474ee-bd20-4d2a-a895-58797158f778', '1a2ee0ff-0000-4000-8000-0000000000a1', 'a'.repeat(32).replace(/a/g, '7') + 'ff', '2026-10-19T12:34:56.789Z',
    'pid_ihioimjioh', '•••-••61', '$250,000', '12 Oak St 60601', 'mjob_9f1c2e3a-4567-4890-abcd-ef0123456789'])
    assert.equal(findPhoneLike(`{"x":"${n}"}`), null, n)
})
