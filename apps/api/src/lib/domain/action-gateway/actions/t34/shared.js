// Shared guards for the T3 / T4 family (docs/ACTION-MCP.md §8). Every fact is re-read here; a read that fails is a
// refusal (fail closed), never "clear". Nothing here writes: the database domain writes do (handoff / envelope).
import { checkAutomationHold } from '../../../holds/automation-hold.js'
import { isStopRequest } from '../../../conversation-ai/stop-request.js'
import { parseKillSwitch, normalizeSendPolicy, threadInPolicyScope, AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY } from '../../../conversation-ai/send-policy.js'
import { encodePropertyRef } from '../../../../agent/missions/mission-codec.js'
import { gwErr } from '../../errors.js'

export const NEGOTIATION_SEND_KEY = 'negotiation_send_enabled'
export const EMERGENCY_STOP_KEY = 'queue_emergency_stop_at'
export const PROPERTY_ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$' }

const STOP_OFF = new Set(['', '0', 'false', 'off', 'none', 'null', 'cleared', 'clear'])
export const emergencyStopActive = (v) => !STOP_OFF.has(String(v ?? '').trim().toLowerCase())
export const pref = (id) => encodePropertyRef(String(id))

export async function mustThread(reads, id) {
  const t = await reads.thread(id)
  if (!t?.thread_key) throw gwErr('not_found', 'THREAD_NOT_FOUND', 'no inbox thread with this id')
  return t
}
export async function mustProperty(reads, id) {
  const p = await reads.property(id)
  if (!p) throw gwErr('not_found', 'PROPERTY_NOT_FOUND', 'no property with this id')
  return p
}
export const threadResource = (t, extra = {}) => ({ type: 'thread', id: t.id, refs: { thread_key: t.thread_key, thread_id: t.id, property_id: t.property_id || null, market: t.market || null, ...extra } })

/** THE hold authority, each capability the action exercises; any hold (or an unreadable registry) refuses. */
export async function holdDeny(services, scope, capabilities) {
  for (const capability of capabilities) {
    let h
    try { h = await services.holdCheck({ ...scope, capability }) } catch { h = { held: true, fail_closed: true } }
    if (h?.held !== false) return { decision: 'deny', code: h?.fail_closed ? 'AUTOMATION_HOLD_LOOKUP_FAILED' : 'AUTOMATION_HOLD', evidence: { hold: h?.fail_closed ? 'lookup_failed' : 'held', capability, hold_type: h?.hold_type || null } }
  }
  return null
}
export { checkAutomationHold }

/** STOP (any language the classifier knows) / suppression / opt-out on the thread. */
export async function permissionDeny(reads, resource) {
  let perm
  try { perm = await reads.permission({ id: resource.id, thread_key: resource.refs.thread_key }) } catch { return { decision: 'deny', code: 'PERMISSION_STATE_UNREADABLE', evidence: {} } }
  if (perm.blocked) return { decision: 'deny', code: perm.reasons.includes('stop_requested') ? 'STOP_REQUESTED' : 'CONTACT_NOT_PERMITTED', evidence: { reasons: perm.reasons } }
  return null
}
export { isStopRequest }

/** The AI send production activation (kill switch + an enabled send policy, no emergency stop). */
export async function replyActivation(reads) {
  const sw = await reads.switches([AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, EMERGENCY_STOP_KEY])
  if (emergencyStopActive(sw[EMERGENCY_STOP_KEY])) return { available: false, code: 'EMERGENCY_STOP_ACTIVE' }
  if (!parseKillSwitch(sw[AI_SEND_KILL_SWITCH_KEY])) return { available: false, code: 'AI_SEND_KILL_SWITCH_OFF' }
  const policy = normalizeSendPolicy(sw[AI_SEND_POLICY_KEY])
  if (!policy.enabled) return { available: false, code: 'AI_SEND_POLICY_DISABLED' }
  return { available: true, policy }
}
export { threadInPolicyScope }

/** The negotiation send production activation (system_control negotiation_send_enabled, no emergency stop). */
export async function negotiationActivation(reads) {
  const sw = await reads.switches([NEGOTIATION_SEND_KEY, EMERGENCY_STOP_KEY])
  if (emergencyStopActive(sw[EMERGENCY_STOP_KEY])) return { available: false, code: 'EMERGENCY_STOP_ACTIVE' }
  if (String(sw[NEGOTIATION_SEND_KEY] ?? '').trim().toLowerCase() !== 'true') return { available: false, code: 'NEGOTIATION_SEND_OFF' }
  return { available: true }
}

export const iso = (v) => (v ? new Date(v).toISOString() : null)
export const num = (v) => { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
