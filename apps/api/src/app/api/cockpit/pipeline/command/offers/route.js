/**
 * PIPELINE COMMAND — offers. Read-only: the offer picture per deal (engine
 * recommendation, any seller_offers row, the negotiation's authorization and
 * the canonical spendability verdict). See getPipelineCommandOffers in
 * lib/domain/opportunity/pipeline-command-service.js. Nothing here can
 * authorize, send or accept an offer.
 */
import { NextResponse } from 'next/server.js'
import { getPipelineCommandOffers } from '@/lib/domain/opportunity/pipeline-command-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  }
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries())
    const data = await getPipelineCommandOffers(params)
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('pipeline.command.offers_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'pipeline_command_offers_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
