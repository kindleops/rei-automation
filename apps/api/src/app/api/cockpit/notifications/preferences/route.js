import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import {
  getNotificationPreferences,
  upsertNotificationPreferences,
} from '@/lib/domain/notifications/notification-intelligence-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function resolveOperatorId(request, body = {}, auth = {}) {
  return body.operator_id || body.operatorId || auth.operator_id || auth.user_id || 'default_operator'
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const authResult = ensureMutationAuth(request)
  if (!authResult.ok) return authResult.response

  try {
    const { searchParams } = new URL(request.url)
    const operatorId = searchParams.get('operator_id') || resolveOperatorId(request, {}, authResult.auth)
    const result = await getNotificationPreferences(operatorId)

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500, headers: cors })
    }

    return NextResponse.json({
      ok: true,
      operator_id: result.operator_id,
      preferences: result.preferences,
      updated_at: result.updated_at,
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'preferences_get_failed' },
      { status: 500, headers: cors },
    )
  }
}

export async function PUT(request) {
  const cors = corsHeaders(request)
  const authResult = ensureMutationAuth(request)
  if (!authResult.ok) return authResult.response

  try {
    const body = await parseJsonSafe(request)
    const operatorId = resolveOperatorId(request, body, authResult.auth)
    const preferences = body.preferences && typeof body.preferences === 'object' ? body.preferences : body

    const result = await upsertNotificationPreferences(operatorId, preferences)
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500, headers: cors })
    }

    return NextResponse.json({
      ok: true,
      operator_id: result.operator_id,
      preferences: result.preferences,
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'preferences_put_failed' },
      { status: 500, headers: cors },
    )
  }
}