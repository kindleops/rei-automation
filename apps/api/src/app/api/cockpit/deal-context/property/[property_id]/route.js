import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../_shared.js'
import { getDealContextByProperty } from '@/lib/domain/deal-context/deal-context-service.js'
import { corsHeaders, unauthorizedJson } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return unauthorizedJson(auth.response, headers)

  try {
    const row = await getDealContextByProperty(params.property_id)
    if (!row) {
      return NextResponse.json(
        { ok: false, error: 'deal_context_not_found' },
        { status: 404, headers },
      )
    }

    return NextResponse.json({ ok: true, data: row }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'deal_context_property_fetch_failed' },
      { status: 500, headers },
    )
  }
}
