// Conversation evidence: what the SELLER'S OWN WORDS show, read with rules only (no model, no I/O).
//
// Every reading here is `inferred` evidence for a human or the Decision Engine to verify, never an
// authority: a price span is a CANDIDATE, not a committed asking price (seller-flow's canonical
// asking-price authority is a write-path module this read-only server may not import); an interest
// reading is a summary of cited messages, never a pipeline label. Opt-out reuses the production
// dispatch guard's independent stop reading (classification/multilingual-opt-out#readStopLikeText)
// and FAILS CLOSED on short stop words it does not cover (a bare "ALTO" / "Para" reads as a possible
// opt-out here — see docs/LEADCOMMAND-CONVERSATION-INTELLIGENCE.md §6, finding F1).
import { readStopLikeText } from '@/lib/domain/classification/multilingual-opt-out.js'

export const EVIDENCE_VERSION = 'lc_conversation_evidence_v1'

// short replies the production stop reading leaves unread; treated as POSSIBLE opt-outs (never as consent)
const SUPPLEMENTAL_STOP = /^\s*(?:alto|para|p[aá]rale|basta|ya basta|remove|quitar|stop\s+please|please\s+stop)\s*[.!¡]*\s*$/i

/** @returns {{ state: 'confirmed'|'possible'|'none', rules: string[] }} */
export function optOutReading(text) {
  const s = String(text ?? '')
  if (!s.trim()) return { state: 'none', rules: [] }
  const r = readStopLikeText(s)
  if (r.confirmed) return { state: 'confirmed', rules: r.sources.slice(0, 3) }
  if (r.uncertain) return { state: 'possible', rules: r.sources.slice(0, 3) }
  if (SUPPLEMENTAL_STOP.test(s)) return { state: 'possible', rules: ['mcp_supplemental_short_stop_word'] }
  return { state: 'none', rules: [] }
}

// Text that addresses an AI system instead of a person: flagged so a reader treats it as hostile data.
const INSTRUCTION_LIKE = /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|messages?|rules?)|\byou are now\b|\bact as (?:an?|the)\b|system\s*prompt|^\s*(?:system|assistant|developer)\s*:|\b(?:developer|admin|god)\s+mode\b|jailbreak|<\|?(?:im_start|system|endoftext)|\[\/?INST\]|reveal\s+(?:the|your)\s+(?:key|secret|prompt|instructions|token)|\b(?:call|use|invoke|run)\s+(?:the\s+)?(?:tool|function)\b|\bsend_sms\b|\bmark\s+(?:this|the)\s+lead\b|\btext\s+every(?:one|\s+contact)\b/im
export const isInstructionLike = (text) => INSTRUCTION_LIKE.test(String(text ?? ''))

const MONEY = /(\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\$\s?\d+(?:\.\d+)?\s?(?:k|m|mil|million|thousand)?\b|\b\d{2,3}(?:\.\d{1,2})?\s?(?:k|grand|mil)\b|\b\d{1,3}(?:\.\d{1,3})?\s?(?:million|millones)\b|\b\d{1,3}(?:,\d{3}){1,2}\b)/gi
const ASK_CUE = /\b(?:take|want|need|asking|ask|price is|looking for|sell (?:it )?for|accept|bottom|lowest|no less than|at least|firm|quiero|pido|acepto|m[ií]nimo)\b/i
const OFFER_CUE = /\b(?:offer(?:ed)?|appraised|zillow|worth|value[ds]?|tax(?:es)?|owe|mortgage|payoff|repairs?)\b/i

function moneyValue(raw) {
  const s = raw.toLowerCase().replace(/[$\s,]/g, '')
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return null
  if (/(?:k|grand)$/.test(s) || (/mil$/.test(s) && !/million|millones/.test(s))) return Math.round(n * 1000)
  if (/(?:m|million|millones)$/.test(s)) return Math.round(n * 1_000_000)
  return Math.round(n)
}

