/**
 * Dashboard-facing read of W8C shadow buyer intelligence for one property.
 *
 * GET /api/intel/buyer-intelligence?property_id=<id>
 *
 * READ-ONLY and OBSERVATIONAL. Returns display data for the property Buyer
 * Intelligence panel. It performs no writes and cannot influence buyer-match
 * ranking or scores, MAO, offer pricing, offers, seller priority, campaigns,
 * outreach, suppressions, send_queue, or autonomous workflows. There are no
 * mutating verbs on this route by design.
 *
 * ACCESS: `reivesti.property_historical_buyers` is service-role only — a
 * per-property buyer roster is re-identifying. It is therefore read here on the
 * server and never by the browser, behind the same `ensureMutationAuth`
 * boundary the dashboard already uses for /api/intel/buyer-match. Only the
 * sanitized projection reaches the client.
 *
 * `ensureMutationAuth` returns ok when NO secret is configured, which is a
 * reasonable default for a local dev mutation endpoint but not for a re-
 * identifying dataset. This route therefore adds the production fail-closed
 * posture that `getSharedSecretAuthResult` already applies elsewhere in REI:
 * unconfigured authorization in production is refused rather than served. Both
 * checks run before any W8C query is issued.
 *
 * PRIVACY: person entity IDs are `person:{individual_key}` upstream, so the
 * payload carries only `person:anon_<hash>`. Natural-person names are never
 * exposed. `redactShadowEnvelope` is applied to the response as a final
 * backstop, including on the error path.
 */

import { ensureMutationAuth } from '../../_shared.js'
import { buildBuyerIntelligencePanel } from '@/lib/intel/w8c-panel-projection.js'
import { redactShadowEnvelope, scrubPersonIds, W8C_SOURCE } from '@/lib/intel/w8c-buyer-intelligence.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = child({ module: 'api.intel.buyer-intelligence' })

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
  }
}

function json(payload, status = 200) {
  // Redact on the way out regardless of which branch produced the payload.
  return new Response(JSON.stringify(redactShadowEnvelope(payload)), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

/** Same env list `ensureMutationAuth` consults; kept in lockstep with it. */
const DASHBOARD_SECRET_ENVS = [
  'OPS_DASHBOARD_SECRET',
  'COCKPIT_MUTATION_SECRET',
  'BUYER_MATCH_MUTATION_SECRET',
  'API_MUTATION_SECRET',
]

const isProductionRuntime = () =>
  String(process.env.VERCEL_ENV ?? '').toLowerCase() === 'production' ||
  String(process.env.NODE_ENV ?? '').toLowerCase() === 'production'

const authorizationConfigured = () =>
  DASHBOARD_SECRET_ENVS.some((name) => String(process.env[name] ?? '').trim().length > 0)

export async function GET(request) {
  // Fail closed in production rather than serving a re-identifying dataset
  // just because no secret happens to be configured.
  if (isProductionRuntime() && !authorizationConfigured()) {
    return json({ ok: false, error: 'authorization_not_configured' }, 500)
  }

  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  const propertyId = String(new URL(request.url).searchParams.get('property_id') ?? '').trim()
  if (!propertyId) {
    return json({ ok: false, error: 'missing_property_id' }, 400)
  }

  try {
    const panel = await buildBuyerIntelligencePanel(propertyId)
    return json({ ok: true, panel })
  } catch (error) {
    // Shadow intelligence must never break the property page: report a quiet
    // unavailable panel rather than an error status.
    logger.warn?.({ err: scrubPersonIds(error?.message ?? ''), propertyId }, 'buyer_intelligence_panel_failed')
    return json({
      ok: true,
      panel: {
        source: W8C_SOURCE,
        propertyId,
        status: 'unavailable',
        reason: 'w8c_unavailable',
        observationalOnly: true,
        buyers: [],
      },
    })
  }
}
