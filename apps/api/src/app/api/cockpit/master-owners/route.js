import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
    const id = clean(searchParams.get('id'))
    const ids = clean(searchParams.get('ids'))
    const search = clean(searchParams.get('search'))
    const limit = parseInt(searchParams.get('limit') ?? '100', 10)

    let query = supabase.from('master_owners').select('*').limit(limit)

    if (id) {
      query = query.eq('master_owner_id', id)
    } else if (ids) {
      const idArray = ids.split(',').map(clean).filter(Boolean)
      if (idArray.length > 0) {
        query = query.in('master_owner_id', idArray)
      }
    } else if (search) {
      query = query.or(`full_name.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`)
    }

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ ok: true, data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
