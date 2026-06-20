import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const { data, error } = await supabase
    .from('smart_inbox_views')
    .select('id,name,icon,color,sort_order,filter_json,is_system,is_pinned,created_at,updated_at')
    .order('sort_order', { ascending: true })

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500, headers: cors })
  }
  return NextResponse.json({ ok: true, views: data || [] }, { status: 200, headers: cors })
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const name = String(body?.name || '').trim()
    const filter_json = body?.filter_json ?? body?.filters ?? {}
    if (!name) {
      return NextResponse.json({ ok: false, error: 'name_required' }, { status: 400, headers: cors })
    }
    const { data, error } = await supabase
      .from('smart_inbox_views')
      .insert({
        name,
        icon: body?.icon || 'filter',
        color: body?.color || null,
        sort_order: Number(body?.sort_order) || 500,
        filter_json,
        is_system: false,
        is_pinned: Boolean(body?.is_pinned),
      })
      .select('id,name,icon,color,sort_order,filter_json,is_system,is_pinned,created_at,updated_at')
      .single()

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500, headers: cors })
    }
    return NextResponse.json({ ok: true, view: data }, { status: 201, headers: cors })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || 'save_view_failed' }, { status: 500, headers: cors })
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}