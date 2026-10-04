/**
 * Route handlers for /api/cockpit/lead-visibility (injected deps → testable).
 *
 *   GET  ?thread_keys=+1…,+1…   → { ok, enabled, reason, pending: [...] }
 *        `enabled` tells the dashboard which archive path to use; `pending` are
 *        "reply on archived deals, property unclear" markers (only when enabled).
 *   POST { action, thread_keys?, opportunity_ids?, scope_choice?, reason?,
 *          action_id?, undo_of?, source? }
 *        → 200 { ok, action_id, status, summary, results, needs_scope?, undo }
 *        → 409 lead_visibility_disabled while the flag is off or the schema is
 *          missing — the caller keeps today's path, nothing is written.
 *
 * Auth: the mutation gate, then the Worker-verified operator (x-ops-user-id).
 */
import { NextResponse } from 'next/server.js'
import { LeadVisibilityError, parseVisibilityRequest } from './lead-visibility-service.js'

export function operatorIdOf(headers) {
  const v = headers && typeof headers.get === 'function' ? headers.get('x-ops-user-id') : null
  const id = typeof v === 'string' ? v.trim() : ''
  return id && id.length <= 128 ? id : null
}

export function createLeadVisibilityRoutes({ getGate, getService, authorize, cors }) {
  const json = (body, status, headers) => NextResponse.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store' } })
  return {
    async OPTIONS(request) {
      return new Response(null, { status: 204, headers: cors(request) })
    },
    async GET(request) {
      const headers = cors(request)
      const auth = authorize(request)
      if (!auth.ok) return auth.response
      const gate = await getGate()
      if (!gate.enabled) return json({ ok: true, enabled: false, reason: gate.reason, pending: [] }, 200, headers)
      try {
        const keys = (new URL(request.url).searchParams.get('thread_keys') || '').split(',').map((k) => k.trim()).filter(Boolean)
        const pending = keys.length ? await (await getService()).listPending(keys) : []
        return json({ ok: true, enabled: true, reason: gate.reason, pending }, 200, headers)
      } catch (error) {
        console.error('lead_visibility.pending_failed', error?.message || error)
        return json({ ok: true, enabled: true, reason: gate.reason, pending: [], pending_unavailable: true }, 200, headers)
      }
    },
    async POST(request) {
      const headers = cors(request)
      const auth = authorize(request)
      if (!auth.ok) return auth.response
      const operatorId = operatorIdOf(request.headers)
      if (!operatorId) return json({ ok: false, error: 'operator_unknown', message: 'The signed-in operator could not be identified.' }, 401, headers)
      const gate = await getGate()
      if (!gate.enabled) return json({ ok: false, error: 'lead_visibility_disabled', reason: gate.reason }, 409, headers)
      try {
        const parsed = parseVisibilityRequest(await request.json().catch(() => null))
        const result = await (await getService()).apply(parsed, operatorId)
        return json({ ok: true, ...result }, 200, headers)
      } catch (error) {
        if (error instanceof LeadVisibilityError) return json({ ok: false, error: error.code, message: error.message }, error.status, headers)
        console.error('lead_visibility.failed', error?.message || error)
        return json({ ok: false, error: 'lead_visibility_failed', message: 'Archive could not run right now.', retryable: true }, 500, headers)
      }
    },
  }
}
