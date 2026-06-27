import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../../_shared.js'
import { patchThreadStateSafe } from '@/lib/cockpit/cockpit-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function PATCH(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: cors }
    )
  }

  const { thread_key } = params
  if (!thread_key) {
    return NextResponse.json(
      { ok: false, error: 'missing_thread_key' },
      { status: 400, headers: cors }
    )
  }

  try {
    const payload = await request.json()
    const patch = {}

    if (payload.conversation_status !== undefined) {
      patch.conversation_status = payload.conversation_status
    }
    if (payload.seller_stage !== undefined) {
      patch.seller_stage = payload.seller_stage
    }
    if (payload.temperature !== undefined) {
      patch.temperature = payload.temperature
    }
    if (payload.autopilot_mode !== undefined) {
      patch.autopilot_mode = payload.autopilot_mode
    }
    if (payload.is_read !== undefined) {
      patch.is_read = payload.is_read
    }
    if (payload.is_pinned !== undefined) {
      patch.is_pinned = payload.is_pinned
    }
    if (payload.is_archived !== undefined) {
      patch.is_archived = payload.is_archived
    }
    if (payload.manual_review !== undefined) {
      patch.manual_review = payload.manual_review
    }
    if (payload.assigned_user !== undefined) {
      patch.assigned_user = payload.assigned_user
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: true, ignored: true }, { headers: cors })
    }

    const result = await patchThreadStateSafe({
      payload: {
        thread_key,
        patch,
      },
    })

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.reason || result.errorMessage || 'patch_failed' },
        { status: 400, headers: cors },
      )
    }

    return NextResponse.json({
      ok: true,
      threadKey: thread_key,
      data: result.diagnostics?.row || null,
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}