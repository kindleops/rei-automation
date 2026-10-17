// AUTOMATION-HOLD PORT (rc-8.5.21). The ONE place the 8.5.21 automated paths ask "is this thread /
// property / opportunity under an automation hold?". It is NOT a second hold mechanism: the
// authority is the containment hotfix's registry (public.automation_holds +
// lib/domain/holds/automation-hold.js, branch hotfix/automation-holds). This port only binds to
// it, so every caller below consults exactly that module once integrated:
//
//   send-time contact guard (live dispatch, Send Now, the AI eligibility bridge, R3 fresh state)
//   R3 executor (before any reservation) · the turn decider's send authorisation · the AI row gate
//   the follow-up pipeline (enqueue AND dispatch) · the recontact guard
//
// Interface (the hotfix's): checkAutomationHold({ threadKey, threadId, propertyId, opportunityId,
// masterOwnerId, capability }) → { held: boolean, hold_type, reason, hold_id }.
//
// INTEGRATION (one line): registerAutomationHoldChecker(checkAutomationHold) where the hotfix module
// is imported (or replace DEFAULT_CHECKER below with that import). Until then the port FAILS
// CLOSED: no registered checker = a lookup error = HELD. The owner-handled thread (send-policy
// isOwnerHandledThread, 3746 Baltimore) is folded in here as a hold of type 'owner_handled'.
import { isOwnerHandledThread } from '../conversation-ai/send-policy.js'

export const AUTOMATION_HOLD_PORT_VERSION = 'automation-hold-port.v1'
const KEY = Symbol.for('lc.automation_hold.checker')

/** Bind the authoritative registry (the hotfix's checkAutomationHold). */
export function registerAutomationHoldChecker(fn) {
  if (typeof fn !== 'function') throw new Error('AUTOMATION_HOLD_CHECKER_INVALID')
  globalThis[KEY] = fn
}
export function __resetAutomationHoldChecker() { delete globalThis[KEY] }

const held = (hold_type, reason, hold_id = null) => ({ held: true, hold_type, reason, hold_id, version: AUTOMATION_HOLD_PORT_VERSION })

/**
 * @param {{ threadKey?: string|null, threadId?: string|null, propertyId?: string|null, opportunityId?: string|null, masterOwnerId?: string|null, capability: string, propertyAddress?: string|null }} a
 * @param {{ checker?: Function|null }} [deps] an injected checker (tests / composition roots)
 * @returns {Promise<{ held: boolean, hold_type: string|null, reason: string|null, hold_id: string|null, version: string }>}
 */
export async function checkAutomationHoldPort(a = {}, { checker = null } = {}) {
  if (!a?.capability) return held('lookup_error', 'automation_hold_capability_required')
  if (isOwnerHandledThread({ thread_key: a.threadKey, property_address: a.propertyAddress })) return held('owner_handled', 'owner_handled_thread')
  const fn = checker || globalThis[KEY] || null
  if (typeof fn !== 'function') return held('lookup_error', 'automation_hold_registry_unavailable')
  try {
    const r = await fn({ threadKey: a.threadKey ?? null, threadId: a.threadId ?? null, propertyId: a.propertyId ?? null, opportunityId: a.opportunityId ?? null, masterOwnerId: a.masterOwnerId ?? null, capability: a.capability })
    if (!r || typeof r.held !== 'boolean') return held('lookup_error', 'automation_hold_result_invalid')
    return r.held ? { ...held(r.hold_type || 'hold', r.reason || 'automation_hold', r.hold_id || null) } : { held: false, hold_type: null, reason: null, hold_id: null, version: AUTOMATION_HOLD_PORT_VERSION }
  } catch {
    return held('lookup_error', 'automation_hold_lookup_failed')
  }
}
