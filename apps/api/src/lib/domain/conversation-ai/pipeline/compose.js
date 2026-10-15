// TEXT GENERATION (8.5.16): the model writes ORIGINAL text for a decided AI_GENERATED_REPLY,
// from the fact ledger (facts with source message ids, confidence, stated vs inferred) and
// playbook v1. Haiku by default; Sonnet only when measured complexity justifies it; spend
// caps checked before every call (and the model client's tracker reserves the worst case).
// The output is never trusted: playbook style + ledger + objective checks, one regeneration
// with the reasons, then HOLD. Nothing here sends; the model never sees a transport.
import { COMPOSE_PROMPT_VERSION, PLAYBOOK_RULES, PLAYBOOK_VERSION } from '../playbook/v1/index.js'
import { validatePlaybookStyle, sentenceCount } from '../playbook/v1/style-validator.js'
import { detectSellerTone } from '../playbook/v1/tone.js'
import { validateProposedMessage } from '../fact-ledger.js'
import { questionKindOf } from '../questions.js'
import { maskText } from '../pii.js'
import { checkSpend, measureComplexity } from './complexity.js'

export const COMPOSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['message'],
  properties: { message: { type: 'string', maxLength: 320 } },
})

const OBJECTIVE_TEXT = Object.freeze({
  ownership: 'confirm they own the property',
  interest: 'ask whether they would consider selling',
  asking_price: 'ask what price they have in mind',
  condition: 'ask about the condition / repairs',
  close_no_question: 'acknowledge politely and close with NO question, in at most 2 short sentences; never say or imply we will not contact them again',
  none: 'respond without a question',
})

function factLines(ledger) {
  return Object.entries(ledger?.facts || {}).map(([k, f]) => {
    const v = k === 'asking_price' && f.value?.amount ? `stated a price (amount on record, never repeat it)` : typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)
    return `- ${k}: ${v} [${f.basis || 'stated'}, confidence ${f.confidence ?? 'n/a'}, source ${(f.source_message_ids || []).join(',')}]`
  })
}

// rotating opening styles (picked by a hash of the inbound) so replies across threads do not
// all open the same way; the validator separately forbids the same opening twice in a row
export const OPENING_HINTS = Object.freeze([
  'open by naming the specific thing they told you, in a few plain words',
  'open by answering their point directly, with no acknowledgement phrase',
  'open with a brief thank-you in your own words that mentions what they said',
  'open with their first name if you have it, then the point',
  'open with one short reaction to their reason, in your own words',
])
export function openingHintFor(seed) {
  let h = 0
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return OPENING_HINTS[h % OPENING_HINTS.length]
}

export function buildComposePrompt({ ledger, inboundText, category, objective, tone, maskOpts = {}, messages = [], followupScheduled = null, avoidOpening = null }) {
  const system = [
    'You write ONE outbound SMS reply for a local home buyer texting a property owner. Call the tool exactly once with {"message": "..."}.',
    'RULES (code enforces every one; a violation is discarded):',
    ...PLAYBOOK_RULES.map((r) => `- ${r}`),
  ].join('\n')
  const asked = Object.values(ledger?.questions || {}).filter((q) => q.asked_count || q.answered).map((q) => `${q.kind}: asked ${q.asked_count}, answered ${q.answered}`)
  const user = [
    `SELLER'S LATEST MESSAGE: ${maskText(inboundText, maskOpts)}`,
    `SELLER REGISTER: ${tone}`,
    'RECENT THREAD (oldest first):',
    ...messages.slice(-6).map((m) => `${m.from}: ${maskText(m.text, maskOpts)}`),
    'FACTS ALREADY KNOWN (never ask for these again; inferred is not confirmed):',
    ...(factLines(ledger).length ? factLines(ledger) : ['- none']),
    `QUESTIONS SO FAR: ${asked.join('; ') || 'none'}`,
    `REPLY TYPE: ${category}. OBJECTIVE: ${OBJECTIVE_TEXT[objective] || OBJECTIVE_TEXT.none}.`,
    'First acknowledge what they said in plain words. At most one question, and only for the objective (one thing per question, never "X, and Y?"). Keep it to 1 or 2 sentences. Never invent a next step such as a visit or viewing.',
    ...(followupScheduled ? [`FOLLOW-UP: a check-in is scheduled in about ${followupScheduled.days || 30} days. You do not have to mention it (usually don't), but NEVER promise to stop contacting them ("won't bother you again", "leave you be", "take you off our list", "won't reach out again" are all false).`] : []),
    'Never claim anything about our inventory, other properties, buyers or plans.',
    'Only repeat what the seller actually said. Never claim they were specially chosen or that this is not a mass message.',
    `OPENING: ${openingHintFor(inboundText)}. Start differently from our previous text${avoidOpening ? ` (it began "${avoidOpening}")` : ''}; do not open with a stock phrase ("Got it, thanks", "Makes sense, thanks", "Understood, thanks for letting me know", "Fair question", "Quick question"), and do not say "feel free to reach out".`,
    'Write in English only.',
  ].join('\n')
  return { system, user, prompt_version: COMPOSE_PROMPT_VERSION }
}

