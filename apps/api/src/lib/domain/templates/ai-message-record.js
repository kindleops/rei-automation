// IMMUTABLE PER-MESSAGE AI TEMPLATE RECORDS (8.5.16; owner decision 2026-10-15).
//
// "Preserve the existing sms_templates invariant. Support adaptive AI-written messages
// using an immutable per-message template record, with provenance, policy authorization,
// validation, and canonical send-queue execution."
//
// Every validated AI draft becomes ONE row in public.ai_message_templates (PROPOSED
// migration 20261015120000): sms_templates-compatible columns (template_id, use_case,
// language, template_body, is_active, metadata), append-only (UPDATE / DELETE / TRUNCATE
// refused by trigger), one per inbound and per queue key, never active, and kept in a
// SEPARATE table so template selection (which reads sms_templates only) can never pick it.
//
// The send_queue row carries template_id = selected_template_id = the record's
// 'ai-msg:' id. The narrow acceptance rule (template authority, pre-claim loader,
// queue-runner gate) is:
//   ONLY an 'ai-msg:' id, ONLY on a source='ai_conversation' row, ONLY when
//   sha256(row body) === record.body_sha256 === sha256(record body), and the record is
//   bound to this row (inbound id, queue key, sealed thread ref).
// Any other source carrying an 'ai-msg:' id is refused; an ai_conversation row carrying
// anything else is refused.
import crypto from 'node:crypto'

export const AI_MESSAGE_RECORD_VERSION = 'ai-message-record.v1'
export const AI_MESSAGE_TABLE = 'ai_message_templates'
export const AI_MESSAGE_TEMPLATE_PREFIX = 'ai-msg:'
export const AI_MESSAGE_KIND = 'ai_message'
export const AI_MESSAGE_SOURCE = 'ai_conversation'
export const AI_MESSAGE_COLUMNS = 'id,template_id,template_kind,use_case,language,template_body,body_sha256,is_active,inbound_message_id,queue_key,thread_ref,model,decision_id,draft_hash,validator_verdict,ledger_snapshot_hash,policy_version,policy_authorization,record_version,created_at'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

/** sha256 hex of the EXACT text (utf-8), no normalisation — the DB CHECK computes the same. */
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** Sealed thread reference: the thread key is never stored on the record. */
export function sealedThreadRef(threadKey) {
  return `tr:${sha256Hex(clean(threadKey))}`
}

/** Canonical JSON (sorted keys) so a hash of an object is stable. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

export function isAiMessageTemplateId(id) {
  return clean(id).startsWith(AI_MESSAGE_TEMPLATE_PREFIX)
}

/** One deterministic id per message (inbound id + body hash). */
export function aiMessageTemplateIdFor({ inboundMessageId, bodySha256 }) {
  return `${AI_MESSAGE_TEMPLATE_PREFIX}${sha256Hex(`${clean(inboundMessageId)}:${clean(bodySha256)}`).slice(0, 32)}`
}

function rowMeta(row) {
  return row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
}
export function rowSourceIsAi(row = {}) {
  return lower(row?.source) === AI_MESSAGE_SOURCE || lower(rowMeta(row).source) === AI_MESSAGE_SOURCE
}
export function rowTemplateId(row = {}) {
  const m = rowMeta(row)
  return clean(row?.selected_template_id) || clean(row?.template_id) || clean(m.selected_template_id) || null
}
export function rowBody(row = {}) {
  return String(row?.message_body ?? row?.message_text ?? '')
}

/**
 * Static (no I/O) part of the narrow rule — what the synchronous pre-claim loader and
 * the runner's name guard can check: an AI row, an 'ai-msg:' id, and the row body hash
 * equal to the hash stamped at enqueue. The DB record itself is verified by the
 * queue-runner gate and by template authority.
 */
export function isVerifiedAiMessageRow(row = {}) {
  if (!rowSourceIsAi(row)) return false
  const id = rowTemplateId(row)
  if (!isAiMessageTemplateId(id)) return false
  const stamped = clean(rowMeta(row).ai_message_body_sha256)
  return Boolean(stamped) && stamped === sha256Hex(rowBody(row))
}

