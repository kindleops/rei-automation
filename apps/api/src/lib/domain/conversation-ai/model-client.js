// Conversation Engine 2.0 — the model seam (SHADOW ONLY).
//
// This module never constructs a provider and never reads a key: the provider
// (lib/ai/anthropic-provider.js shape: listModels(), createMessage(params)) and
// the spend tracker are INJECTED. Model ids are never hard-coded: they are
// resolved through the research agent's resolver (GET /v1/models, priced,
// line-ceilinged) and priced with its table (worstCaseUsd / actualUsd).
//
// Every call is: payload masked + residual-checked → route resolved → worst case
// priced → tracker.reserve (refused past the cap) → ONE streamed call, forced
// tool (structured output) → tracker.settle(actual from usage) → raw tool input.
import { actualUsd, createModelResolver, worstCaseUsd } from '../../agent/research/models.js'
import { residualContact } from '../../agent/research/pii.js'

export const DECISION_TOOL_NAME = 'record_conversation_decision'

export class ModelCallRefused extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail }
}

/**
 * In-memory spend tracker with a hard cap (USD). A reservation is the worst case;
 * settle() replaces it with the provider-reported actual. Unsettled reservations
 * (a call that died) stay counted — never released on a guess.
 */
export function createSpendTracker({ capUsd, spentUsd = 0, onSettle = null } = {}) {
  let committed = Number(spentUsd) || 0
  let reserved = 0
  const cap = Number(capUsd)
  if (!(cap > 0)) throw new Error('SPEND_CAP_REQUIRED')
  return {
    reserve(worst /* , model */) {
      const w = Number(worst)
      if (!(w > 0) || !Number.isFinite(w)) throw new ModelCallRefused('UNPRICED_CALL')
      if (committed + reserved + w > cap) throw new ModelCallRefused('SPEND_CAP_REACHED', { committed, reserved, worst: w, cap })
      reserved += w
      return { worst: w }
    },
    settle(tok, actual /* , usage */) {
      reserved = Math.max(0, reserved - tok.worst)
      committed += actual == null ? tok.worst : Number(actual)
      onSettle?.({ committed, actual: actual == null ? tok.worst : Number(actual) })
    },
    abandon(tok) { reserved = Math.max(0, reserved - tok.worst); committed += tok.worst },
    release(tok) { reserved = Math.max(0, reserved - tok.worst) },
    snapshot: () => ({ committed, reserved, cap, remaining: Math.max(0, cap - committed - reserved) }),
  }
}

/**
 * @param {{ provider: { listModels: Function, createMessage: Function }, tracker: ReturnType<typeof createSpendTracker>, env?: object, now?: () => number, timeoutMs?: number }} deps
 */
export function createConversationModelClient({ provider, tracker, env = {}, now = () => Date.now(), timeoutMs = 45_000 } = {}) {
  if (!provider || typeof provider.createMessage !== 'function') throw new Error('PROVIDER_REQUIRED')
  if (!tracker) throw new Error('TRACKER_REQUIRED')
  const resolver = createModelResolver({ provider, env })

  async function resolveModel(route) {
    const r = await resolver.resolve()
    const pick = route === 'escalation' ? r.escalation : r.default
    if (!r.ok && route === 'default') throw new ModelCallRefused(r.code || 'MODELS_UNRESOLVED')
    if (!pick?.id) throw new ModelCallRefused('ROUTE_UNRESOLVED', { route })
    return pick.id
  }

  /**
   * One structured decision call.
   * @returns {Promise<{ input: object|null, model: string, usage: object, usd: number|null, latency_ms: number, stop_reason: string|null }>}
   */
  async function decide({ route = 'default', system, user, inputSchema, maxTokens = null }) {
    // Sonnet 5.5 refuses a forced tool_choice (400 "type tool/any not supported"):
    // the escalation route asks for the tool (auto) and a missing tool call fails closed.
    const forced = route !== 'escalation'
    const max = maxTokens ?? (route === 'escalation' ? 2400 : 1400)
    const userText = typeof user === 'string' ? user : JSON.stringify(user)
    if (residualContact(userText) || residualContact(system)) throw new ModelCallRefused('RESIDUAL_PII')
    const model = await resolveModel(route)
    const params = {
      model,
      max_tokens: max,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: [{ name: DECISION_TOOL_NAME, description: 'Record the structured conversation decision. Always call this exactly once.', input_schema: inputSchema }],
      tool_choice: forced ? { type: 'tool', name: DECISION_TOOL_NAME } : { type: 'auto' },
      messages: [{ role: 'user', content: userText }],
    }
    // a token is never shorter than one UTF-8 byte ⇒ bytes bound the prompt
    const promptBound = Buffer.byteLength(JSON.stringify({ s: params.system, t: params.tools, m: params.messages }), 'utf8')
    const worst = worstCaseUsd(model, { promptTokensBound: promptBound, maxTokens: max })
    if (worst == null) throw new ModelCallRefused('UNPRICED_MODEL', { model })
    // a tracker refusal propagates (the runtime adapter turns budget refusal into a job stop)
    const tok = await tracker.reserve(worst, model)
    const t0 = now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort({ code: 'MODEL_TIMEOUT' }), timeoutMs)
    let msg
    try {
      msg = await provider.createMessage(params, { signal: ctl.signal })
    } catch (err) {
      // the provider refused before any work (400/401/403/404/429): nothing was billed
      if (err?.billed === 'no' && typeof tracker.release === 'function') await tracker.release(tok)
      else await tracker.abandon(tok)
      throw new ModelCallRefused(err?.code || 'PROVIDER_ERROR', { model, billed: err?.billed ?? 'unknown' })
    } finally {
      clearTimeout(timer)
    }
    const cost = actualUsd(model, msg?.usage || {})
    await tracker.settle(tok, cost ? cost.usd : null, msg?.usage || null)
    const block = Array.isArray(msg?.content) ? msg.content.find((b) => b?.type === 'tool_use' && b?.name === DECISION_TOOL_NAME) : null
    return {
      input: block?.input && typeof block.input === 'object' ? block.input : null,
      model,
      usage: { input_tokens: msg?.usage?.input_tokens ?? 0, output_tokens: msg?.usage?.output_tokens ?? 0, cache_read_input_tokens: msg?.usage?.cache_read_input_tokens ?? 0, cache_creation_input_tokens: msg?.usage?.cache_creation_input_tokens ?? 0 },
      usd: cost ? cost.usd : worst,
      usd_is_actual: Boolean(cost),
      latency_ms: now() - t0,
      stop_reason: msg?.stop_reason ?? null,
    }
  }

  return { decide, resolveModel, peekModels: () => resolver.peek() }
}
