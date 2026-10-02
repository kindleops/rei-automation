/**
 * One fired signal — POST /api/cockpit/signals/:id { action: 'acknowledge' | 'resolve' }.
 * Writes only the signal ledger row (who + when). The linked notification keeps
 * its own read/dismiss lifecycle in the notification center.
 */
import { acknowledgeSignal, resolveSignal, SignalError } from '@/lib/domain/signals/signal-service.js'
import { corsHeaders, parseJsonSafe } from '../../_shared.js'
import { fail, guard, ok } from '../_signal-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const g = guard(request)
  if (g.denied) return g.denied
  try {
    const id = String(params?.id || '')
    if (!UUID.test(id)) throw new SignalError('invalid_id', 'Signal id must be a uuid.')
    const body = await parseJsonSafe(request)
    if (body.action === 'acknowledge') return ok(await acknowledgeSignal(id, { operatorId: g.operatorId }), g.headers)
    if (body.action === 'resolve') return ok(await resolveSignal(id, { operatorId: g.operatorId }), g.headers)
    throw new SignalError('unknown_action', 'action must be acknowledge or resolve.')
  } catch (error) {
    return fail(error, g.headers, 'signals.signal_write_failed')
  }
}
