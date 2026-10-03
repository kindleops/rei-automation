/**
 * Route handler for POST /api/cockpit/archive/bulk, built from injected
 * dependencies so it is testable without a network or a database.
 *
 *   POST { object_type, action: 'archive'|'unarchive', ids: [...], reason? }
 *     → 200 { ok: true, object_type, action, operator_id, summary, partial, results: [{ id, ok, outcome, reason?, message? }] }
 *
 * Auth: the ops-dashboard gate (Worker session + operator allowlist), then the
 * operator the Worker verified (x-ops-user-id). No operator → 401
 * operator_unknown: nothing is archived for "someone". A body never names the actor.
 * Partial failure is per item (200 with partial: true), never all-or-nothing.
 */
import { NextResponse } from 'next/server.js'
import { BulkArchiveError, parseBulkRequest } from './bulk-archive-service.js'

export function operatorIdOf(headers) {
  const v = headers && typeof headers.get === 'function' ? headers.get('x-ops-user-id') : null
  const id = typeof v === 'string' ? v.trim() : ''
  return id && id.length <= 128 ? id : null
}

export function createBulkArchiveRoutes({ getService, authorize, cors }) {
  const json = (body, status, headers) => NextResponse.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store' } })
  return {
    async OPTIONS(request) {
      return new Response(null, { status: 204, headers: cors(request) })
    },
    async POST(request) {
      const headers = cors(request)
      const auth = authorize(request)
      if (!auth.ok) return auth.response
      const operatorId = operatorIdOf(request.headers)
      if (!operatorId) return json({ ok: false, error: 'operator_unknown', message: 'The signed-in operator could not be identified.' }, 401, headers)
      try {
        const parsed = parseBulkRequest(await request.json().catch(() => null))
        const service = await getService()
        const result = await service.run(parsed, operatorId)
        return json({ ok: true, ...result }, 200, headers)
      } catch (error) {
        if (error instanceof BulkArchiveError) return json({ ok: false, error: error.code, message: error.message }, error.status, headers)
        console.error('bulk_archive.failed', error?.message || error)
        return json({ ok: false, error: 'bulk_archive_failed', message: 'The bulk archive could not run right now.', retryable: true }, 500, headers)
      }
    },
  }
}
