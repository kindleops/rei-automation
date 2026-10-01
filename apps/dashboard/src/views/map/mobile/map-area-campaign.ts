/**
 * Drawn area → campaign DRAFT.
 *
 * The draft's targeting is the polygon itself (`properties.drawn_area`, a
 * GeoJSON Polygon). Campaign Command resolves it inside the database to the
 * exact cohort, the same rows for Reach and for Build, with no cap and no
 * arbitrary order.
 *
 * It used to target `properties.property_id in [...]` built from the area
 * summary's id list, which is the first 5,000 rows of the area in no defined
 * order: an 18,400-property area became an arbitrary 5,000-property campaign.
 * That list is now only a labelled visual sample and never reaches a campaign.
 *
 * Explicitly inert (no auto-send, auto-reply disabled; createCampaign refuses
 * either anyway). Nothing is queued or sent from the map.
 */
import * as backendClient from '../../../lib/api/backendClient'
import type { AreaSummary, Ring } from './MapAreaTool'

export const DRAWN_AREA_FIELD_KEY = 'properties.drawn_area'

export function areaCampaignName(summary: AreaSummary, label: string | null): string {
  const market = summary.markets?.[0]?.market
  const where = market && market !== 'Unknown' ? ` · ${market}` : ''
  return `Map area${where} · ${summary.count.toLocaleString()} properties${label ? ` · ${label}` : ''}`
}

/** The drawn ring as a closed GeoJSON Polygon (lng, lat). */
export function areaPolygon(ring: Ring): { type: 'Polygon'; coordinates: Array<Array<[number, number]>> } {
  const points = ring.map(([lng, lat]) => [lng, lat] as [number, number])
  const first = points[0]
  const last = points[points.length - 1]
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) points.push([first[0], first[1]])
  return { type: 'Polygon', coordinates: [points] }
}

export function areaTargetFilters(ring: Ring) {
  return {
    properties: [{
      field_key: DRAWN_AREA_FIELD_KEY,
      operator: 'within',
      value: areaPolygon(ring),
      domain: 'properties',
      category: 'Location & Market',
    }],
  }
}

export async function createAreaCampaignDraft(summary: AreaSummary, ring: Ring, label: string | null): Promise<string> {
  if (!summary.count) throw new Error('no_properties_in_area')
  if (!Array.isArray(ring) || ring.length < 3) throw new Error('invalid_area')
  const targetFilters = areaTargetFilters(ring)
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
          // Context only: the cohort is the polygon in target_filters.
          area: { bbox: [w, s, e, n], vertices: ring.length, label, property_count: summary.count },
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
