import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { deriveAudienceVsAngle, readCampaignAudienceAngles } from '@/lib/domain/campaigns/campaign-audience-angle.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * AUDIENCE FILTER vs MESSAGE ANGLE — read-only derivation (owner 2026-10-07).
 *   GET ?campaign_id=<uuid>[&campaign_id=…]   saved campaigns (templates actually sent)
 *   GET ?all=1[&limit=300]                    every campaign, newest first (historical backfill)
 *   GET ?spec=<json {name, filters, template_use_case}>  a Composer composition (template pool for the use case)
 * Never writes.
 */
function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const p = new URL(request.url).searchParams
  try {
    const { queryWithTimeout } = await import('@/lib/postgres/client.js')
    const db = { query: (sql, params) => queryWithTimeout(sql, params, 30_000) }
    if (p.get('spec')) {
      let spec
      try { spec = JSON.parse(p.get('spec')) } catch { return withCors(request, { ok: false, error: 'invalid_spec' }, 400) }
      const useCase = String(spec?.template_use_case || '').trim()
      const { rows } = useCase
        ? await db.query("select id::text id, template_id::text template_id, template_name, use_case, template_body from public.sms_templates where use_case = $1 and is_active and coalesce(quarantine_state, 'clear') not in ('quarantined') order by usage_count desc nulls last limit 12", [useCase])
        : { rows: [] }
      const r = deriveAudienceVsAngle({ name: spec?.name, metadata: { target_filters: spec?.filters, template_use_case: useCase } }, { templates: rows.map((t) => ({ ...t, sends: 0 })) })
      return withCors(request, { ok: true, ...r, message_angle: { ...r.message_angle, template_source: 'active template pool for the strategy (not yet sent)' } })
    }
    const ids = p.getAll('campaign_id').filter(Boolean)
    if (!ids.length && p.get('all') !== '1') return withCors(request, { ok: false, error: 'campaign_id_or_all_required' }, 400)
    const campaigns = await readCampaignAudienceAngles({ campaignIds: ids.length ? ids : null, limit: p.get('limit') || 300 }, { db })
    return withCors(request, { ok: true, version: 'audience_angle_v1', campaigns, angle_only_campaigns: campaigns.filter((c) => c.badges.length).length })
  } catch (error) {
    console.error('campaigns.audience_angle_failed', error)
    return withCors(request, { ok: false, error: 'audience_angle_failed', message: error?.message || String(error) }, 500)
  }
}
