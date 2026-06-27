import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { buildPropertyParticipantGraphResponse } from '@/lib/domain/inbox/property-participant-graph.js'
import {
  enrichParticipantRow,
  rankParticipants,
  selectNextEligibleParticipant,
} from '@/lib/domain/inbox/participant-intelligence.js'

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

async function loadPropertyContext(property_id) {
  const { data: propertyRow } = await supabase
    .from('properties')
    .select('property_id, master_owner_id, property_address_full')
    .eq('property_id', property_id)
    .maybeSingle()

  const master_owner_id = clean(propertyRow?.master_owner_id)
  let master_owner_name = null
  if (master_owner_id) {
    const { data: ownerRow } = await supabase
      .from('master_owners')
      .select('master_owner_id, display_name, full_name, owner_name')
      .eq('master_owner_id', master_owner_id)
      .maybeSingle()
    master_owner_name = clean(ownerRow?.display_name || ownerRow?.full_name || ownerRow?.owner_name) || null
  }

  return {
    property_id,
    master_owner_id: master_owner_id || null,
    master_owner_name,
    property_address_full: clean(propertyRow?.property_address_full) || null,
  }
}

async function loadProspectPhoneIndex(property_id, master_owner_id) {
  const prospectById = new Map()
  const phoneByE164 = new Map()

  if (master_owner_id) {
    const { data: prospects } = await supabase
      .from('prospects')
      .select('prospect_id, master_owner_id, full_name, first_name, last_name, relationship_type, matching_flags, person_flags_text, likely_owner, likely_renting, contact_score, sms_eligible, status')
      .eq('master_owner_id', master_owner_id)
      .limit(100)
    for (const row of Array.isArray(prospects) ? prospects : []) {
      prospectById.set(clean(row.prospect_id), row)
    }

    const { data: phones } = await supabase
      .from('phones')
      .select('phone_id, master_owner_id, property_id, prospect_id, canonical_e164, phone_number, score, rank, sms_status, status, wireless_status, last_contacted, last_reply')
      .or(`property_id.eq.${property_id},master_owner_id.eq.${master_owner_id}`)
      .limit(200)
    for (const row of Array.isArray(phones) ? phones : []) {
      const e164 = clean(row.canonical_e164 || row.phone_number)
      if (e164) phoneByE164.set(e164, row)
    }
  }

  return { prospectById, phoneByE164 }
}

async function loadLatestInboundMessage(property_id, phone) {
  if (!phone) return null
  const { data } = await supabase
    .from('message_events')
    .select('id, message_body, received_at, direction')
    .eq('property_id', property_id)
    .eq('from_phone_number', phone)
    .eq('direction', 'inbound')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return clean(data?.message_body) || null
}

function mergeParticipantRecord(base = {}, { prospectById, phoneByE164, latestInboundMessage } = {}) {
  const phone = clean(base.canonical_e164)
  const phoneRow = phone ? phoneByE164.get(phone) : null
  const prospectId = clean(base.prospect_id || phoneRow?.prospect_id)
  const prospect = prospectId ? prospectById.get(prospectId) : null

  const displayName = clean(
    base.display_name
    || prospect?.full_name
    || [prospect?.first_name, prospect?.last_name].filter(Boolean).join(' ')
    || null,
  )

  const merged = {
    ...base,
    prospect_id: prospectId || base.prospect_id || null,
    phone_id: base.phone_id || phoneRow?.phone_id || null,
    display_name: displayName || base.display_name || null,
    relationship_to_property: base.relationship_to_property
      || prospect?.relationship_type
      || 'respondent',
    matching_flags: base.matching_flags || prospect?.matching_flags || null,
    person_flags_text: base.person_flags_text || prospect?.person_flags_text || null,
    likely_owner: base.likely_owner === true || prospect?.likely_owner === true,
    likely_renting: base.likely_renting === true || prospect?.likely_renting === true,
    contact_score: base.contact_score ?? prospect?.contact_score ?? phoneRow?.score ?? null,
    best_phone_score: base.best_phone_score ?? phoneRow?.score ?? null,
    sms_eligible: base.sms_eligible ?? (prospect?.sms_eligible !== false && phoneRow?.sms_status !== 'Invalid'),
    contactability: base.safe_to_contact === false ? 'blocked' : 'contactable',
    active_thread_state: base.unread_count > 0 ? 'active' : (base.last_message_at ? 'recent' : 'inactive'),
  }

  return enrichParticipantRow(merged, { latest_inbound_message: latestInboundMessage })
}

