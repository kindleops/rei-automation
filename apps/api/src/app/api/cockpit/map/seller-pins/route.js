import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
    const min_lat = parseFloat(searchParams.get('min_lat') ?? '')
    const min_lng = parseFloat(searchParams.get('min_lng') ?? '')
    const max_lat = parseFloat(searchParams.get('max_lat') ?? '')
    const max_lng = parseFloat(searchParams.get('max_lng') ?? '')
    const zoom_level = Math.max(1, Math.min(22, parseInt(searchParams.get('zoom_level') ?? '10', 10)))
    const max_rows = Math.min(parseInt(searchParams.get('max_rows') ?? '1000', 10), 2000)

    if (isNaN(min_lat) || isNaN(min_lng) || isNaN(max_lat) || isNaN(max_lng)) {
      return NextResponse.json(
        { ok: false, error: 'missing_bounds', required: ['min_lat', 'min_lng', 'max_lat', 'max_lng'] },
        { status: 400, headers: cors },
      )
    }

    const { data, error } = await supabase.rpc('get_command_map_seller_pins', {
      min_lat,
      min_lng,
      max_lat,
      max_lng,
      zoom_level,
      max_rows,
    })

    if (error) throw error

    return NextResponse.json({ ok: true, data: data ?? [] }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors },
    )
  }
}
