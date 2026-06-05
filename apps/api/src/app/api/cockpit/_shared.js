import { NextResponse } from 'next/server.js'
import { requireOpsDashboardAuth } from '@/lib/security/dashboard-auth.js'

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
