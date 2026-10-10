// Model gateway — the ONLY code allowed to call a model provider
// (architecture §0.3, §15.4). S1: it REFUSES EVERY CALL.
//
// This module deliberately imports no provider SDK, no HTTP client and never
// touches fetch/network. A static test asserts the import graph of
// lib/agent/** contains no provider SDK ('openai', '@anthropic-ai/*', 'groq',
// axios, node:http(s)) and that calling the gateway performs no network I/O.
//
// Refusal order (each is a hard stop; all are true in S1):
//   0 AGENT_DISABLED           AGENT_ENABLED kill switch off (Gate B; default off in prod)
//   1 MODELS_DISABLED          models_approved=false (owner)
//   2 EXTERNAL_HOLD            agent_external_hold on (owner hold)
//   3 OPUS_DISABLED            any claude-opus-* route while opus_enabled=false
//   4 PROCESSOR_NOT_AUTHORIZED no agent.ai_processor row allows the data class (O1)
//   5 MODE_OFF                 AGENT_MAX_MODE / agent_mode is off
//   6 IDENTITY_REQUIRED        no verified named user on the request (Gate B, D1)
//   7 SPEND_* / TOKEN_*        per-user / global daily caps ($0 until the owner sets them)
// A future S5 implementation keeps this order and adds: payload whitelist →
// residual-PII gate → ledger.reserve → provider call → ledger.settle.
import { MODEL_SWITCHES, isAgentEnabled, resolveAgentMode } from '../config/agent-config.js'
import { checkSpend, resolveSpendCaps } from '../budget/spend-guard.js'

export const GATEWAY_HAS_PROVIDER_CLIENT = false

/** O1 processor registry (agent.ai_processor). Empty + disabled in S1. */
export const DEFAULT_AI_PROCESSORS = Object.freeze([
  Object.freeze({ processor: 'anthropic', enabled: false, terms_reviewed_at: null, allowed_data_classes: Object.freeze([]) }),
])

/**
 * spendUsage(user_id) → today's committed { user_usd, global_usd, user_tokens, global_tokens }
 * (the ledger's view); absent ⇒ zero usage. Caps come from the env (spend-guard.js).
 */
export function createModelGateway({ switches = MODEL_SWITCHES, processors = DEFAULT_AI_PROCESSORS, env = process.env, systemControlMode = null, onRefusal = null, spendUsage = null } = {}) {
  // Switches are read from the frozen S1 constant unless a test injects a copy;
  // even an injected models_approved=true cannot reach a provider: there is
  // no provider client in this module (GATEWAY_HAS_PROVIDER_CLIENT=false).
  function refusal(code, request) {
    const result = {
      ok: false,
      refused: true,
      code,
      route: request?.route ?? null,
      model: request?.model ?? null,
      reserved_usd: 0,
      network: false,
    }
    if (typeof onRefusal === 'function') onRefusal(result)
    return result
  }

  /**
   * @param {{ route: string, model?: string, data_classes?: string[], messages?: unknown }} request
   * @returns {Promise<{ ok: false, refused: true, code: string }>}
   */
  async function call(request = {}) {
    if (!isAgentEnabled(env)) return refusal('AGENT_DISABLED', request)
    if (!switches.models_approved) return refusal('MODELS_DISABLED', request)
    if (switches.external_hold) return refusal('EXTERNAL_HOLD', request)
    if (/opus/i.test(String(request.model || '')) && !switches.opus_enabled) return refusal('OPUS_DISABLED', request)
    const processor = processors.find((p) => p.processor === 'anthropic')
    const classes = Array.isArray(request.data_classes) ? request.data_classes : []
    if (!processor?.enabled || classes.some((c) => !processor.allowed_data_classes.includes(c))) {
      return refusal('PROCESSOR_NOT_AUTHORIZED', request)
    }
    if (resolveAgentMode({ env, systemControlMode }) === 'off') return refusal('MODE_OFF', request)
    const actor = request.identity || null
    if (!(actor && actor.verified === true && actor.named === true && actor.user_id)) return refusal('IDENTITY_REQUIRED', request)
    const usage = typeof spendUsage === 'function' ? spendUsage(actor.user_id) : { user_usd: 0, global_usd: 0, user_tokens: 0, global_tokens: 0 }
    const worstTokens = Math.max(0, Number(request.max_input_tokens || 0)) + Math.max(0, Number(request.max_tokens || 0))
    // a model call is never structurally free: with no worst-case estimate it is priced as unbounded
    const worstUsd = Number(request.worst_case_usd) > 0 ? Number(request.worst_case_usd) : Number.POSITIVE_INFINITY
    const spend = checkSpend({ caps: resolveSpendCaps(env), actor, worst_usd: worstUsd, worst_tokens: worstTokens || 1, usage })
    if (!spend.ok) return refusal(spend.code, request)
    // No provider client exists in S1. Reaching here is still a refusal.
    return refusal('NO_PROVIDER_CLIENT', request)
  }

  return { call, stream: call, hasProviderClient: GATEWAY_HAS_PROVIDER_CLIENT }
}
