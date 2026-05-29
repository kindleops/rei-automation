import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)

  if (!auth.ok) return auth.response

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
