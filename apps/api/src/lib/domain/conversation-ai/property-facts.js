// PROPERTY ATTRIBUTION (rc-8.5.21, blind-eval S1). Pure; imports nothing.
//
// A thread can carry several properties (the seller owns 8583 Oak Dr and 5471 Pine Ct, we asked
// about each). Every ownership answer belongs to ONE property, or to none when that cannot be
// told. This module is the ONE attribution rule, used by the recontact guard (send time), the
// conversation ledger / shared outbound validator (what an AI text may name) and the inbound
// contact-resolution writer (which property a denial is recorded on):
//
//   1. a reply that NAMES exactly one known property address answers that property
//      ("I dont own 5787 Elm St" ⇒ Elm St, whatever property the inbound row carries)
//   2. a reply that names several, or none while ownership questions about MORE THAN ONE property
//      are open (we asked about Oak Dr, then about Pine Ct, and got one bare "No") ⇒ UNATTRIBUTED
//      (property ''): the owner 10-17 rule makes that a thread HOLD, never a denial of the latest
//   3. otherwise the property of our open question (the one it answers), then the inbound row's
//
// Addresses come from the property records (properties[].address) and from our own outbound texts
// stamped with a property_id ("Do you still own 8583 Oak Dr?").
//
// blind-eval v2 (MUL-02/03/05/14): a reply that names SEVERAL properties is read CLAUSE BY CLAUSE
// ("I don't own the Oak Hollow one, never did. Pine Crest is mine though"; "Mill Race is my rental,
// I'd sell that one. Orchard View is where I live, not selling"): each clause that names exactly one
// property carries that property's ownership / interest answer (clauseFacts).
import { OWN_CONFIRM_RE, OWN_DENY_RE, OWN_FORMER_RE, NOT_INTERESTED_RE } from './fact-ledger.js'

const clean = (v) => String(v ?? '').trim()
const t = (m) => Date.parse(m?.at || m?.event_timestamp || m?.created_at || 0) || 0
const SUFFIX = '(?:st|street|dr|drive|ct|court|ave|avenue|rd|road|ln|lane|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|run|sq|square)'
// "8583 Oak Dr", "5471 n pine ct", "1214 Elm"
const ADDRESS_RE = new RegExp(`\\b([0-9]{1,6})\\s+((?:[nsew]\\.?\\s+)?[a-z][a-z'-]*(?:\\s+[a-z][a-z'-]*)?)(?:\\s+${SUFFIX}\\b)?`, 'gi')
// "the Oak Dr house" (no number): a street name WITH a suffix
const STREET_RE = new RegExp(`\\b([a-z][a-z'-]{1,})\\s+(${SUFFIX})\\b`, 'gi')
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'it', 'my', 'your', 'this', 'that', 'was', 'year', 'years', 'days', 'day', 'k', 'percent', 'dollars', 'months', 'month', 'weeks', 'week', 'beds', 'bed', 'baths', 'bath', 'sq', 'sqft', 'feet', 'ft', 'units', 'unit'])
const SUFFIX_RE = new RegExp(`^${SUFFIX}$`, 'i')

/** Normalized address keys a text mentions: "8583 oak" (number + first street word) and "street:oak". */
export function addressKeysIn(text) {
  const s = clean(text).toLowerCase()
  const keys = new Set()
  for (const m of s.matchAll(ADDRESS_RE)) {
    const words = m[2].replace(/^[nsew]\.?\s+/, '').split(/\s+/).filter((w) => w && !SUFFIX_RE.test(w))
    const first = words[0]
    if (!first || STOP_WORDS.has(first)) continue
    keys.add(`${m[1]} ${first}`)
    keys.add(`street:${first}`)
  }
  for (const m of s.matchAll(STREET_RE)) if (!STOP_WORDS.has(m[1])) keys.add(`street:${m[1]}`)
  return [...keys]
}

/**
 * key → property_id, from the property records and our own outbound texts. A key claimed by two
 * properties is ambiguous and dropped (it names neither).
 * @param {{ properties?: Array<{ property_id: string, address?: string|null }>, messages?: Array<{ direction: string, body?: string, message_body?: string, property_id?: string|null }> }} a
 */
