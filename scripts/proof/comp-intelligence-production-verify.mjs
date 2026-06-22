#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../../apps/api/.env.local') })

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const SAMPLE_IDS = [
  '217702430',
  '2109544499',
  '217744793',
  '2100000001',
  '2100000002',
]

async function verifyProperty(propertyId) {
  const { data: prop } = await db
    .from('properties')
    .select(
      'property_id,apn_parcel_id,property_address_full,latitude,longitude,building_square_feet,units_count,normalized_asset_class,property_type,market,property_address_city,property_address_state,property_address_zip,updated_at',
    )
    .eq('property_id', propertyId)
    .maybeSingle()

  if (!prop) return { property_id: propertyId, found: false }

  const { data: comps } = await db.rpc('get_comp_candidates_for_subject', {
    p_subject_property_id: propertyId,
    p_radius_miles: 3,
    p_months_back: 12,
    p_limit: 100,
  })

  const compDates = (comps ?? [])
    .map((c) => c.sale_date || c.mls_sold_date)
    .filter(Boolean)
    .sort()
    .reverse()

  return {
    property_id: prop.property_id,
    source_property_id: null,
    parcel_apn: prop.apn_parcel_id,
    normalized_address: prop.property_address_full,
    latitude: prop.latitude,
    longitude: prop.longitude,
    square_feet: prop.building_square_feet,
    units: prop.units_count,
    asset_type: prop.normalized_asset_class,
    property_type: prop.property_type,
    market: prop.market,
    comp_count: comps?.length ?? 0,
    most_recent_comp_date: compDates[0] ?? null,
    comp_source_count: new Set((comps ?? []).map((c) => (c.mls_sold_price ? 'MLS' : 'PUBLIC'))).size,
    fields_used: {
      latitude: 'properties.latitude',
      longitude: 'properties.longitude',
      square_feet: 'properties.building_square_feet',
    },
  }
}

async function main() {
  const { data: sampleRows } = await db
    .from('properties')
    .select('property_id,market,property_type')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)
    .limit(25)

  const ids = [...new Set([...(sampleRows ?? []).map((r) => r.property_id), ...SAMPLE_IDS])].slice(0, 25)
  const results = []
  for (const id of ids) {
    results.push(await verifyProperty(id))
  }

  console.log(JSON.stringify({ project: 'lcppdrmrdfblstpcbgpf', sampled: results.length, results }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})