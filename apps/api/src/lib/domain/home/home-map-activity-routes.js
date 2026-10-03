/**
 * Route handlers for /api/cockpit/home/map-activity, dependency-injected so the
 * contract is testable without a network. A 30s cache with single-flight
 * collapses concurrent Home boards asking for the same lens/period into one read.
 */
import { NextResponse } from 'next/server.js'
import { getHomeMapActivity, MAP_LENSES } from './home-map-activity-service.js'
import { createReadCache } from './home-read-kit.js'

const SAFE = /^[\w:.+-]{1,64}$/
const RANGES = ['today', '7d', '30d']

export function createHomeMapActivityRoutes({ authorize, cors, read = getHomeMapActivity, now = () => Date.now() } = {}) {
  const cache = createReadCache({ ttlMs: 30_000, now })
  // `today` carries the operator's local midnight; bucket the key to the minute.
  const cached = (params) => cache(`${params.lens}|${params.range}|${params.start ? params.start.slice(0, 16) : ''}`, () => read(params))

  return {
    async OPTIONS(request) {
      return new Response(null, { status: 204, headers: cors(request) })
    },
    async GET(request) {
      const headers = cors(request)
      const auth = authorize(request)
      if (!auth.ok) return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
      const url = new URL(request.url)
      const pick = (k) => { const v = (url.searchParams.get(k) || '').trim(); return v && SAFE.test(v) ? v : null }
      const lens = pick('lens') || 'replies'
      const range = pick('range') || '7d'
      if (!MAP_LENSES.includes(lens)) return NextResponse.json({ ok: false, errorType: 'bad_request', error: 'unknown_lens', lenses: MAP_LENSES }, { status: 400, headers })
      if (!RANGES.includes(range)) return NextResponse.json({ ok: false, errorType: 'bad_request', error: 'unknown_range', ranges: RANGES }, { status: 400, headers })
      try {
        const data = await cached({ lens, range, start: range === 'today' ? pick('start') : null })
        return NextResponse.json({ ok: true, data }, { status: 200, headers })
      } catch (error) {
        console.error('home.map_activity_failed', { lens, range, message: error?.message })
        return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'home_map_activity_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
      }
    },
  }
}