/** Money spans with a role guess from the words around them (bounded, ≤ 3 per message). */
export function priceMentions(text) {
  const s = String(text ?? '')
  const out = []
  for (const m of s.matchAll(MONEY)) {
    const value = moneyValue(m[0])
    if (value == null || value < 5_000 || value > 50_000_000) continue
    const ctx = s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20)
    out.push({ span: m[0].trim().slice(0, 24), value, role: ASK_CUE.test(ctx) && !OFFER_CUE.test(ctx) ? 'seller_ask_candidate' : 'mentioned' })
    if (out.length >= 3) break
  }
  return out
}

const TIMELINE = /\b(?:within|in|under|less than|next|by|before|after)\s+(?:the\s+)?(?:\d{1,3}|a|one|two|three|four|six|few|couple(?: of)?)\s+(?:days?|weeks?|months?|years?)\b|\b(?:asap|as soon as possible|right away|immediately|quickly|this (?:week|month|year)|next (?:week|month|year)|end of (?:the )?(?:month|year)|by (?:january|february|march|april|may|june|july|august|september|october|november|december)|no rush|no hurry|not in a hurry|cuanto antes|lo antes posible|pronto)\b/gi
export function timelineMentions(text) {
  return [...String(text ?? '').matchAll(TIMELINE)].slice(0, 3).map((m) => m[0].slice(0, 40))
}

