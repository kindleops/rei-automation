#!/usr/bin/env node
/**
 * Pipeline Nexus functional proof — property hydration, temperature unknown, Monica Ruiz sample.
 * Run: node --env-file=apps/api/.env.local scripts/proof/pipeline-nexus-functional-proof.mjs
 */
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const apiRoot = resolve(__dirname, '../../apps/api')
process.chdir(apiRoot)

register(
  pathToFileURL(resolve(apiRoot, 'tests/alias-loader.mjs')).href,
  pathToFileURL(`${apiRoot}/`),
)

const { supabase, hasSupabaseConfig } = await import('../../apps/api/src/lib/supabase/client.js')
const { listOpportunities, getOpportunityById, normalizeOpportunityRow } = await import('../../apps/api/src/lib/domain/opportunity/opportunity-service.js')
const { batchHydrateOpportunityProperties, operatorPropertyTypeLabel } = await import('../../apps/api/src/lib/domain/opportunity/opportunity-property-hydration.js')

const TABLE = 'acquisition_opportunities'

async function main() {
  assert.equal(hasSupabaseConfig(), true, 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')

  const t0 = Date.now()
  const { count: total } = await supabase.from(TABLE).select('*', { count: 'exact', head: true })
  assert.ok(total >= 721, `expected >= 721 opportunities, got ${total}`)

  const { data: allRows } = await supabase.from(TABLE).select('*')
  const normalized = (allRows ?? []).map(normalizeOpportunityRow).filter(Boolean)
  const hydrated = await batchHydrateOpportunityProperties(supabase, normalized)

  let matched = 0
  let unresolved = 0
  const byPropertyType = {}
  const byState = {}

  for (const row of hydrated) {
    if (row.property_match_status === 'matched') {
      matched += 1
      const pt = row.property_type || 'Unknown'
      const st = row.property_state || 'Unknown'
      byPropertyType[pt] = (byPropertyType[pt] ?? 0) + 1
      byState[st] = (byState[st] ?? 0) + 1
    } else if (row.primary_property_id) {
      unresolved += 1
    }
  }

  assert.ok(matched >= 714, `expected >= 714 matched properties, got ${matched}`)
  assert.ok(Object.keys(byPropertyType).length > 1, 'property type distribution should not be all Unknown')

  const monica = hydrated.find((r) =>
    String(r.seller_display_name || '').toLowerCase().includes('monica')
    && String(r.seller_display_name || '').toLowerCase().includes('ruiz'),
  ) || hydrated.find((r) => String(r.primary_property_id) === '217702430')

  if (monica) {
    assert.equal(String(monica.property_state), 'CA', 'Monica Ruiz should display CA')
    const ptLabel = String(monica.property_type || '')
    assert.ok(ptLabel.includes('Single Family') || String(monica.property_type_raw).toUpperCase() === 'SFR', `Monica property type expected SFR/Single Family, got ${ptLabel}`)
  }

  const unknownTemp = hydrated.filter((r) => r.temperature == null)
  assert.ok(unknownTemp.length > 0, 'production should have null temperature rows')

  const listMs = Date.now()
  const list = await listOpportunities({ limit: 100, scope: 'active' })
  const listElapsed = Date.now() - listMs
  assert.ok(list.rows.length > 0, 'active scope list should return rows')
  assert.ok(listElapsed < 15000, `list should complete <15s, took ${listElapsed}ms`)

  const sample = list.rows[0]
  const detailMs = Date.now()
  const detail = await getOpportunityById(sample.id)
  const detailElapsed = Date.now() - detailMs
  assert.ok(Array.isArray(detail?.activity_timeline), 'detail should include unified activity timeline')
  assert.ok(detailElapsed < 45000, `detail should complete <45s, took ${detailElapsed}ms`)

  console.log(JSON.stringify({
    ok: true,
    total,
    matched,
    unresolved,
    unknown_temperature_count: unknownTemp.length,
    by_property_type: byPropertyType,
    by_state: byState,
    monica_proof: monica ? {
      seller: monica.seller_display_name,
      property_id: monica.primary_property_id,
      property_type: monica.property_type,
      property_type_raw: monica.property_type_raw,
      state: monica.property_state,
      market: monica.market,
    } : null,
    timings_ms: { total: Date.now() - t0, list: listElapsed, detail: detailElapsed },
    operatorPropertyTypeLabel_sfr: operatorPropertyTypeLabel({ property_type: 'SFR' }),
  }, null, 2))
}

main().catch((err) => {
  console.error('[proof] failed:', err)
  process.exit(1)
})