// Automation-hold consultation — PACKAGE A (hotfix/research-runtime) version.
//
// rc-8.5.21 binds this gate to the hold registry of hotfix/automation-holds
// (public.automation_holds + lib/domain/holds/automation-hold.js) through the hold port. Package A
// deploys on production 6ecbae6b, which has NEITHER the registry NOR the port, and must not wait for
// them. Package A's acting paths are research-only (property.research enqueues and the valuation dry
// run): nothing here contacts a seller, queues a message or writes a stage, offer or disposition.
//
// The Package A authority is therefore the owner's FIXED exclusion list
// (missions/research-exclusions.js: the static permanent exclusion of automation-hold-core — Maxwell —
// plus Hartford, CLOSED LOST by owner decision 2026-10-19). An injected checker (tests, or a later
// composition root bound to the registry) is used as given and FAILS CLOSED: a throw or a verdict
// without held:boolean is a hold. The interface is the rc-8.5.21 one, so the rc-8.5.21 merge replaces
// this file without touching any caller.
import { researchExclusionFor } from '../missions/research-exclusions.js'

export const HOLD_GATE_VERSION = 'automation-hold-gate.package-a.v1'
export const HOLD_CAPABILITIES = Object.freeze({
  recovery_research: 'recovery.research_enqueue',
  recovery_nurture: 'recovery.nurture_intent',
  valuation_refresh: 'valuation.refresh',
  negotiation_compose: 'negotiation.compose',
  research_hook: 'property.research_enqueue',
})

const held = (hold_type, reason, hold_id = null) => ({ held: true, hold_type, reason, hold_id, consulted: true })

/**
 * @param {Function|null} check  an injected checkAutomationHold (or a test fake); null ⇒ the Package A exclusion list
 * @param {{ threadKey?, threadId?, propertyId?, opportunityId?, masterOwnerId?, capability: string }} args
 * @returns {Promise<{ held: boolean, hold_type: string|null, reason: string|null, hold_id: string|null, consulted: true }>}
 */
export async function consultHold(check, args = {}) {
  if (!args?.capability) return held('lookup_error', 'automation_hold_capability_required')
  const ex = researchExclusionFor({ thread_id: args.threadId, thread_key: args.threadKey, property_id: args.propertyId, opportunity_id: args.opportunityId })
  if (ex) return held(ex.hold_type, ex.reason, ex.key)
  if (typeof check !== 'function') return { held: false, hold_type: null, reason: null, hold_id: null, consulted: true }
  try {
    const r = await check({ threadKey: args.threadKey ?? null, threadId: args.threadId ?? null, propertyId: args.propertyId ?? null, opportunityId: args.opportunityId ?? null, masterOwnerId: args.masterOwnerId ?? null, capability: args.capability })
    if (!r || typeof r.held !== 'boolean') return held('lookup_error', 'automation_hold_result_invalid')
    return r.held ? held(r.hold_type || 'hold', r.reason || 'automation_hold', r.hold_id || null) : { held: false, hold_type: null, reason: null, hold_id: null, consulted: true }
  } catch {
    return held('lookup_error', 'automation_hold_lookup_failed')
  }
}

/** Report label for a held item (supervisor / brief / work items): "held: <type>". */
export const heldLabel = (h) => `held: ${String(h?.hold_type || 'unknown').replace(/_/g, ' ')}`
