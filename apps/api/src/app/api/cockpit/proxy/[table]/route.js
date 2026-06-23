import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

// URL query strings decode '+' as space. For queue_ids like inbox:send_now:+1XXXXXXXXXX
// the phone segment arrives as " 1XXXXXXXXXX". Restore the '+' so the value matches the DB.
function restoreQueueId(id) {
  return id.replace(/((?:^|:)) (\d{10,11}$)/, '$1+$2')
}

const ALLOWED_TABLES = [
  'message_events',
  'phones',
  'phone_numbers',
  'master_owners'
]

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

  const { table } = await params
  if (!ALLOWED_TABLES.includes(table)) {
    return NextResponse.json({ ok: false, error: 'unauthorized_table' }, { status: 403, headers: cors })
  }

  try {
    const { searchParams } = new URL(request.url)
    const property_id = clean(searchParams.get('property_id'))
    const property_ids = clean(searchParams.get('property_ids'))
    const master_owner_id = clean(searchParams.get('master_owner_id'))
    const master_owner_ids = clean(searchParams.get('master_owner_ids'))
    const queue_ids = clean(searchParams.get('queue_ids'))
    const direction = clean(searchParams.get('direction'))
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '1000', 10), 1000)
    const offset = parseInt(searchParams.get('offset') ?? '0', 10)

    let query = supabase.from(table).select('*')

    if (property_id) {
      query = query.eq('property_id', property_id)
    } else if (property_ids) {
      const idArray = property_ids.split(',').map(clean).filter(Boolean)
      if (idArray.length > 0) query = query.in('property_id', idArray)
    }

    if (master_owner_id) {
      query = query.eq('master_owner_id', master_owner_id)
    } else if (master_owner_ids) {
      const idArray = master_owner_ids.split(',').map(clean).filter(Boolean)
      if (idArray.length > 0) query = query.in('master_owner_id', idArray)
    }

    if (queue_ids) {
      const idArray = queue_ids.split(',').map(clean).map(restoreQueueId).filter(id => id && !id.includes(' ')).slice(0, 200)
      if (idArray.length > 0) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        const validUuids = idArray.filter(id => uuidRegex.test(id))
        const nonUuids = idArray.filter(id => !uuidRegex.test(id))

        if (nonUuids.length > 0) {
          const { data: queueRecords } = await supabase
            .from('send_queue')
            .select('id')
            .in('queue_key', nonUuids)
            
          if (queueRecords) {
            queueRecords.forEach(record => {
              if (record.id && uuidRegex.test(record.id)) {
                validUuids.push(record.id)
              }
            })
          }
        }

        if (validUuids.length > 0) {
          query = query.in('queue_id', validUuids)
        } else {
          query = query.in('queue_id', ['00000000-0000-0000-0000-000000000000'])
        }
      }
    }

    if (direction) {
      query = query.eq('direction', direction)
    }

    if (table === 'message_events') {
      query = query.order('created_at', { ascending: false })
    }

    query = query.limit(limit)
    if (offset > 0) query = query.offset(offset)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ ok: true, data }, { status: 200, headers: cors })
  } catch (error) {
    console.error('[proxy] message_events failed', {
      code: error.code ?? null,
      message: error.message,
      details: error.details ?? null,
      hint: error.hint ?? null,
    })
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code ?? null, details: error.details ?? null, hint: error.hint ?? null },
      { status: 500, headers: cors }
    )
  }
}
