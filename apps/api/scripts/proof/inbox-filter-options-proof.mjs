#!/usr/bin/env node
import * as dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { queryInboxFilterOptions, countHydratedInboxFilters } from '@/lib/domain/inbox/inbox-hydrated-filter-service.js'

dotenv.config({ path: './.env.local' })

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('BLOCKED: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}

const supabase = createClient(url, key, { auth: { persistSession: false } })

const checks = [
  { field: 'states', min: 15, label: 'states' },
  { field: 'markets', min: 10, label: 'markets' },
  { field: 'property_types', min: 3, label: 'property types' },
  { field: 'building_conditions', min: 3, label: 'building conditions' },
  { field: 'propertyFlags', min: 20, label: 'property flags' },
  { field: 'personFlags', min: 10, label: 'person flags' },
  { field: 'household_incomes', min: 10, label: 'household incomes' },
  { field: 'net_asset_values', min: 5, label: 'net asset values' },
  { field: 'occupation_groups', min: 3, label: 'occupation groups' },
  { field: 'owner_types', min: 3, label: 'owner types' },
  { field: 'phone_carriers', min: 1, label: 'phone carriers' },
]

async function main() {
  const filters = { filter: 'all_messages' }
  const total = await countHydratedInboxFilters(filters, { supabase })
  console.log(`match_count_all_messages=${total}`)
  if (total < 7000) {
    console.error(`BLOCKED: expected ~7828 threads, got ${total}`)
    process.exit(2)
  }

  let failed = 0
  for (const check of checks) {
    const result = await queryInboxFilterOptions({ field: check.field, filters, search: '' }, { supabase })
    const count = result.totalDistinct
    const maxOptionCount = Math.max(0, ...(result.options || []).map((o) => o.count))
    const ok = count >= check.min
    console.log(`${ok ? '✅' : '❌'} ${check.label}: distinct=${count}, max_count=${maxOptionCount}`)
    if (!ok) failed += 1
    if (maxOptionCount > 1000) {
      console.log(`   ↳ facet counts exceed 1000-row cap (${maxOptionCount})`)
    }
  }

  const cities = await queryInboxFilterOptions({ field: 'cities', filters, search: '' }, { supabase })
  console.log(`cities distinct=${cities.totalDistinct}`)
  if (cities.totalDistinct < 50) {
    console.error('BLOCKED: city options still look truncated')
    failed += 1
  }

  if (failed > 0) {
    console.error(`BLOCKED: ${failed} catalog checks failed`)
    process.exit(2)
  }

  console.log('DONE: inbox filter options use full hydrated universe')
}

main().catch((err) => {
  console.error('BLOCKED:', err?.message || err)
  process.exit(2)
})