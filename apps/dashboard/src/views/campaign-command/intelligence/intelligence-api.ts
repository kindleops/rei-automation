import { callBackend } from '../../../lib/api/backendClient'
import type { DiscoveryResult, QualityReport, ScreenerCatalog, ScreenerExpr, ScreenerRefusal, ScreenerResult, WhyTargetedResult } from './intelligence-types'

/**
 * Acquisition OS intelligence reads (all read-only; the screener POST carries
 * the expression in its body and writes nothing). Behind the server flag
 * SELLER_SCREENER (default OFF): a 404 `seller_screener_disabled` is reported
 * as `{ off: true }` so surfaces can render nothing (Composer) or one honest
 * line (Screener) — never an error, never a guess.
 */
const BASE = '/api/cockpit/campaigns'

export type IntelResult<T> =
  | { ok: true; data: T }
  | { ok: false; off: true }
  | { ok: false; off: false; error: string; message: string; status: number; refused?: ScreenerRefusal[] }

type Body = { ok?: boolean; error?: string; message?: string; refused?: ScreenerRefusal[] }

export function isScreenerOff(status: number, body: unknown): boolean {
  const b = body && typeof body === 'object' ? (body as Body) : null
  return status === 404 && b?.error === 'seller_screener_disabled'
}

async function request<T>(path: string, init: { method?: string; body?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<IntelResult<T>> {
  const res = await callBackend<T & Body>(path, { method: init.method, body: init.body, signal: init.signal, timeoutMs: init.timeoutMs ?? 120_000 })
  if (!res.ok) {
    const upstream = res.upstream && typeof res.upstream === 'object' ? (res.upstream as Body) : null
    if (isScreenerOff(res.status, upstream)) return { ok: false, off: true }
    return { ok: false, off: false, error: upstream?.error || res.error, message: upstream?.message || res.message, status: res.status, refused: upstream?.refused }
  }
  const data = res.data as T & Body
  if (data && data.ok === false) {
    if (data.error === 'seller_screener_disabled') return { ok: false, off: true }
    return { ok: false, off: false, error: data.error || 'request_failed', message: data.message || data.error || 'Request failed', status: res.status, refused: data.refused }
  }
  return { ok: true, data }
}

export const readScreenerCatalog = (signal?: AbortSignal) => request<ScreenerCatalog>(`${BASE}/screener`, { signal })

export const runScreener = (input: { expression: ScreenerExpr; max_scan?: number; seller_limit?: number }, signal?: AbortSignal) =>
  request<ScreenerResult>(`${BASE}/screener`, { method: 'POST', body: JSON.stringify(input), signal })

export const readDiscovery = (scope: { state?: string; market?: string; asset?: string; limit?: number }, signal?: AbortSignal) => {
  const p = new URLSearchParams()
  if (scope.state) p.set('state', scope.state)
  if (scope.market) p.set('market', scope.market)
  if (scope.asset) p.set('asset', scope.asset)
  p.set('limit', String(scope.limit ?? 25))
  return request<DiscoveryResult>(`${BASE}/discovery?${p.toString()}`, { signal })
}

export const readWhyTargeted = (propertyIds: string[], signal?: AbortSignal) => {
  const p = new URLSearchParams()
  for (const id of propertyIds.slice(0, 200)) p.append('property_id', id)
  return request<WhyTargetedResult>(`${BASE}/why-targeted?${p.toString()}`, { signal, timeoutMs: 60_000 })
}

export const readQualityReport = (input: { spec?: Record<string, unknown> | null; campaign_id?: string | null }, signal?: AbortSignal) => {
  const q = input.campaign_id
    ? `campaign_id=${encodeURIComponent(input.campaign_id)}`
    : `spec=${encodeURIComponent(JSON.stringify(input.spec ?? {}))}`
  return request<QualityReport>(`${BASE}/composer?part=quality&${q}`, { signal, timeoutMs: 240_000 })
}

/** Audience filter vs message angle (read-only, NOT flag-gated: it only explains stored rows). */
export const readAudienceAngle = (q: { campaignId?: string; spec?: Record<string, unknown> }, signal?: AbortSignal) =>
  request<AudienceAngle>(q.campaignId ? `${BASE}/audience-angle?campaign_id=${encodeURIComponent(q.campaignId)}` : `${BASE}/audience-angle?spec=${encodeURIComponent(JSON.stringify(q.spec ?? {}))}`, { signal, timeoutMs: 45_000 })

export interface AudienceAngle {
  ok: true
  version: string
  name: string | null
  audience_filters: Array<{ field_key: string; label: string; category: string; operator: string; value: unknown }>
  audience_summary: string[]
  drawn_area: boolean
  message_angle: { use_case: string | null; stage_code: string | null; template_source: string; templates: Array<{ template_id: string; name: string | null; use_case: string | null; body_preview: string | null; sends: number }> }
  terms: Array<{ key: string; label: string; implied_by: string[]; filtered_by: string[]; status: 'filtered' | 'filter_only' | 'angle_only_not_filtered' }>
  badges: Array<{ key: string; label: string; implied_by: string[] }>
  campaigns?: AudienceAngle[]
}
