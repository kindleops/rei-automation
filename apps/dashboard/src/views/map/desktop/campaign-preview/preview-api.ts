import { callBackend } from '../../../../lib/api/backendClient'
import type { CampaignPreviewSpec } from '../../../../domain/campaign-preview/campaign-preview-context'
import type { GeoPreview } from './preview-model'

/**
 * GET /api/cockpit/campaigns/composer?part=geo — the eligible cohort on
 * canonical coordinates. Read-only; the server shares the Composer's cohort
 * run (cache + single flight), caps it at the build limit and batches the
 * coordinate read. The Map sends the Composer's spec untouched.
 */
export type GeoResult = { ok: true; data: GeoPreview } | { ok: false; error: string; message: string }

export async function readCampaignGeography(spec: CampaignPreviewSpec, signal?: AbortSignal): Promise<GeoResult> {
  const path = `/api/cockpit/campaigns/composer?part=geo&spec=${encodeURIComponent(JSON.stringify(spec))}`
  const res = await callBackend<GeoPreview & { ok?: boolean; error?: string; message?: string }>(path, { signal, timeoutMs: 240_000 })
  if (!res.ok) return { ok: false, error: res.error || 'request_failed', message: res.message || 'Request failed' }
  const body = res.data as unknown as { ok?: boolean; error?: string; message?: string }
  if (!body || body.ok === false) return { ok: false, error: body?.error || 'geo_unavailable', message: body?.message || body?.error || 'Preview unavailable' }
  return { ok: true, data: res.data as GeoPreview }
}
