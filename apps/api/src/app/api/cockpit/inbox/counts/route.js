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
    const counts = {
      priority: 0,
      new_replies: 0,
      needs_review: 0,
      follow_up: 0,
      cold: 0,
      suppressed: 0,
      all_messages: 0,
      unlinked: 0
    }

    const categories = ['priority', 'new_replies', 'needs_review', 'follow_up', 'cold', 'suppressed', 'unlinked']
    
    // Fetch counts in parallel
    await Promise.all([
      supabase.from('v_universal_inbox_threads').select('*', { count: 'exact', head: true }).then(res => {
        counts.all_messages = res.count || 0
      }),
      ...categories.map(category => 
        supabase.from('v_universal_inbox_threads')
          .select('*', { count: 'exact', head: true })
          .eq('inbox_category', category)
          .then(res => {
            counts[category] = res.count || 0
          })
      )
    ])
    
    return NextResponse.json({ ok: true, data: { counts } }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
