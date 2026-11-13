// OWNERSHIP ATTRIBUTION THREAD HOLD (rc-8.5.21, blind-eval v2 MUL-01; owner rule 2026-10-17).
//
// One bare answer ("No", "No thanks", "Not interested") to ownership questions about SEVERAL
// properties says nothing about which one. It is a THREAD HOLD for a person — never a denial of the
// latest property, never a nurture, never a close. The hold is RECORDED in the ONE hold authority
// (public.automation_holds), so every automated path that consults it (inbound auto-reply, the AI
// turn / R3, the follow-up lifecycle, campaigns, workflows) and the send_queue BEFORE-insert trigger
// refuse automation on the thread until an operator releases it. Manual sends stay allowed so the
// operator can resolve the ambiguity. Idempotent per thread (one active hold key).
import { bareNoAnswer } from '@/lib/domain/conversation-ai/answers.js'
import { isBareNotInterested } from '@/lib/domain/classification/ownership-answer-forms.js'

export const OWNERSHIP_UNRESOLVED_HOLD_REASON = 'ownership_denial_property_unresolved'
const BLOCKED = ['offer_acceptance', 'offer_write', 'closing_case_create', 'stage_advance', 'auto_reply', 'ai_action', 'follow_up', 'campaign', 'workflow', 'outbound_send', 'recovery']
const clean = (v) => String(v ?? '').trim()

/** Is this reply a BARE answer (no property named, no substance) that could only answer the open question? */
export function isBareOwnershipAnswer(text) {
  const b = bareNoAnswer(text)
  return Boolean(b?.matched) || isBareNotInterested(text)
}

export const ownershipHoldKey = (thread_key) => `ownership_unresolved:${clean(thread_key)}`

/**
 * @param {{ supabase: object, thread_key: string, property_ids?: string[], source_message_id?: string|null, basis?: string|null, now?: string }} a
 * @returns {Promise<{ ok: boolean, recorded: boolean, existing?: boolean, hold_key: string, reason?: string }>}
 */
export async function recordOwnershipAttributionHold({ supabase, thread_key, property_ids = [], source_message_id = null, basis = null, now = new Date().toISOString() } = {}) {
  const hold_key = ownershipHoldKey(thread_key)
  if (!clean(thread_key) || !supabase?.from) return { ok: false, recorded: false, hold_key, reason: 'missing_thread_or_client' }
  const row = {
    hold_key,
    hold_type: 'operator_hold',
    thread_key: clean(thread_key),
    blocked_capabilities: BLOCKED,
    reason: OWNERSHIP_UNRESOLVED_HOLD_REASON,
    set_by: 'system:ownership_attribution',
    set_at: now,
    approval_ref: 'owner_rule_2026-10-17:ambiguous_property_thread_hold',
    metadata: { property_ids: [...new Set(property_ids.map(clean).filter(Boolean))].slice(0, 10), source_message_id: clean(source_message_id) || null, basis: clean(basis) || null, release: 'an operator resolves which property the answer was about' },
  }
  const { error } = await supabase.from('automation_holds').insert(row)
  if (!error) return { ok: true, recorded: true, hold_key }
  if (error.code === '23505') return { ok: true, recorded: false, existing: true, hold_key }
  return { ok: false, recorded: false, hold_key, reason: clean(error.message) || 'hold_insert_failed' }
}
