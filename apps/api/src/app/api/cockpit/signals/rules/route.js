/**
 * Arm / disarm one built-in rule — POST /api/cockpit/signals/rules
 * { rule_key, enabled }. Rules are seeded disarmed; arming one does not start
 * the evaluator (that is the Worker ceiling + system_control.signal_center_enabled).
 */
import { setRuleArmed } from '@/lib/domain/signals/signal-service.js'
import { corsHeaders, parseJsonSafe } from '../../_shared.js'
import { fail, guard, ok } from '../_signal-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const g = guard(request)
  if (g.denied) return g.denied
  try {
    const body = await parseJsonSafe(request)
    return ok(await setRuleArmed(String(body.rule_key || ''), body.enabled, { operatorId: g.operatorId }), g.headers)
  } catch (error) {
    return fail(error, g.headers, 'signals.rule_write_failed')
  }
}