export function propertyAddressIndex({ properties = [], messages = [] } = {}) {
  const claims = new Map()
  const claim = (key, pid) => { if (!pid) return; const s = claims.get(key) || new Set(); s.add(pid); claims.set(key, s) }
  for (const p of properties || []) for (const k of addressKeysIn(p?.address || '')) claim(k, clean(p.property_id))
  for (const m of messages || []) {
    if (!String(m?.direction || '').toLowerCase().startsWith('out')) continue
    const pid = clean(m.property_id)
    if (!pid) continue
    const keys = addressKeysIn(m.body ?? m.message_body)
    // an outbound naming SEVERAL addresses says nothing about which one its property id is
    if (keys.filter((k) => !k.startsWith('street:')).length > 1) continue
    for (const k of keys) claim(k, pid)
  }
  const index = new Map()
  for (const [k, s] of claims) if (s.size === 1) index.set(k, [...s][0])
  return index
}

/** The thread properties a text names (via the index): numbered / suffixed addresses, and a bare
 *  street name ("Cider Mill", "the Oak Hollow one") when the index knows that street word (≥ 4 letters). */
export function propertiesNamedIn(text, index) {
  const named = new Set()
  for (const k of addressKeysIn(text)) if (index?.has(k)) named.add(index.get(k))
  const lowerText = clean(text).toLowerCase()
  for (const [k, pid] of index || []) {
    if (!k.startsWith('street:')) continue
    const w = k.slice(7)
    if (w.length >= 4 && !STOP_WORDS.has(w) && new RegExp(`\\b${w.replace(/[^a-z'-]/g, '')}\\b`).test(lowerText)) named.add(pid)
  }
  return [...named]
}

