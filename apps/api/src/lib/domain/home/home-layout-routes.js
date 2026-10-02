/**
 * Route handlers for /api/cockpit/home/layouts, built from injected
 * dependencies so they can be tested without a network or a database.
 *
 *   GET     → { ok, layouts: [row…] }               the operator's saved layouts
 *   PUT     { layout } → { ok, layout: row }        create / update (revision-checked)
 *   DELETE  ?layout_id= → { ok, layout_id }
 *
 * Auth: the ops-dashboard gate (Worker session + operator allowlist), then the
 * operator the Worker verified (x-ops-user-id). No operator → 401
 * operator_unknown: a layout is never written for "someone".
 */
import { NextResponse } from 'next/server.js'
import { HomeLayoutError, operatorIdOf } from './home-layout-service.js'

export function createHomeLayoutRoutes({ service, authorize, cors }) {
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
    if (error instanceof HomeLayoutError) {
      const body = { ok: false, error: error.code, message: error.message }
      if (error.code === 'revision_conflict') body.current = error.current ?? null
      return json(body, error.status, headers)
    }
    console.error('home.layouts_failed', error?.message || error)
    return json({ ok: false, error: 'home_layouts_failed', message: 'Home layouts could not be read right now.', retryable: true }, 500, headers)
  }

  return {
    async OPTIONS(request) {
      return new Response(null, { status: 204, headers: cors(request) })
    },
    async GET(request) {
      const g = guard(request)
      if (g.denied) return g.denied
      try {
        return json({ ok: true, layouts: await service.list(g.operatorId) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
    async PUT(request) {
      const g = guard(request)
      if (g.denied) return g.denied
      try {
        const body = await request.json().catch(() => ({}))
        return json({ ok: true, layout: await service.save(g.operatorId, body?.layout) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
    async DELETE(request) {
      const g = guard(request)
      if (g.denied) return g.denied
      try {
        const id = new URL(request.url).searchParams.get('layout_id')
        return json({ ok: true, ...(await service.remove(g.operatorId, id)) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
  }
}
