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
// Calls are STREAMED (createMessage): see the comment there for why.
//
// Retries are OFF (maxRetries: 0): every provider attempt must be its own spend
// reservation, so a retry is a new, separately reserved call — never a hidden one.
import { AsyncLocalStorage } from 'node:async_hooks'
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

function providerError(code, { status = null, billed = 'no', requestId = null, phase = null, transport = null } = {}) {
  const e = new Error(code)
  e.code = code
  e.status = status
  // billed: 'no' (the provider refused before any work), 'unknown' (sent; outcome not known)
  e.billed = billed
  e.request_id = requestId
  // phase: where the call died — 'connect' (before response headers: DNS / TCP / TLS /
  // request upload / time-to-first-byte) or 'stream' (headers received, body streaming).
  e.phase = phase
  // transport: the undici / socket error CODE under a connection failure (never its
  // message: it can carry hostnames / addresses), e.g. UND_ERR_CONNECT_TIMEOUT.
  e.transport = transport
  return e
}

// An error code is a short UPPER_SNAKE identifier; anything else is dropped (a message never leaks).
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,40}$/
/** The deepest socket / undici error code in an error's cause chain, or null. */
export function transportCode(err) {
  let e = err
  for (let i = 0; e && i < 6; i += 1) {
    const c = typeof e.code === 'string' && CODE_SHAPE.test(e.code) && !/^PROVIDER_|^MODEL_/.test(e.code) ? e.code : null
    if (c) return c
    e = e.cause
  }
  return null
}

const CONNECT_TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'])
const STREAM_TIMEOUT_REASONS = Object.freeze({ MODEL_TIMEOUT: true })

/**
 * Map an SDK / transport error to a stable code. Never includes the provider message (it can echo input).
 * ctx (set by createMessage, optional for direct callers):
 *   phase       'connect' until response headers arrive, then 'stream'
 *   stopped     why THIS module aborted: 'idle' (stream stalled) | 'caller' (the caller's signal)
 *   callerReason the caller's abort reason ({ code: 'MODEL_TIMEOUT' } = the run's per-call ceiling)
 *   transport   the transport code captured under the SDK (the SDK drops causes on timeouts)
 * Timeout taxonomy (all billed:'unknown' — the reserve stays counted; a connect timeout is
 * almost surely unbilled, but "almost" is not proof, so it is never released):
 *   PROVIDER_CONNECT_TIMEOUT  TCP / TLS connect never completed (undici connect timer, ~10 s)
 *   PROVIDER_HEADERS_TIMEOUT  connected and sent, no response headers before the ceiling
 *   PROVIDER_READ_TIMEOUT     headers received, the stream outlived the per-call ceiling
 *   PROVIDER_STREAM_STALLED   headers received, then no stream event for the idle window
 *   PROVIDER_STREAM_INTERRUPTED  the body stream broke mid-response (socket closed / reset)
 *   PROVIDER_ABORTED          the caller cancelled (not a timeout)
 */
export function classifyProviderError(err, ctx = {}) {
  if (err?.code && err?.billed) return err
  const status = Number(err?.status) || null
  const requestId = err?.request_id || err?.requestID || null
  const phase = ctx.phase || null
  const transport = ctx.transport || transportCode(err)
  const mk = (code, billed = 'unknown') => providerError(code, { status, billed, requestId, phase, transport })
  if (err instanceof Anthropic.NotFoundError || status === 404) return mk('MODEL_NOT_FOUND', 'no')
  if (err instanceof Anthropic.AuthenticationError || status === 401) return mk('PROVIDER_AUTH', 'no')
  if (err instanceof Anthropic.PermissionDeniedError || status === 403) return mk('PROVIDER_FORBIDDEN', 'no')
  if (err instanceof Anthropic.RateLimitError || status === 429) return mk('PROVIDER_RATE_LIMITED', 'no')
  if (err instanceof Anthropic.BadRequestError || status === 400 || status === 413 || status === 422) return mk('PROVIDER_BAD_REQUEST', 'no')
  // aborts: ours (idle watchdog), the caller's per-call ceiling, or a real cancel
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError' || ctx.stopped) {
    if (ctx.stopped === 'idle') return mk('PROVIDER_STREAM_STALLED')
    if (ctx.stopped === 'caller' && STREAM_TIMEOUT_REASONS[ctx.callerReason?.code]) {
      if (phase === 'stream') return mk('PROVIDER_READ_TIMEOUT')
      return mk(transport && CONNECT_TIMEOUT_CODES.has(transport) ? 'PROVIDER_CONNECT_TIMEOUT' : 'PROVIDER_HEADERS_TIMEOUT')
    }
    return mk('PROVIDER_ABORTED')
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    // the SDK raises this both for its own request timer (no headers within timeoutMs) and for
    // undici's connect timer; only the captured transport code tells them apart
    return mk(transport && CONNECT_TIMEOUT_CODES.has(transport) ? 'PROVIDER_CONNECT_TIMEOUT' : 'PROVIDER_HEADERS_TIMEOUT')
  }
  if (err instanceof Anthropic.APIConnectionError) {
    if (transport && CONNECT_TIMEOUT_CODES.has(transport)) return mk('PROVIDER_CONNECT_TIMEOUT')
    return mk(phase === 'stream' ? 'PROVIDER_STREAM_INTERRUPTED' : 'PROVIDER_UNREACHABLE')
  }
  if (status && status >= 500) return mk('PROVIDER_UNAVAILABLE')
  // an in-band SSE error event (e.g. overloaded_error mid-stream) arrives as an APIError without a status
  const inband = String(err?.error?.error?.type || err?.error?.type || '')
  if (inband === 'overloaded_error' || inband === 'api_error') return mk('PROVIDER_UNAVAILABLE')
  // the body stream broke after headers (undici "terminated" / socket closed)
  if (phase === 'stream') return mk('PROVIDER_STREAM_INTERRUPTED')
  return mk('PROVIDER_ERROR')
}

