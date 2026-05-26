import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../_shared.js'
import { listDealContexts } from '@/lib/domain/deal-context/deal-context-service.js'
import { corsHeaders, unauthorizedJson } from './_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return unauthorizedJson(auth.response, headers)

  try {
    const { searchParams } = new URL(request.url)
    const result = await listDealContexts(Object.fromEntries(searchParams.entries()))

    return NextResponse.json(
      {
        ok: true,
        data: result.rows,
        total: result.total,
        pagination: result.pagination,
      },
      { status: 200, headers },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'deal_context_fetch_failed' },
      { status: 500, headers },
    )
  }
}
