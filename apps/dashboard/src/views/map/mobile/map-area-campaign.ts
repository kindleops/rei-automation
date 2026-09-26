/**
 * Drawn area → campaign DRAFT.
 *
 * The same handoff Entity Graph uses: a draft whose only targeting is
 * `properties.property_id in [...]` — the exact properties inside the shape —
 * explicitly inert (no auto-send, auto-reply disabled; createCampaign refuses
 * either anyway). The operator reviews it in the builder and launches through
 * the campaign lifecycle. Nothing is queued or sent from the map.
 */
import * as backendClient from '../../../lib/api/backendClient'
import type { AreaSummary, Ring } from './MapAreaTool'

export function areaCampaignName(summary: AreaSummary, label: string | null): string {
  const market = summary.markets?.[0]?.market
  const where = market && market !== 'Unknown' ? ` · ${market}` : ''
  return `Map area${where} · ${summary.count.toLocaleString()} properties${label ? ` · ${label}` : ''}`
}

export function areaTargetFilters(summary: AreaSummary) {
  return { properties: [{ field_key: 'properties.property_id', operator: 'in', value: summary.property_ids }] }
}

export async function createAreaCampaignDraft(summary: AreaSummary, ring: Ring, label: string | null): Promise<string> {
  if (!summary.property_ids?.length) throw new Error('no_properties_in_area')
  const targetFilters = areaTargetFilters(summary)
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y) }
  const res = await backendClient.callBackend<{ ok: boolean; campaign_id?: string; id?: string; campaign?: { id?: string }; message?: string; error?: string }>(
    '/api/cockpit/campaigns',
    {
      method: 'POST',
      body: JSON.stringify({
        name: areaCampaignName(summary, label),
        status: 'draft',
        auto_send_enabled: false,
        auto_reply_mode: 'disabled',
        metadata: {
          target_filters: targetFilters,
          source: 'map_area',
          area: { bbox: [w, s, e, n], vertices: ring.length, label, property_count: summary.count, truncated: summary.count > summary.property_ids.length },
        },
        target_filters: targetFilters,
      }),
    },
  )
  const body = res as unknown as { ok?: boolean; data?: Record<string, unknown>; campaign_id?: string; id?: string; campaign?: { id?: string }; message?: string; error?: string }
  const data = (body.data ?? body) as Record<string, unknown>
  const id = String(data.campaign_id ?? data.id ?? (data.campaign as { id?: string } | undefined)?.id ?? '')
  if (!body.ok || !id) throw new Error(body.message || body.error || 'campaign_create_failed')
  return id
}
