import { NextResponse } from 'next/server.js'

import { recoverDeliveryWebhookBacklog } from '@/lib/domain/delivery/delivery-webhook-recovery.js'
import { pollMissingDeliveryCallbacks } from '@/lib/domain/delivery/delivery-polling-fallback.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { requireSharedSecretAuth } from '@/lib/security/shared-secret.js'
import { requireCronAuth } from '@/lib/security/cron-auth.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function requireAuth(request) {
  const cronAuth = requireCronAuth(request)
  if (cronAuth.authorized) {
    return { authorized: true, via: 'vercel_cron' }
  }
  return requireSharedSecretAuth(request, null, {
    env_name: 'INTERNAL_API_SECRET',
    header_names: ['x-internal-api-secret'],
  })
}

async function runRecovery(body = {}) {
  const supabase = getDefaultSupabaseClient()
  const provider_id_batch_size = Number(body.provider_id_batch_size ?? body.batch_size ?? 500)
  const max_duration_ms = Number(body.max_duration_ms ?? 55_000)
  const include_polling = body.include_polling_fallback !== false

  const recovery = await recoverDeliveryWebhookBacklog(
    {
      provider_id_batch_size,
      max_duration_ms,
      max_provider_groups: Number(body.max_provider_groups ?? provider_id_batch_size),
      concurrency: Number(body.concurrency ?? 10),
      provider_message_sids: body.provider_message_sids || body.provider_ids || null,
      cursor: body.cursor || null,
      dry_run: body.dry_run === true,
      force_local_delivery_reconcile: body.force_local_delivery_reconcile === true,
    },
    { supabase },
  )

  let polling = null
  if (include_polling && body.dry_run !== true) {
    polling = await pollMissingDeliveryCallbacks(
      { limit: Number(body.polling_limit ?? 25) },
      { supabase },
    ).catch((error) => ({
      ok: false,
      reason: error?.message || 'polling_failed',
    }))
  }

  return {
    ok: recovery.ok !== false,
    route: 'internal/webhooks/recover-delivery',
    recovery,
    polling_fallback: polling,
  }
}

export async function GET(request) {
  const auth = requireAuth(request)
  if (!auth.authorized) return auth.response

  try {
    const result = await runRecovery({ provider_id_batch_size: 500, max_duration_ms: 55_000 })
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: 'delivery_recovery_failed', error: error?.message || 'failed' },
      { status: 500 },
    )
  }
}

export async function POST(request) {
  const auth = requireAuth(request)
  if (!auth.authorized) return auth.response

  try {
    const body = await request.json().catch(() => ({}))
    const result = await runRecovery(body)
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: 'delivery_recovery_failed', error: error?.message || 'failed' },
      { status: 500 },
    )
  }
}