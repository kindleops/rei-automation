/**
 * Command Wall HTTP client. Talks ONLY to /api/wall/* (display credential) —
 * never to cockpit routes, never with an operator session, never to Supabase.
 *
 * The credential normally rides an HttpOnly cookie the page cannot read. On a
 * TV browser that refuses cookies the pairing poll asks for `delivery:
 * 'bearer'` and the token is kept in localStorage instead (documented
 * tradeoff: readable by script on this origin — acceptable for a revocable,
 * read-only, wall-scoped credential, never for an operator one).
 */
import type { WallEventsReply, WallSession, WallState } from './wall-types'

export const BEARER_KEY = 'lc.wall.token.v1'
export const PAIRING_KEY = 'lc.wall.pairing.v1'

export class WallHttpError extends Error {
  status: number
  code: string
  retryAfterMs: number | null
  constructor(status: number, code: string, retryAfterMs: number | null = null) {
    super(code)
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
  get unpaired() { return this.status === 401 && /^display_/.test(this.code) }
  get unprovisioned() { return this.status === 503 && this.code === 'display_registry_unprovisioned' }
}

export type WallEndpoint = 'pair' | 'session' | 'state' | 'events' | 'heartbeat' | 'layers'

export interface WallApi {
  pairStart(client: Record<string, unknown>): Promise<{ pairing_id: string; code: string; poll_secret: string; expires_at: string; poll_interval_ms: number }>
  pairPoll(p: { pairing_id: string; poll_secret: string }): Promise<{ paired: false; expires_at: string; poll_interval_ms: number } | { paired: true; display: WallSession; token?: string }>
  session(): Promise<{ display: WallSession; server_time: string }>
  state(q: { mi: boolean; markets: string[] }): Promise<WallState>
  events(q: { after: number; epoch: string | null }): Promise<WallEventsReply>
  heartbeat(body: Record<string, unknown>): Promise<{ display: WallSession; rotated: boolean; token?: string }>
  layers(q: { kind: 'cameras' | 'crime' | 'presence'; bbox: string; zoom: number }): Promise<Record<string, unknown>>
  stats(): Record<WallEndpoint, number>
}

function safeStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

export function createWallApi({ base = '', fetchImpl = (...a: Parameters<typeof fetch>) => fetch(...a), timeoutMs = 20_000 }: { base?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): WallApi {
  const counts: Record<WallEndpoint, number> = { pair: 0, session: 0, state: 0, events: 0, heartbeat: 0, layers: 0 }
  const storage = safeStorage()
  const bearer = () => storage?.getItem(BEARER_KEY) || null
  const wantsBearer = () => typeof navigator !== 'undefined' && navigator.cookieEnabled === false

  async function call<T>(endpoint: WallEndpoint, path: string, init: RequestInit = {}): Promise<T> {
    counts[endpoint] += 1
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (init.body) headers['Content-Type'] = 'application/json'
    const token = bearer()
    if (token) headers['x-lc-display-token'] = token
    try {
      const res = await fetchImpl(`${base}${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store', signal: ctrl?.signal })
      const body = await res.json().catch(() => null) as ({ ok?: boolean; error?: string; retry_after_ms?: number } & Record<string, unknown>) | null
      if (!res.ok || !body || body.ok === false) {
        if (res.status === 401 && token) storage?.removeItem(BEARER_KEY)
        throw new WallHttpError(res.status, String(body?.error || `http_${res.status}`), typeof body?.retry_after_ms === 'number' ? body.retry_after_ms : null)
      }
      return body as T
    } catch (error) {
      if (error instanceof WallHttpError) throw error
      throw new WallHttpError(0, (error as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    pairStart: (client) => call('pair', '/api/wall/pair', { method: 'POST', body: JSON.stringify({ action: 'start', client }) }),
    async pairPoll(p) {
      const out = await call<{ paired: boolean; display: WallSession; token?: string; expires_at: string; poll_interval_ms: number }>('pair', '/api/wall/pair', { method: 'POST', body: JSON.stringify({ action: 'poll', ...p, delivery: wantsBearer() ? 'bearer' : 'cookie' }) })
      if (out.paired && out.token) storage?.setItem(BEARER_KEY, out.token)
      return out as never
    },
    session: () => call('session', '/api/wall/session'),
    state: ({ mi, markets }) => call('state', `/api/wall/state?mi=${mi ? 1 : 0}${markets.length ? `&markets=${encodeURIComponent(markets.join(','))}` : ''}`),
    events: ({ after, epoch }) => call('events', `/api/wall/events?after=${after}${epoch ? `&epoch=${encodeURIComponent(epoch)}` : ''}`),
    async heartbeat(body) {
      const out = await call<{ display: WallSession; rotated: boolean; token?: string }>('heartbeat', '/api/wall/heartbeat', { method: 'POST', body: JSON.stringify({ ...body, delivery: bearer() ? 'bearer' : 'cookie' }) })
      if (out.rotated && out.token) storage?.setItem(BEARER_KEY, out.token)
      return out
    },
    layers: ({ kind, bbox, zoom }) => call('layers', `/api/wall/layers?kind=${kind}&bbox=${encodeURIComponent(bbox)}&zoom=${zoom}`),
    stats: () => ({ ...counts }),
  }
}
