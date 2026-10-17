// AI-GENERATED MESSAGES (8.5.16, owner directive 2026-10-15; supersedes the per-message
// template record of b001ffb6).
//
// "LeadCommand AI is not a template picker." "An AI-generated message must not masquerade
// as a template." An AI message therefore carries NO template_id. Its authority is ONE
// immutable record in public.ai_generated_messages (PROPOSED migration 20261015130000),
// linked to its queue row by queue_key, with:
//   exact text + sha256, sealed identities (thread / property / contact / sender /
//   recipient as sha256 refs), decision + job id, model, playbook / prompt / context
//   versions, validation result, ledger snapshot hash, authorisation scope + approval
//   state, idempotency key (one reply per inbound), generation time, cost / tokens,
//   audit refs. Lifecycle (queued, provider result, delivery state) is the append-only
//   public.ai_generated_message_events.
//
// The send_queue row: message_origin = 'ai_generated', source = 'ai_conversation',
// template_id / selected_template_id NULL, metadata.ai_message_id + ai_message_body_sha256.
// Acceptance rule (template authority, pre-claim loader, runner name guard, AI row gate):
//   origin ai_generated, no template id, record(queue_key) exists,
//   sha256(row body) = record.body_sha256 = sha256(record body), bound to this inbound / thread.
// An 'ai-msg:' template id is refused everywhere (no masquerade).
import crypto from 'node:crypto'

import { storedMessageOrigin } from '@/lib/domain/messages/message-origin.js'

export const AI_GENERATED_MESSAGE_VERSION = 'ai-generated-message.v1'
export const AI_GENERATED_MESSAGES_TABLE = 'ai_generated_messages'
export const AI_GENERATED_MESSAGE_EVENTS_TABLE = 'ai_generated_message_events'
export const AI_ORIGIN = 'ai_generated'
export const AI_SOURCE = 'ai_conversation'
export const LEGACY_AI_TEMPLATE_PREFIX = 'ai-msg:' // refused everywhere
export const AI_MESSAGE_EVENT_TYPES = Object.freeze(['queued', 'provider_accepted', 'provider_failed', 'delivered', 'undelivered', 'cancelled', 'held'])
export const AI_GENERATED_MESSAGE_COLUMNS = 'id,message_origin,queue_key,idempotency_key,inbound_message_id,thread_ref,property_ref,contact_ref,recipient_ref,sender_ref,message_body,body_sha256,decision_id,job_id,decision_outcome,model,playbook_version,prompt_version,context_version,validation,ledger_snapshot_hash,authorization_scope,approval_state,generated_at,cost_usd,input_tokens,output_tokens,audit_refs,record_version,created_at'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const digits = (v) => clean(v).replace(/[^0-9]/g, '').slice(-10)

/** sha256 hex of the EXACT text (utf-8); the DB CHECK computes the same. */
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** Sealed reference: kind prefix + sha256; the raw value is never stored. Phones by last 10 digits. */
export function sealedRef(kind, value) {
  const v = kind === 'ph' ? digits(value) : clean(value)
  return v ? `${kind}:${sha256Hex(v)}` : null
}
export const sealedThreadRef = (threadKey) => sealedRef('tr', threadKey)

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

function rowMeta(row) {
  return row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
}
export function rowTemplateIds(row = {}) {
  const m = rowMeta(row)
  return [row?.template_id, row?.selected_template_id, row?.template_key, m.selected_template_id, m.template_id].map(clean).filter(Boolean)
}
export function carriesAiTemplateMasquerade(row = {}) {
  return rowTemplateIds(row).some((id) => id.startsWith(LEGACY_AI_TEMPLATE_PREFIX))
}
export function rowSourceIsAi(row = {}) {
  return lower(row?.source) === AI_SOURCE || lower(rowMeta(row).source) === AI_SOURCE
}
export function rowBody(row = {}) {
  return String(row?.message_body ?? row?.message_text ?? '')
}

/**
 * Static (no I/O) acceptance check: the synchronous pre-claim loader and the runner's name
 * guard use it. The DB record itself is verified by the AI row gate and template authority.
 */
