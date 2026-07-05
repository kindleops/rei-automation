/**
 * Read-only production smoke proof for map ownership resolver.
 * No database writes. No SMS. No queue inserts.
 */
import { createClient } from '@supabase/supabase-js'
import {
  resolveMapOwnershipCheckIdentity,
  type MapOwnershipCheckHints,
} from '../../src/domain/map/resolve-map-ownership-check'

const redactPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 4) return '****'
  return `***${digits.slice(-4)}`
}

const loadSupabase = () => {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL and key for read-only smoke proof')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

const countMissingDirectOwner = async (supabase: ReturnType<typeof createClient>) => {
  const { count, error } = await supabase
    .from('properties')
    .select('property_id', { count: 'exact', head: true })
    .is('master_owner_id', null)
  if (error) throw error
  return count ?? 0
}

const findResolvableExampleProperties = async (supabase: ReturnType<typeof createClient>) => {
  const examples: Array<{ propertyId: string; source: string; masterOwnerId: string }> = []

  const { data: linkRows, error: linkError } = await supabase
    .from('map_filter_property_prospect_links')
    .select('property_id, master_owner_id')
    .not('master_owner_id', 'is', null)
    .limit(1500)

  if (linkError) throw linkError

  const seenPropertyIds = new Set<string>()

  for (const row of linkRows ?? []) {
    if (examples.length >= 3) break
    const propertyId = String(row.property_id || '').trim()
    const masterOwnerId = String(row.master_owner_id || '').trim()
    if (!propertyId || !masterOwnerId || seenPropertyIds.has(propertyId)) continue

    const { data: propertyRow, error: propertyError } = await supabase
      .from('properties')
      .select('property_id, master_owner_id')
      .eq('property_id', propertyId)
      .is('master_owner_id', null)
      .limit(1)
      .maybeSingle()

    if (propertyError || !propertyRow) continue
    seenPropertyIds.add(propertyId)

    const probe = await resolveMapOwnershipCheckIdentity(propertyId, {
      supabase,
      hints: { masterOwnerId },
    })
    if (!probe.ok) continue

    examples.push({
      propertyId,
      source: probe.identity.resolutionSource,
      masterOwnerId,
    })
  }

  return examples
}

const run = async () => {
  const supabase = loadSupabase()
  const missingDirectOwnerCount = await countMissingDirectOwner(supabase)
  const examples = await findResolvableExampleProperties(supabase)

  console.log(JSON.stringify({
    missing_direct_master_owner_count: missingDirectOwnerCount,
    example_count: examples.length,
    queue_inserts: 0,
    sms_sent: 0,
  }, null, 2))

  for (const example of examples) {
    const hints: MapOwnershipCheckHints = {
      masterOwnerId: example.masterOwnerId,
    }
    const result = await resolveMapOwnershipCheckIdentity(example.propertyId, {
      supabase,
      hints,
    })

    if (!result.ok) {
      console.log(JSON.stringify({
        property_id: example.propertyId,
        expected_source: example.source,
        ok: false,
        error: result.error,
        diagnostics: result.diagnostics ?? null,
      }, null, 2))
      continue
    }

    console.log(JSON.stringify({
      property_id: result.identity.propertyId,
      resolution_source: result.identity.resolutionSource,
      master_owner_id: result.identity.masterOwnerId,
      best_phone_1: redactPhone(result.identity.recipientPhone),
      phone_id: result.identity.phoneId,
      prospect_id: result.identity.prospectId,
      prospect_first_name: result.identity.prospectFirstName,
      sms_eligible: result.identity.smsEligible,
      assigned_agent: result.identity.agentName,
      candidate_count: result.identity.resolutionDiagnostics.candidateCount,
    }, null, 2))
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})