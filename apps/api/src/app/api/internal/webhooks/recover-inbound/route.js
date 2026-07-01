import { NextResponse } from 'next/server.js'

import { processInboundWebhookRecovery } from '@/lib/domain/webhooks/webhook-event-processor.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { requireSharedSecretAuth } from '@/lib/security/shared-secret.js'
import { requireCronAuth } from '@/lib/security/cron-auth.js'
import { setSystemValues } from '@/lib/system-control.js'

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
  const result = await processInboundWebhookRecovery(
    {
      limit: Number(body.limit ?? 25),
      auto_reply_mode: body.auto_reply_mode || null,
    },
    { supabase },
  )

  if (body.dry_run !== true) {
    await setSystemValues({
      webhook_inbound_recovery_last_at: new Date().toISOString(),
      webhook_inbound_recovery_last_processed: String(result.processed ?? 0),
    }).catch(() => {})
  }

  return {
    ok: result.ok !== false,
    route: 'internal/webhooks/recover-inbound',
    ...result,
  }
}

export async function GET(request) {
  const auth = requireAuth(request)
  if (!auth.authorized) return auth.response

  try {
    const result = await runRecovery({ limit: 10 })
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: 'inbound_recovery_failed', error: error?.message || 'failed' },
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
      { ok: false, reason: 'inbound_recovery_failed', error: error?.message || 'failed' },
      { status: 500 },
    )
  }
}