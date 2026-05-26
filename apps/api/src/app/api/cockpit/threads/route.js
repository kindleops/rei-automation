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

  // ensureMutationAuth returns null on success and a NextResponse on failure.
  // Older generated routes expected { ok, response }, so handle both shapes safely.
  if (auth instanceof Response) {
    return auth
  }

  if (auth && auth.ok === false) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    
    const inbox_bucket = searchParams.get('inbox_bucket')
    const universal_status = searchParams.get('universal_status')
    const universal_stage = searchParams.get('universal_stage')
    const include_suppressed = searchParams.get('include_suppressed') === 'true'
    
    let query = supabase.from('v_universal_inbox_threads').select('*', { count: 'exact' })
    
    if (inbox_bucket && inbox_bucket !== 'all_messages') {
      query = query.eq('inbox_category', inbox_bucket)
    }
    
    if (universal_status) {
      query = query.eq('inbox_status', universal_status)
    }
    
    if (universal_stage) {
      query = query.eq('conversation_stage', universal_stage)
    }
    
    if (!include_suppressed && inbox_bucket !== 'suppressed' && inbox_bucket !== 'all_messages') {
      query = query.neq('inbox_status', 'suppressed')
    }
    
    // Order by latest message by default
    query = query.order('last_message_at', { ascending: false, nullsFirst: false })
    
    const { data, count, error } = await query.limit(50)
    
    if (error) throw error
    
    return NextResponse.json({ 
      ok: true, 
      data: {
        threads: data,
        count
      }
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
