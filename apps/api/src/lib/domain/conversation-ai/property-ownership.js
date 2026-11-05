// PER-PROPERTY OWNERSHIP FACTS for the conversation ledger (rc-8.5.21, blind-eval S1).
//
// The thread-level ownership fact ("ownership: confirmed") cannot say WHICH property: in a thread
// where the seller denied 8583 Oak Dr and confirmed 5471 Pine Ct, both answers landed on the same
// slot and an AI text thanked them "for confirming 8583 Oak Dr is yours". The canonical per-property
// facts here are the SAME evidence the send-time recontact guard ranks (ownershipEvidenceItems with
// the one attribution rule of property-facts.js) plus the persisted contact × property resolutions,
// so the writer, the shared outbound validator and the guard agree on every property.
import { evaluateContactPropertyResolution, ownershipEvidenceItems, resolveOwnershipEvidence } from '../queue/ownership-recontact-guard.js'
import { addressKeysIn, attributeInbounds, propertyAddressIndex } from './property-facts.js'
import { questionKindOf } from './questions.js'

export const PROPERTY_OWNERSHIP_VERSION = 'conv-ai.property-ownership.v1'
const clean = (v) => String(v ?? '').trim()

/**
 * @param {{ messages: Array, properties?: Array<{ property_id: string, address?: string|null }>, resolutions?: Array, inboundId?: string|null, inboundPropertyId?: string|null }} a
 * @returns {{ version: string, by_property: Record<string, { state: 'confirmed'|'denied'|'declined'|'conflict'|'unknown', basis: string|null, message_id: string|null, source: 'message'|'store'|null }>, thread_hold: boolean, thread_hold_basis: string|null, inbound: { property: string, basis: string, ambiguous: boolean }|null, address_keys: Record<string, string[]> }}
 */
export function propertyOwnershipFacts({ messages = [], properties = [], resolutions = [], inboundId = null, inboundPropertyId = null } = {}) {
  const items = ownershipEvidenceItems({ messages, properties })
  const pids = new Set([...(properties || []).map((p) => clean(p.property_id)), ...items.map((e) => e.property), ...(resolutions || []).map((r) => clean(r.property_id)), clean(inboundPropertyId)].filter(Boolean))
  const by_property = {}
  for (const pid of pids) {
    const own = items.filter((e) => e.property === pid)
    const store = evaluateContactPropertyResolution({ property_id: pid, resolutions })
    if (store.excluded && !store.hold && store.scope !== 'phone') own.push({ property: pid, state: store.declined ? 'declined' : 'denied', message_id: null, at: Date.parse(store.rejected_at || '') || 0, basis: `store:${store.role}`, kind: 'store', rank: 2 })
    const r = resolveOwnershipEvidence(own)
    by_property[pid] = r
      ? { state: r.conflict ? 'conflict' : r.state, basis: r.basis, message_id: r.message_id || null, source: r.kind === 'store' ? 'store' : 'message' }
      : { state: 'unknown', basis: null, message_id: null, source: null }
  }
  // an unattributed denial / decline (one bare "No" to questions about several properties) holds the
  // thread until newer, at-least-as-confident evidence for a property resolves it
  const loose = resolveOwnershipEvidence(items.filter((e) => !e.property))
  const looseNegative = loose && ['denied', 'declined'].includes(loose.state) ? loose : null
  const resolvedAfter = looseNegative && items.some((e) => e.property && e.at > looseNegative.at && e.rank >= looseNegative.rank)
  const att = inboundId ? attributeInbounds({ messages, properties, questionKindOf }).get(String(inboundId)) || null : null
  const index = propertyAddressIndex({ properties, messages })
  const address_keys = {}
  for (const [k, pid] of index) (address_keys[pid] ||= []).push(k)
  const labels = {}
  for (const p of properties || []) if (clean(p.property_id) && clean(p.address)) labels[clean(p.property_id)] = clean(p.address)
  return {
    version: PROPERTY_OWNERSHIP_VERSION,
    by_property,
    thread_hold: Boolean(looseNegative && !resolvedAfter),
    thread_hold_basis: looseNegative && !resolvedAfter ? looseNegative.basis : null,
    inbound: att ? { property: att.property, basis: att.basis, ambiguous: att.ambiguous, clauses: att.clauses || null } : null,
    address_keys,
    labels,
  }
}

/** Attach the per-property facts to a canonical ledger (ledger.property.ownership). Returns the ledger. */
export function attachPropertyFacts(ledger, { messages = [], properties = [], resolutions = [], inboundId = null, inboundPropertyId = null } = {}) {
  if (!ledger || typeof ledger !== 'object') return ledger
  ledger.property = { ...(ledger.property || {}), ownership: propertyOwnershipFacts({ messages, properties, resolutions, inboundId, inboundPropertyId }) }
  return ledger
}

/** The ledger messages of a buildConversationContext() input (thread + inbound, both directions, with property ids). */
export function messagesOfInput(input = {}) {
  const rows = [...(input.thread || [])]
  const ib = input.inbound || {}
  if (ib.id && !rows.some((m) => m.id === ib.id)) rows.push({ ...ib, direction: 'inbound' })
  return rows.map((m) => ({ id: m.id, direction: m.direction, body: m.body ?? m.message_body ?? '', at: m.at, property_id: m.property_id || null, use_case: m.use_case || null, detected_intent: m.intent || m.detected_intent || null }))
}

/** attachPropertyFacts for a context input (what the pipeline and R3 both call). */
export function attachPropertyFactsFromInput(ledger, input = {}) {
  return attachPropertyFacts(ledger, { messages: messagesOfInput(input), properties: input.properties || [], resolutions: input.contact_property_resolutions || [], inboundId: input.inbound?.id || null, inboundPropertyId: input.inbound?.property_id || null })
}

export { mixedAnswerTarget } from './property-facts.js'
export { addressKeysIn }