// a promise of no further contact is false whenever a follow-up is scheduled (disinterest = 30-day follow-up)
const FALSE_NO_CONTACT_RE = /\b(?:(?:won'?t|wont|will\s+not|never|not\s+going\s+to)\s+(?:bother|contact|text|message|call|trouble|reach\s+out(?:\s+to)?|be\s+(?:bothering|contacting|texting|reaching\s+out))(?:\s+you)?(?:\s+(?:again|anymore|any\s+more|further))?|leave\s+you\s+(?:be|alone)|leave\s+it\s+(?:alone|there)|take\s+you\s+off\s+(?:our|my|the)\s+list|(?:remove|removing)\s+(?:you|your\s+number)|last\s+(?:time|message|text)\s+(?:you'?ll|we|i)|won'?t\s+(?:take|waste)\s+(?:up\s+)?(?:any\s+)?more\s+of\s+your\s+time|won'?t\s+hear\s+from\s+(?:us|me)\s+again|close\s+(?:this|it)\s+out|close\s+the\s+loop|done\s+(?:reaching|texting)\s+out|leave\s+it\s+(?:with|to)\s+(?:them|your\s+(?:agent|realtor)|the\s+(?:agent|realtor))|won'?t\s+(?:push|pursue|follow\s+up))\b/i
// "since you're confident you own it" after "I don't know": an attribution must be a STATED fact
const ATTRIBUTION_RE = /\b(?:since\s+you(?:'re|\s+are|'ve|\s+have)?|you\s+(?:said|mentioned|told\s+(?:me|us)|confirmed|noted|indicated)|as\s+you\s+(?:said|mentioned|noted)|you(?:'re|\s+are)\s+(?:confident|sure|certain))\b([^.?!,;]{0,80})/i
const ATTRIBUTION_TOPICS = [
  ['ownership', /\b(?:own|owner|yours|title)\b/i, (v) => ['confirmed', 'representative'].includes(v)],
  ['asking_price', /\b(?:price|number|asking|\$|[0-9]+k)\b/i, (v) => v != null],
  ['condition', /\b(?:repair|roof|condition|work|fix|hvac|foundation|update)\w*/i, (v) => v != null],
  ['timeline', /\b(?:close|closing|timeline|move|soon|month|week|november|december|spring|summer|fall|winter)\b/i, (v) => v != null],
  ['seller_interest', /\b(?:sell|selling|interested|open\s+to)\b/i, (v) => v != null],
]
export function unsupportedAttribution(text, ledger) {
  const m = ATTRIBUTION_RE.exec(String(text || ''))
  if (!m) return null
  const clause = `${m[0]}`
  const topics = ATTRIBUTION_TOPICS.filter(([, re]) => re.test(clause))
  if (!topics.length) return 'unsupported_attribution'
  for (const [key, , ok] of topics) {
    const f = ledger?.facts?.[key]
    if (!f || f.basis === 'inferred' || !ok(f.value)) return `unsupported_attribution:${key}`
  }
  return null
}

/** The send-side subset (R3 re-checks it on the final text): false no-contact promise, close length, attribution. */
export function closeAndAttributionReasons(text, { ledger, category, followupScheduled = null }) {
  const r = []
  if ((followupScheduled || category === 'not_interested_close') && FALSE_NO_CONTACT_RE.test(text)) r.push('close:false_no_contact_promise_with_followup_scheduled')
  if (category === 'not_interested_close' && sentenceCount(text) > 2) r.push('close:more_than_two_sentences')
  const attr = unsupportedAttribution(text, ledger)
  if (attr) r.push(`ledger:${attr}`)
  return r
}

const openingOf = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().split(/\s+/).slice(0, 3).join(' ')

/** Every check a composed draft must pass (pure). */
export function checkComposedText(text, { ledger, objective, category, inboundIntent = null, personaPolicy, establishedPersona = null, followupScheduled = null, previousOutbound = null }) {
  const reasons = [...validatePlaybookStyle(text, { personaPolicy, establishedPersona }).reasons]
  if ((followupScheduled || category === 'not_interested_close') && FALSE_NO_CONTACT_RE.test(text)) reasons.push('close:false_no_contact_promise_with_followup_scheduled')
  if (category === 'not_interested_close' && sentenceCount(text) > 2) reasons.push('close:more_than_two_sentences')
  const attr = unsupportedAttribution(text, ledger)
  if (attr) reasons.push(`ledger:${attr}`)
  if (previousOutbound && openingOf(previousOutbound) && openingOf(previousOutbound) === openingOf(text)) reasons.push('style:repeated_opening')
  const qn = (String(text).match(/\?/g) || []).length
  if (qn) {
    for (const r of validateProposedMessage(ledger, { text, inboundIntent }).reasons) reasons.push(`ledger:${r}`)
    const kind = questionKindOf({ body: text })
    if (objective && ['ownership', 'interest', 'asking_price', 'condition'].includes(objective) && kind !== objective) reasons.push(`off_objective:${kind}`)
    if (['close_no_question', 'none'].includes(objective) || category === 'not_interested_close') reasons.push('question_not_allowed_for_objective')
  }
  return [...new Set(reasons)]
}

/**
 * @param {object} a
 * @param {{ decide: Function }} a.modelClient   createConversationModelClient()
 * @param {{ spentTodayUsd: () => number, perMessageMaxUsd: number, dailyMaxUsd: number, estimateUsd: (route: string) => number }} a.spend
 */
export async function composeReply({ ledger, inboundText, category, objective, modelClient, spend, messages = [], maskOpts = {}, threadLength = 0, inboundIntent = null, personaPolicy, establishedPersona = null, followupScheduled = null }) {
  const previousOutbound = [...messages].reverse().find((x) => x.from === 'us')?.text || null
  if (!modelClient?.decide) return { ok: false, reason: 'model_unavailable', attempts: [] }
  const { tone, abusive } = detectSellerTone(inboundText)
  const complexity = measureComplexity({ inboundText, ledger, threadLength })
  const attempts = []
  let feedback = null
  for (let i = 0; i < 2; i += 1) {
    const route = complexity.route
    const est = spend?.estimateUsd ? spend.estimateUsd(route) : null
    const cap = checkSpend({ estimateUsd: est, spentTodayUsd: spend?.spentTodayUsd ? spend.spentTodayUsd() : null, perMessageMaxUsd: spend?.perMessageMaxUsd, dailyMaxUsd: spend?.dailyMaxUsd })
    if (!cap.allowed) return { ok: false, reason: cap.reason, attempts, complexity }
    const p = buildComposePrompt({ ledger, inboundText, category, objective, tone: abusive ? 'frustrated (do not mirror any insult)' : tone, maskOpts, messages, followupScheduled, avoidOpening: previousOutbound ? maskText(previousOutbound, maskOpts).split(/\s+/).slice(0, 3).join(' ') : null })
    const user = feedback ? `${p.user}\nYOUR PREVIOUS DRAFT WAS REJECTED FOR: ${feedback.join(', ')}. Write a new one that fixes every point.` : p.user
    let r
    try {
      r = await modelClient.decide({ route, system: p.system, user, inputSchema: COMPOSE_SCHEMA, maxTokens: 300 })
    } catch (err) {
      if (err?.abortJob === true) throw err
      attempts.push({ route, error: err?.code || 'MODEL_CALL_FAILED' })
      return { ok: false, reason: err?.code || 'model_call_failed', attempts, complexity }
    }
    const text = typeof r?.input?.message === 'string' ? r.input.message.replace(/\s+/g, ' ').trim() : ''
    const reasons = text ? checkComposedText(text, { ledger, objective, category, inboundIntent, personaPolicy, establishedPersona, followupScheduled, previousOutbound }) : ['empty_composition']
    attempts.push({ route, model: r?.model || null, usd: r?.usd ?? null, usage: r?.usage || null, reasons })
    if (!reasons.length) {
      const usd = attempts.reduce((s, a) => s + (Number(a.usd) || 0), 0)
      const usage = attempts.reduce((u, a) => ({ input_tokens: u.input_tokens + (a.usage?.input_tokens || 0), output_tokens: u.output_tokens + (a.usage?.output_tokens || 0) }), { input_tokens: 0, output_tokens: 0 })
      return { ok: true, text, model: r.model, route, usd, usage, attempts, complexity, tone, playbook_version: PLAYBOOK_VERSION, prompt_version: p.prompt_version }
    }
    feedback = reasons
  }
  return { ok: false, reason: 'composition_rejected', attempts, complexity }
}
