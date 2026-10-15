// 8.5.16 UNIFIED MESSAGE-ORIGIN CONTRACT: template | ai_generated | operator_manual.
// Templates and every existing producer are BYTE-IDENTICAL to production (golden from 6ecbae6b);
// ai_generated is a first-class origin with NO template id and an immutable record.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import * as smsEngine from '../../src/lib/supabase/sms-engine.js'
import * as provenance from '../../src/lib/domain/automation/outbound-provenance.js'
import * as templateAuthority from '../../src/lib/domain/templates/template-authority.js'
import { makeSendQueueRowsSupabase } from '../helpers/queue-run-test-harness.js'
import { computeSnapshots, NOW } from '../helpers/origin-byte-identity.mjs'
import { resolveMessageOrigin, storedMessageOrigin, MESSAGE_ORIGINS } from '../../src/lib/domain/messages/message-origin.js'
import { buildAiGeneratedMessage, isVerifiedAiGeneratedRow, verifyAiGeneratedRecordForRow, carriesAiTemplateMasquerade, sha256Hex, sealedThreadRef } from '../../src/lib/domain/messages/ai-generated-message.js'
import { evaluateAiConversationRowGate, isMaterialInbound } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { evaluateAutoReplySuperseded } from '../../src/lib/domain/queue/process-send-queue.js'
import { AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY } from '../../src/lib/domain/conversation-ai/send-policy.js'

const GOLDEN = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'origin-byte-identity.golden.json'), 'utf8'))
const SELLER = '+15555550101'
const OURS = '+15555550199'
const BODY = 'Got it, thanks. Would you consider selling it?'

function aiPair(over = {}) {
  const record = { id: crypto.randomUUID(), ...buildAiGeneratedMessage({ body: BODY, inboundMessageId: 'i1', queueKey: 'ai_conversation:i1', threadKey: SELLER, recipientPhone: SELLER, senderPhone: OURS, decisionId: 'conv-ai:v1:i1', model: 'claude-haiku-5-5', playbookVersion: 'playbook.v1', promptVersion: 'compose.v1', contextVersion: 'conv-ai.context.v1', validation: { status: 'validated' }, ledgerSnapshot: {}, policy: { enabled: true }, authorizationScope: { scope_match: 'thread_keys', category: 'next_missing_fact' }, generatedAt: NOW }) }
  const row = { id: 'q1', queue_key: 'ai_conversation:i1', message_body: BODY, to_phone_number: SELLER, from_phone_number: OURS, thread_key: SELLER, timezone: 'America/Chicago', message_origin: 'ai_generated', source: 'ai_conversation', inbound_message_id: 'i1', metadata: { source: 'ai_conversation', message_origin: 'ai_generated', ai_message_id: record.id, ai_message_body_sha256: sha256Hex(BODY), inbound_message_event_id: 'i1', inbound_received_at: '2026-10-15T14:58:00.000Z' }, ...over }
  return { record, row }
}
const sw = (policy = { enabled: true, scope: { thread_keys: [SELLER] } }) => async (k) => (k === AI_SEND_KILL_SWITCH_KEY ? 'true' : k === AI_SEND_POLICY_KEY ? JSON.stringify(policy) : null)

test('byte-identity: campaign, auto-reply, follow-up, operator and workflow rows are EXACTLY as in production (golden from 6ecbae6b)', async () => {
  const now = await computeSnapshots({ smsEngine, provenance, templateAuthority, makeSendQueueRowsSupabase })
  assert.deepEqual(now, GOLDEN.snapshots)
  // and nothing in them carries an origin field (the column stays NULL for existing producers)
  assert.ok(!JSON.stringify(GOLDEN.snapshots).includes('message_origin'))
})

test('origin resolution: stored origin wins; legacy rows derive template / operator_manual', () => {
  assert.deepEqual(MESSAGE_ORIGINS, ['template', 'ai_generated', 'operator_manual'])
  assert.deepEqual(resolveMessageOrigin({ template_id: 't1', metadata: { source: 'campaign_launch_execution' } }), { origin: 'template', basis: 'legacy_template' })
  assert.deepEqual(resolveMessageOrigin({ template_source: 'manual_composer', message_type: 'manual_reply', metadata: { source: 'manual_inbox' } }).origin, 'operator_manual')
  assert.deepEqual(resolveMessageOrigin({ message_origin: 'ai_generated' }), { origin: 'ai_generated', basis: 'stored' })
  assert.equal(storedMessageOrigin({ message_origin: 'robot' }), null, 'unknown values are not an origin')
})

test('ai_generated rows: no template id, no masquerade; template rows still need a real sms_templates row', async () => {
  const { record, row } = aiPair()
  assert.equal(isVerifiedAiGeneratedRow(row), true)
  assert.deepEqual(verifyAiGeneratedRecordForRow(row, record), { ok: true, reason: 'ai_generated_message' })
  assert.equal(isVerifiedAiGeneratedRow({ ...row, template_id: 't1' }), false)
  assert.equal(verifyAiGeneratedRecordForRow({ ...row, template_id: 'ai-msg:0123' }, record).reason, 'ai_template_masquerade_refused')
  assert.equal(carriesAiTemplateMasquerade({ metadata: { selected_template_id: 'ai-msg:1' } }), true)
  const client = { from: (t) => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: t === 'ai_generated_messages' ? [record] : [] }) }) }) }) }
  const ok = await templateAuthority.evaluateTemplateAuthority({ queue_row: row, supabase: client })
  assert.deepEqual([ok.allowed, ok.reason, ok.template_id], [true, 'ai_generated_message', null])
  // a template-origin row carrying an ai-msg id is refused (masquerade)
  const mask = await templateAuthority.evaluateTemplateAuthority({ queue_row: { template_id: 'ai-msg:0123456789abcdef0123456789abcdef', message_body: 'x', metadata: { source: 'auto_reply' } }, supabase: client })
  assert.deepEqual([mask.allowed, mask.detail], [false, 'ai_template_masquerade_refused'])
  // an ai_conversation row WITHOUT the ai_generated origin is refused
  const noOrigin = await templateAuthority.evaluateTemplateAuthority({ queue_row: { ...row, message_origin: null, metadata: { ...row.metadata, message_origin: null } }, supabase: client })
  assert.deepEqual([noOrigin.allowed, noOrigin.detail], [false, 'ai_conversation_requires_ai_generated_origin'])
  // operator copy can never be passed off as AI and vice versa
  const asManual = await templateAuthority.evaluateTemplateAuthority({ queue_row: row, supabase: client, manual_operator_send: true })
  assert.equal(asManual.allowed, false)
  // template rows: unchanged rule
  const tplNone = await templateAuthority.evaluateTemplateAuthority({ queue_row: { message_body: 'x', metadata: { source: 'auto_reply' } }, supabase: client })
  assert.equal(tplNone.detail, 'missing_template_id')
})

