/**
 * Route handlers for /api/cockpit/analytics/goals, built from injected
 * dependencies so they can be tested without a network or a database.
 *
 *   GET     /goals            → { ok, goals: [row…], catalogue }   the operator's goals
 *   PUT     /goals { goal }   → { ok, goal: row }                  create / update (revision-checked)
 *   DELETE  /goals?goal_id=   → { ok, goal_id, archived }          soft archive (no hard delete)
 *   GET     /goals/progress?goals=<base64url JSON [goal…]>
 *                             → { ok, generated_at, goals: [progress…] }
 *
 * Auth: the ops-dashboard gate (Worker session + operator allowlist), then —
 * for the store — the operator the Worker verified (x-ops-user-id). No
 * operator → 401 operator_unknown: a goal is never written for "someone".
 * Progress is a read over definitions the client holds (server or local
 * copies alike); it never writes.
 */
import { NextResponse } from 'next/server.js'
import { GoalError, goalCatalogue } from './goal-model.js'
import { operatorIdOf } from './goal-service.js'

export function createGoalRoutes({ service, authorize, cors }) {
  const json = (body, status, headers) => NextResponse.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store' } })

  function gate(request, { needOperator = true } = {}) {
    const headers = cors(request)
    const auth = authorize(request)
    if (!auth.ok) return { headers, denied: auth.response }
    const operatorId = operatorIdOf(request.headers)
    if (needOperator && !operatorId) return { headers, denied: json({ ok: false, error: 'operator_unknown', message: 'The signed-in operator could not be identified.' }, 401, headers) }
    return { headers, operatorId }
  }

  function fail(error, headers) {
    if (error instanceof GoalError) {
      const body = { ok: false, error: error.code, message: error.message }
      if (error.code === 'revision_conflict') body.current = error.current ?? null
      // the catalogue is static: a device-only goal list still needs it to offer metrics
      if (error.code === 'goals_store_unavailable') body.catalogue = goalCatalogue()
      return json(body, error.status, headers)
    }
    console.error('analytics.goals_failed', error?.message || error)
    return json({ ok: false, error: 'goals_failed', message: 'Goals could not be read right now.', retryable: true }, 500, headers)
  }

  return {
    async OPTIONS(request) {
      return new Response(null, { status: 204, headers: cors(request) })
    },
    async GET(request) {
      const g = gate(request)
      if (g.denied) return g.denied
      try {
        return json({ ok: true, goals: await service.list(g.operatorId), catalogue: goalCatalogue() }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
    async PUT(request) {
      const g = gate(request)
      if (g.denied) return g.denied
      try {
        const body = await request.json().catch(() => ({}))
        return json({ ok: true, goal: await service.save(g.operatorId, body?.goal) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
    async DELETE(request) {
      const g = gate(request)
      if (g.denied) return g.denied
      try {
        const id = new URL(request.url).searchParams.get('goal_id')
        return json({ ok: true, ...(await service.archive(g.operatorId, id)) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
    async PROGRESS(request) {
      const g = gate(request, { needOperator: false })
      if (g.denied) return g.denied
      try {
        const raw = new URL(request.url).searchParams.get('goals') || ''
        if (raw.length > 12_000) throw new GoalError('invalid_goal', 400, 'goals parameter too long')
        let goals
        try { goals = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : [] } catch { throw new GoalError('invalid_goal', 400, 'goals is not valid base64url JSON') }
        return json({ ok: true, ...(await service.progress(goals)) }, 200, g.headers)
      } catch (error) {
        return fail(error, g.headers)
      }
    },
  }
}
