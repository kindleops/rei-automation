import { createClient } from '@supabase/supabase-js'

const PROPERTY_IDS = ['2100277107', '2100278140', '2100277008', '273415177']

const run = async () => {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Missing Supabase credentials')
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  for (const propertyId of PROPERTY_IDS) {
    const probes = await Promise.all([
      supabase.from('properties').select('property_id,master_owner_id,property_address_full').eq('property_id', propertyId).maybeSingle(),
      supabase.from('v_seller_work_items').select('property_id,master_owner_id,prospect_id,prospect_best_phone,display_phone').eq('property_id', propertyId).maybeSingle(),
      supabase.from('v_command_map_seller_pin_feed').select('property_id,master_owner_id,prospect_id,seller_state,thread_key').eq('property_id', propertyId).maybeSingle(),
      supabase.from('property_participant_graph').select('property_id,master_owner_id,prospect_id,canonical_e164,phone_id').eq('property_id', propertyId).limit(3),
      supabase.from('map_filter_property_prospect_links').select('property_id,master_owner_id,prospect_id').eq('property_id', propertyId).limit(3),
      supabase.from('universal_lead_command_cache').select('property_id,master_owner_id,prospect_id,contact_channel_value').eq('property_id', propertyId).limit(3),
    ])

    const masterOwnerId = String(
      probes[0].data?.master_owner_id
      || probes[1].data?.master_owner_id
      || probes[2].data?.master_owner_id
      || '',
    ).trim() || null

    let masterOwner: Record<string, unknown> | null = null
    let prospect: Record<string, unknown> | null = null
    let phones: Record<string, unknown>[] = []

    if (masterOwnerId) {
      const ownerRes = await supabase
        .from('master_owners')
        .select('master_owner_id,best_phone_1,primary_phone_id,agent_persona')
        .eq('master_owner_id', masterOwnerId)
        .maybeSingle()
      masterOwner = (ownerRes.data as Record<string, unknown> | null) ?? null

      const phoneRes = await supabase
        .from('phones')
        .select('phone_id,canonical_e164,canonical_prospect_id,primary_prospect_id')
        .eq('master_owner_id', masterOwnerId)
        .limit(5)
      phones = (phoneRes.data as Record<string, unknown>[] | null) ?? []
    }

    const prospectId = String(probes[1].data?.prospect_id || probes[2].data?.prospect_id || '').trim() || null
    if (prospectId) {
      const prospectRes = await supabase
        .from('prospects')
        .select('prospect_id,best_phone,first_name,full_name,sms_eligible,master_owner_id')
        .eq('prospect_id', prospectId)
        .maybeSingle()
      prospect = (prospectRes.data as Record<string, unknown> | null) ?? null
    }

    console.log(JSON.stringify({
      property_id: propertyId,
      properties: { data: probes[0].data, error: probes[0].error?.message ?? null },
      work_item: { data: probes[1].data, error: probes[1].error?.message ?? null },
      pin_feed: { data: probes[2].data, error: probes[2].error?.message ?? null },
      graph: { count: Array.isArray(probes[3].data) ? probes[3].data.length : 0, error: probes[3].error?.message ?? null, sample: Array.isArray(probes[3].data) ? probes[3].data[0] : null },
      prospect_links: { count: Array.isArray(probes[4].data) ? probes[4].data.length : 0, error: probes[4].error?.message ?? null },
      cache: { count: Array.isArray(probes[5].data) ? probes[5].data.length : 0, error: probes[5].error?.message ?? null, sample: Array.isArray(probes[5].data) ? probes[5].data[0] : null },
      master_owner: masterOwner,
      master_owner_error: masterOwnerId && !masterOwner ? 'lookup_empty' : null,
      prospect,
      phones,
    }, null, 2))
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})