import { createClient } from '@supabase/supabase-js'
import { resolveMapOwnershipCheckIdentity } from '../../src/domain/map/resolve-map-ownership-check'

const PROPERTY_IDS = ['2100277107', '2100278140', '273415177']

const run = async () => {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Missing Supabase anon credentials')

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  for (const propertyId of PROPERTY_IDS) {
    const { data: pin, error: pinError } = await supabase
      .from('v_command_map_seller_pin_feed')
      .select('property_id,master_owner_id,prospect_id,prospect_best_phone,canonical_e164,phone_id,prospect_full_name,prospect_first_name,agent_persona,seller_state')
      .eq('property_id', propertyId)
      .maybeSingle()

    if (pinError) throw pinError

    const result = await resolveMapOwnershipCheckIdentity(propertyId, {
      supabase,
      hints: {
        masterOwnerId: pin?.master_owner_id,
        prospectId: pin?.prospect_id,
        prospectFirstName: pin?.prospect_first_name,
        prospectFullName: pin?.prospect_full_name,
        recipientPhone: pin?.prospect_best_phone || pin?.canonical_e164,
        phoneId: pin?.phone_id,
        agentPersona: pin?.agent_persona,
      },
    })

    console.log(JSON.stringify({
      property_id: propertyId,
      seller_state: pin?.seller_state,
      pin_phone: pin?.prospect_best_phone || pin?.canonical_e164,
      ok: result.ok,
      error: result.ok ? null : result.error,
      recipient_phone: result.ok ? result.identity.recipientPhone : null,
      prospect_first_name: result.ok ? result.identity.prospectFirstName : null,
      phone_id: result.ok ? result.identity.phoneId : null,
    }))
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})