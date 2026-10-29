// QUEUE-RUNNER GATE for AGENT-COMPOSED TEXTS (Action Gateway queue_agent_text, link #32) — runs ONLY for rows stamped
// metadata.agent_text_intent_id; every other row is untouched (applies:false, no reads). It REPLACES the AI reply row
// gate for these rows (ai-conversation-row-gate.js returns applies:false for them): that gate certifies LeadCommand's
// own writer behind ai_conversation_send_enabled, and LeadCommand wrote nothing here — an agent text depends on its OWN
// switch (ai_agent_text_enabled), never on the reply engine's.
//
//   the agent-text activation (public.lc_agent_text_activation: BOTH emergency stops — R2 agent.runtime_limits and
//   queue_emergency_stop_at — and ai_agent_text_enabled + its policy) not available           → CANCEL (nothing sent)
//   the activation / the record / the holder / the inbounds unreadable                           → DEFER (fail closed)
//   the immutable ai_generated_messages record (kind agent_text) missing, not this intent's, or its body / hash not the
//   row's body (verifyAiGeneratedRecordForRow)                                                     → CANCEL
//   the record's author no longer holds the lead (released / transferred: one holder at a time)   → CANCEL
//   the automation-hold registry holds the thread                                                 → DEFER
//   any seller message since the text was written (an answer: since the inbound it answers)       → CANCEL (stale: the
//                                                                                                    agent re-reads and writes again)
//   the recipient-local window closed (an answer: the in-session rule, else 08:00–21:00)          → CANCEL with the next
//                                                                                                    permitted time (never sent late silently)
//   otherwise → proceed: every existing guard (send-time contact guard, template authority, cadence, duplicate, sender
//   routing, the final sender-continuity check) still runs, unchanged.
import { verifyAiGeneratedRecordForRow, sealedThreadRef } from '@/lib/domain/messages/ai-generated-message.js'
import { evaluateReplyTiming, rowRecipientZones } from '@/lib/domain/queue/reply-timing.js'
import { checkAutomationHoldPort } from '@/lib/domain/holds-port/automation-hold-port.js'

export const AGENT_TEXT_ROW_GATE_VERSION = 'agent-text.row-gate.v1'
const clean = (v) => String(v ?? '').trim()
const meta = (row) => (row?.metadata && typeof row.metadata === 'object' ? row.metadata : {})

export function isAgentTextRow(row = {}) {
  return Boolean(clean(meta(row).agent_text_intent_id))
}

/** Default readers (service_role). */
export async function readAgentTextActivation(supabase) {
  if (!supabase?.rpc) return { read_failed: true }
  const r = await supabase.rpc('lc_agent_text_activation', {})
  if (r?.error || !r?.data) return { read_failed: true }
  return r.data
}
/** The agent holding the lead of a thread key NOW (link #32's lc_agent_lead_holder). Without link #32 nobody holds a lead. */
export async function readLeadHolder(supabase, threadKey, { strict = true } = {}) {
  // strict (the agent-text gate): no client ⇒ unreadable. Not strict (the AI reply gate, which runs with or without
  // link #32): a client with no rpc surface cannot carry the link ⇒ nobody holds the lead.
  if (!supabase?.rpc) return strict ? { read_failed: true } : { read_failed: false, agent_id: null, link_absent: true }
  let r
  try { r = await supabase.rpc('lc_agent_lead_holder', { p_thread_key: threadKey }) } catch { return { read_failed: true } }
  if (r?.error) return /PGRST202|42883|does not exist|Could not find the function/i.test(`${r.error.code || ''} ${r.error.message || ''}`) ? { read_failed: false, agent_id: null, link_absent: true } : { read_failed: true }
  return { read_failed: false, agent_id: typeof r?.data === 'string' && r.data ? r.data : null }
}
export async function loadInboundsSince(supabase, threadKey, since) {
  if (!supabase?.from || !clean(threadKey) || !clean(since)) return { read_failed: true, rows: [] }
  const r = await supabase.from('message_events').select('id,created_at').eq('thread_key', threadKey).eq('direction', 'inbound').gt('created_at', since).order('created_at', { ascending: true }).limit(20)
  if (r?.error) return { read_failed: true, rows: [] }
  return { read_failed: false, rows: r?.data || [] }
}

/**
 * @param {object} row send_queue row
 * @param {{ readActivation: Function, loadRecord: (queueKey) => Promise<{record, read_failed}>, readHolder: (threadKey) => Promise<{agent_id, read_failed}>,
 *           loadInbounds: (threadKey, since) => Promise<{rows, read_failed}>, now?: string, automationHoldChecker?: Function|null }} deps
 * @returns {Promise<{ applies: boolean, action?: 'proceed'|'cancel'|'defer', reason?: string, next_permitted_at?: string|null }>}
 */