async function enrichParticipants(participants = [], context = {}) {
  const { prospectById, phoneByE164, property_id, master_owner_name } = context
  const enriched = []
  for (const row of participants) {
    const latestInboundMessage = await loadLatestInboundMessage(property_id, clean(row.canonical_e164))
    enriched.push(mergeParticipantRecord(row, { prospectById, phoneByE164, latestInboundMessage }))
  }
  return rankParticipants(enriched, {
    master_owner_name,
    selected_phone: context.selected_phone,
  })
}

async function loadParticipantsFromGraph(property_id, selected_phone, context) {
  const { data, error } = await supabase
    .from('property_participant_graph')
    .select('*')
    .eq('property_id', property_id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  const participants = await enrichParticipants(rows, {
    ...context,
    property_id,
    selected_phone,
  })
  const selected = participants.find((row) => clean(row.canonical_e164) === clean(selected_phone)) || null
  return buildPropertyParticipantGraphResponse({
    property_id,
    participants,
    selected_participant_id: selected?.participant_id || null,
  })
}

async function loadParticipantsFallback(property_id, selected_phone, context) {
  const { data, error } = await supabase
    .from('message_events')
    .select('property_id, master_owner_id, prospect_id, from_phone_number, thread_key, received_at, metadata, message_body')
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
      master_owner_id: row.master_owner_id || context.master_owner_id || null,
      prospect_id: row.prospect_id || null,
      canonical_e164: phone,
      display_name: clean(metadata.seller_display_name) || clean(metadata.prospect_name) || null,
      relationship_to_property: clean(metadata.identity_class) || 'respondent',
      identity_class: clean(metadata.identity_class) || 'unknown',
      last_message_at: row.received_at || null,
      unread_count: 0,
      safe_to_contact: true,
      is_referred_contact: false,
      is_primary_owner_record: metadata.identity_class === 'confirmed_owner',
      ownership_status: metadata.ownership_status || null,
    })
  }

  const participants = await enrichParticipants([...by_phone.values()], {
    ...context,
    property_id,
    selected_phone,
  })
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
    const preview_next = ['1', 'true', 'yes'].includes(lower(searchParams.get('preview_next') || ''))

    if (!property_id) {
      return NextResponse.json({ ok: false, error: 'property_id_required' }, { status: 400, headers: cors })
    }

    const propertyContext = await loadPropertyContext(property_id)
    const indexes = await loadProspectPhoneIndex(property_id, propertyContext.master_owner_id)
    const context = {
      ...propertyContext,
      ...indexes,
      selected_phone,
    }

    let payload
    try {
      payload = await loadParticipantsFromGraph(property_id, selected_phone, context)
    } catch (error) {
      if (!isMissingRelationError(error)) throw error
      payload = await loadParticipantsFallback(property_id, selected_phone, context)
      payload.source = 'message_events_fallback'
    }

    const nextEligible = selectNextEligibleParticipant(payload.participants || [], {
      current_phone: selected_phone,
      master_owner_name: propertyContext.master_owner_name,
    })

    return NextResponse.json({
      ok: true,
      ...payload,
      master_owner_name: propertyContext.master_owner_name,
      master_owner_household_label: propertyContext.master_owner_name
        ? `${propertyContext.master_owner_name} household`
        : null,
      property_address_full: propertyContext.property_address_full,
      next_eligible_contact: preview_next ? nextEligible.selected : nextEligible.selected,
      next_eligible_reason: nextEligible.reason,
      next_eligible_selection_log: nextEligible.selection_log,
      source: payload.source || 'property_participant_graph',
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors },
    )
  }
}

function lower(value) {
  return clean(value).toLowerCase()
}