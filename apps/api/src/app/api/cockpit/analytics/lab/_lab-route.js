/**
 * ANALYTICS LAB — shared route plumbing: dashboard read auth, CORS, the query
 * contract (?ctx= base64url JSON), error mapping and timing. GET only; the Lab
 * never mutates business state.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { ContractError, decodeContext, normalizeContext } from '@/lib/domain/analytics/lab/query-contract.js'

export function options(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function handle(request, fn, { needsContext = true } = {}) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  const url = new URL(request.url)
  const t0 = Date.now()
  try {
    const ctx = needsContext ? normalizeContext(decodeContext(url.searchParams.get('ctx'))) : null
    const data = await fn({ ctx, url })
    const ms = Date.now() - t0
    return NextResponse.json({ ok: true, data }, { status: 200, headers: { ...headers, 'Server-Timing': `lab;dur=${ms}`, 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof ContractError) {
      return NextResponse.json({ ok: false, errorType: 'contract_error', error: error.message, detail: error.detail || null }, { status: 400, headers })
    }
    console.error('analytics.lab_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'analytics_lab_failed', message: error?.message || null, source: error?.source || null, retryable: true }, { status: 500, headers })
  }
}

/** A JSON object carried in a base64url query parameter (cohort specs). */
export function jsonParam(url, name) {
  const raw = url.searchParams.get(name)
  if (!raw) return {}
  if (raw.length > 4000) throw new ContractError(`${name} too long`)
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) } catch { throw new ContractError(`${name} is not valid base64url JSON`) }
}
