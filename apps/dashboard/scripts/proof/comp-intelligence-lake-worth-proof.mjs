import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const env = fs.readFileSync(path.join(root, '.env.local'), 'utf8')
const url = env.match(/VITE_SUPABASE_URL=(.+)/)?.[1]?.trim()
const key = env.match(/VITE_SUPABASE_ANON_KEY=(.+)/)?.[1]?.trim()
const sb = createClient(url, key)

const propertyId = '234334277'
const { data: property } = await sb.from('properties').select('property_id,property_address_full,latitude,longitude').eq('property_id', propertyId).maybeSingle()
const { data: comps, error } = await sb.rpc('get_comp_candidates_for_subject', {
  p_subject_property_id: propertyId,
  p_radius_miles: 1,
  p_months_back: 12,
  p_limit: 50,
})

console.log(JSON.stringify({ property, compCount: comps?.length ?? 0, error: error?.message, sample: comps?.[0] }, null, 2))