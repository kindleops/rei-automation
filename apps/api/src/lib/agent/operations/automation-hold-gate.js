// Automation-hold consultation (8.5.21-b, owner P0 2026-10-16).
//
// The containment hotfix (rc-8.5.20-holds) adds ONE authoritative registry: public.automation_holds +
// lib/domain/holds/automation-hold.js with
//   checkAutomationHold({ threadKey, threadId, propertyId, opportunityId, masterOwnerId, capability })
//     → { held, hold_type, reason, hold_id }
// Every acting path of 8.5.21-b consults it BEFORE acting (recovery research / nurture enqueue,
// valuation refresh, the negotiation composer, the turn-engine research hook). FAIL CLOSED: a lookup that
// throws or answers anything but { held: boolean } is a hold. Held items are REPORTED ("held: operator
// review"), never acted on.
//
// Until the hotfix is integrated the composition roots pass failClosedHoldCheck (everything held). A
// caller that passes no checker at all (pure unit use) gets { consulted: false } and must not be a
// production path.
export const HOLD_GATE_VERSION = 'automation-hold-gate.v1'
export const HOLD_CAPABILITIES = Object.freeze({
  recovery_research: 'recovery.research_enqueue',
  recovery_nurture: 'recovery.nurture_intent',
  valuation_refresh: 'valuation.refresh',
  negotiation_compose: 'negotiation.compose',
  research_hook: 'property.research_enqueue',
})

/** Fail-closed placeholder used by the composition roots until rc-8.5.20-holds is integrated. */
export const failClosedHoldCheck = async () => ({ held: true, hold_type: 'hold_registry_not_integrated', reason: 'automation hold registry not integrated (rc-8.5.20-holds): fail closed', hold_id: null })

/**
 * @param {Function|null} check  checkAutomationHold
 * @param {{ threadKey?, threadId?, propertyId?, opportunityId?, masterOwnerId?, capability: string }} args
 * @returns {Promise<{ held: boolean, hold_type: string|null, reason: string|null, hold_id: string|null, consulted: boolean }>}
 */
export async function consultHold(check, args = {}) {
  if (typeof check !== 'function') return { held: false, hold_type: null, reason: 'hold_registry_not_wired', hold_id: null, consulted: false }
  try {
    const r = await check(args)
    if (!r || typeof r.held !== 'boolean') return { held: true, hold_type: 'hold_lookup_invalid', reason: 'hold lookup returned no verdict: fail closed', hold_id: null, consulted: true }
    return { held: r.held, hold_type: r.hold_type ?? null, reason: r.reason ?? null, hold_id: r.hold_id ?? null, consulted: true }
  } catch (e) {
    return { held: true, hold_type: 'hold_lookup_error', reason: String(e?.code || e?.message || 'lookup_error').slice(0, 80), hold_id: null, consulted: true }
  }
}

/** Report label for a held item (supervisor / brief / work items): "held: <type>". */
export const heldLabel = (h) => `held: ${String(h?.hold_type || 'unknown').replace(/_/g, ' ')}`
