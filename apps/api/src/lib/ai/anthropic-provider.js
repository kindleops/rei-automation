// THE ONLY model-provider client in apps/api (read-only research agent, owner GO 10-10).
//
// Lives outside lib/agent on purpose: lib/agent never imports a provider SDK and
// never reads a provider key (static test). The research gateway receives this
// object by injection and is the only caller.
//
// Key: AGENT_ANTHROPIC_API_KEY (a dedicated name, so no other code path that
// might look for ANTHROPIC_API_KEY ever gains a key in production). Outside
// production only, ANTHROPIC_API_KEY is accepted as a local-dev fallback.
// The key is never logged, returned, or placed in an error message.
//
// Retries are OFF (maxRetries: 0): every provider attempt must be its own spend
// reservation, so a retry is a new, separately reserved call — never a hidden one.
import Anthropic from '@anthropic-ai/sdk'

export const PROVIDER_KEY_ENV = 'AGENT_ANTHROPIC_API_KEY'

function isProduction(env) {
  return String(env?.NODE_ENV ?? '').trim() === 'production' || String(env?.VERCEL_ENV ?? '').trim() === 'production'
}

export function providerKeyFrom(env = process.env) {
  const k = String(env?.[PROVIDER_KEY_ENV] ?? '').trim()
  if (k) return k
  if (!isProduction(env)) return String(env?.ANTHROPIC_API_KEY ?? '').trim()
  return ''
}

function providerError(code, { status = null, billed = 'no', requestId = null } = {}) {
  const e = new Error(code)
  e.code = code
  e.status = status
  // billed: 'no' (the provider refused before any work), 'unknown' (sent; outcome not known)
  e.billed = billed
  e.request_id = requestId
  return e
}

/** Map an SDK error to a stable code. Never includes the provider message (it can echo input). */
export function classifyProviderError(err) {
  if (err?.code && err?.billed) return err
  const status = Number(err?.status) || null
  const requestId = err?.request_id || err?.requestID || null
  if (err instanceof Anthropic.NotFoundError || status === 404) return providerError('MODEL_NOT_FOUND', { status, requestId })
  if (err instanceof Anthropic.AuthenticationError || status === 401) return providerError('PROVIDER_AUTH', { status, requestId })
  if (err instanceof Anthropic.PermissionDeniedError || status === 403) return providerError('PROVIDER_FORBIDDEN', { status, requestId })
  if (err instanceof Anthropic.RateLimitError || status === 429) return providerError('PROVIDER_RATE_LIMITED', { status, requestId })
  if (err instanceof Anthropic.BadRequestError || status === 400 || status === 413 || status === 422) return providerError('PROVIDER_BAD_REQUEST', { status, requestId })
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') return providerError('PROVIDER_ABORTED', { status, billed: 'unknown', requestId })
  if (err instanceof Anthropic.APIConnectionTimeoutError) return providerError('PROVIDER_TIMEOUT', { status, billed: 'unknown', requestId })
  if (err instanceof Anthropic.APIConnectionError) return providerError('PROVIDER_UNREACHABLE', { status, billed: 'unknown', requestId })
  if (status && status >= 500) return providerError('PROVIDER_UNAVAILABLE', { status, billed: 'unknown', requestId })
  return providerError('PROVIDER_ERROR', { status, billed: 'unknown', requestId })
}

/**
 * @param {{ env?: object, client?: object, timeoutMs?: number }} [opts]
 *   client: an injected SDK-shaped double (tests); never constructed without a key.
 */
export function createAnthropicProvider({ env = process.env, client = null, timeoutMs = 90_000 } = {}) {
  let sdk = client
  function getClient() {
    if (sdk) return sdk
    const apiKey = providerKeyFrom(env)
    if (!apiKey) throw providerError('PROVIDER_KEY_MISSING')
    sdk = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs })
    return sdk
  }

  /** Every model the key can see (GET /v1/models, all pages). Free; no spend. */
  async function listModels() {
    const c = getClient()
    const out = []
    try {
      for await (const m of c.models.list({ limit: 100 })) {
        out.push({
          id: String(m.id),
          display_name: String(m.display_name || ''),
          created_at: m.created_at ? String(m.created_at) : null,
          max_input_tokens: Number(m.max_input_tokens) || null,
          max_tokens: Number(m.max_tokens) || null,
          supports_effort: Boolean(m.capabilities?.effort?.supported),
          lifecycle: m.lifecycle ? String(m.lifecycle) : null,
        })
        if (out.length >= 500) break
      }
    } catch (err) {
      throw classifyProviderError(err)
    }
    return out
  }

  /** One Messages API call. Throws a classified error; returns the SDK message on success. */
  async function createMessage(params, { signal = null } = {}) {
    const c = getClient()
    try {
      return await c.messages.create(params, signal ? { signal } : undefined)
    } catch (err) {
      throw classifyProviderError(err)
    }
  }

  return Object.freeze({ kind: 'anthropic', listModels, createMessage, hasKey: () => Boolean(client || providerKeyFrom(env)) })
}
