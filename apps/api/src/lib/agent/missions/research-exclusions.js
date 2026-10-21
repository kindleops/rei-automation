// Package A research exclusions — records the research runtime NEVER reads, researches, values or
// raises an operator item for. Pure (no I/O); applied at the SOURCE in lib/ai/research-runtime-wiring.js,
// so an excluded conversation / property never enters any job, and again by the hold gate.
//
//   Maxwell   3746 Baltimore Ave — owner 2026-10-14 "never revisit, message or follow up". Taken from
//             STATIC_PERMANENT_EXCLUSIONS of lib/domain/holds/automation-hold-core.js (byte-identical to
//             hotfix/automation-holds 4c519ab6), so the two lists cannot drift.
//   Hartford  thread 596a9368…, property 225438557, opportunity 9b690ce3… — CLOSED LOST, owner
//             2026-10-19: "never attempt to revive it". Its registry hold (PROPOSED_hartford_hold.sql)
//             belongs to the holds hotfix; Package A does not depend on it.
import { STATIC_PERMANENT_EXCLUSIONS, staticExclusionFor } from '../../domain/holds/automation-hold-core.js'

export const RESEARCH_EXCLUSIONS_VERSION = 'research-exclusions.package-a.v1'

export const HARTFORD_EXCLUSION = Object.freeze({
  key: 'owner_closed_lost_20261019:hartford',
  thread_id: '596a9368-6ef8-40f8-97cb-fcc46e6672d3',
  property_id: '225438557',
  opportunity_id: '9b690ce3-ff88-400b-b56e-69e9bd0055b0',
})

/** Every excluded property id (Maxwell from the hold core + Hartford). */
export const EXCLUDED_PROPERTY_IDS = Object.freeze([...new Set([...STATIC_PERMANENT_EXCLUSIONS.map((x) => String(x.property_id)), HARTFORD_EXCLUSION.property_id])])
export const EXCLUDED_THREAD_IDS = Object.freeze([HARTFORD_EXCLUSION.thread_id])
export const EXCLUDED_OPPORTUNITY_IDS = Object.freeze([HARTFORD_EXCLUSION.opportunity_id])

const s = (v) => (v == null ? '' : String(v).trim())

/**
 * @param {{ thread_id?, thread_key?, property_id?, opportunity_id?, property_address? }} a
 * @returns {{ key: string, hold_type: string, reason: string }|null}
 */
export function researchExclusionFor({ thread_id = null, thread_key = null, property_id = null, opportunity_id = null, property_address = null } = {}) {
  const st = staticExclusionFor({ thread_key, property_id, property_address })
  if (st) return { key: st.key, hold_type: 'permanent_exclusion', reason: 'owner_handled_static_exclusion' }
  if ((s(thread_id) && EXCLUDED_THREAD_IDS.includes(s(thread_id))) || (s(property_id) && EXCLUDED_PROPERTY_IDS.includes(s(property_id))) || (s(opportunity_id) && EXCLUDED_OPPORTUNITY_IDS.includes(s(opportunity_id)))) {
    return { key: HARTFORD_EXCLUSION.key, hold_type: 'owner_closed_lost', reason: 'owner_closed_lost_never_revive' }
  }
  return null
}

/** Row filter for sources (conversation facts, sweep / valuation candidates). */
export function isExcludedRow(r = {}) {
  return Boolean(researchExclusionFor({ thread_id: r.conversation_id ?? r.thread_id ?? null, property_id: r.property_id ?? r.primary_property_id ?? null, opportunity_id: r.opportunity_id ?? null }))
}

export class ResearchExcludedError extends Error {
  constructor() {
    super('PROPERTY_EXCLUDED_BY_OWNER')
    this.code = 'PROPERTY_EXCLUDED_BY_OWNER'
    this.permanent = true // runtime-tick: a permanent failure (no retry)
  }
}
