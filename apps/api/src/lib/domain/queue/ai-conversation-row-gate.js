// QUEUE-RUNNER GATE for AI conversation rows (8.5.16, R3) — runs ONLY for rows whose
// source is 'ai_conversation'; every other row is untouched (applies:false, no reads).
//
//   kill switch system_control[ai_conversation_send_enabled] not exactly 'true'
//       → CANCEL the row (safe: nothing was sent; reason ai_conversation_send_disabled)
//   rc-8.5.21: THE shared send-time eligibility function (reply-timing.js#evaluateRowReplyTiming):
//       in session (the owner rule 2026-10-10, the same evaluateInSessionReply the runner uses
//       for template replies) or 08–21 in EVERY recipient zone stamped on the row at enqueue
//       (metadata.recipient_zones; else resolved from the row's phone + property). Not lawful
//       → DEFER (release). The scheduler, R3 and this gate cannot disagree.
//   the immutable ai_generated_messages record missing / not bound / body hash mismatch
//       → CANCEL; record unreadable → DEFER
//   a MATERIALLY new inbound on the thread since generation → CANCEL (stale); unreadable → DEFER
//   AI send policy no longer authorises it (disabled, scope or category revoked) → CANCEL
//   otherwise → proceed to every existing guard (send-time contact guard, template
//       authority, cadence, duplicate, sender routing …), unchanged.
//
// cancelPendingAiConversationRows() is the sweep the operator (or a cron) can run when
// the switch is turned off: every not-yet-sent ai_conversation row → cancelled.
import { evaluateRowReplyTiming, resolveRecipientZones } from '@/lib/domain/queue/reply-timing.js'
import { AI_CONVERSATION_SOURCE, AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, isOwnerHandledThread, normalizeSendPolicy, parseKillSwitch, threadInPolicyScope } from '@/lib/domain/conversation-ai/send-policy.js'
import { verifyAiGeneratedRecordForRow } from '@/lib/domain/messages/ai-generated-message.js'
import { isAiGeneratedOrigin } from '@/lib/domain/messages/message-origin.js'
import { isStopRequest } from '@/lib/domain/conversation-ai/stop-request.js'
import { checkAutomationHoldPort } from '@/lib/domain/holds-port/automation-hold-port.js'

export const AI_ROW_GATE_VERSION = 'conv-ai.row-gate.v2'
export const AI_ROW_DISABLED_REASON = 'ai_conversation_send_disabled'
// every not-yet-sent state an AI row can sit in (incl. the existing guards' holds)
export const AI_ROW_PENDING_STATUSES = Object.freeze(['queued', 'scheduled', 'pending', 'approval', 'held', 'paused_operator_review', 'paused_invalid_queue_row', 'paused_name_missing'])

const clean = (v) => String(v ?? '').trim()

export function isAiConversationRow(row = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return isAiGeneratedOrigin(row) || clean(row?.source).toLowerCase() === AI_CONVERSATION_SOURCE || clean(meta.source).toLowerCase() === AI_CONVERSATION_SOURCE
}

// A pure acknowledgement ("ok", "thanks", an emoji) does not change what the reply should
// say; anything else (an answer, a question, a correction, a STOP) is MATERIAL and makes a
// queued AI reply stale.
const ACK_ONLY_RE = /^\s*(?:ok(?:ay)?|k|kk|thanks?|thank\s+you|thx|ty|got\s+it|cool|sounds\s+good|great|np|no\s+problem)?\s*[.!]*\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]\s*)*$/iu
export function isMaterialInbound(text) {
  const t = String(text ?? '')
  if (isStopRequest(t)) return true
  return !ACK_ONLY_RE.test(t)
}

/** Default reader: inbounds on the row's thread received after the inbound the row answers. */
export async function loadNewerInboundsForRow(supabase, row = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const since = clean(meta.inbound_received_at)
  if (!supabase?.from || !clean(row.thread_key) || !since) return { read_failed: true, rows: [] }
  const r = await supabase.from('message_events').select('id,message_body,created_at').eq('thread_key', row.thread_key).eq('direction', 'inbound').gt('created_at', since).order('created_at', { ascending: true }).limit(20)
  if (r?.error) return { read_failed: true, rows: [] }
  return { read_failed: false, rows: r?.data || [] }
}

