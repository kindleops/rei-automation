import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { previewExactSelection } from '@/lib/domain/campaigns/campaign-exact-selection.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * Read-only exact-selection preview. Body: { property_ids: string[], cohort_confirmation?: { confirmed_count } }.
 * Never writes campaign targets or send_queue rows.
 */
export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = await parseJsonSafe(request)
    const result = await previewExactSelection({
      property_ids: body?.property_ids,
      cohort_confirmation: body?.cohort_confirmation || null,
    })
    return withCors(request, result, result.ok === false && result.status ? Number(result.status) : 200)
  } catch (error) {
    console.error('campaigns.preview_selection_failed', error)
    return withCors(request, { ok: false, error: 'campaign_preview_selection_failed', message: error?.message || String(error) }, 500)
  }
}
