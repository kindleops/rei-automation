import { NextResponse } from 'next/server.js'
import { parseJsonSafe, ensureMutationAuth } from '../../_shared.js'
import { runInboxAction } from '@/lib/cockpit/cockpit-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── CORS ──────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
])

function resolveAllowedOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  if (/^https:\/\/nexus-dashboard(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) return origin
  return null
}

function corsHeaders(request) {
  const origin = request.headers.get('origin')
  const allowedOrigin = resolveAllowedOrigin(origin)
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin
  }
  return headers
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return withCors(request, NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors }
    ))
  }
  const payload = await parseJsonSafe(request)
  
  try {
    const result = await runInboxAction({ action: 'send-now', payload: { ...payload, dry_run: false } })
    const status = result.ok ? 200 : (result.reason === 'invalid_canonical_thread_key' ? 400 : 423)
    return withCors(request, NextResponse.json(result, { status, headers: cors }))
  } catch (error) {
    console.error('send-now.failed', { error: error?.message })
    return withCors(request, NextResponse.json(
      { ok: false, error: 'send_now_failed', message: error?.message },
      { status: 500, headers: cors }
    ))
  }
}
