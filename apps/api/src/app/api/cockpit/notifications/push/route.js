import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import {
  removePushSubscription,
  resolvePushConfig,
  savePushSubscription,
} from '@/lib/domain/notifications/web-push-transport.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * PUSH SUBSCRIPTION ENDPOINT.
 *
 *   GET     what the browser needs to subscribe, or an honest reason it cannot
 *   POST    persist a PushSubscription
 *   DELETE  drop one (operator turned push off, or signed out)
 *
 * GET deliberately answers 200 with `configured: false` when VAPID is absent rather
 * than 500. "Push is not set up on this deployment" is a STATE, not a server error,
 * and the client has a designed surface for it — returning 500 would make the UI show
 * a failure banner for a deployment that is simply not configured yet.
 *
 * Only the PUBLIC key is ever returned. The private key stays in the environment.
 */

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const config = resolvePushConfig()
  return NextResponse.json({
    ok: true,
    configured: config.configured,
    vapid_public_key: config.publicKey,
    reason: config.reason,
  }, { status: 200, headers: cors })
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const config = resolvePushConfig()
  if (!config.configured) {
    // 503, not 200: the operator asked to subscribe and it did not happen. The
    // client must be able to tell "stored" from "not stored" without parsing prose.
    return NextResponse.json(
      { ok: false, configured: false, error: config.reason },
      { status: 503, headers: cors },
    )
  }

  try {
    const body = await parseJsonSafe(request)
    const result = await savePushSubscription({
      subscription: body.subscription,
      userKey: body.user_key ?? body.userKey ?? null,
      userAgent: request.headers.get('user-agent'),
    })

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400, headers: cors })
    }
    return NextResponse.json({ ok: true, configured: true }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'push_subscribe_failed' },
      { status: 500, headers: cors },
    )
  }
}

export async function DELETE(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const body = await parseJsonSafe(request)
    const endpoint = body.endpoint || new URL(request.url).searchParams.get('endpoint')
    const result = await removePushSubscription(endpoint)
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400, headers: cors })
    }
    return NextResponse.json({ ok: true }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'push_unsubscribe_failed' },
      { status: 500, headers: cors },
    )
  }
}
