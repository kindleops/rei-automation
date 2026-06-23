import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../../_shared.js'
import { fetchTemplateDossier } from '@/lib/domain/templates/template-intelligence-service.js'
import { DEFAULT_AUTOPILOT_MODE } from '@/lib/domain/templates/template-intelligence-contract.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    const range = searchParams.get('range') ?? '7d'
    const autopilotMode = searchParams.get('autopilot_mode') ?? DEFAULT_AUTOPILOT_MODE
    const templateId = decodeURIComponent(params.template_id ?? '')
    const result = await fetchTemplateDossier(templateId, { range, autopilotMode })
    const status = result.ok ? 200 : 404
    return NextResponse.json(result, { status, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors },
    )
  }
}