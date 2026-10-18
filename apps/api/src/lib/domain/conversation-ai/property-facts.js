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

const clean = (v) => String(v ?? '').trim()
const t = (m) => Date.parse(m?.at || m?.event_timestamp || m?.created_at || 0) || 0
const SUFFIX = '(?:st|street|dr|drive|ct|court|ave|avenue|rd|road|ln|lane|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|run|sq|square)'
// "8583 Oak Dr", "5471 n pine ct", "1214 Elm"
const ADDRESS_RE = new RegExp(`\\b([0-9]{2,6})\\s+((?:[nsew]\\.?\\s+)?[a-z][a-z'-]*(?:\\s+[a-z][a-z'-]*)?)(?:\\s+${SUFFIX}\\b)?`, 'gi')
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
    for (const k of addressKeysIn(m.body ?? m.message_body)) claim(k, pid)
  }
  const index = new Map()
  for (const [k, s] of claims) if (s.size === 1) index.set(k, [...s][0])
  return index
}

/** The thread properties a text names (via the index). */
export function propertiesNamedIn(text, index) {
  const named = new Set()
  for (const k of addressKeysIn(text)) if (index?.has(k)) named.add(index.get(k))
  return [...named]
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
    if (named.length === 1) { property = named[0]; basis = 'named_in_reply' }
    else if (named.length > 1) { ambiguous = true; basis = 'several_properties_named' }
    else if (ownOpen.length > 1) { ambiguous = true; basis = 'several_open_ownership_questions' }
    else if (ownOpen.length === 1 && ownOpen[0] !== '?') { property = ownOpen[0]; basis = 'answers_open_ownership_question' }
    else {
      const lastQ = open.length ? open[open.length - 1] : null
      if (lastQ?.property_id) { property = lastQ.property_id; basis = 'answers_open_question' }
      else if (clean(m.property_id)) { property = clean(m.property_id); basis = 'inbound_row_property' }
    }
    out.set(String(m.id), { property, basis, ambiguous, open_ownership_properties: ownOpen.filter((p) => p !== '?') })
    // an inbound answers (consumes) the questions it follows
    open = []
  }
  return out
}
