import { NextResponse } from 'next/server'

// Explicit allowlist — never a wildcard in production.
// * + credentials:true is invalid per CORS spec and blocked by all browsers.
const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
])

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOW_HEADERS = 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept'
const MAX_AGE = '86400'

function resolveOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  // Allow any nexus-dashboard Vercel preview deployment during testing
  if (/^https:\/\/nexus-dashboard(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) return origin
  return null
}

function setCorsHeaders(headers, allowedOrigin) {
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin)
    headers.set('Vary', 'Origin')
  }
  headers.set('Access-Control-Allow-Methods', ALLOW_METHODS)
  headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS)
  headers.set('Access-Control-Max-Age', MAX_AGE)
  // No Access-Control-Allow-Credentials — header-based auth (Bearer/x-ops-dashboard-secret)
  // does not require credentials mode and wildcard+credentials is spec-invalid.
}

export function middleware(request) {
  const origin = request.headers.get('origin') || ''
  const allowedOrigin = resolveOrigin(origin)

  // Preflight: short-circuit with 204, no auth required.
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    setCorsHeaders(response.headers, allowedOrigin)
    return response
  }

  // Pass request to the route handler; inject CORS headers on the response.
  const response = NextResponse.next()
  setCorsHeaders(response.headers, allowedOrigin)
  return response
}

export const config = {
  matcher: ['/api/cockpit/:path*', '/api/internal/:path*'],
}
