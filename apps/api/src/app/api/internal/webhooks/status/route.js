import { NextResponse } from 'next/server.js'

import { getWebhookProcessingStatus } from '@/lib/domain/webhooks/webhook-observability.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { requireSharedSecretAuth } from '@/lib/security/shared-secret.js'
import { requireCronAuth } from '@/lib/security/cron-auth.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function GET(request) {
  const auth = requireAuth(request)
  if (!auth.authorized) return auth.response

  try {
    const status = await getWebhookProcessingStatus({}, { supabase: getDefaultSupabaseClient() })
    return NextResponse.json({ ok: true, route: 'internal/webhooks/status', ...status })
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: 'webhook_status_failed', error: error?.message || 'failed' },
      { status: 500 },
    )
  }
}