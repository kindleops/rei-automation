import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../_shared.js'
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

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { thread_key } = params
    
    const { data, error } = await supabase
      .from('deal_thread_state')
      .select('*')
      .eq('thread_key', thread_key)
      .single()
      
    if (error) throw error
    
    return NextResponse.json({ ok: true, data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}

export async function PATCH(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { thread_key } = params
    const updates = await request.json()
    
    // Fetch current state
    const { data: currentState, error: fetchError } = await supabase
      .from('deal_thread_state')
      .select('universal_status, universal_stage')
      .eq('thread_key', thread_key)
      .single()
      
    if (fetchError) throw fetchError

    // Mark as manually overridden if status or stage is changed
    updates.manually_overridden = true

    const { data, error } = await supabase
      .from('deal_thread_state')
      .update(updates)
      .eq('thread_key', thread_key)
      .select()
      .single()
      
    if (error) throw error
    
    // Write audit log
    await supabase.from('deal_thread_state_events').insert({
      thread_key,
      previous_status: currentState.universal_status,
      new_status: updates.universal_status || currentState.universal_status,
      previous_stage: currentState.universal_stage,
      new_stage: updates.universal_stage || currentState.universal_stage,
      event_type: 'manual_override',
      event_source: 'cockpit_api'
    })
    
    return NextResponse.json({ ok: true, data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
