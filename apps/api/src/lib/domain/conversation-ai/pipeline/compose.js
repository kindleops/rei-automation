// TEXT GENERATION (8.5.16): the model writes ORIGINAL text for a decided AI_GENERATED_REPLY,
// from the fact ledger (facts with source message ids, confidence, stated vs inferred) and
// playbook v1. Haiku by default; Sonnet only when measured complexity justifies it; spend
// caps checked before every call (and the model client's tracker reserves the worst case).
// The output is never trusted: playbook style + ledger + objective checks, one regeneration
// with the reasons, then HOLD. Nothing here sends; the model never sees a transport.
import { COMPOSE_PROMPT_VERSION, PLAYBOOK_RULES, PLAYBOOK_VERSION } from '../playbook/v1/index.js'
import { validatePlaybookStyle } from '../playbook/v1/style-validator.js'
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
  close_no_question: 'close politely with NO question (they are not interested; we will check back later)',
  none: 'respond without a question',
})

function factLines(ledger) {
  return Object.entries(ledger?.facts || {}).map(([k, f]) => {
    const v = k === 'asking_price' && f.value?.amount ? `stated a price (amount on record, never repeat it)` : typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)
    return `- ${k}: ${v} [${f.basis || 'stated'}, confidence ${f.confidence ?? 'n/a'}, source ${(f.source_message_ids || []).join(',')}]`
  })
}

export function buildComposePrompt({ ledger, inboundText, category, objective, tone, maskOpts = {}, messages = [] }) {
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
    'First acknowledge what they said in plain words. At most one question, and only for the objective.',
  ].join('\n')
  return { system, user, prompt_version: COMPOSE_PROMPT_VERSION }
}

/** Every check a composed draft must pass (pure). */
export function checkComposedText(text, { ledger, objective, category, inboundIntent = null, personaPolicy, establishedPersona = null }) {
  const reasons = [...validatePlaybookStyle(text, { personaPolicy, establishedPersona }).reasons]
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
export async function composeReply({ ledger, inboundText, category, objective, modelClient, spend, messages = [], maskOpts = {}, threadLength = 0, inboundIntent = null, personaPolicy, establishedPersona = null }) {
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
    const p = buildComposePrompt({ ledger, inboundText, category, objective, tone: abusive ? 'frustrated (do not mirror any insult)' : tone, maskOpts, messages })
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
    const reasons = text ? checkComposedText(text, { ledger, objective, category, inboundIntent, personaPolicy, establishedPersona }) : ['empty_composition']
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
