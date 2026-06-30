import test from 'node:test'
import assert from 'node:assert/strict'
import { supabase } from '../../src/lib/supabase/client.js'
import {
  buildBaselineScores,
  buildDealIntelligenceDossier,
  ENGINE_PROGRESS_STAGES,
} from '../../src/lib/cockpit/deal-intelligence-dossier.js'

test('buildBaselineScores uses property Supabase columns only, not engine AOS', () => {
  const baseline = buildBaselineScores(
    {
      final_acquisition_score: 72,
      structured_motivation_score: 61,
      deal_strength_score: 58,
      tag_distress_score: 44,
    },
    null,
  )

  assert.equal(baseline.acquisition_score, 72)
  assert.equal(baseline.motivation_score, 61)
  assert.equal(baseline.deal_strength_score, 58)
  assert.equal(baseline.distress_score, 44)

  const polluted = buildBaselineScores(
    { final_acquisition_score: 72 },
    { priority_score: 55 },
  )
  assert.equal(polluted.acquisition_score, 72)
  assert.equal(polluted.motivation_score, 55)
})

test('buildDealIntelligenceDossier returns canonical sections', async (t) => {
  const originalFrom = supabase.from
  const originalRpc = supabase.rpc

  const makeTerminal = (rows = []) => {
    const terminal = {
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      limit: () => terminal,
      order: () => terminal,
      lt: () => terminal,
      lte: () => terminal,
      gt: () => terminal,
      gte: () => terminal,
      in: () => terminal,
      eq: () => terminal,
      or: () => terminal,
      abortSignal: () => terminal,
      then(resolve, reject) {
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
      },
    }
    return terminal
  }

  t.mock.method(supabase, 'from', (table) => {
    if (table === 'inbox_thread_state') {
      return {
        select: () => makeTerminal([{
          property_id: 'prop-1',
          prospect_id: 'prospect-1',
          master_owner_id: 'owner-1',
          canonical_e164: '+14805551212',
        }]),
      }
    }

    if (table === 'properties') {
      return {
        select: () => makeTerminal([{
          property_id: 'prop-1',
          property_address_full: '123 Main St, Phoenix, AZ 85001',
          market: 'Phoenix',
          property_type: 'Single Family',
          normalized_asset_class: 'sfr',
          total_bedrooms: 3,
          total_baths: 2,
          building_square_feet: 1450,
          estimated_value: 325000,
          equity_amount: 180000,
          equity_percent: 55,
          latitude: 33.45,
          longitude: -112.07,
        }]),
      }
    }

    if (table === 'property_acquisition_scores') {
      return {
        select: () => makeTerminal([]),
      }
    }

    if (table === 'buyer_geo_rollups_v2') {
      return {
        select: () => makeTerminal([{
          purchase_count: 42,
          buyer_count: 18,
          buyer_heat_score: 68,
          liquidity_score: 61,
          investor_demand_score: 64,
          geo_level: 'zip',
          geo_key: '85001',
        }]),
      }
    }

    return {
      select: () => makeTerminal([]),
    }
  })

  t.mock.method(supabase, 'rpc', async () => ({ data: [], error: null }))

  const dossier = await buildDealIntelligenceDossier({ thread_key: '+14805551212' })

  assert.equal(dossier.identity.property_id, 'prop-1')
  assert.equal(dossier.property.status, 'available')
  assert.equal(dossier.acquisition_decision.status, 'not_run')
  assert.equal(dossier.buyer_market.source, 'buyer_geo_rollups_v2')
  assert.equal(dossier.buyer_market.signal, 'Active')
  assert.equal(dossier.census.status, 'pending')
  assert.ok(Array.isArray(dossier.activity_timeline))
  assert.equal(ENGINE_PROGRESS_STAGES.length, 11)

  supabase.from = originalFrom
  supabase.rpc = originalRpc
})