export function isVerifiedAiGeneratedRow(row = {}) {
  if (storedMessageOrigin(row) !== AI_ORIGIN || !rowSourceIsAi(row)) return false
  if (rowTemplateIds(row).length) return false
  const m = rowMeta(row)
  const stamped = clean(m.ai_message_body_sha256)
  return Boolean(clean(m.ai_message_id)) && Boolean(stamped) && stamped === sha256Hex(rowBody(row))
}

/** Full verification of the record against the row about to be sent. */
export function verifyAiGeneratedRecordForRow(row = {}, record = null) {
  if (storedMessageOrigin(row) !== AI_ORIGIN) return { ok: false, reason: 'not_ai_generated_origin' }
  if (!rowSourceIsAi(row)) return { ok: false, reason: 'ai_generated_wrong_source' }
  if (carriesAiTemplateMasquerade(row)) return { ok: false, reason: 'ai_template_masquerade_refused' }
  if (rowTemplateIds(row).length) return { ok: false, reason: 'ai_generated_must_not_carry_template_id' }
  if (!record) return { ok: false, reason: 'ai_generated_record_not_found' }
  if (record.message_origin !== AI_ORIGIN) return { ok: false, reason: 'ai_generated_record_wrong_origin' }
  const recordHash = sha256Hex(String(record.message_body ?? ''))
  if (clean(record.body_sha256) !== recordHash) return { ok: false, reason: 'ai_generated_record_corrupt' }
  if (sha256Hex(rowBody(row)) !== recordHash) return { ok: false, reason: 'ai_generated_body_mismatch' }
  const m = rowMeta(row)
  if (clean(m.ai_message_body_sha256) && clean(m.ai_message_body_sha256) !== recordHash) return { ok: false, reason: 'ai_generated_body_mismatch' }
  if (clean(m.ai_message_id) && record.id && clean(m.ai_message_id) !== clean(record.id)) return { ok: false, reason: 'ai_generated_record_id_mismatch' }
  if (!clean(row.queue_key) || clean(record.queue_key) !== clean(row.queue_key)) return { ok: false, reason: 'ai_generated_record_reused' }
  const inbound = clean(row.inbound_message_id) || clean(m.inbound_message_event_id)
  if (!inbound || clean(record.inbound_message_id) !== inbound) return { ok: false, reason: 'ai_generated_record_not_bound_to_inbound' }
  if (clean(record.thread_ref) !== sealedThreadRef(row.thread_key)) return { ok: false, reason: 'ai_generated_record_wrong_thread' }
  if (record.recipient_ref && clean(record.recipient_ref) !== sealedRef('ph', row.to_phone_number)) return { ok: false, reason: 'ai_generated_record_wrong_recipient' }
  if (lower(record.validation?.status) !== 'validated') return { ok: false, reason: 'ai_generated_record_not_validated' }
  if (!['policy_authorized', 'operator_approved'].includes(record.approval_state)) return { ok: false, reason: 'ai_generated_record_not_authorized' }
  return { ok: true, reason: 'ai_generated_message' }
}

/** Build the immutable record (the executor inserts it BEFORE the queue row). */
export function buildAiGeneratedMessage({
  body, inboundMessageId, queueKey, threadKey, propertyId = null, contactId = null, recipientPhone, senderPhone = null,
  decisionId, jobId = null, model, playbookVersion, promptVersion, contextVersion, validation, ledgerSnapshot,
  policy, authorizationScope, approvalState = 'policy_authorized', generatedAt, costUsd = 0, inputTokens = null, outputTokens = null, auditRefs = {},
}) {
  const text = String(body ?? '')
  return {
    message_origin: AI_ORIGIN,
    queue_key: clean(queueKey),
    idempotency_key: `inbound_reply:${clean(inboundMessageId)}`,
    inbound_message_id: clean(inboundMessageId),
    thread_ref: sealedThreadRef(threadKey),
    property_ref: sealedRef('pr', propertyId),
    contact_ref: sealedRef('ct', contactId),
    recipient_ref: sealedRef('ph', recipientPhone),
    sender_ref: sealedRef('ph', senderPhone),
    message_body: text,
    body_sha256: sha256Hex(text),
    decision_id: clean(decisionId),
    job_id: clean(jobId) || null,
    decision_outcome: 'AI_GENERATED_REPLY',
    model: clean(model),
    playbook_version: clean(playbookVersion),
    prompt_version: clean(promptVersion),
    context_version: clean(contextVersion),
    validation: { status: validation?.status || null, validators: validation?.validators || [], reasons: (validation?.reasons || []).slice(0, 20) },
    ledger_snapshot_hash: sha256Hex(canonicalJson(ledgerSnapshot ?? null)),
    authorization_scope: { ...authorizationScope, policy_hash: sha256Hex(canonicalJson(policy ?? null)) },
    approval_state: approvalState,
    generated_at: generatedAt,
    cost_usd: Math.max(0, Math.round((Number(costUsd) || 0) * 1e6) / 1e6),
    input_tokens: inputTokens ?? null,
    output_tokens: outputTokens ?? null,
    audit_refs: auditRefs,
    record_version: AI_GENERATED_MESSAGE_VERSION,
  }
}

