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
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5180',
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

export function parseJsonSafe(request) {
  return request.json().catch(() => ({}))
}

export function responseFromResult(result, status = 200) {
  return NextResponse.json(result, { status })
}

export function ensureMutationAuth(request) {
  const auth = requireOpsDashboardAuth(request)
  if (!auth.authorized) {
    const cors = corsHeaders(request)
    const response = auth.response
    Object.entries(cors).forEach(([key, value]) => {
      response.headers.set(key, value)
    })
    return { ok: false, response }
  }
  return { ok: true, auth: auth.auth }
}

const ALLOWED_ORIGINS = [
  'https://ops.leadcommand.ai',
  'https://real-estate-automation-three.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173'
];

export function getCorsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const allowOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ops-dashboard-secret, x-internal-api-secret, x-queue-engine-secret",
    "Vary": "Origin"
  };
}

export function handleOptionsResponse(request) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request)
  });
}

export function withCors(request, response) {
  const headers = getCorsHeaders(request);
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}