const OFFER_REQUEST = /what(?:'s| is| would(?: be)?| will(?: be)?| can)?\s+(?:your|the|you)?\s*(?:best\s+)?(?:cash\s+)?offer|what (?:would|will|can|could) you (?:offer|pay|give)|make (?:me )?an offer|send (?:me )?(?:an |your |the )?offer|how much (?:would|will|can|could|are) you (?:pay|give|offer|willing)|cu[aá]nto (?:me )?(?:ofrece|ofrecen|pagar[ií]an|dar[ií]an|pagan|dan)|h[aá]game una oferta/i
const POSITIVE = /\b(?:i(?:'m| am) interested|we(?:'re| are) interested|interested in selling|open to (?:selling|offers?|an offer)|(?:would|might) (?:consider|sell)|willing to sell|want to sell|looking to sell|ready to sell|thinking (?:about|of) selling|let'?s talk|call me|s[ií] me interesa|quiero vender|estoy interesad[oa])\b/i
const NEGATIVE = /\b(?:not interested|no interest|not (?:for sale|selling)|(?:don'?t|do not) want to sell|not looking to sell|no thanks?|no gracias|keep(?:ing)? (?:it|the (?:house|property))|already sold|sold it|not selling|no me interesa|no (?:lo )?vendo)\b/i
const NOT_OWNER = /\b(?:wrong (?:number|person)|not (?:the |an )?owner|(?:don'?t|do not|never) own(?:ed)?|not mine|isn'?t mine|no soy (?:el|la) due[nñ]o|n[uú]mero equivocado)\b/i
const OWNER = /\b(?:yes,? (?:i|we) (?:own|do)|i(?:'m| am) the owner|it'?s mine|(?:i|we) own (?:it|the|this)|soy (?:el|la) due[nñ]o)\b/i

/** Signals in ONE inbound message (the seller's words). */
export function readInbound(text) {
  const s = String(text ?? '')
  return {
    opt_out: optOutReading(s),
    offer_request: OFFER_REQUEST.test(s),
    positive: POSITIVE.test(s),
    negative: NEGATIVE.test(s),
    not_owner: NOT_OWNER.test(s),
    owner_confirmed: OWNER.test(s) && !NOT_OWNER.test(s),
    prices: priceMentions(s),
    timeline: timelineMentions(s),
    instruction_like: isInstructionLike(s),
  }
}

/**
 * The interest reading of a conversation from its INBOUND messages (chronological, the seller's words).
 * A label is never evidence: `label` only tells whether the pipeline SAYS interested, and a label
 * without supporting messages reads `label_only`.
 *   opted_out     a confirmed opt-out (recorded or read) — overrides everything
 *   possible_opt_out  a possible opt-out and nothing later contradicting it — treat as do-not-contact
 *   not_owner     the latest decisive message denies ownership / says wrong number
 *   negative      the latest decisive message declines
 *   interest      the latest decisive message asks for an offer, states a price ask, a timeline or interest
 *   label_only    no decisive message, but the pipeline label says interested
 *   no_evidence   none of the above
 * @param {Array<{ id: string, text: string|null, recorded_opt_out?: boolean }>} inbound oldest → newest
 * @param {{ labelSaysInterested?: boolean|null }} [o]
 */
export function interestReading(inbound, { labelSaysInterested = null } = {}) {
  const basis = []
  let decisive = null // { kind, at: index }
  let optOut = null
  let possible = null // { id, at: index }
  inbound.forEach((m, i) => {
    const r = readInbound(m.text)
    if (m.recorded_opt_out || r.opt_out.state === 'confirmed') optOut = m.id
    else if (r.opt_out.state === 'possible') possible = { id: m.id, at: i }
    const asks = r.prices.some((p) => p.role === 'seller_ask_candidate')
    const kind = r.not_owner ? 'not_owner'
      : r.negative && !r.offer_request ? 'negative'
        : r.offer_request || asks || r.positive || (r.timeline.length && (r.prices.length || r.owner_confirmed)) ? 'interest' : null
    if (!kind) return
    decisive = { kind, at: i }
    basis.push({ message_id: m.id, signal: kind, detail: [r.offer_request && 'offer_request', asks && 'price_ask_candidate', r.positive && 'interest_words', r.timeline.length > 0 && 'timeline', r.negative && 'decline_words', r.not_owner && 'ownership_denial'].filter(Boolean) })
  })
  // a possible opt-out stands unless the seller's LATER words are decisive (they then speak for themselves)
  const possibleStands = possible && (!decisive || possible.at >= decisive.at)
  const state = optOut ? 'opted_out' : possibleStands ? 'possible_opt_out' : decisive ? decisive.kind : labelSaysInterested ? 'label_only' : 'no_evidence'
  return {
    state,
    basis: basis.slice(-6),
    opt_out_message_id: optOut,
    possible_opt_out_message_id: possible?.id ?? null,
    label_says_interested: labelSaysInterested,
    rule: EVIDENCE_VERSION,
  }
}

const INTERESTED_LABEL = /interest|offer|negotiat|hot|warm|motivated|appointment|under_contract|contract/i
export const labelSaysInterested = (...labels) => {
  const xs = labels.filter((x) => typeof x === 'string' && x.trim())
  return xs.length ? xs.some((x) => INTERESTED_LABEL.test(x)) : null
}

// ── our own commitments (outbound text): "we will get back to you tomorrow" with no later outbound ──
const COMMIT = /\b(?:(?:we|i)(?:'ll| will| can| are going to| am going to)|let me|will)\s+(?:[a-z]+\s+(?:and\s+|&\s+)?){0,3}?(?:get back to you|call you|follow up|reach out|send (?:you )?(?:an? |the |our )?(?:offer|number|contract|details)|have (?:an? |the )?offer|text you|circle back|be in touch)\b[^.?!]{0,60}/i
const WHEN = [
  [/\b(?:today|tonight|this (?:afternoon|evening))\b/i, 0.5],
  [/\btomorrow|mañana\b/i, 1],
  [/\bin (?:a|one|1) (?:day|couple of hours)\b/i, 1],
  [/\bin (\d{1,2}|two|three|four|five) days?\b/i, null],
  [/\b(?:this|end of the) week\b|\bby (?:monday|tuesday|wednesday|thursday|friday)\b|\b(?:monday|tuesday|wednesday|thursday|friday)\b/i, 7],
  [/\bnext week\b/i, 10],
  [/\b(?:soon|shortly|asap|right away|in a bit)\b/i, 2],
]
const WORD_N = { two: 2, three: 3, four: 4, five: 5 }
/** A commitment in OUR outbound text, with a due date read from its words (no date words → 3 days). */
export function commitmentReading(text, sentAt, now) {
  const m = COMMIT.exec(String(text ?? ''))
  if (!m || !sentAt) return null
  const phrase = m[0].trim().slice(0, 80)
  let days = 3
  for (const [re, d] of WHEN) {
    const w = re.exec(phrase)
    if (w) { days = d ?? (Number(w[1]) || WORD_N[String(w[1]).toLowerCase()] || 3); break }
  }
  const due = new Date(Date.parse(sentAt) + days * 86_400_000)
  return { phrase, due_by: due.toISOString(), overdue: now.getTime() > due.getTime(), rule: EVIDENCE_VERSION }
}