/**
 * @param {object} row send_queue row
 * @param {{ readSwitch: (key: string) => Promise<string|null>, now?: string, propertyGeography?: object|null }} deps
 * @returns {Promise<{ applies: boolean, action?: 'proceed'|'cancel'|'defer', reason?: string }>}
 */
export async function evaluateAiConversationRowGate(row = {}, { readSwitch, loadRecord = null, loadNewerInbounds = null, now = new Date().toISOString(), propertyGeography = null, windowMinutes = undefined, automationHoldChecker = null } = {}) {
  if (!isAiConversationRow(row)) return { applies: false }
  let raw = null
  try { raw = typeof readSwitch === 'function' ? await readSwitch(AI_SEND_KILL_SWITCH_KEY) : null } catch { raw = null }
  if (!parseKillSwitch(raw)) return { applies: true, action: 'cancel', reason: AI_ROW_DISABLED_REASON }
  if (isOwnerHandledThread({ thread_key: row.thread_key })) return { applies: true, action: 'cancel', reason: 'ai_conversation_owner_handled_thread' }
  // the ONE automation-hold registry: held (or unanswerable) ⇒ defer, never send
  const hold = await checkAutomationHoldPort({ threadKey: row.thread_key, propertyId: row.property_id || null, masterOwnerId: row.master_owner_id || null, capability: 'ai_reply_dispatch' }, { checker: automationHoldChecker })
  if (hold.held) return { applies: true, action: 'defer', reason: `ai_conversation_automation_hold:${hold.hold_type}` }
  // the body must equal its IMMUTABLE ai_generated_messages record (owner 2026-10-15)
  let lookup = null
  try { lookup = typeof loadRecord === 'function' ? await loadRecord(row.queue_key) : null } catch { lookup = null }
  if (!lookup || lookup.read_failed) return { applies: true, action: 'defer', reason: 'ai_generated_record_unreadable' }
  const record = verifyAiGeneratedRecordForRow(row, lookup.record)
  if (!record.ok) return { applies: true, action: 'cancel', reason: record.reason }
  // …and the AI send policy must STILL authorise it (enabled, thread in scope, category on)
  let policyRaw = null
  try { policyRaw = await readSwitch(AI_SEND_POLICY_KEY) } catch { policyRaw = null }
  const policy = normalizeSendPolicy(policyRaw)
  if (!policy.enabled) return { applies: true, action: 'cancel', reason: 'ai_policy_disabled_at_send' }
  if (!threadInPolicyScope(policy, { thread_key: row.thread_key })) return { applies: true, action: 'cancel', reason: 'ai_policy_scope_revoked_at_send' }
  const category = lookup.record?.authorization_scope?.category
  if (!category || !(policy.categories || []).includes(category)) return { applies: true, action: 'cancel', reason: 'ai_policy_category_revoked_at_send' }
  // latest-inbound revalidation: a materially new inbound since generation makes the reply stale
  let newer = null
  try { newer = typeof loadNewerInbounds === 'function' ? await loadNewerInbounds(row) : null } catch { newer = null }
  if (!newer || newer.read_failed) return { applies: true, action: 'defer', reason: 'ai_latest_inbound_unreadable' }
  if ((newer.rows || []).some((m) => isMaterialInbound(m.message_body))) return { applies: true, action: 'cancel', reason: 'ai_reply_stale_new_inbound' }
  const fallback = resolveRecipientZones({ recipientPhone: row.to_phone_number, propertyGeography: propertyGeography || { state: row.property_address_state || null, zip: row.property_address_zip || null }, storedTimezone: row.timezone || null })
  const timing = evaluateRowReplyTiming(row, { now, windowMinutes, fallbackZones: fallback.zones })
  if (!timing.lawful) return { applies: true, action: 'defer', reason: 'ai_conversation_outside_contact_window', timing }
  return { applies: true, action: 'proceed', reason: 'ai_conversation_gate_open', timing }
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