/** Read the record for a queue row (read-only). */
export async function lookupAiGeneratedMessageByQueueKey(supabase, queueKey) {
  const key = clean(queueKey)
  if (!key) return { found: false, read_failed: false, record: null }
  if (!supabase?.from) return { found: false, read_failed: true, record: null }
  try {
    const r = await supabase.from(AI_GENERATED_MESSAGES_TABLE).select(AI_GENERATED_MESSAGE_COLUMNS).eq('queue_key', key).limit(1)
    if (r?.error) return { found: false, read_failed: true, record: null }
    const record = Array.isArray(r?.data) ? r.data[0] || null : r?.data || null
    return { found: Boolean(record), read_failed: false, record }
  } catch {
    return { found: false, read_failed: true, record: null }
  }
}

/** Append-only insert (the table refuses UPDATE / DELETE / TRUNCATE). */
export async function insertAiGeneratedMessage(supabase, record) {
  if (!supabase?.from) return { ok: false, reason: 'no_client' }
  const { data, error } = await supabase.from(AI_GENERATED_MESSAGES_TABLE).insert(record).select('id,queue_key').maybeSingle()
  if (error) return { ok: false, reason: error.code === '23505' ? 'ai_generated_record_exists' : 'ai_generated_record_insert_failed' }
  return { ok: true, id: data?.id || null, queue_key: data?.queue_key || record.queue_key }
}

/** Append one lifecycle event (queued / provider result / delivery state / cancelled / held). */
export async function recordAiGeneratedMessageEvent(supabase, { aiMessageId, eventType, queueRowId = null, providerResult = null, deliveryState = null, detail = {} }) {
  if (!AI_MESSAGE_EVENT_TYPES.includes(eventType)) return { ok: false, reason: 'unknown_event_type' }
  if (!supabase?.from || !clean(aiMessageId)) return { ok: false, reason: 'no_client_or_id' }
  const { error } = await supabase.from(AI_GENERATED_MESSAGE_EVENTS_TABLE).insert({ ai_message_id: aiMessageId, event_type: eventType, queue_row_id: queueRowId, provider_result: providerResult, delivery_state: deliveryState, detail })
  return error ? { ok: false, reason: 'event_insert_failed' } : { ok: true }
}

/**
 * rc-8.5.21: the provider outcome of an AI row, appended to its immutable record's lifecycle
 * (provider_accepted / provider_failed). Never throws, never blocks the send path; a non-AI row
 * (no metadata.ai_message_id) is a no-op.
 */
export async function recordAiRowProviderOutcome(supabase, row = {}, { eventType, providerResult = null, detail = {} } = {}) {
  try {
    const m = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const aiMessageId = clean(m.ai_message_id)
    if (!aiMessageId || clean(row?.message_origin || m.message_origin) !== AI_ORIGIN) return { ok: false, reason: 'not_an_ai_row' }
    const pr = providerResult && typeof providerResult === 'object'
      ? { ok: providerResult.ok !== false, provider_message_id: clean(providerResult.provider_message_id || providerResult.sid || providerResult.message_id) || null, status: clean(providerResult.status || providerResult.error_status) || null }
      : null
    return await recordAiGeneratedMessageEvent(supabase, { aiMessageId, eventType, queueRowId: row?.id || null, providerResult: pr, detail })
  } catch {
    return { ok: false, reason: 'event_record_threw' }
  }
}
