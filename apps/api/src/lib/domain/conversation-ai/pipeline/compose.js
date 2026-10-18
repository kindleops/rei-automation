// TEXT GENERATION (8.5.16): the model writes ORIGINAL text for a decided AI_GENERATED_REPLY,
// from the fact ledger (facts with source message ids, confidence, stated vs inferred) and
// playbook v1. Haiku by default; Sonnet only when measured complexity justifies it; spend
// caps checked before every call (and the model client's tracker reserves the worst case).
// The output is never trusted: playbook style + ledger + objective checks, one regeneration
// with the reasons, then HOLD. Nothing here sends; the model never sees a transport.
// rc-8.5.20: playbook v2 (owner persona rule: the thread's established persona, no invented
// backstory / credentials, never deny automation); v1 stays intact for its own records.
// rc-8.5.21: playbook v3 (configured company identity only; no inspected / funds / sent-email /
// unverified-website / no-contact claims). Every attempt is judged by the SHARED outbound
// validator (outbound-validator.js) — the same function the decision and R3 re-validation use.
import { COMPOSE_PROMPT_VERSION, PLAYBOOK_RULES, PLAYBOOK_VERSION } from '../playbook/v3/index.js'
import { detectSellerTone } from '../playbook/v1/tone.js'
import { maskText } from '../pii.js'
import { validateOutbound } from '../outbound-validator.js'
import { NO_COMPANY_IDENTITY } from '../company-identity.js'
import { checkSpend, measureComplexity } from './complexity.js'

export const COMPOSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['message'],
  properties: { message: { type: 'string', maxLength: 320 } },
})

const CATEGORY_TEXT = Object.freeze({
  conditional_interest_clarify: 'They said they will not do creative financing (or similar terms). Say plainly that this would be a straightforward purchase with no creative financing. Do not mention cash, funds, speed or any amount.',
  identity_answer: 'They asked who we are. Answer truthfully and briefly from PERSONA and COMPANY only.',
})

const OBJECTIVE_TEXT = Object.freeze({
  ownership: 'confirm they own the property',
  interest: 'ask whether they would consider selling',
  asking_price: 'ask what price they have in mind',
  condition: 'ask about the condition / repairs',
  close_no_question: 'acknowledge politely and close with NO question, in at most 2 short sentences; never say or imply we will not contact them again',
  none: 'respond without a question',
})

// blind-eval S1: what the writer may say about each property (the validator HARD-blocks the rest)
export function propertyRuleLines(ledger) {
  const po = ledger?.property?.ownership
  if (!po) return []
  const label = (pid) => po.labels?.[pid] || null
  const by = Object.entries(po.by_property || {})
  const confirmed = by.filter(([, v]) => v.state === 'confirmed').map(([pid]) => label(pid)).filter(Boolean)
  const never = by.filter(([, v]) => ['denied', 'declined', 'conflict'].includes(v.state)).map(([pid]) => label(pid)).filter(Boolean)
  const lines = ['PROPERTY RULE: name a property only if they CONFIRMED they own it; never thank them for confirming anything they did not confirm in a message.']
  lines.push(`- confirmed (you may name it): ${confirmed.length ? confirmed.join('; ') : 'none'}`)
  if (never.length) lines.push(`- NEVER mention or ask about: ${never.join('; ')}`)
  if (po.thread_hold) lines.push('- their last ownership answer did not say which property it was about: name no property')
  return lines
}

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

