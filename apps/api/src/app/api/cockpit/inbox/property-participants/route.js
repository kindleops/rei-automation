import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { buildPropertyParticipantGraphResponse } from '@/lib/domain/inbox/property-participant-graph.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

function isMissingRelationError(error) {
  const message = clean(error?.message).toLowerCase()
  return (
    message.includes('does not exist')
    || message.includes('schema cache')
    || (message.includes('relation') && message.includes('property_participant_graph'))
    || (message.includes('could not find the table') && message.includes('property_participant_graph'))
  )
}

async function loadParticipantsFromGraph(property_id, selected_phone) {
  const { data, error } = await supabase
    .from('property_participant_graph')
    .select('*')
    .eq('property_id', property_id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  const selected = rows.find((row) => clean(row.canonical_e164) === clean(selected_phone)) || null
  return buildPropertyParticipantGraphResponse({
    property_id,
    participants: rows,
    selected_participant_id: selected?.participant_id || null,
  })
}

async function loadParticipantsFallback(property_id, selected_phone) {
  const { data, error } = await supabase
    .from('message_events')
    .select('property_id, master_owner_id, prospect_id, from_phone_number, thread_key, received_at, metadata')
    .eq('property_id', property_id)
    .eq('direction', 'inbound')
    .order('received_at', { ascending: false })
    .limit(200)

  if (error) throw error

  const by_phone = new Map()
  for (const row of Array.isArray(data) ? data : []) {
    const phone = clean(row.from_phone_number || row.thread_key)
    if (!phone || by_phone.has(phone)) continue
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    by_phone.set(phone, {
      participant_id: `${property_id}:${phone}`,
      property_id,
      master_owner_id: row.master_owner_id || null,
      prospect_id: row.prospect_id || null,
      canonical_e164: phone,
      display_name: clean(metadata.seller_display_name) || clean(metadata.owner_name) || null,
      relationship_to_property: clean(metadata.identity_class) || 'respondent',
      identity_class: clean(metadata.identity_class) || 'unknown',
      last_message_at: row.received_at || null,
      unread_count: 0,
      safe_to_contact: true,
      is_referred_contact: false,
      is_primary_owner_record: metadata.identity_class === 'confirmed_owner',
    })
  }

  const participants = [...by_phone.values()]
  const selected = participants.find((row) => clean(row.canonical_e164) === clean(selected_phone)) || null
  return buildPropertyParticipantGraphResponse({
    property_id,
    participants,
    selected_participant_id: selected?.participant_id || null,
  })
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const property_id = clean(searchParams.get('property_id') || searchParams.get('propertyId'))
    const selected_phone = clean(
      searchParams.get('selected_phone')
      || searchParams.get('selectedPhone')
      || searchParams.get('canonical_e164')
      || searchParams.get('thread_key'),
    )

    if (!property_id) {
      return NextResponse.json({ ok: false, error: 'property_id_required' }, { status: 400, headers: cors })
    }

    let payload
    try {
      payload = await loadParticipantsFromGraph(property_id, selected_phone)
    } catch (error) {
      if (!isMissingRelationError(error)) throw error
      payload = await loadParticipantsFallback(property_id, selected_phone)
      payload.source = 'message_events_fallback'
    }

    return NextResponse.json({
      ok: true,
      ...payload,
      source: payload.source || 'property_participant_graph',
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors },
    )
  }
}