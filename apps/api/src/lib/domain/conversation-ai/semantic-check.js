// Optional cheap SEMANTIC duplicate / relevance check for a draft (Haiku route).
// It can only ADD rejection reasons; it never approves anything on its own.
// Input is already masked (context.model texts).

export const SEMANTIC_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['duplicate', 'already_answered', 'irrelevant', 'reason'],
  properties: {
    duplicate: { type: 'boolean', description: 'the draft asks something we already asked in prior_questions (same meaning, any wording)' },
    already_answered: { type: 'boolean', description: 'the draft asks for something the seller already told us (facts or their messages)' },
    irrelevant: { type: 'boolean', description: 'the draft ignores what the seller just said or asked' },
    reason: { type: 'string', maxLength: 160 },
  },
})

const SYSTEM = 'You check one draft SMS reply against the conversation. Answer strictly by calling the tool. duplicate = it repeats a question we already asked (same meaning). already_answered = it asks for information the seller already gave. irrelevant = it does not respond to the seller\'s latest message. A draft with no question is never a duplicate. Policy: we never quote prices by text, so a reply that acknowledges an offer request without a number and asks the next missing fact (e.g. condition, or ownership when it is not yet confirmed) IS relevant. A reply that answers who we are / why we are texting and then asks the next stage question IS relevant. prior_questions lists only questions the seller already ANSWERED or deflected; re-asking a question that is not in that list is never a duplicate.'

export function createSemanticCheck(modelClient) {
  return async function semanticCheck({ draft, prior_questions, facts, inbound }) {
    const r = await modelClient.decide({ route: 'default', system: SYSTEM, user: JSON.stringify({ draft, prior_questions, facts, latest_seller_message: inbound }), inputSchema: SEMANTIC_SCHEMA, maxTokens: 200 })
    const x = r.input || {}
    return {
      duplicate: x.duplicate === true || x.already_answered === true,
      irrelevant: x.irrelevant === true,
      reason: typeof x.reason === 'string' ? x.reason.slice(0, 160) : null,
      call: { model: r.model, usd: r.usd, latency_ms: r.latency_ms, usage: r.usage, valid: Boolean(r.input) },
    }
  }
}
