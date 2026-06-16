import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { phone } = await request.json()
    if (!phone) throw new Error('phone_required')

    const { data, error } = await supabase
      .from('message_events')
      .select('is_opt_out, opt_out_keyword')
      .or(`from_phone_number.eq.${phone},to_phone_number.eq.${phone}`)
      .eq('is_opt_out', true)
      .limit(1)
      .maybeSingle()

    if (error) throw error

    return NextResponse.json({
      ok: true,
      opted_out: Boolean(data?.is_opt_out),
      keyword: data?.opt_out_keyword || null
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
