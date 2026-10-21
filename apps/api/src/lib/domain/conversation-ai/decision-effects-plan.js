// The protective EFFECTS of a canonical decision (rc-8.5.21 v4). PURE: what must be written for a decision
// (lib/ai/conversation-decision-effects.js writes it, from the runtime HANDLERS — the deciding modules reach
// no writer of the compliance tables and no send / queue module).
import { ACTIONS } from './pipeline/outcomes.js'

const clean = (v) => String(v ?? '').trim()
const DENIAL_TO_OUTCOME = Object.freeze({ denied: 'not_owner', not_owner: 'not_owner', property_non_owner: 'not_owner', tenant: 'not_owner', former_owner: 'former_owner' })

/** The protective effects a canonical decision record requires (pure; what applyCanonicalDecisionEffects writes). */
export function decisionEffectsOf(record = {}) {
  const effects = []
  const terminal = record?.terminal || null
  if (terminal?.type === ACTIONS.SUPPRESS) {
    const precautionary = terminal.mode === 'precautionary' || terminal.reason === 'possible_opt_out_unconfirmed'
    // an EXISTING suppression (cancel_pending false, eligibility already blocked) is not re-written
    if (precautionary) effects.push({ kind: 'precautionary_no_contact', evidence: terminal.evidence || null })
    else if (terminal.cancel_pending !== false) effects.push({ kind: 'opt_out', evidence: terminal.evidence || null })
  }
  for (const a of record?.plan?.actions || []) {
    if (a?.type !== ACTIONS.UPDATE_SELLER_FACTS || !a.facts) continue
    const outcome = DENIAL_TO_OUTCOME[clean(a.facts.ownership)]
    if (outcome && a.persist === true && clean(a.target_property)) effects.push({ kind: 'property_denial', property_id: clean(a.target_property), outcome, basis: a.persist_reason || null })
    // a mixed per-property answer: each property's own denial (the confirmed one continues the conversation)
    const byProperty = a.facts.ownership_by_property && typeof a.facts.ownership_by_property === 'object' ? a.facts.ownership_by_property : null
    for (const [pid, v] of Object.entries(byProperty || {})) {
      const o = DENIAL_TO_OUTCOME[clean(v?.ownership)]
      if (o && clean(pid)) effects.push({ kind: 'property_denial', property_id: clean(pid), outcome: o, basis: 'mixed_property_answer' })
    }
  }
  return effects
}

