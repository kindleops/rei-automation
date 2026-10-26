// Action Gateway phase 1, unit + static proofs (no database): the catalog's invariants, the standing-grant scope /
// envelope mirrors, approval judging, free-text cleaning, credentials, and that the gateway can never reach the
// send stack (no import path to a queue writer, the R3 executor or a provider transport).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACTIONS, READS, REQUESTED_TOOLS, NEVER_EXPOSED, WORKFORCE_TOOLS, createActionCatalog } from '../../src/lib/domain/action-gateway/catalog.js'
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
  const all = [...ACTIONS.map((a) => a.name), ...READS.filter((r) => r.name !== 'read_conversation_context').map((r) => r.name)].filter((n) => !WORKFORCE_TOOLS.includes(n))
  assert.deepEqual([...all].sort(), [...REQUESTED_TOOLS].sort())
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
  assert.deepEqual(READS.map((r) => r.name).filter((n) => !WORKFORCE_TOOLS.includes(n)).sort(), ['prepare_acquisition_offer', 'read_conversation_context'])
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

test('test detector findPhoneLike: catches every real NANP / E.164 rendering, never a UUID / hash / timestamp / pid digit run', async () => {
  const { findPhoneLike } = await import('../helpers/action-gateway-pg.mjs')
  for (const p of ['+13125550161', '13125550161', '3125550161', '312-555-0161', '(312) 555-0161', '312.555.0161', '+1 312 555 0161', '1-312-555-0161', '+442071838750', 'call 312 555 0161 today'])
    assert.ok(findPhoneLike(`{"body":"${p}"}`), p)
  for (const n of ['700474ee-bd20-4d2a-a895-58797158f778', '1a2ee0ff-0000-4000-8000-0000000000a1', 'a'.repeat(32).replace(/a/g, '7') + 'ff', '2026-10-19T12:34:56.789Z',
    'pid_ihioimjioh', '•••-••61', '$250,000', '12 Oak St 60601', 'mjob_9f1c2e3a-4567-4890-abcd-ef0123456789'])
    assert.equal(findPhoneLike(`{"x":"${n}"}`), null, n)
})
