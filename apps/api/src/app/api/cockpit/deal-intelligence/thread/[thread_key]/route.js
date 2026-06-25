import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, getCorsHeaders, handleOptionsResponse } from '../../../_shared.js'
import { getUniversalDealDossier } from '@/lib/cockpit/universal-deal-dossier-service.js'
import { readThroughCache } from '@/lib/dashboard/ops-cache.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return handleOptionsResponse(request)
}

export async function GET(request, { params }) {
  return handleRequest(request, await params)
}

export async function POST(request, { params }) {
  return handleRequest(request, await params, true)
}

async function handleRequest(request, params, isPost = false) {
  const cors = getCorsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const { thread_key } = params
  const url = new URL(request.url)
  const debug = url.searchParams.get('debug') === 'true'
  
  let payload = {}
  if (isPost) {
    try { payload = await request.json() } catch(e) {}
  }

  const property_id = url.searchParams.get('property_id') || payload.property_id
  const canonical_e164 = url.searchParams.get('canonical_e164') || payload.canonical_e164
  const prospect_id = url.searchParams.get('prospect_id') || payload.prospect_id
  const master_owner_id = url.searchParams.get('master_owner_id') || payload.master_owner_id

  try {
    const cacheKey = [
      'deal-dossier',
      thread_key,
      property_id || '',
      prospect_id || '',
      master_owner_id || '',
      canonical_e164 || '',
    ].join(':')
    const dossier = await readThroughCache(cacheKey, 8_000, () => getUniversalDealDossier({
      thread_key,
      property_id,
      prospect_id,
      master_owner_id,
      canonical_e164,
      debug,
    }))

    return NextResponse.json(
      {
        ok: true,
        data: dossier
      },
      { status: 200, headers: cors }
    )
  } catch (error) {
    console.error('[DEAL_DOSSIER_ERROR]', error)
    return NextResponse.json(
      { ok: false, error: 'deal_dossier_failed', message: error?.message },
      { status: 500, headers: cors }
    )
  }
}