// clause-level answers
const CLAUSE_SPLIT_RE = /(?<=[.;!?\n])\s*|\s+(?:but|though|however|whereas|while)\b\s*|,\s+(?=(?:the\s+)?[a-z0-9][a-z0-9'-]*(?:\s+[a-z0-9'-]+){0,3}\s+(?:is|was|'s)\b)/i
const CLAUSE_DENY_RE = /\b(?:(?:is|was|'s)\s+(?:not\s+(?:mine|ours)|my\s+(?:aunt|uncle|mom|mother|dad|father|parents|brother|sister|son|daughter|grandma|grandmother|grandpa|grandfather|cousin|ex|friend|neighbor)(?:'s)?)|never\s+(?:did|owned|was\s+mine)|(?:don'?t|dont|do\s+not|never)\s+own(?:ed)?)\b/i
const CLAUSE_CONFIRM_RE = /\b(?:(?:is|'s)\s+(?:mine|ours)|my\s+(?:rental|house|home|place|property|investment)|where\s+(?:i|we)\s+live|(?:i|we)\s+(?:still\s+)?own\s+(?:it|that|this|the))\b/i
const CLAUSE_INTEREST_RE = /\b(?:(?:i'?d|i\s+would|we'?d|we\s+would)\s+(?:sell|consider)|(?:willing|open|happy)\s+to\s+sell|(?:could|would)\s+sell|(?:is|that\s+one'?s?)\s+for\s+sale|interested\s+in\s+selling\s+(?:that|this|it))\b/i
const CLAUSE_DISINTEREST_RE = /\b(?:not\s+selling|won'?t\s+sell|not\s+for\s+sale|keeping\s+(?:it|that|this)|not\s+interested)\b/i

/**
 * Per-clause answers of ONE reply (pure).
 * @returns {Array<{ property: string, ownership: 'denied'|'confirmed'|null, interest: 'interested'|'not_interested'|null, clause: string }>}
 */
export function clauseFacts(text, index) {
  const out = []
  let lastProperty = null
  for (const raw of String(text || '').split(CLAUSE_SPLIT_RE)) {
    const clause = clean(raw)
    if (!clause) continue
    const named = propertiesNamedIn(clause, index)
    const refersBack = /\b(?:that|this)\s+one\b|\bit\b/i.test(clause)
    const property = named.length === 1 ? named[0] : named.length === 0 && refersBack && lastProperty ? lastProperty : null
    if (!property) continue
    const ownership = CLAUSE_DENY_RE.test(clause) || OWN_DENY_RE.test(clause) || OWN_FORMER_RE.test(clause) ? 'denied' : CLAUSE_CONFIRM_RE.test(clause) || OWN_CONFIRM_RE.test(clause) ? 'confirmed' : null
    const interest = CLAUSE_DISINTEREST_RE.test(clause) || NOT_INTERESTED_RE.test(clause) ? 'not_interested' : CLAUSE_INTEREST_RE.test(clause) ? 'interested' : null
    const prev = out.find((x) => x.property === property)
    if (prev) { prev.ownership = prev.ownership || ownership; prev.interest = prev.interest || interest; prev.clause += ` ${clause}` } else out.push({ property, ownership, interest, clause })
    lastProperty = property
  }
  return out.filter((x) => x.ownership || x.interest)
}

/**
 * Attribution of every inbound message in the thread (time order). `questionKindOf` is injected
 * (questions.js) so this module stays dependency-free.
 * @returns {Map<string, { property: string, basis: string, ambiguous: boolean, open_ownership_properties: string[] }>}
 *          inbound message id → attribution ('' = not reliably identified)
 */
export function attributeInbounds({ messages = [], properties = [], questionKindOf }) {
  const index = propertyAddressIndex({ properties, messages })
  const out = new Map()
  let open = [] // our unanswered questions since the last inbound: [{ kind, property_id }]
  for (const m of [...messages].sort((a, b) => t(a) - t(b))) {
    const dir = String(m?.direction || '').toLowerCase()
    const body = clean(m.body ?? m.message_body)
    if (dir.startsWith('out')) {
      const kind = typeof questionKindOf === 'function' ? questionKindOf({ use_case: m.use_case || null, body }) : 'none'
      if (kind !== 'none') open.push({ kind, property_id: clean(m.property_id) || null })
      continue
    }
    if (!dir.startsWith('in')) continue
    const named = propertiesNamedIn(body, index)
    const ownOpen = [...new Set(open.filter((q) => q.kind === 'ownership').map((q) => q.property_id || '?'))]
    let property = ''
    let basis = 'unattributed'
    let ambiguous = false
    let clauses = null
    if (named.length === 1) { property = named[0]; basis = 'named_in_reply' }
    else if (named.length > 1) {
      // several properties named: read clause by clause; a clause naming one property answers it
      clauses = clauseFacts(body, index)
      if (clauses.length) basis = 'per_clause'
      else { ambiguous = true; basis = 'several_properties_named' }
    }
    else if (ownOpen.length > 1) { ambiguous = true; basis = 'several_open_ownership_questions' }
    else if (ownOpen.length === 1 && ownOpen[0] !== '?') { property = ownOpen[0]; basis = 'answers_open_ownership_question' }
    else {
      const lastQ = open.length ? open[open.length - 1] : null
      if (lastQ?.property_id) { property = lastQ.property_id; basis = 'answers_open_question' }
      else if (clean(m.property_id)) { property = clean(m.property_id); basis = 'inbound_row_property' }
    }
    out.set(String(m.id), { property, basis, ambiguous, clauses, open_ownership_properties: ownOpen.filter((p) => p !== '?') })
    // an inbound answers (consumes) the questions it follows
    open = []
  }
  return out
}

/**
 * blind-eval v2 (MUL-02/05/14): a mixed answer resolved clause by clause ("I don't own X, Y is mine";
 * "Y is my rental, I'd sell that one. X is where I live, not selling") — the property the conversation
 * CONTINUES on (confirmed / interested in THIS inbound) and its next stage question. null when the
 * inbound is not such an answer. Pure.
 */
export function mixedAnswerTarget(po) {
  const clauses = po?.inbound?.clauses || []
  if (clauses.length < 2) return null
  const negative = clauses.filter((c) => c.ownership === 'denied' || c.interest === 'not_interested')
  const positive = clauses.filter((c) => c.ownership !== 'denied' && c.interest !== 'not_interested' && (c.ownership === 'confirmed' || c.interest === 'interested'))
  if (!negative.length || positive.length !== 1) return null
  const target = positive[0]
  return { property: target.property, objective: target.interest === 'interested' ? 'asking_price' : 'interest', denied: negative.filter((c) => c.ownership === 'denied').map((c) => c.property), not_interested: negative.filter((c) => c.interest === 'not_interested').map((c) => c.property) }
}


/**
 * blind-eval v2 (MUL-08/13): never skip S1 for a property that is not confirmed. In a thread with
 * several properties, a reply whose stage objective is past ownership (interest / price / condition)
 * about a property this contact has NOT confirmed asks the OWNERSHIP question for it instead. Returns
 * { property, objective: 'ownership' } or null. Pure.
 */
export function perPropertyObjective(po, objective) {
  if (!po || !['interest', 'asking_price', 'condition'].includes(objective)) return null
  const props = Object.keys(po.by_property || {})
  if (props.length < 2) return null
  const target = po.inbound?.property || null
  if (!target) return null
  const state = po.by_property?.[target]?.state || 'unknown'
  if (state === 'confirmed') return null
  if (['denied', 'declined', 'conflict'].includes(state)) return null // never ask about it at all (validator / decide hold)
  return { property: target, objective: 'ownership' }
}
