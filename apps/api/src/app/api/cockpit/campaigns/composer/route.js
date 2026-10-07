import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { operatorIdFromHeaders } from '@/lib/domain/intelligence/corrections/corrections.js'
import {
  launchComposedCampaign,
  prepareComposerLaunch,
  readComposerAudience,
  readComposerCohort,
  readComposerCoverage,
  readComposerFleet,
  readComposerGeography,
  readComposerOfferReadiness,
  readComposerQualityReport,
  readComposerTemplates,
  saveComposerDraft,
} from '@/lib/domain/campaigns/campaign-composer.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET — Campaign Composer reads. READ-ONLY (selects and the dry-run preview).
 *   ?part=quality&spec=<json>|&campaign_id=  Campaign Quality Report (§19/§70; SELLER_SCREENER flag, default off)
 *   ?part=fleet                     sender fleet: router state, sent today, capacity
 *   ?part=templates                 template coverage per strategy × language
 *   ?part=audience&spec=<json>      dry-run audience for a composition (sampled build)
 *   ?part=coverage&markets=<json>   sender coverage from the canonical routing engine
 *   ?part=cohort&spec=<json>        the whole cohort counted by the build's pipeline (aggregates only)
 *   ?part=offer_ready&spec=<json>   Offer Ready preflight over the eligible cohort (same predicate as Autopilot)
 *   ?part=offer_ready&campaign_id=  Offer Ready preflight over a campaign's queue-eligible targets
 *   ?part=geo&spec=<json>           the eligible cohort on canonical coordinates (Campaign Map Preview;
 *                                   shares the cohort's cache + single flight; ids and coordinates only)
 */
export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const params = new URL(request.url).searchParams
  const part = params.get('part')
  try {
    if (part === 'fleet') return withCors(request, await readComposerFleet())
    if (part === 'templates') return withCors(request, await readComposerTemplates())
    if (part === 'audience') {
      let spec = {}
      try { spec = JSON.parse(params.get('spec') || '{}') } catch {
        return withCors(request, { ok: false, error: 'invalid_spec' }, 400)
      }
      const result = await readComposerAudience(spec)
      return withCors(request, result, result.ok === false ? 502 : 200)
    }
    if (part === 'cohort') {
      let spec = {}
      try { spec = JSON.parse(params.get('spec') || '{}') } catch {
        return withCors(request, { ok: false, error: 'invalid_spec' }, 400)
      }
      const result = await readComposerCohort(spec)
      return withCors(request, result, result.ok === false ? 502 : 200)
    }
    if (part === 'geo') {
      let spec = {}
      try { spec = JSON.parse(params.get('spec') || '{}') } catch {
        return withCors(request, { ok: false, error: 'invalid_spec' }, 400)
      }
      // a preview needs an audience: no filter clause at all would be the whole graph
      const groups = spec && typeof spec === 'object' && spec.filters && typeof spec.filters === 'object' ? Object.values(spec.filters) : []
      if (!groups.some((g) => Array.isArray(g) && g.length > 0)) return withCors(request, { ok: false, error: 'audience_required' }, 400)
      const result = await readComposerGeography(spec)
      return withCors(request, result, result.ok === false ? 502 : 200)
    }
    if (part === 'offer_ready') {
      const campaign_id = params.get('campaign_id')
      let spec = null
      if (!campaign_id) {
        try { spec = JSON.parse(params.get('spec') || '{}') } catch {
          return withCors(request, { ok: false, error: 'invalid_spec' }, 400)
        }
      }
      const result = await readComposerOfferReadiness({ campaign_id, spec })
      return withCors(request, result, result.ok === false ? 502 : 200)
    }
    if (part === 'quality') {
      // Campaign Quality Report (§19/§70), behind SELLER_SCREENER (default OFF → 404, nothing read).
      const campaign_id = params.get('campaign_id')
      let spec = null
      if (!campaign_id) {
        try { spec = JSON.parse(params.get('spec') || '{}') } catch {
          return withCors(request, { ok: false, error: 'invalid_spec' }, 400)
        }
      }
      const result = await readComposerQualityReport({ campaign_id, spec })
      return withCors(request, result, result.ok === false ? Number(result.status || 502) : 200)
    }
    if (part === 'coverage') {
      let markets = []
      try { markets = JSON.parse(params.get('markets') || '[]') } catch {
        return withCors(request, { ok: false, error: 'invalid_markets' }, 400)
      }
      const result = await readComposerCoverage(markets)
      return withCors(request, result, result.ok === false ? 502 : 200)
    }
    return withCors(request, { ok: false, error: 'unknown_part' }, 400)
  } catch (error) {
    console.error('campaigns.composer_read_failed', part, error)
    return withCors(request, { ok: false, error: 'composer_read_failed', part, message: error?.message || String(error) }, 500)
  }
}

/**
 * POST — Campaign Composer writes, each through the canonical writer.
 *   { action: 'save', composer_key, campaign_id?, composition }
 *   { action: 'prepare', campaign_id }                    build targets + readiness
 *   { action: 'launch', campaign_id, launch_key, start, expected_eligible, audit }
 */
export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const body = await parseJsonSafe(request)
  const action = String(body?.action || '')
  // The Worker-verified operator (x-ops-user-id) first; the dashboard auth object carries none.
  const operator = operatorIdFromHeaders(request.headers) || auth.auth?.email || auth.auth?.user_id || auth.auth?.operator || null
  try {
    let result
    if (action === 'save') result = await saveComposerDraft(body)
    else if (action === 'prepare') result = await prepareComposerLaunch(body)
    else if (action === 'launch') result = await launchComposedCampaign({ ...body, operator })
    else return withCors(request, { ok: false, error: 'unknown_action' }, 400)
    return withCors(request, result, result.ok === false ? Number(result.status || 409) : 200)
  } catch (error) {
    console.error('campaigns.composer_write_failed', action, error)
    return withCors(request, { ok: false, error: 'composer_write_failed', action, message: error?.message || String(error) }, 500)
  }
}
