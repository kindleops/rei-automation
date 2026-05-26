import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'http://localhost:5173',
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
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

function clean(value) {
  return String(value ?? '').trim()
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    
    // Delegate entirely to live-inbox-service to bypass the broken 15s timeout on v_operator_inbox_threads
    const { getLiveInbox } = await import('@/lib/domain/inbox/live-inbox-service.js')
    
    // Map bucket parameter to filter parameter for live-inbox
    const bucket = clean(searchParams.get('bucket')) || 'all'
    const params = Object.fromEntries(searchParams.entries())
    if (bucket && bucket !== 'all' && !params.filter) {
      params.filter = bucket
    }
    
    const data = await getLiveInbox(params)
    
    return NextResponse.json({ 
      ok: true, 
      action: 'inbox-live-fallback',
      data: {
        threads: data.threads,
        counts: data.counts,
        pagination: data.pagination
      },
      diagnostics: data 
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
