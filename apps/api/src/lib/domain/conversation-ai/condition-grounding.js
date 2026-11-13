// Owner 2026-10-30 (the unsupported property-condition claim gap found while writing the blind v11 tests): an agent's
// text may speak about THIS property's condition only from evidence. What counts as evidence, and for what:
//   seller_reported      the seller's own messages in this thread: may be acknowledged ("sorry to hear about the roof")
//   verified_finding     an inspection or verified record handed in by the caller: may also be stated as found
//                        ("the inspection showed…")
//   underwriting_estimate an internal estimate (Equity, a data provider's condition or repair figures): never stated to a
//                        seller as fact; only framed as an estimate, and only under negotiation authority for this lead
// What it checks: a SENTENCE that asserts a material condition (repairs, damage, defects, costs, the property's general
// shape) about THIS property ("the roof needs repairs", "sorry about the leak", "the house is in great shape"). What it
// leaves alone, by design, so ordinary conversation is not refused: questions ("Does the roof need any repairs?"),
// conditionals ("if the roof needs work…", "whether…"), statements about houses in general ("older homes often need
// roof work"), and anything the seller said. Nothing here touches opt-out, suppression, ownership or sending limits.

const FAMILIES = [
  ['roof', /\broof(?:s|ing|line)?\b|\bshingles?\b|\bgutters?\b/i],
  ['foundation', /\bfoundation\b|\bslab\b|\bsettl(?:ing|ed|ement)\b|\bstructur(?:e|al)\b|\bcrawl\s*space\b|\bjoists?\b/i],
  ['plumbing', /\bplumbing\b|\bpipes?\b|\bsewer\b|\bseptic\b|\bwater\s+heater\b|\bdrains?\b/i],
  ['electrical', /\belectric(?:al)?\b|\bwiring\b|\bbreakers?(?:\s+(?:box|panel))?\b|\belectrical\s+panel\b|\boutlets?\b/i],
  ['hvac', /\bhvac\b|\ba\/c\b|\bac\s+(?:unit|system)\b|\bthe\s+ac\b|\bair\s+condition\w*\b|\bfurnace\b|\bheat\s+pump\b|\bboiler\b|\bheating\b/i],
  ['water_damage', /\bwater\s+damage\b|\bleak\w*\b|\bflood\w*\b|\bmold\w*\b|\bmildew\b|\bmoisture\b|\bwater\s+in\s+the\s+basement\b/i],
  ['pests', /\btermites?\b|\binfestation\b|\brodents?\b|\bmice\b|\broaches\b/i],
]
const FAMILY_NAMES = FAMILIES.map(([k]) => k)
// THIS property as the subject of a general condition statement
const GENERAL_SUBJECT_RE = /\b(?:the|your|this|that)\s+(?:house|home|place|property|unit|building)\b|\bit(?:'s|\s+is|\s+needs|\s+has|\s+looks|\s+sounds|\s+seems)\b/i
// a family word that is about THIS property (a determiner within two words before it)
const familyOnProperty = (sentence, re) => {
  const src = re.source
  return new RegExp(`\\b(?:the|your|its|this|that|their|his|her)\\s+(?:[\\w'-]+\\s+){0,2}(?:${src})`, 'i').test(sentence)
}
// what makes a sentence ASSERT a condition (the damage nouns of the families assert on their own: "the leak")
const PREDICATE_RE = /\bneeds?\s+(?:a\s+lot\s+of\s+|some\s+|major\s+|serious\s+|a\s+bit\s+of\s+|a\s+new\s+)?(?:work|repairs?|replac\w*|updat\w*|tlc|attention|fixing|redone|redoing)\b|\bneed(?:s|ing)?\s+to\s+be\s+(?:replaced|repaired|redone|fixed|updated)\b|\b(?:is|are|was|were|'s|'re|looks?|seems?|sounds?)\s+(?:like\s+it'?s\s+)?(?:in\s+)?(?:rough|bad|poor|great|good|excellent|decent|solid|fair|terrible|awful)\s+(?:shape|condition)\b|\bdamaged?\b|\bbroken\b|\bcracked\b|\bcracks?\b|\brott(?:ed|ing)\b|\bfailing\b|\bshot\b|\boutdated\b|\bworn(?:\s+out)?\b|\bsagging\b|\bsettling\b|\bmove[\s-]?in\s+ready\b|\bturn[\s-]?key\b|\b(?:fully\s+)?(?:updated|renovated|remodeled|remodelled)\b|\bfixer(?:[\s-]upper)?\b|\b(?:old|older|new|newer)\b/i
const COST_RE = /\bcost(?:s|ly)?\b|\bexpensive\b|\bpricey\b|\bestimat\w*\b|\bbudget\b|\brun\s+(?:you|about|around)\b|\bbig\s+(?:expense|bill)\b|\bthousands\b|\$\s?\d/i
const VERIFIED_FRAMING_RE = /\b(?:inspection|inspector|inspected|appraisal|appraiser|assessor|records?\s+show|report\s+(?:shows|says)|we\s+(?:found|saw|noticed|verified|confirmed|know)|i\s+(?:found|saw|noticed|verified|know)|it\s+shows)\b/i
const ESTIMATE_FRAMING_RE = /\b(?:estimat\w*|we\s+figure|our\s+(?:numbers|figures)|ballpark|rough\s+(?:number|figure))\b/i
// leaves a sentence alone: a question, a conditional or a hypothetical
const NOT_AN_ASSERTION_RE = /\?\s*$|^\s*(?:does|do|did|is|are|was|were|has|have|had|how|what|any|anything|can|could|would|will)\b|\b(?:if|whether|in\s+case|unless|any\s+(?:issues|problems|work|repairs))\b/i
// the seller's general condition words (ground a general statement about the property)
const SELLER_GENERAL_RE = /\b(?:needs?\s+(?:a\s+lot\s+of\s+|some\s+)?(?:work|repairs?|tlc|updating)|repairs?|fixer|shape|condition|updated|remodel\w*|renovat\w*|gutted|redid|redone|as[\s-]is|move[\s-]?in\s+ready|turn[\s-]?key|rough|old|new\s+\w+|falling\s+apart|damage\w*)\b/i

/** The condition families a text names (a question or a statement alike). */
export function conditionFamiliesIn(text) { return FAMILIES.filter(([, re]) => re.test(String(text || ''))).map(([k]) => k) }

const sentencesOf = (text) => String(text || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || []

/**
 * The evidence for each condition family, from the seller's own messages and the caller's authorized evidence.
 * @param {{ thread?: Array<{direction:string, body:string}>, evidence?: Array<{family:string, source:'seller_reported'|'verified_finding'|'underwriting_estimate'}> }} o
 */
export function conditionEvidenceOf({ thread = [], evidence = [] } = {}) {
  const sellerText = thread.filter((m) => m?.direction === 'inbound').map((m) => String(m.body || '')).join(' \n ')
  const by = Object.fromEntries([...FAMILY_NAMES, 'general'].map((k) => [k, new Set()]))
  for (const [k, re] of FAMILIES) if (re.test(sellerText)) { by[k].add('seller_reported'); by.general.add('seller_reported') }
  if (SELLER_GENERAL_RE.test(sellerText)) by.general.add('seller_reported')
  for (const e of evidence || []) {
    const fam = by[e?.family] ? e.family : 'general'
    if (['seller_reported', 'verified_finding', 'underwriting_estimate'].includes(e?.source)) { by[fam].add(e.source); if (fam !== 'general') by.general.add(e.source) }
  }
  return by
}

/**
 * Reasons a text asserts a property condition it cannot back. Empty when every condition statement is grounded.
 * @param {string} text
 * @param {{ thread?: Array<{direction:string, body:string}>, evidence?: Array<object>, moneyAuthority?: object|null }} [o]
 * @returns {string[]}
 */
export function conditionGroundingReasons(text, { thread = [], evidence = [], moneyAuthority = null } = {}) {
  const by = conditionEvidenceOf({ thread, evidence })
  const reasons = []
  for (const s of sentencesOf(text)) {
    if (NOT_AN_ASSERTION_RE.test(s)) continue
    const families = FAMILIES.filter(([, re]) => familyOnProperty(s, re)).map(([k]) => k)
    const general = !families.length && GENERAL_SUBJECT_RE.test(s) && PREDICATE_RE.test(s)
    const damageNoun = families.some((k) => k === 'water_damage' || k === 'pests')
    if (!general && !(families.length && (PREDICATE_RE.test(s) || damageNoun || COST_RE.test(s)))) continue
    for (const fam of general ? ['general'] : families) {
      const src = by[fam]
      if (VERIFIED_FRAMING_RE.test(s)) { if (!src.has('verified_finding')) reasons.push(`condition:verification_claim_without_finding:${fam}`); continue }
      if (ESTIMATE_FRAMING_RE.test(s)) { if (!(src.has('underwriting_estimate') && moneyAuthority)) reasons.push(`condition:estimate_without_authority:${fam}`); continue }
      // a cost is a claim beyond the condition itself: the seller must have raised it, or it is an authorized estimate
      if (COST_RE.test(s) && !(src.has('seller_reported') && COST_RE.test(thread.filter((m) => m?.direction === 'inbound').map((m) => m.body).join(' ')))) { reasons.push(`condition:unsupported_cost_claim:${fam}`); continue }
      if (!src.has('seller_reported') && !src.has('verified_finding')) reasons.push(src.has('underwriting_estimate') ? `condition:estimate_stated_as_fact:${fam}` : `condition:unsupported_assertion:${fam}`)
    }
  }
  return [...new Set(reasons)]
}
