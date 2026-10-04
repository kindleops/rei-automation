/**
 * S5 — a manual temperature on the conversation reaches the deal (like stage),
 * through the canonical opportunity writer, and never ping-pongs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { patchUniversalLeadState } from '../../src/lib/domain/lead-state/patch-universal-lead-state.js'

const KEY = '+15550009101'

function makeSupabase({ oppTemperature = 'cold' } = {}) {
  const updates = []
  const thread = { thread_key: KEY, canonical_e164: KEY, property_id: 'prop-1', lead_temperature: 'cold' }
  const opp = { id: 'opp-1', temperature: oppTemperature, primary_thread_key: KEY, version: 1 }
  return {
    updates,
    opp,
    from(table) {
      const q = { table, patch: null }
      const api = {
        select() { return api }, eq() { return api }, in() { return api }, is() { return api }, not() { return api }, or() { return api },
        order() { return api }, limit() { return api }, gte() { return api }, lte() { return api }, lt() { return api }, gt() { return api },
        insert(rows) { q.patch = rows; return api },
        update(patch) { q.patch = patch; if (table === 'acquisition_opportunities') Object.assign(opp, patch); return api },
        upsert(patch) { q.patch = patch; Object.assign(thread, patch); return api },
        maybeSingle: async () => ({ data: table === 'inbox_thread_state' ? { ...thread } : null, error: null }),
        single: async () => ({ data: table === 'acquisition_opportunities' ? opp : thread, error: null }),
        then(resolve) {
          if (q.patch) updates.push({ table, patch: q.patch })
          const data = table === 'acquisition_opportunities' ? [opp] : table === 'inbox_thread_state' ? [thread] : []
          return Promise.resolve().then(() => resolve({ data, error: null, count: data.length }))
        },
      }
      return api
    },
  }
}

test('manual hot on the conversation → the deal turns hot through the canonical writer', async () => {
  const supabase = makeSupabase({ oppTemperature: 'cold' })
  const result = await patchUniversalLeadState({ threadKey: KEY, patch: { lead_temperature: 'hot' }, meta: { source_view: 'inbox', change_source: 'manual', operator_id: 'op' }, supabase })
  assert.equal(result.ok, true)
  assert.equal(result.opportunity_temperature_sync?.ok, true, JSON.stringify(result.opportunity_temperature_sync))
  assert.equal(supabase.opp.temperature, 'hot')
  assert.ok(supabase.updates.some((u) => u.table === 'acquisition_opportunity_history'), 'history row written by the canonical writer')
})

test('the opportunity→thread sync never re-enters (no ping-pong)', async () => {
  const supabase = makeSupabase({ oppTemperature: 'cold' })
  const result = await patchUniversalLeadState({ threadKey: KEY, patch: { lead_temperature: 'hot' }, meta: { source_view: 'opportunity_sync', change_source: 'manual' }, supabase })
  assert.equal(result.opportunity_temperature_sync, null)
  assert.equal(supabase.opp.temperature, 'cold')
})

test('already aligned → nothing written to the deal', async () => {
  const supabase = makeSupabase({ oppTemperature: 'hot' })
  const result = await patchUniversalLeadState({ threadKey: KEY, patch: { lead_temperature: 'hot' }, meta: { source_view: 'inbox', change_source: 'manual' }, supabase })
  assert.equal(result.opportunity_temperature_sync?.reason, 'already_aligned')
})
