import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function PATCH(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: cors }
    )
  }

  const { thread_key } = params
  if (!thread_key) {
    return NextResponse.json(
      { ok: false, error: 'missing_thread_key' },
      { status: 400, headers: cors }
    )
  }

  try {
    const payload = await request.json()
    const allowedFields = [
      'inbox_bucket',
      'seller_stage',
      'conversation_stage',
      'lead_temperature',
      'review_status',
      'follow_up_at',
      'assigned_operator',
      'suppression_status',
      'notes'
    ]

    const updateData = {}
    
    // Direct mappings
    for (const key of allowedFields) {
      if (payload[key] !== undefined) {
        updateData[key] = payload[key]
      }
    }
    
    // UI field mappings
    if (payload.conversation_status !== undefined) {
      updateData.review_status = payload.conversation_status
    }
    if (payload.temperature !== undefined) {
      updateData.lead_temperature = payload.temperature
    }
    if (payload.autopilot_mode !== undefined) {
      updateData.metadata = { autopilot_mode: payload.autopilot_mode }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ ok: true, ignored: true }, { headers: cors })
    }

    const { data, error } = await supabase
      .from('operator_thread_state')
      .upsert({ thread_key, ...updateData }, { onConflict: 'thread_key' })
      .select()
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
