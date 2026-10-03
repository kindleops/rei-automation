/**
 * Route handlers for /api/cockpit/research/sources, built from injected
 * dependencies so they can be tested without a network or a database.
 *
 *   GET     ?object_type&object_id → { ok, sources: [row…] }   this operator's only
 *   POST    { source }  → { ok, source, created }        attach (+ audit row)
 *   POST    { report }  → { ok, destination_id }         report a broken destination (audit only)
 *   DELETE  ?research_source_id=  → { ok, research_source_id }   soft remove (+ audit row)
 *
 * Auth: the ops-dashboard gate (Worker session + operator allowlist), then the
 * operator the Worker verified (x-ops-user-id). No operator → 401
 * operator_unknown: a source is never attributed to "someone".
 */
import { NextResponse } from 'next/server.js'
import { ResearchSourceError, operatorIdOf } from './research-sources-service.js'

export function createResearchSourcesRoutes({ service, authorize, cors }) {
  const json = (body, status, headers) => NextResponse.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store' } })

  function guard(request) {
    const headers = cors(request)
    const auth = authorize(request)
    if (!auth.ok) return { headers, denied: auth.response }
    const operatorId = operatorIdOf(request.headers)
    if (!operatorId) return { headers, denied: json({ ok: false, error: 'operator_unknown', message: 'The signed-in operator could not be identified.' }, 401, headers) }
    return { headers, operatorId }
  }

  function fail(error, headers) {
    if (error instanceof ResearchSourceError) return json({ ok: false, error: error.code, message: error.message }, error.status, headers)
    console.error('research.sources_failed', error?.message || error)
    return json({ ok: false, error: 'research_sources_failed', message: 'Research sources could not be read right now.', retryable: true }, 500, headers)
  }

  return {
    async OPTIONS(request) {
      return new Response(null, { status: 204, headers: cors(request) })
    },
    async GET(request) {
      const g = guard(request)
      if (g.denied) return g.denied
      try {
        const q = new URL(request.url).searchParams
        return json({ ok: true, sources: await service.list(g.operatorId, q.get('object_type'), q.get('object_id')) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
    async POST(request) {
      const g = guard(request)
      if (g.denied) return g.denied
      try {
        const body = await request.json().catch(() => ({}))
        if (body?.report) return json({ ok: true, ...(await service.report(g.operatorId, body.report)) }, 200, g.headers)
        const r = await service.save(g.operatorId, body?.source)
        return json({ ok: true, source: r.source, created: r.created }, r.created ? 201 : 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
    async DELETE(request) {
      const g = guard(request)
      if (g.denied) return g.denied
      try {
        const id = new URL(request.url).searchParams.get('research_source_id')
        return json({ ok: true, ...(await service.remove(g.operatorId, id)) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
  }
}
