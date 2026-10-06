import { NextResponse } from 'next/server'
import { hasDisplayCredential, isWallPath } from './src/lib/domain/command-wall/wall-credential.js'

// Explicit allowlist — never a wildcard in production.
// * + credentials:true is invalid per CORS spec and blocked by all browsers.
const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'https://real-estate-automation-three.vercel.app',
])

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOW_HEADERS = 'Content-Type, Authorization, x-ops-dashboard-secret, x-internal-api-secret, x-queue-engine-secret, X-Requested-With, Accept'
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

// Paths that carried CORS before the Command Wall check widened the matcher.
const CORS_PREFIXES = ['/api/cockpit/', '/api/internal/']

/**
 * COMMAND WALL READ-ONLY ENFORCEMENT (defense in depth; tightening only).
 * A display credential is accepted by /api/wall/* and NOTHING else: every
 * other API route — every mutation endpoint included — refuses a request that
 * carries one, before the route runs. Structurally the credential already
 * fails there (it is neither a Supabase session at the Worker nor the
 * dashboard secret in the container); this makes the refusal explicit and
 * independent of either secret being configured.
 */
function refuseDisplayCredential(request) {
  const { pathname } = new URL(request.url)
  if (isWallPath(pathname) || !hasDisplayCredential(request)) return null
  return NextResponse.json(
    { ok: false, error: 'display_credential_forbidden', message: 'A Command Wall display credential cannot call this API.' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  )
}

export function middleware(request) {
  const refused = refuseDisplayCredential(request)
  if (refused) return refused

  const { pathname } = new URL(request.url)
  if (!CORS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next()

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
  // Every API path, so the display-credential refusal covers all of them; CORS
  // behaviour is unchanged (still only /api/cockpit/* and /api/internal/*).
  matcher: ['/api/:path*'],
}