export async function evaluateAgentTextRowGate(row = {}, { readActivation, loadRecord, readHolder, loadInbounds, now = new Date().toISOString(), automationHoldChecker = null } = {}) {
  if (!isAgentTextRow(row)) return { applies: false }
  const m = meta(row)
  const call = async (fn, ...a) => { try { return typeof fn === 'function' ? await fn(...a) : null } catch { return null } }
  const a = await call(readActivation)
  if (!a || a.read_failed) return { applies: true, action: 'defer', reason: 'agent_text_activation_unreadable' }
  if (a.available !== true) return { applies: true, action: 'cancel', reason: `agent_text_unavailable_at_send:${clean(a.code).toLowerCase() || 'off'}` }
  // the body must equal its IMMUTABLE ledger record (kind agent_text, bound to this intent)
  const lookup = await call(loadRecord, row.queue_key)
  if (!lookup || lookup.read_failed) return { applies: true, action: 'defer', reason: 'agent_text_record_unreadable' }
  const v = verifyAiGeneratedRecordForRow(row, lookup.record)
  if (!v.ok) return { applies: true, action: 'cancel', reason: v.reason }
  if (clean(lookup.record?.record_kind) !== 'agent_text') return { applies: true, action: 'cancel', reason: 'agent_text_record_wrong_kind' }
  if (clean(lookup.record?.thread_ref) !== sealedThreadRef(row.thread_key)) return { applies: true, action: 'cancel', reason: 'agent_text_record_wrong_thread' }
  // ONE holder: the author must still hold the lead (a release / a transfer stops what it queued)
  const h = await call(readHolder, row.thread_key)
  if (!h || h.read_failed) return { applies: true, action: 'defer', reason: 'agent_text_lead_holder_unreadable' }
  if (!clean(h.agent_id) || clean(h.agent_id) !== clean(m.agent_id)) return { applies: true, action: 'cancel', reason: 'agent_text_author_no_longer_holds_lead' }
  const hold = await checkAutomationHoldPort({ threadKey: row.thread_key, propertyId: row.property_id || null, masterOwnerId: row.master_owner_id || null, capability: 'outbound_send' }, { checker: automationHoldChecker })
  if (hold.held) return { applies: true, action: 'defer', reason: `agent_text_automation_hold:${hold.hold_type}` }
  // anything the seller wrote after the text was written (an answer: after the inbound it answers) makes it stale
  const at = m.agent_text || {}
  const since = clean(at.inbound_received_at) || clean(at.generated_at)
  const newer = await call(loadInbounds, row.thread_key, since)
  if (!newer || newer.read_failed) return { applies: true, action: 'defer', reason: 'agent_text_latest_inbound_unreadable' }
  if ((newer.rows || []).some((x) => clean(x.id) !== clean(at.in_reply_to_message_id))) return { applies: true, action: 'cancel', reason: 'agent_text_stale_new_inbound' }
  // the recipient-local window NOW (the zones stamped at enqueue); closed ⇒ cancelled with the next permitted time
  const answer = Boolean(clean(at.in_reply_to_message_id))
  const timing = evaluateReplyTiming({ purpose: answer ? 'reply' : clean(at.purpose) === 'first_touch' ? 'campaign' : 'followup', at: now, zones: rowRecipientZones(row) || [],
    ...(answer ? { inboundId: clean(at.in_reply_to_message_id), inboundAt: clean(at.inbound_received_at) || null, queuedAt: clean(row.created_at) || now } : {}) })
  if (timing.lawful !== true) return { applies: true, action: 'cancel', reason: 'agent_text_outside_recipient_window_at_send', next_permitted_at: timing.next_permitted_at || null }
  return { applies: true, action: 'proceed', reason: 'agent_text_gate_open', timing }
}

export function agentTextRowCancelPayload(row = {}, { now = new Date().toISOString(), reason, next_permitted_at = null } = {}) {
  return {
    queue_status: 'cancelled', paused_reason: reason, is_locked: false, locked_at: null, lock_token: null, updated_at: now,
    metadata: { ...(row?.metadata || {}), skip_reason: reason, final_queue_status: 'cancelled', cancelled_by: 'agent_text_row_gate', finalized_at: now, ...(next_permitted_at ? { next_permitted_at } : {}) },
  }
}
