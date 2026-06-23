import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../../_shared.js'
import { applyTemplateControl } from '@/lib/domain/templates/template-intelligence-service.js'
import { DEFAULT_AUTOPILOT_MODE } from '@/lib/domain/templates/template-intelligence-contract.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const body = await request.json()
    const mode = body.mode ?? DEFAULT_AUTOPILOT_MODE
    if (!body.template_id || !body.action || !body.reason) {
      return NextResponse.json(
        { ok: false, error: 'template_id_action_reason_required' },
        { status: 400, headers: cors },
      )
    }

    const result = await applyTemplateControl({
      templateId: body.template_id,
      action: body.action,
      reason: body.reason,
      actor: body.actor ?? 'operator',
      values: body.values ?? {},
      mode,
    })

    return NextResponse.json(result, { status: result.ok ? 200 : 400, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors },
    )
  }
}