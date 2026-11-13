// QUEUE-RUNNER GATE for AGENT-INITIATED messages (Action Gateway queue_agent_message, link #32) — runs ONLY for rows
// stamped metadata.agent_message_intent_id (an AI-composed agent message, or its governed-template fallback); every
// other row is untouched (applies:false, no reads).
//
//   the agent-message activation (public.lc_agent_message_activation: BOTH emergency stops — R2
//   agent.runtime_limits.emergency_stop and queue_emergency_stop_at —, the AI-reply certification gate, this action's
//   own switch ai_agent_message_enabled and its policy) not available        → CANCEL (nothing was sent)
//   the activation unreadable                                                 → DEFER (release; fail closed)
//   otherwise → proceed: an AI-composed row has already met the AI row gate (record, policy scope / category, newer
//   inbound, window), and every row meets every existing guard (send-time contact guard, template authority, cadence,
//   duplicate, sender routing, the recipient window), unchanged.
export const AGENT_MESSAGE_ROW_GATE_VERSION = 'agent-message.row-gate.v1'
const clean = (v) => String(v ?? '').trim()

export function isAgentMessageRow(row = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return Boolean(clean(meta.agent_message_intent_id))
}

/** Default reader: the database's ONE activation verdict (service_role). */
export async function readAgentMessageActivation(supabase) {
  if (!supabase?.rpc) return { read_failed: true }
  const r = await supabase.rpc('lc_agent_message_activation', {})
  if (r?.error || !r?.data) return { read_failed: true }
  return r.data
}

/**
 * @param {object} row send_queue row
 * @param {{ readActivation: () => Promise<{available?: boolean, code?: string, read_failed?: boolean}> }} deps
 * @returns {Promise<{ applies: boolean, action?: 'proceed'|'cancel'|'defer', reason?: string }>}
 */
export async function evaluateAgentMessageRowGate(row = {}, { readActivation } = {}) {
  if (!isAgentMessageRow(row)) return { applies: false }
  let a = null
  try { a = typeof readActivation === 'function' ? await readActivation() : null } catch { a = null }
  if (!a || a.read_failed) return { applies: true, action: 'defer', reason: 'agent_message_activation_unreadable' }
  if (a.available !== true) return { applies: true, action: 'cancel', reason: `agent_message_unavailable_at_send:${clean(a.code).toLowerCase() || 'off'}` }
  return { applies: true, action: 'proceed', reason: 'agent_message_gate_open' }
}

export function agentMessageRowCancelPayload(row = {}, { now = new Date().toISOString(), reason } = {}) {
  return {
    queue_status: 'cancelled', paused_reason: reason, is_locked: false, locked_at: null, lock_token: null, updated_at: now,
    metadata: { ...(row?.metadata || {}), skip_reason: reason, final_queue_status: 'cancelled', cancelled_by: 'agent_message_row_gate', finalized_at: now },
  }
}
