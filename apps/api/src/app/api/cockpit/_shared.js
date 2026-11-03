import crypto from 'node:crypto'

import { NextResponse } from 'next/server.js'
import { requireOpsDashboardAuth } from '@/lib/security/dashboard-auth.js'

export function newTraceId() {
  return crypto.randomUUID()
}

export function errorPayload(request, error, message, status = 500, extra = {}) {
  return {
    ok: false,
    error,
    message,
    trace_id: newTraceId(),
    path: request?.url ? new URL(request.url).pathname : null,
    ...extra,
  }
}

/** Standard Workflow Studio success envelope. */
export function workflowSuccess(data, startedAt = Date.now()) {
  return {
    ok: true,
    data,
    meta: {
      request_id: newTraceId(),
      duration_ms: Math.max(0, Date.now() - startedAt),
    },
  }
}

/** Standard Workflow Studio failure envelope. */
export function workflowError(code, message, retryable = false, startedAt = Date.now()) {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
    meta: {
      request_id: newTraceId(),
      duration_ms: Math.max(0, Date.now() - startedAt),
    },
  }
}

export function workflowErrorFromLegacy(result, startedAt = Date.now()) {
  const code = String(result?.error ?? 'WORKFLOW_REQUEST_FAILED').toUpperCase()
  const message = result?.message ?? result?.error ?? 'Workflow request failed.'
  const retryable = result?.retryable === true || Number(result?.status) >= 500
  return workflowError(code, message, retryable, startedAt)
}

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'https://real-estate-automation-three.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5180',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5199',
])

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/nexus-dashboard(-[a-z0-9]+)*\.vercel\.app$/,
  /^https:\/\/rei-automation-dashboard-[a-z0-9-]+\.vercel\.app$/,
]

function resolveAllowedOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  if (ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) return origin
  return null
}

export function corsHeaders(request) {
  const origin = request.headers.get('origin')
  const allowedOrigin = resolveAllowedOrigin(origin)
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE, PATCH',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, x-ops-dashboard-secret, x-internal-api-secret, x-queue-engine-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

export function getCorsHeaders(request) {
  return corsHeaders(request)
}

export function handleOptionsResponse(request) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request),
  })
}

export function withCors(request, response) {
  const headers = getCorsHeaders(request)
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value)
  })
  return response
}

export function parseJsonSafe(request) {
  return request.json().catch(() => ({}))
}

export function responseFromResult(result, status = 200) {
  return NextResponse.json(result, { status })
}

/**
 * The authenticated operator principal, built SERVER-SIDE from the verified
 * auth result. This is the only place a principal is minted.
 *
 * - `authenticated: true` comes from requireOpsDashboardAuth: the presented
 *   session matched OPS_DASHBOARD_SECRET. In production the browser never holds
 *   that secret; the Cloudflare Worker attaches it only after verifying a
 *   Supabase session against the operator allowlist (infra/cloudflare/worker).
 * - `id` is the Worker-stamped x-ops-user-id: provenance for the audit trail,
 *   never authority (the Worker's own words).
 * - Nothing here reads the request BODY. A body field cannot become a principal.
 *
 * Returns null when the session is not actually authenticated (e.g. a dev
 * process with no secret configured), so callers fall back to the automation
 * authority rather than being granted operator authority by default.
 */
export function resolveOperatorPrincipal(request, auth) {
  if (!auth || auth.ok !== true || auth.authenticated !== true) return null
  const via = String(auth.via ?? '').trim()
  if (!via) return null
  const user_id = String(request?.headers?.get?.('x-ops-user-id') ?? '').trim() || null
  return Object.freeze({
    kind: 'ops_dashboard_operator',
    authenticated: true,
    auth_source: 'ops_dashboard_session',
    via,
    id: user_id,
    email: null,
  })
}

export function ensureMutationAuth(request) {
  const auth = requireOpsDashboardAuth(request)
  if (!auth.authorized) {
    const cors = corsHeaders(request)
    const response = auth.response
    Object.entries(cors).forEach(([key, value]) => {
      response.headers.set(key, value)
    })
    return { ok: false, response, operator: null }
  }
  return { ok: true, auth: auth.auth, operator: resolveOperatorPrincipal(request, auth.auth) }
}

/** Dashboard read auth — same ops-dashboard gate as mutations; named for read routes. */
export function ensureDashboardReadAuth(request) {
  return ensureMutationAuth(request)
}