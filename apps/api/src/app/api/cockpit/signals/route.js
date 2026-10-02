/**
 * SIGNAL CENTER read model — GET /api/cockpit/signals.
 * Gate, schema readiness (tables_ready:false → "Setup required"), rules with
 * their arming + firing subjects, the fired-signal ledger, watches, evaluator
 * checkpoints and the legacy scans each rule retires. Read-only.
 */
import { getSignalCenter } from '@/lib/domain/signals/signal-service.js'
import { corsHeaders } from '../_shared.js'
import { fail, guard, ok } from './_signal-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const g = guard(request)
  if (g.denied) return g.denied
  try {
    return ok(await getSignalCenter(), g.headers)
  } catch (error) {
    return fail(error, g.headers, 'signals.read_failed')
  }
}