// Every fetch the SDK makes runs inside the caller's async context: this is how a
// transport error code (which the SDK discards when it raises a timeout) is tied to
// the exact call that hit it, even with concurrent calls on one client.
const callScope = new AsyncLocalStorage()
function scopedFetch(baseFetch) {
  return async function providerFetch(url, init) {
    const scope = callScope.getStore()
    try {
      return await baseFetch(url, init)
    } catch (err) {
      if (scope) scope.transport = transportCode(err)
      throw err
    }
  }
}

export const STREAM_IDLE_MS = 45_000

/**
 * @param {{ env?: object, client?: object, timeoutMs?: number, idleMs?: number, baseFetch?: typeof fetch, baseURL?: string|null }} [opts]
 *   client:    an injected SDK-shaped double (tests); never constructed without a key.
 *   baseFetch / baseURL: test seams (a local SSE server) — production passes neither, so
 *              the SDK talks to its default API host through the global fetch.
 */
export function createAnthropicProvider({ env = process.env, client = null, timeoutMs = 90_000, idleMs = STREAM_IDLE_MS, baseFetch = null, baseURL = null } = {}) {
  let sdk = client
  function getClient() {
    if (sdk) return sdk
    const apiKey = providerKeyFrom(env)
    if (!apiKey) throw providerError('PROVIDER_KEY_MISSING')
    // timeout: the SDK arms it around the fetch only (until response headers); the
    // body is bounded by the caller's signal and the idle watchdog below.
    sdk = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs, fetch: scopedFetch(baseFetch || globalThis.fetch), ...(baseURL ? { baseURL } : {}) })
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

  /**
   * One Messages API call, STREAMED (R1, 10-12). Throws a classified error; returns
   * the final accumulated Message (same shape as a non-streamed create: content,
   * stop_reason, usage) on success.
   *
   * WHY streaming: a non-streamed call holds one HTTP response silent until the whole
   * answer is generated. Production (Cloudflare container egress, 10-12) lost the
   * longer tool-carrying calls at 10.5 s / 15.3 s while short calls passed. A stream
   * sends headers at once, then message_start, content deltas and ping events, so
   * bytes flow for the whole call, and a dead connection is DETECTED (idle
   * watchdog) instead of waited out. Usage stays exact: message_start carries input +
   * cache tokens, message_delta the cumulative output tokens; MessageStream folds
   * them into finalMessage().usage, which is what the ledger settles from.
   *
   * Bounds: the SDK timer covers connect → headers (timeoutMs); the caller's signal
   * (the run's per-call ceiling) covers the whole call; the idle watchdog aborts a
   * stream that goes silent for idleMs after headers. No retries (maxRetries 0).
   */
  async function createMessage(params, { signal = null, onEvent = null } = {}) {
    const c = getClient()
    const ctx = { phase: 'connect', stopped: null, callerReason: null, transport: null }
    const ctl = new AbortController()
    const onCaller = () => { if (!ctx.stopped) { ctx.stopped = 'caller'; ctx.callerReason = signal?.reason ?? null } ctl.abort() }
    if (signal) {
      if (signal.aborted) onCaller()
      else signal.addEventListener?.('abort', onCaller, { once: true })
    }
    let idle = null
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => { if (!ctx.stopped) ctx.stopped = 'idle'; ctl.abort() }, idleMs)
      if (typeof idle?.unref === 'function') idle.unref()
    }
    try {
      return await callScope.run(ctx, async () => {
        const stream = c.messages.stream(params, { signal: ctl.signal })
        stream.on?.('connect', () => { ctx.phase = 'stream'; arm() })
        // onEvent: the raw provider stream events (message_start, content_block_start /
        // delta / stop, message_delta, …) for the caller's live run events. A throwing
        // listener never breaks the call.
        stream.on?.('streamEvent', (ev) => { arm(); if (onEvent) { try { onEvent(ev) } catch { /* listener errors are the caller's */ } } })
        return await stream.finalMessage()
      })
    } catch (err) {
      throw classifyProviderError(err, ctx)
    } finally {
      clearTimeout(idle)
      signal?.removeEventListener?.('abort', onCaller)
    }
  }

  return Object.freeze({ kind: 'anthropic', listModels, createMessage, hasKey: () => Boolean(client || providerKeyFrom(env)) })
}