export function buildComposePrompt({ ledger, inboundText, category, objective, tone, maskOpts = {}, messages = [], followupScheduled = null, avoidOpening = null, establishedPersona = null, companyIdentity = NO_COMPANY_IDENTITY }) {
  const system = [
    'You write ONE outbound SMS reply for a local home buyer texting a property owner. Call the tool exactly once with {"message": "..."}.',
    'RULES (code enforces every one; a violation is discarded):',
    ...PLAYBOOK_RULES.map((r) => `- ${r}`),
  ].join('\n')
  const asked = Object.values(ledger?.questions || {}).filter((q) => q.asked_count || q.answered).map((q) => `${q.kind}: asked ${q.asked_count}, answered ${q.answered}`)
  const user = [
    `SELLER'S LATEST MESSAGE: ${maskText(inboundText, maskOpts)}`,
    `SELLER REGISTER: ${tone}`,
    `PERSONA: ${establishedPersona ? `${establishedPersona} (the name this seller already knows; use it only if a name is needed)` : 'none on record: give no name'}`,
    `COMPANY: ${companyIdentity?.configured ? `${companyIdentity.name}${companyIdentity.website ? ` (website ${companyIdentity.website})` : ' (no website: never give one)'}` : 'none: name no company, give no website, never say you are or are not with a company'}`,
    'RECENT THREAD (oldest first):',
    ...messages.slice(-6).map((m) => `${m.from}: ${maskText(m.text, maskOpts)}`),
    'FACTS ALREADY KNOWN (never ask for these again; inferred is not confirmed):',
    ...(factLines(ledger).length ? factLines(ledger) : ['- none']),
    `QUESTIONS SO FAR: ${asked.join('; ') || 'none'}`,
    ...propertyRuleLines(ledger),
    `REPLY TYPE: ${category}. OBJECTIVE: ${OBJECTIVE_TEXT[objective] || OBJECTIVE_TEXT.none}.`,
    ...(CATEGORY_TEXT[category] ? [CATEGORY_TEXT[category]] : []),
    'First acknowledge what they said in plain words. At most one question, and only for the objective (one thing per question, never "X, and Y?"). Keep it to 1 or 2 sentences. Never invent a next step such as a visit or viewing.',
    ...(followupScheduled ? [`FOLLOW-UP: a check-in is scheduled in about ${followupScheduled.days || 30} days. You do not have to mention it (usually don't), but NEVER promise to stop contacting them ("won't bother you again", "leave you be", "take you off our list", "won't reach out again" are all false).`] : []),
    'Never claim anything about our inventory, other properties, buyers or plans.',
    'Only repeat what the seller actually said. Never claim they were specially chosen or that this is not a mass message.',
    `OPENING: ${openingHintFor(inboundText)}. Start differently from our previous text${avoidOpening ? ` (it began "${avoidOpening}")` : ''}; do not open with a stock phrase ("Got it, thanks", "Makes sense, thanks", "Understood, thanks for letting me know", "Fair question", "Quick question"), and do not say "feel free to reach out".`,
    'Write in English only.',
  ].join('\n')
  return { system, user, prompt_version: COMPOSE_PROMPT_VERSION }
}

export { unsupportedAttribution, closeAndAttributionReasons } from '../outbound-validator.js'


/**
 * Every CONTENT check a composed draft must pass: the shared outbound validator
 * (outbound-validator.js#validateOutbound), the one function every caller uses. Pure.
 * @returns {string[]} reasons (empty = passes)
 */
export function checkComposedText(text, { ledger, objective, category, inboundIntent = null, personaPolicy, establishedPersona = null, followupScheduled = null, previousOutbound = null, companyIdentity = NO_COMPANY_IDENTITY, knownNumbers = null, firstName = null, otherNames = [] }) {
  return validateOutbound(text, { ledger, objective, category, inboundIntent, personaPolicy, establishedPersona, followupScheduled, previousOutbound, companyIdentity, knownNumbers: knownNumbers ?? [], firstName, otherNames }).content_reasons
}

/**
 * @param {object} a
 * @param {{ decide: Function }} a.modelClient   createConversationModelClient()
 * @param {{ spentTodayUsd: () => number, perMessageMaxUsd: number, dailyMaxUsd: number, estimateUsd: (route: string) => number }} a.spend
 */
export async function composeReply({ ledger, inboundText, category, objective, modelClient, spend, messages = [], maskOpts = {}, threadLength = 0, inboundIntent = null, personaPolicy, establishedPersona = null, followupScheduled = null, companyIdentity = NO_COMPANY_IDENTITY, firstName = null, otherNames = [] }) {
  const knownNumbers = [...new Set(messages.flatMap((m) => String(m.text || '').match(/[0-9]{3,}/g) || []))]
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
    const p = buildComposePrompt({ ledger, inboundText, category, objective, tone: abusive ? 'frustrated (do not mirror any insult)' : tone, maskOpts, messages, followupScheduled, establishedPersona, companyIdentity, avoidOpening: previousOutbound ? maskText(previousOutbound, maskOpts).split(/\s+/).slice(0, 3).join(' ') : null })
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
    const reasons = text ? checkComposedText(text, { ledger, objective, category, inboundIntent, personaPolicy, establishedPersona, followupScheduled, previousOutbound, companyIdentity, knownNumbers, firstName, otherNames }) : ['empty_composition']
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
