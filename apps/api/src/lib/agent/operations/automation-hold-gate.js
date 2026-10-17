// Automation-hold consultation (8.5.21-b, owner P0 2026-10-16).
//
// ONE authority: public.automation_holds + lib/domain/holds/automation-hold.js (rc-8.5.20-holds,
// behavior-equivalent to hotfix/automation-holds), reached through its port interface
//   checkAutomationHold({ threadKey, threadId, propertyId, opportunityId, masterOwnerId, capability })
//     → { held, hold_type, reason, hold_id }
// Every acting path of 8.5.21-b consults it BEFORE acting (recovery research / nurture enqueue,
// valuation refresh, the negotiation composer, the turn-engine research hook). Held items are
// REPORTED ("held: operator review"), never acted on.
//
// rc-8.5.21 integration: this gate is NOT a second mechanism. consultHold delegates to 8.5.21-a's
// hold port (lib/domain/holds-port/automation-hold-port.js), which is bound to the registry's
// checkAutomationHold. An injected checker (composition roots pass checkAutomationHold explicitly;
// tests pass fakes) is used as given; with none, the port's bound registry is used — never "not
// consulted". The integration placeholder that held everything (failClosedHoldCheck) is removed.
// FAIL CLOSED (the port's rules): a throw, a verdict without held:boolean, a missing capability, an
// unmapped capability or an unbound registry is a hold.
import { checkAutomationHoldPort } from '../../domain/holds-port/automation-hold-port.js'

export const HOLD_GATE_VERSION = 'automation-hold-gate.v2'
export const HOLD_CAPABILITIES = Object.freeze({
  recovery_research: 'recovery.research_enqueue',
  recovery_nurture: 'recovery.nurture_intent',
  valuation_refresh: 'valuation.refresh',
  negotiation_compose: 'negotiation.compose',
  research_hook: 'property.research_enqueue',
})

/**
 * @param {Function|null} check  checkAutomationHold (or a test fake); null ⇒ the port's bound registry
 * @param {{ threadKey?, threadId?, propertyId?, opportunityId?, masterOwnerId?, capability: string }} args
 * @returns {Promise<{ held: boolean, hold_type: string|null, reason: string|null, hold_id: string|null, consulted: true }>}
 */
export async function consultHold(check, args = {}) {
  const r = await checkAutomationHoldPort(args, { checker: typeof check === 'function' ? check : null })
  return { held: r.held, hold_type: r.hold_type ?? null, reason: r.reason ?? null, hold_id: r.hold_id ?? null, consulted: true }
}

/** Report label for a held item (supervisor / brief / work items): "held: <type>". */
export const heldLabel = (h) => `held: ${String(h?.hold_type || 'unknown').replace(/_/g, ' ')}`
