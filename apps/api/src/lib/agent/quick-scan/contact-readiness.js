// CONTACT READINESS — entity-owned properties (S3, owner 10-09). PURE.
//
// Presents the contact EVIDENCE a property has, separately from campaign
// eligibility, in five states (plus "unknown" when a read failed):
//
//   held_suppressed          a suppression / opt-out / hold blocks contact
//   relationship_unresolved  people or phones exist, but the entity-contact
//                            relationship requires review (entity owner, role
//                            not resolved) — contact found, NOT missing
//   vendor_associated_phone  phones linked to the property by the vendor only
//                            (prospect linked_property), owner identity unresolved
//   confirmed_relationship   the phone/person is the resolved owner's (campaign
//                            graph person or same master owner) and no review flag
//   no_contact_found         every contact read succeeded and found no person or phone
//   unknown                  a contact read failed — never shown as "no contact"
//
// Rules:
//   * unresolved entity ownership is never presented as missing contact data;
//   * a found contact is never promoted into campaign eligibility — eligibility
//     is the campaign target graph's verdict (sms.eligible), carried alongside;
//   * phones leave masked (last four) — the outreach service already masks them;
//   * the role resolver is not re-implemented: requires_review / exclusion_reasons
//     are read as published by seller.property_entity_contact_v1 (via the
//     allowlisted campaign_entity_contact_review_flags accessor).

export const CONTACT_READINESS_STATES = Object.freeze({
  held_suppressed: { label: 'Held / suppressed', rank: 0 },
  relationship_unresolved: { label: 'Contact found — relationship unresolved', rank: 1 },
  vendor_associated_phone: { label: 'Vendor-associated phone', rank: 2 },
  confirmed_relationship: { label: 'Confirmed relationship', rank: 3 },
  no_contact_found: { label: 'No contact found', rank: 4 },
  unknown: { label: 'Contact evidence unavailable', rank: 5 },
})

// strict: only explicit suppression / opt-out / do-not-contact / litigation. The entity-contact
// reasons (ENT_ROLE_UNCORROBORATED, ENT_NO_REGISTRY_LINK, ENT_NO_COMPLIANT_CHANNEL,
// ENT_NO_HUMAN_CANDIDATE, ENT_DISSOLVED — prod vocabulary 10-09) are review reasons, never suppression.
const SUPPRESSION_RE = /suppress|opt(?:ed)?[_\s-]?out|\bdnc\b|do[_\s-]?not[_\s-]?(contact|call|text)|litigat/i

export const ENTITY_REVIEW_REASON_LABELS = Object.freeze({
  ENT_NO_REGISTRY_LINK: 'no state-registry link for the entity',
  ENT_ROLE_UNCORROBORATED: "the person's role at the entity is not corroborated",
  ENT_NO_COMPLIANT_CHANNEL: 'no compliant channel for the selected person',
  ENT_NO_HUMAN_CANDIDATE: 'no human candidate behind the entity',
  ENT_DISSOLVED: 'the entity is dissolved',
})
const reasonLabel = (r) => ENTITY_REVIEW_REASON_LABELS[r] || r

/**
 * @param {{
 *   sms: { eligible?: boolean, reason?: string|null, rows?: number, ready?: number } | null,
 *   graphRead: boolean,                  campaign_target_graph read succeeded
 *   candidates: { people: number, phones: number, unresolved: number, candidates?: Array<{ resolution: string, phones: Array<{ masked: string, type?: string|null, inCampaignGraph?: boolean }> }> } | null,
 *   candidatesLookedUp: boolean,         discovery ran (only when the graph had no phone)
 *   candidatesRead: boolean,             discovery did not fail
 *   review: { requires_review: boolean|null, exclusion_reasons: string[] } | null,
 *   reviewRead: boolean,
 *   suppressedThread: boolean,
 * }} input
 */
export function classifyContactReadiness(input) {
  const { sms, graphRead, candidates, candidatesLookedUp, candidatesRead, review, reviewRead, suppressedThread } = input
  const reasons = (review?.exclusion_reasons || []).map(String)
  // the graph has a phone exactly when discovery was skipped for this property (outreach-state gapIds rule)
  const graphPhone = graphRead && !candidatesLookedUp && (sms?.rows || 0) > 0
  const list = candidates?.candidates || []
  const resolvedCands = list.filter((c) => c.resolution === 'resolved_owner' || c.resolution === 'graph_person')
  const vendorCands = list.filter((c) => c.resolution === 'linked_unresolved')
  const people = (candidates?.people || 0) + (graphPhone ? 1 : 0)
  const phones = (candidates?.phones || 0) + (graphPhone ? 1 : 0)
  const anyContact = graphPhone || phones > 0
  const requiresReview = review?.requires_review === true
  const evidence = []
  if (graphPhone) evidence.push('campaign_graph_phone')
  if (resolvedCands.length) evidence.push('resolved_owner_candidate')
  if (vendorCands.length) evidence.push('vendor_linked_candidate')
  if (requiresReview) evidence.push('entity_contact_requires_review')
  if (suppressedThread) evidence.push('thread_suppressed')

  let state
  const suppressedBy = [
    suppressedThread ? 'conversation thread is suppressed' : null,
    sms && !sms.eligible && sms.reason && SUPPRESSION_RE.test(sms.reason) ? `campaign graph: ${sms.reason}` : null,
    ...reasons.filter((r) => SUPPRESSION_RE.test(r)).map((r) => `entity contact: ${r}`),
  ].filter(Boolean)
  if (suppressedBy.length) state = 'held_suppressed'
  else if (requiresReview && anyContact) state = 'relationship_unresolved'
  else if (graphPhone && review?.requires_review !== true) state = 'confirmed_relationship'
  else if (resolvedCands.length) state = 'confirmed_relationship'
  else if (vendorCands.length) state = requiresReview ? 'relationship_unresolved' : 'vendor_associated_phone'
  else if (!graphRead || (candidatesLookedUp && !candidatesRead)) state = 'unknown'
  else state = 'no_contact_found'

  const masked = [...new Set(list.flatMap((c) => (c.phones || []).map((p) => p.masked)).filter(Boolean))].slice(0, 6)
  return {
    state,
    label: CONTACT_READINESS_STATES[state].label,
    people,
    phones,
    masked_phones: masked,
    resolved_people: resolvedCands.length + (graphPhone && !requiresReview ? 1 : 0),
    vendor_linked_people: vendorCands.length,
    requires_review: review ? review.requires_review : null,
    review_reasons: reasons,
    review_checked: reviewRead,
    suppressed_by: suppressedBy,
    evidence,
    // eligibility is NOT decided here — it is the campaign target graph's verdict, carried for display
    campaign_eligible: sms ? Boolean(sms.eligible) : null,
    campaign_reason: sms?.reason ?? null,
  }
}

export function contactReadinessDisplay(r) {
  const bits = [r.label]
  if (r.state !== 'no_contact_found' && r.state !== 'unknown') bits.push(`${r.people} ${r.people === 1 ? 'person' : 'people'} · ${r.phones} phone${r.phones === 1 ? '' : 's'}${r.masked_phones.length ? ` (${r.masked_phones.join(', ')})` : ''}`)
  if (r.requires_review) bits.push(`entity review${r.review_reasons.length ? `: ${r.review_reasons.map(reasonLabel).join('; ')}` : ' required'}`)
  bits.push(r.campaign_eligible === true ? 'campaign-eligible (target graph)' : r.campaign_eligible === false ? `not campaign-eligible${r.campaign_reason ? ` — ${r.campaign_reason}` : ''}` : 'campaign eligibility unknown')
  return bits.join(' · ')
}
