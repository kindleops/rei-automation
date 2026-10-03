/**
 * Route handlers for /api/cockpit/home/instruments?kind=deal|comps|buyers|entity|queue
 * (dependency-injected for tests). 60s cache + single flight per kind.
 */
import { NextResponse } from 'next/server.js'
import { createHomeInstrumentsReader, INSTRUMENT_KINDS } from './home-instruments-service.js'
import { createReadCache } from './home-read-kit.js'

export function createHomeInstrumentsRoutes({ authorize, cors, read = createHomeInstrumentsReader(), now = () => Date.now() } = {}) {
  const cache = createReadCache({ ttlMs: 60_000, now })
  return {
    async OPTIONS(request) {
      return new Response(null, { status: 204, headers: cors(request) })
    },
    async GET(request) {
      const headers = cors(request)
      const auth = authorize(request)
      if (!auth.ok) return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
      const kind = new URL(request.url).searchParams.get('kind') || ''
      if (!INSTRUMENT_KINDS.includes(kind)) return NextResponse.json({ ok: false, errorType: 'bad_request', error: 'unknown_kind', kinds: INSTRUMENT_KINDS }, { status: 400, headers })
      const started = now()
      try {
        const data = await cache(kind, () => read(kind))
        return NextResponse.json({ ok: true, kind, data, ms: now() - started }, { status: 200, headers })
      } catch (error) {
        console.error('home.instruments_failed', { kind, message: error?.message })
        return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'home_instruments_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
      }
    },
  }
}
