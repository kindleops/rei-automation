/**
 * Route handlers for /api/cockpit/home/metrics (dependency-injected for tests).
 * 30s cache + single-flight per (range, start-minute, market, markets).
 */
import { NextResponse } from 'next/server.js'
import { getHomeMetrics, METRIC_RANGES } from './home-metrics-service.js'
import { createReadCache } from './home-read-kit.js'

const SAFE = /^[\w:.+-]{1,64}$/

export function createHomeMetricsRoutes({ authorize, cors, read = getHomeMetrics, now = () => Date.now() } = {}) {
  const cache = createReadCache({ ttlMs: 30_000, now })
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
      const range = pick('range') || '7d'
      if (!METRIC_RANGES.includes(range)) return NextResponse.json({ ok: false, errorType: 'bad_request', error: 'unknown_range', ranges: METRIC_RANGES }, { status: 400, headers })
      const params = { range, start: range === 'today' ? pick('start') : null, market: pick('market'), withMarkets: url.searchParams.get('markets') === '1' }
      const key = `${params.range}|${params.start ? params.start.slice(0, 16) : ''}|${params.market ?? '*'}|${params.withMarkets ? 'm' : ''}`
      try {
        const data = await cache(key, () => read(params))
        return NextResponse.json({ ok: true, data }, { status: 200, headers })
      } catch (error) {
        console.error('home.metrics_failed', { range, market: params.market, message: error?.message })
        return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'home_metrics_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
      }
    },
  }
}