/**
 * Full check of a record against the row about to be sent.
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyAiMessageRecordForRow(row = {}, record = null) {
  if (!rowSourceIsAi(row)) return { ok: false, reason: 'ai_message_record_wrong_source' }
  const id = rowTemplateId(row)
  if (!isAiMessageTemplateId(id)) return { ok: false, reason: 'ai_row_requires_ai_message_record' }
  if (!record) return { ok: false, reason: 'ai_message_record_not_found' }
  if (clean(record.template_id) !== id) return { ok: false, reason: 'ai_message_record_id_mismatch' }
  if (record.template_kind !== AI_MESSAGE_KIND) return { ok: false, reason: 'ai_message_record_wrong_kind' }
  if (record.is_active !== false) return { ok: false, reason: 'ai_message_record_selectable' }
  const recordHash = sha256Hex(String(record.template_body ?? ''))
  if (clean(record.body_sha256) !== recordHash) return { ok: false, reason: 'ai_message_record_corrupt' }
  if (sha256Hex(rowBody(row)) !== recordHash) return { ok: false, reason: 'ai_message_body_mismatch' }
  const stamped = clean(rowMeta(row).ai_message_body_sha256)
  if (stamped && stamped !== recordHash) return { ok: false, reason: 'ai_message_body_mismatch' }
  const inbound = clean(row.inbound_message_id) || clean(rowMeta(row).inbound_message_event_id)
  if (!inbound || clean(record.inbound_message_id) !== inbound) return { ok: false, reason: 'ai_message_record_not_bound_to_inbound' }
  if (!clean(row.queue_key) || clean(record.queue_key) !== clean(row.queue_key)) return { ok: false, reason: 'ai_message_record_reused' }
  if (clean(record.thread_ref) !== sealedThreadRef(row.thread_key)) return { ok: false, reason: 'ai_message_record_wrong_thread' }
  if (lower(record.validator_verdict?.status) !== 'validated_draft') return { ok: false, reason: 'ai_message_record_not_validated' }
  return { ok: true, reason: 'ai_message_record' }
}

/**
 * Build the immutable record (the executor inserts it BEFORE the queue row).
 */
export function buildAiMessageRecord({
  body, inboundMessageId, queueKey, threadKey, useCase, model = null, decisionId, validator, ledgerSnapshot,
  policy, policyAuthorization, language = 'English', executorVersion = null,
}) {
  const text = String(body ?? '')
  const bodySha = sha256Hex(text)
  return {
    template_id: aiMessageTemplateIdFor({ inboundMessageId, bodySha256: bodySha }),
    template_kind: AI_MESSAGE_KIND,
    use_case: clean(useCase),
    language,
    template_body: text,
    body_sha256: bodySha,
    is_active: false,
    inbound_message_id: clean(inboundMessageId),
    queue_key: clean(queueKey),
    thread_ref: sealedThreadRef(threadKey),
    model: clean(model) || null,
    decision_id: clean(decisionId),
    draft_hash: bodySha,
    validator_verdict: { status: validator?.status || null, version: validator?.version || null, reasons: (validator?.reasons || []).slice(0, 20) },
    ledger_snapshot_hash: sha256Hex(canonicalJson(ledgerSnapshot ?? null)),
    policy_version: clean(policy?.policy_version),
    policy_authorization: { ...policyAuthorization, policy_hash: sha256Hex(canonicalJson(policy ?? null)) },
    record_version: AI_MESSAGE_RECORD_VERSION,
    metadata: { executor_version: executorVersion },
  }
}

/** Read one record (read-only). */
export async function lookupAiMessageRecord(supabase, templateId) {
  const id = clean(templateId)
  if (!isAiMessageTemplateId(id)) return { found: false, read_failed: false, record: null }
  if (!supabase?.from) return { found: false, read_failed: true, record: null }
  try {
    const r = await supabase.from(AI_MESSAGE_TABLE).select(AI_MESSAGE_COLUMNS).eq('template_id', id).limit(1)
    if (r?.error) return { found: false, read_failed: true, record: null }
    const record = Array.isArray(r?.data) ? r.data[0] || null : r?.data || null
    return { found: Boolean(record), read_failed: false, record }
  } catch {
    return { found: false, read_failed: true, record: null }
  }
}

/** Append-only insert (the table refuses UPDATE / DELETE). */
export async function insertAiMessageRecord(supabase, record) {
  if (!supabase?.from) return { ok: false, reason: 'no_client' }
  const { data, error } = await supabase.from(AI_MESSAGE_TABLE).insert(record).select('id,template_id').maybeSingle()
  if (error) return { ok: false, reason: error.code === '23505' ? 'ai_message_record_exists' : 'ai_message_record_insert_failed' }
  return { ok: true, id: data?.id || null, template_id: data?.template_id || record.template_id }
}
