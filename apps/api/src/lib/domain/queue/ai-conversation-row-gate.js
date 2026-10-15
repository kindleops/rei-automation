// QUEUE-RUNNER GATE for AI conversation rows (8.5.16, R3) — runs ONLY for rows whose
// source is 'ai_conversation'; every other row is untouched (applies:false, no reads).
//
//   kill switch system_control[ai_conversation_send_enabled] not exactly 'true'
//       → CANCEL the row (safe: nothing was sent; reason ai_conversation_send_disabled)
//   recipient-local window (08–21) closed, or the zone unknown
//       → DEFER (release; AI rows get NO in-session bypass)
//   the immutable record (ai_message_templates) missing / not bound / body hash mismatch
//       → CANCEL; record unreadable → DEFER
//   AI send policy no longer authorises it (disabled, scope or category revoked) → CANCEL
//   otherwise → proceed to every existing guard (send-time contact guard, template
//       authority, cadence, duplicate, sender routing …), unchanged.
//
// cancelPendingAiConversationRows() is the sweep the operator (or a cron) can run when
// the switch is turned off: every not-yet-sent ai_conversation row → cancelled.
import { isOutsideLocalContactWindow } from '@/lib/domain/queue/conversational-reply-window.js'
import { resolveRecipientTimezone } from '@/lib/domain/queue/recipient-timezone.js'
import { AI_CONVERSATION_SOURCE, AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, isOwnerHandledThread, normalizeSendPolicy, parseKillSwitch, threadInPolicyScope } from '@/lib/domain/conversation-ai/send-policy.js'
import { rowTemplateId, verifyAiMessageRecordForRow } from '@/lib/domain/templates/ai-message-record.js'

export const AI_ROW_GATE_VERSION = 'conv-ai.row-gate.v1'
export const AI_ROW_DISABLED_REASON = 'ai_conversation_send_disabled'
// every not-yet-sent state an AI row can sit in (incl. the existing guards' holds)
export const AI_ROW_PENDING_STATUSES = Object.freeze(['queued', 'scheduled', 'pending', 'approval', 'held', 'paused_operator_review', 'paused_invalid_queue_row', 'paused_name_missing'])

const clean = (v) => String(v ?? '').trim()

export function isAiConversationRow(row = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return clean(row?.source).toLowerCase() === AI_CONVERSATION_SOURCE || clean(meta.source).toLowerCase() === AI_CONVERSATION_SOURCE
}

/**
 * @param {object} row send_queue row
 * @param {{ readSwitch: (key: string) => Promise<string|null>, now?: string, propertyGeography?: object|null }} deps
 * @returns {Promise<{ applies: boolean, action?: 'proceed'|'cancel'|'defer', reason?: string }>}
 */
export async function evaluateAiConversationRowGate(row = {}, { readSwitch, loadRecord = null, now = new Date().toISOString(), propertyGeography = null } = {}) {
  if (!isAiConversationRow(row)) return { applies: false }
  let raw = null
  try { raw = typeof readSwitch === 'function' ? await readSwitch(AI_SEND_KILL_SWITCH_KEY) : null } catch { raw = null }
  if (!parseKillSwitch(raw)) return { applies: true, action: 'cancel', reason: AI_ROW_DISABLED_REASON }
  if (isOwnerHandledThread({ thread_key: row.thread_key })) return { applies: true, action: 'cancel', reason: 'ai_conversation_owner_handled_thread' }
  // the body must equal its IMMUTABLE per-message record (owner 2026-10-15)
  let lookup = null
  try { lookup = typeof loadRecord === 'function' ? await loadRecord(rowTemplateId(row)) : null } catch { lookup = null }
  if (!lookup || lookup.read_failed) return { applies: true, action: 'defer', reason: 'ai_message_record_unreadable' }
  const record = verifyAiMessageRecordForRow(row, lookup.record)
  if (!record.ok) return { applies: true, action: 'cancel', reason: record.reason }
  // …and the AI send policy must STILL authorise it (enabled, thread in scope, category on)
  let policyRaw = null
  try { policyRaw = await readSwitch(AI_SEND_POLICY_KEY) } catch { policyRaw = null }
  const policy = normalizeSendPolicy(policyRaw)
  if (!policy.enabled) return { applies: true, action: 'cancel', reason: 'ai_policy_disabled_at_send' }
  if (!threadInPolicyScope(policy, { thread_key: row.thread_key })) return { applies: true, action: 'cancel', reason: 'ai_policy_scope_revoked_at_send' }
  const category = lookup.record?.policy_authorization?.category
  if (!category || !(policy.categories || []).includes(category)) return { applies: true, action: 'cancel', reason: 'ai_policy_category_revoked_at_send' }
  const tz = resolveRecipientTimezone(row, { propertyGeography })
  const outside = tz?.ok ? isOutsideLocalContactWindow(now, tz.iana) : null
  if (outside === null) return { applies: true, action: 'defer', reason: 'ai_conversation_timezone_unknown' }
  if (outside) return { applies: true, action: 'defer', reason: 'ai_conversation_outside_contact_window' }
  return { applies: true, action: 'proceed', reason: 'ai_conversation_gate_open' }
}

/** Payload that cancels one AI row (used by the runner and the sweep). */
export function aiRowCancelPayload(row = {}, { now = new Date().toISOString(), reason = AI_ROW_DISABLED_REASON } = {}) {
  return {
    queue_status: 'cancelled',
    paused_reason: reason,
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: { ...(row?.metadata || {}), skip_reason: reason, final_queue_status: 'cancelled', cancelled_by: 'ai_conversation_row_gate', finalized_at: now },
  }
}

/** Sweep: cancel every not-yet-sent AI row (bounded). Only ever narrows what can send. */
export async function cancelPendingAiConversationRows({ supabase, now = new Date().toISOString(), limit = 500 } = {}) {
  if (!supabase?.from) return { ok: false, reason: 'no_client', cancelled: 0 }
  const { data, error } = await supabase.from('send_queue').select('id,metadata,queue_status').eq('source', AI_CONVERSATION_SOURCE).in('queue_status', AI_ROW_PENDING_STATUSES).limit(limit)
  if (error) return { ok: false, reason: 'read_failed', cancelled: 0 }
  let cancelled = 0
  for (const row of data || []) {
    const { error: e } = await supabase.from('send_queue').update(aiRowCancelPayload(row, { now })).eq('id', row.id).in('queue_status', AI_ROW_PENDING_STATUSES)
    if (!e) cancelled += 1
  }
  return { ok: true, cancelled, scanned: (data || []).length }
}
