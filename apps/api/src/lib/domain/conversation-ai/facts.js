// The seller FACT LEDGER: every fact with its source message id and origin.
//
//   origin 'seller_stated'   extracted from a seller (inbound) message — the existing
//                            deterministic extractor (extractSellerFacts) and the
//                            deterministic classifier's intent, never a guess
//   origin 'record_derived'  from LeadCommand records (property type, units, an
//                            authoritative offer row) — never presented as something
//                            the seller said
//   origin 'model_extracted' a fact the R1 model extracted from a cited seller message
//                            (merged after contract validation only)
//
// CORRECTION RECONCILIATION: a later seller-stated value for the same fact replaces
// the current value; the earlier one stays in history with superseded_by. A price
// "correction" is therefore latest-wins with full provenance, never an average.
import { extractSellerFacts } from '../seller-flow/extract-seller-facts.js'

const INTENT_FACTS = Object.freeze({
  ownership_confirmed: ['ownership', 'confirmed'],
  wrong_number: ['ownership', 'denied'],
  not_owner: ['ownership', 'denied'],
  property_specific_non_owner: ['ownership', 'denied'],
  former_owner_respondent: ['ownership', 'former_owner'],
  executor_heir_respondent: ['identity_role', 'executor_or_heir'],
  family_member_respondent: ['identity_role', 'family_member'],
  agent_representative_respondent: ['identity_role', 'agent'],
  tenant_occupied: ['occupancy', 'tenant_occupied'],
  not_interested: ['seller_interest', 'not_interested'],
  seller_interested: ['seller_interest', 'interested'],
  latent_interest: ['seller_interest', 'conditional'],
  asks_offer: ['offer_request', 'asked_for_offer'],
  condition_disclosed: ['condition', 'disclosed'],
})

function push(ledger, key, entry) {
  const slot = (ledger[key] ||= { current: null, history: [] })
  const prev = slot.current
  if (prev && prev.origin !== 'record_derived' && entry.origin !== 'record_derived' && JSON.stringify(prev.value) !== JSON.stringify(entry.value)) {
    prev.superseded_by = entry.source_message_id
    entry.corrects = prev.source_message_id
  }
  slot.history.push(entry)
  // a record-derived value never overrides a seller-stated one
  if (!(prev && prev.origin === 'seller_stated' && entry.origin === 'record_derived')) slot.current = entry
}

/**
 * @param {{ inbound: Array<{ id: string, body: string, at: string, intent?: string|null, answers_price_question?: boolean }>, recordFacts?: Record<string, any>, now?: string }} args
 *   inbound: the thread's SELLER messages, chronological (current inbound included).
 *   intent: the deterministic classifier's primary intent for that message.
 */
export function buildFactLedger({ inbound = [], recordFacts = {}, now = new Date().toISOString() } = {}) {
  const ledger = {}
  for (const [k, v] of Object.entries(recordFacts || {})) if (v != null) push(ledger, k, { value: v, origin: 'record_derived', source_message_id: null, at: null, confidence: 1 })
  for (const m of inbound) {
    // rc-8.5.21 v3 (remember supplied asking prices): a reply to OUR asking-price question is read with the
    // v3 number rules (a bare "250" answering "what price?" is $250,000), never dropped as an ambiguous mention
    const ex = extractSellerFacts({ message: m.body, sourceMessageId: m.id, now, ...(m.answers_price_question ? { priceSignalOptions: { numberRules: 'v3' } } : {}) })
    const f = ex.facts || {}
    const add = (key, value, confidence) => push(ledger, key, { value, origin: 'seller_stated', source_message_id: m.id, at: m.at, confidence: Number(confidence ?? 0.7) })
    if (f.asking_price?.value?.amount > 0) add('asking_price', { amount: f.asking_price.value.amount, price_type: f.asking_price.value.price_type, range: f.asking_price.value.range || null }, f.asking_price.confidence)
    if (f.asking_price_mention) add('asking_price_mention', f.asking_price_mention.value?.raw_text || 'ambiguous', 0.3)
    if (f.condition || f.repairs) add('condition', { condition: f.condition?.value ?? null, repairs: f.repairs?.value ?? null }, (f.condition || f.repairs).confidence)
    if (f.occupancy) add('occupancy', f.occupancy.value, f.occupancy.confidence)
    if (f.timeline) add('timeline', f.timeline.value, f.timeline.confidence)
    if (f.listing_status) add('listing_status', f.listing_status.value, f.listing_status.confidence)
    if (f.ownership) add('ownership', f.ownership.value, f.ownership.confidence)
    if (f.seller_interest) add('seller_interest', f.seller_interest.value, f.seller_interest.confidence)
    if (f.reason_for_selling) add('motivation', f.reason_for_selling.value, f.reason_for_selling.confidence)
    const it = INTENT_FACTS[String(m.intent || '')]
    if (it && !(ledger[it[0]]?.current?.source_message_id === m.id)) add(it[0], it[1], 0.8)
  }
  return ledger
}

/** Merge validated model-extracted facts (each cites a seller message id in context). */
export function mergeModelFacts(ledger, factsExtracted = [], { inboundIds, atById = {} } = {}) {
  const out = structuredClone(ledger)
  for (const f of factsExtracted) {
    if (!inboundIds?.has?.(f.source_message_id)) continue
    const key = f.fact === 'asking_price' && typeof f.value === 'number' ? 'asking_price' : f.fact
    const value = key === 'asking_price' && typeof f.value === 'number' ? { amount: f.value, price_type: 'model_extracted', range: null } : f.value
    const slot = out[key]
    // a model fact never overrides a deterministic seller-stated fact from the same message
    if (slot?.current?.origin === 'seller_stated' && slot.current.source_message_id === f.source_message_id) continue
    push(out, key, { value, origin: 'model_extracted', source_message_id: f.source_message_id, at: atById[f.source_message_id] || null, confidence: f.confidence })
  }
  return out
}

/** Compact, model-facing view: fact → { value, origin, source_message_id, corrects } */
export function factSummary(ledger) {
  const out = {}
  for (const [k, slot] of Object.entries(ledger)) {
    if (!slot.current) continue
    out[k] = { value: slot.current.value, origin: slot.current.origin, source_message_id: slot.current.source_message_id, ...(slot.current.corrects ? { corrects: slot.current.corrects } : {}), history_count: slot.history.length }
  }
  return out
}
