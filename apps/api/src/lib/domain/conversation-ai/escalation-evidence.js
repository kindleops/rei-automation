// EVIDENCE-BACKED ESCALATION REASONS (rc-8.5.21, Phase 3D). Pure.
//
// An escalation names WHY a person is needed and carries the evidence that proves it. A reason
// with no evidence is not recorded as that reason (8.5.20 eval #29 / #55 / #101: "multiple
// properties" on single-property threads, from a thread whose events carry two property ids or
// from the model's unverified escalation_reason).
//
//   missing_negotiation_authority   money: an offer request / a counter / a live quote, and the
//                                   negotiation authority did not grant an envelope
//   missing_comps                   the offer step needs valuation evidence that is absent
//   incompatible_term               a deal structure we do not do (financing structures, legal / title)
//   failed_tool                     a tool / model / store call failed
//   insufficient_context            the context does not support a safe next step (incl. a model
//                                   escalation whose claimed reason has no evidence)
//   multiple_properties             seller text names several properties / asks which one, or the
//                                   inbound is attached to a different property than our last text
//   multiple_owners                 seller text says someone else is on title / must agree
//   company_identity_not_configured the seller asked which company and none is configured
//   requested_email_or_card         an e-mail / business card / website request (a person sends it)
//   asked_if_automated              a person answers it truthfully
//   ownership_evidence_conflict     a stored not-owner label vs a stated confirmation
//   language_not_enabled            non-English (or unknown) language
//   price_contradiction             two stated asking prices far apart
export const ESCALATION_EVIDENCE_VERSION = 'conv-ai.escalation-evidence.v1'
export const ESCALATION_REASON_CODES = Object.freeze([
  'missing_negotiation_authority', 'missing_comps', 'incompatible_term', 'failed_tool', 'insufficient_context',
  'multiple_properties', 'multiple_owners', 'company_identity_not_configured', 'requested_email_or_card',
  'asked_if_automated', 'ownership_evidence_conflict', 'language_not_enabled', 'price_contradiction',
])

export const MULTI_PROPERTY_TEXT_RE = /\b(?:(?:both|all|several|multiple|two|three|other)\s+(?:of\s+(?:my|the)\s+)?(?:properties|houses|homes|lots|units|addresses)|i\s+(?:own|have)\s+(?:a\s+few|several|multiple|[0-9]+)\s+(?:properties|houses|homes)|which\s+(?:property|house|one|address)|what\s+(?:property|address|house))\b/i
export const MULTI_OWNER_TEXT_RE = /\b(?:my\s+(?:brother|sister|siblings|wife|husband|partner|ex|mom|mother|dad|father)\s+(?:and\s+i\s+)?(?:own|co-?own|is\s+on\s+the\s+title)|co-?owner|joint(?:ly)?\s+owned|on\s+the\s+(?:title|deed)\s+with|have\s+to\s+(?:ask|talk\s+to|check\s+with)\s+my\s+(?:wife|husband|partner|brother|sister|family))\b/i

/** @returns {{ type: 'ESCALATE_TO_OPERATOR', reason: string, evidence: object }} */
export function escalation(reason, evidence = {}) {
  if (!ESCALATION_REASON_CODES.includes(reason)) throw new Error(`ESCALATION_REASON_UNKNOWN:${reason}`)
  return { type: 'ESCALATE_TO_OPERATOR', reason, evidence: { version: ESCALATION_EVIDENCE_VERSION, ...evidence } }
}

/**
 * Multiple-property evidence, or null. Thread events with different property ids are NOT
 * evidence by themselves (campaign rows and later re-links attach ids to old events).
 * @param {{ inboundText?: string, ledger?: object, thread?: Array, inbound?: object }} a
 */
export function multiPropertyEvidence({ inboundText = '', ledger = null, thread = [], inbound = null } = {}) {
  const m = MULTI_PROPERTY_TEXT_RE.exec(String(inboundText || ''))
  if (m) return { kind: 'seller_text', phrase: m[0].toLowerCase().slice(0, 60) }
  const req = (ledger?.requests || []).find((r) => r.kind === 'property_identity' && r.source_message_id === inbound?.id)
  if (req) return { kind: 'seller_asked_which_property', source_message_id: req.source_message_id }
  const outs = (thread || []).filter((x) => x.direction === 'outbound' && x.property_id).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
  const lastOut = outs[outs.length - 1]
  const distinctOut = new Set(outs.map((x) => String(x.property_id)))
  if (inbound?.property_id && lastOut && distinctOut.size > 1 && String(lastOut.property_id) !== String(inbound.property_id)) {
    return { kind: 'inbound_property_differs_from_last_outbound', distinct_outbound_properties: distinctOut.size }
  }
  return null
}

export function multiOwnerEvidence({ inboundText = '' } = {}) {
  const m = MULTI_OWNER_TEXT_RE.exec(String(inboundText || ''))
  return m ? { kind: 'seller_text', phrase: m[0].toLowerCase().slice(0, 60) } : null
}

/**
 * The model's own escalation (R1 judgment.escalation_reason), mapped onto an evidence-backed code.
 * A claim the evidence does not support becomes insufficient_context (claimed reason kept).
 */
export function mapModelEscalation(judgment, ctx = {}) {
  const claimed = String(judgment?.escalation_reason || 'other')
  if (claimed === 'multiple_properties') {
    const ev = multiPropertyEvidence(ctx)
    return ev ? escalation('multiple_properties', ev) : escalation('insufficient_context', { model_claimed: claimed, unsupported: true })
  }
  if (claimed === 'multiple_owners') {
    const ev = multiOwnerEvidence(ctx)
    return ev ? escalation('multiple_owners', ev) : escalation('insufficient_context', { model_claimed: claimed, unsupported: true })
  }
  if (claimed === 'financing' || claimed === 'nonstandard_deal' || claimed === 'legal') return escalation('incompatible_term', { model_claimed: claimed })
  if (claimed === 'complex_negotiation') return escalation('missing_negotiation_authority', { model_claimed: claimed })
  if (claimed === 'contradiction') return escalation('price_contradiction', { model_claimed: claimed })
  if (claimed === 'validation_failure') return escalation('failed_tool', { model_claimed: claimed })
  return escalation('insufficient_context', { model_claimed: claimed })
}
