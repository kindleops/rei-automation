import { getSupabaseClient } from '../../lib/supabaseClient'
import type { AnyRecord } from '../../lib/data/shared'

const PROPERTY_SELECT = [
  'property_id',
  'property_address_full',
  'property_address',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_zip',
  'property_address_county_name',
  'apn_parcel_id',
  'market',
  'market_region',
  'latitude',
  'longitude',
  'normalized_asset_class',
  'asset_class',
  'asset_type',
  'property_type',
  'total_bedrooms',
  'total_baths',
  'building_square_feet',
  'units_count',
  'year_built',
  'lot_square_feet',
  'master_owner_id',
  'raw_payload_json',
  'updated_at',
].join(',')

export async function fetchPropertyRecord(propertyId: string): Promise<AnyRecord | null> {
  const id = String(propertyId ?? '').trim()
  if (!id) return null

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('properties')
    .select(PROPERTY_SELECT)
    .eq('property_id', id)
    .maybeSingle()

  if (error) {
    console.error('[comp-intelligence] property record fetch failed', error)
    return null
  }
  return (data as AnyRecord | null) ?? null
}