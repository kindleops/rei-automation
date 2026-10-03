import { callBackend, cloneCampaignBackend, getCampaignBackend } from '../../../lib/api/backendClient'
import type { ComposerAudience, ComposerCohort, ComposerCoverage, ComposerFailure, ComposerFleet, ComposerTemplates, LaunchResult, PrepareResult } from './composer-types'

/**
 * CAMPAIGN COMPOSER 2.0 — the Composer's reads and writes. Reads are GET
 * (read-only); writes go through POST /composer, which composes the canonical
 * create / PATCH / build / readiness / lifecycle writers server-side.
 */
const BASE = '/api/cockpit/campaigns/composer'

type Ok<T> = { ok: true; data: T }
type Fail = { ok: false; error: string; message: string; status: number; body?: ComposerFailure | null }
export type ApiResult<T> = Ok<T> | Fail

async function read<T>(path: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<ApiResult<T>> {
  const res = await callBackend<T & { ok?: boolean; error?: string; message?: string }>(path, { signal, timeoutMs })
  if (!res.ok) return { ok: false, error: res.error || 'request_failed', message: res.message || 'Request failed', status: res.status }
  if (res.data && (res.data as { ok?: boolean }).ok === false) {
    const body = res.data as unknown as ComposerFailure
    return { ok: false, error: body.error, message: body.message || body.error, status: res.status, body }
  }
  return { ok: true, data: res.data as T }
}

async function write<T>(body: Record<string, unknown>, timeoutMs = 280_000): Promise<ApiResult<T>> {
  const res = await callBackend<T>(BASE, { method: 'POST', body: JSON.stringify(body), timeoutMs })
  if (!res.ok) {
    const upstream = (res.upstream && typeof res.upstream === 'object' ? res.upstream : null) as ComposerFailure | null
    return { ok: false, error: upstream?.error || res.error || 'request_failed', message: upstream?.message || res.message || 'Request failed', status: res.status, body: upstream }
  }
  const data = res.data as T & { ok?: boolean }
  if (data && data.ok === false) {
    const failure = data as unknown as ComposerFailure
    return { ok: false, error: failure.error, message: failure.message || failure.error, status: res.status, body: failure }
  }
  return { ok: true, data }
}

export const readFleet = (signal?: AbortSignal) => read<ComposerFleet>(`${BASE}?part=fleet`, signal)
export const readTemplates = (signal?: AbortSignal) => read<ComposerTemplates>(`${BASE}?part=templates`, signal)
export const readAudience = (spec: Record<string, unknown>, signal?: AbortSignal) =>
  read<ComposerAudience>(`${BASE}?part=audience&spec=${encodeURIComponent(JSON.stringify(spec))}`, signal, 180_000)

export const readCohort = (spec: Record<string, unknown>, signal?: AbortSignal) =>
  read<ComposerCohort>(`${BASE}?part=cohort&spec=${encodeURIComponent(JSON.stringify(spec))}`, signal, 240_000)

export const readCoverage = (markets: Array<{ market: string; state: string | null; targets: number }>, signal?: AbortSignal) =>
  read<ComposerCoverage>(`${BASE}?part=coverage&markets=${encodeURIComponent(JSON.stringify(markets))}`, signal, 90_000)

export const saveDraft = (input: { composer_key: string; campaign_id?: string | null; composition: Record<string, unknown> }) =>
  write<{ ok: true; campaign_id: string; created: boolean; changed_fields?: string[]; unchanged?: boolean }>({ action: 'save', ...input }, 60_000)
export const prepareLaunch = (campaignId: string) => write<PrepareResult>({ action: 'prepare', campaign_id: campaignId })
export const launch = (input: { campaign_id: string; launch_key: string; start: { mode: 'now' | 'at'; at: string | null }; expected_eligible: number; audit: Record<string, unknown> }) =>
  write<LaunchResult>({ action: 'launch', ...input })

export async function loadCampaign(id: string): Promise<ApiResult<Record<string, unknown>>> {
  const res = await getCampaignBackend(id)
  if (!res.ok || !res.data?.campaign) return { ok: false, error: res.ok ? 'campaign_not_found' : res.error, message: res.ok ? 'Campaign not found' : res.message, status: res.ok ? 404 : res.status }
  return { ok: true, data: res.data.campaign as Record<string, unknown> }
}

export async function duplicateAsDraft(id: string, name?: string): Promise<ApiResult<string>> {
  const res = await cloneCampaignBackend(id, name ? { name } : {})
  if (!res.ok || !res.data.campaign_id) return { ok: false, error: res.ok ? 'clone_failed' : res.error, message: res.ok ? 'Duplicate failed' : res.message, status: res.ok ? 500 : res.status }
  return { ok: true, data: res.data.campaign_id }
}