test('pre-claim: a verified ai_generated row is runnable (no template id needed); tampered or template-carrying AI rows are held', async () => {
  const { row } = aiPair({ id: 'b1f3c2d4-0000-4000-8000-0000000002a0', created_at: NOW, scheduled_for: NOW, scheduled_for_utc: NOW, queue_status: 'queued', timezone: 'America/Chicago' })
  const tampered = { ...row, id: 'b1f3c2d4-0000-4000-8000-0000000002a1', queue_key: 'x1', message_body: 'Thanks. What is the lowest you would take?' }
  const withTpl = { ...row, id: 'b1f3c2d4-0000-4000-8000-0000000002a2', queue_key: 'x2', template_id: 'tmpl-1' }
  const r = await smsEngine.loadRunnableSendQueueRows(10, { now: NOW, stale_lock_recovery_enabled: false, supabaseClient: makeSendQueueRowsSupabase([row, tampered, withTpl]), getSystemValue: async () => null, pauseInvalidQueueRow: async (n, p) => ({ ...n, ...p }) })
  assert.deepEqual(r.rows.map((x) => x.id), [row.id], JSON.stringify(r.skipped))
  assert.equal(r.skipped.find((s) => s.id === tampered.id)?.reason, 'missing_selected_template_id')
  assert.equal(r.skipped.find((s) => s.id === withTpl.id)?.reason, 'missing_candidate_snapshot', 'a template id puts the row back under the template rules')
})

test('send time: record verification, policy re-check and LATEST-INBOUND revalidation (a materially new inbound makes the AI reply stale)', async () => {
  const { record, row } = aiPair()
  const load = async () => ({ found: true, read_failed: false, record })
  const gate = (over = {}) => evaluateAiConversationRowGate(row, { readSwitch: sw(), loadRecord: load, loadNewerInbounds: async () => ({ read_failed: false, rows: [] }), now: NOW, ...over })
  assert.equal((await gate()).action, 'proceed')
  for (const [text, stale] of [['ok', false], ['Thanks!', false], ['👍', false], ['Actually my wife owns it too', true], ['how much would you pay?', true], ['STOP', true], ['no', true]]) {
    assert.equal(isMaterialInbound(text), stale, text)
    const g = await gate({ loadNewerInbounds: async () => ({ read_failed: false, rows: [{ id: 'i2', message_body: text }] }) })
    assert.equal(g.action === 'cancel' && g.reason === 'ai_reply_stale_new_inbound', stale, `${text}: ${JSON.stringify(g)}`)
  }
  assert.deepEqual(await gate({ loadNewerInbounds: async () => ({ read_failed: true }) }), { applies: true, action: 'defer', reason: 'ai_latest_inbound_unreadable' })
  assert.equal((await gate({ loadRecord: async () => ({ found: true, record: { ...record, message_body: 'other' } }) })).reason, 'ai_generated_record_corrupt')
  assert.equal((await gate({ readSwitch: sw({ enabled: true, scope: { thread_keys: [] } }) })).reason, 'ai_policy_scope_revoked_at_send')
  // a reply by ANY origin after the inbound supersedes the AI row (existing guard, now covering AI rows)
  const sb = { from: () => ({ select: () => ({ eq: (c) => (c === 'id' ? { maybeSingle: async () => ({ data: { id: 'i1', created_at: '2026-10-15T14:58:00.000Z' } }) } : { eq: () => ({ gt: () => ({ order: () => ({ limit: async () => ({ data: [{ id: 'op1', queue_id: 'manual-1' }] }) }) }) }) }) }) }) }
  const sup = await evaluateAutoReplySuperseded({ supabase: sb, queue_row: row })
  assert.deepEqual(sup, { superseded: true, newer_outbound_id: 'op1' })
})

test('provenance + message_events: the ai_generated origin and record link are stamped ONLY on AI rows', () => {
  const { row } = aiPair()
  const p = provenance.buildOutboundProvenance(row)
  assert.deepEqual([p.source_surface, p.message_origin, p.template_id], ['ai_conversation', 'ai_generated', null])
  const ev = smsEngine.buildSuccessMessageEvent({ ...row, id: 'b1f3c2d4-0000-4000-8000-0000000003a0', queue_status: 'sent' }, { sid: 'SM1' }, { now: NOW })
  assert.equal(ev.metadata.message_origin, 'ai_generated')
  assert.equal(ev.metadata.ai_message_id, row.metadata.ai_message_id)
  assert.equal(ev.template_id ?? null, null)
  assert.equal(sealedThreadRef(SELLER).startsWith('tr:'), true)
})
