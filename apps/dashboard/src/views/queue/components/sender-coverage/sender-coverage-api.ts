import { callBackend } from '../../../../lib/api/backendClient'

/**
 * SENDER ROUTING 2.0 — Sender Coverage reads + route-edit preview/save.
 * GET is read-only; POST preview is read-only; POST save is gated server-side
 * (graph-writes double gate + operator auth) and audited/versioned.
 */
const BASE = '/api/cockpit/routing/sender-coverage'

export type CoverageStatus = 'LOCAL' | 'REGIONAL' | 'DEGRADED' | 'UNCOVERED'
export type AffinityTier = 'primary' | 'preferred_fallback' | 'regional_fallback' | 'last_resort' | 'blocked_never'

export interface CoverageRoute {
  pool_key: string
  pool_name: string
  tier: AffinityTier
  priority: number
  provenance: string | null
  local: boolean
  eligible: number
  total: number
  health: 'healthy' | 'partial' | 'down' | 'empty' | 'disabled'
  remaining_capacity: number
}

export interface CoverageMarket {
  market_id: string
  display_name: string
  status: CoverageStatus
  active_pool: string | null
  label: string | null
  routes: CoverageRoute[]
  blocked_pools: string[]
  parked_sends: number | null
}

export interface CoveragePoolNumber {
  phone: string | null
  textgrid_number_id: string | null
  eligible: boolean
  reason: string | null
  remaining: number | null
}

export interface CoveragePool {
  pool_key: string
  name: string
  home_market_id: string | null
  enabled: boolean
  total: number
  eligible: number
  remaining_capacity: number
  health: CoverageRoute['health']
  numbers: CoveragePoolNumber[]
}

export interface SenderCoverage {
  ok: true
  gate: { enabled: boolean; reason: string }
  graph_status: 'live' | 'proposal_schema_not_applied' | 'proposal_live_graph_unreadable'
  graph_enabled: boolean
  seed_backfill_simulated: boolean
  graph_version: number | string | null
  proposal_version: string | null
  blocklist_readable: boolean
  per_sender_cap: number | null
  parked_unresolved_market: number
  definitions: Record<CoverageStatus, string>
  metrics: {
    markets: number
    local: number
    regional: number
    degraded: number
    uncovered: number
    healthy_senders: number
    daily_capacity_remaining: number
    parked_sends: number | null
  }
  pools: CoveragePool[]
  markets: CoverageMarket[]
}

export interface RouteDraft {
  pool_key: string
  tier: AffinityTier
}

export interface RoutePreview {
  ok: true
  graph_status: string
  market_id: string
  coverage_before: CoverageStatus
  coverage_after: CoverageStatus
  rows_considered: number
  became_routable: number
  lost_coverage: number
  changed_pool: number
  unchanged: number
}

type Fail = { ok: false; error: string; message: string; status: number }
export type CoverageResult<T> = { ok: true; data: T } | Fail

function failure(res: { status: number; error?: string; message?: string; upstream?: unknown }): Fail {
  const up = (res.upstream && typeof res.upstream === 'object' ? res.upstream : {}) as { error?: string; message?: string; reason?: string }
  return { ok: false, status: res.status, error: up.error || res.error || 'request_failed', message: up.message || up.reason || res.message || 'Request failed' }
}

export async function readSenderCoverage(signal?: AbortSignal): Promise<CoverageResult<SenderCoverage>> {
  const res = await callBackend<SenderCoverage | { ok: false; error: string; message?: string }>(BASE, { signal, timeoutMs: 60_000 })
  if (!res.ok) return failure(res)
  if ((res.data as { ok?: boolean }).ok === false) {
    const b = res.data as { error: string; message?: string }
    return { ok: false, status: res.status, error: b.error, message: b.message || b.error }
  }
  return { ok: true, data: res.data as SenderCoverage }
}

async function post<T>(body: Record<string, unknown>): Promise<CoverageResult<T>> {
  const res = await callBackend<T & { ok?: boolean; error?: string; message?: string }>(BASE, { method: 'POST', body: JSON.stringify(body), timeoutMs: 60_000 })
  if (!res.ok) return failure(res)
  const data = res.data as T & { ok?: boolean; error?: string; message?: string }
  if (data && data.ok === false) return { ok: false, status: res.status, error: data.error || 'rejected', message: data.message || data.error || 'Rejected' }
  return { ok: true, data }
}

export const previewRoutes = (market_id: string, routes: RouteDraft[]) => post<RoutePreview>({ action: 'preview', market_id, routes })
export const saveRoutes = (market_id: string, routes: RouteDraft[], reason: string) =>
  post<{ ok: true; graph_version: number | null }>({ action: 'save', market_id, routes, reason })
