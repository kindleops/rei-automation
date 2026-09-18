/**
 * NO BACKEND REQUEST MAY HANG FOREVER (§3, §35).
 *
 * There was no deadline anywhere in the client. A caller could pass its own
 * `signal`, but nothing imposed a limit, so any surface awaiting `callBackend`
 * stayed in `loading` forever whenever the upstream neither answered nor
 * refused — exactly what a dev proxy in front of a dead API does, and what a
 * stalled connection does in production.
 *
 * That is the mechanism behind "Campaign Command sits in readiness forever":
 * the promise never settles, so the error branch a component carefully wrote is
 * never reached. No amount of per-surface handling can fix that; the deadline
 * has to live where the request is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A server that accepts the connection and then says nothing. It never
 * rejects, so without a deadline the await is permanent.
 *
 * The `aborted` check matters: a real `fetch` rejects immediately when handed
 * an already-aborted signal, and the client aborts before calling fetch when
 * the caller cancelled during the session-token await. A mock that only
 * listens for the event would hang on that path and misreport it as a client
 * defect.
 */
const silentServer = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
  const fail = () => reject(new DOMException('Aborted', 'AbortError'))
  if (init?.signal?.aborted) { fail(); return }
  init?.signal?.addEventListener('abort', fail)
})) as typeof fetch

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.stubEnv('VITE_BACKEND_API_URL', 'http://backend.test')
  vi.stubEnv('VITE_BACKEND_API_SECRET', 'test-secret')
})

describe('request deadline', () => {
  it('a request that never answers SETTLES, as a timeout', async () => {
    // The precise failure shape: a server that accepts the connection and then
    // says nothing. It never rejects, so without a deadline the await is
    // permanent.
    globalThis.fetch = silentServer

    const { callBackend } = await import('./backendClient')
    const result = await callBackend('/api/cockpit/campaigns', { timeoutMs: 50 })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(504)
    expect((result as { error: string }).error).toBe('BACKEND_TIMEOUT')
  })

  it('a timeout is NOT reported as an unreachable backend', async () => {
    // Reporting the deadline as "backend unreachable" would send an operator to
    // check a server that is up and answering every other call.
    globalThis.fetch = silentServer

    const { callBackend } = await import('./backendClient')
    const result = await callBackend('/api/cockpit/campaigns', { timeoutMs: 50 })

    expect((result as { error: string }).error).not.toBe('BACKEND_UNAVAILABLE')
    expect((result as { message: string }).message).toMatch(/never answered|did not respond/i)
  })

  it("a caller's own cancellation is not reported as a failure", async () => {
    // Superseded fetches are cancelled on purpose; calling that an error would
    // make normal navigation look broken.
    globalThis.fetch = silentServer

    const controller = new AbortController()
    const { callBackend } = await import('./backendClient')
    const pending = callBackend('/api/cockpit/campaigns', { signal: controller.signal, timeoutMs: 5_000 })
    controller.abort()
    const result = await pending

    expect((result as { error: string }).error).toBe('BACKEND_REQUEST_CANCELLED')
  })

  it('a normal response is unaffected by the deadline', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, campaigns: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const { callBackend } = await import('./backendClient')
    const result = await callBackend('/api/cockpit/campaigns', { timeoutMs: 5_000 })
    expect(result.ok).toBe(true)
  })
})
