import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { patchUniversalLeadState } from '@/lib/domain/lead-state/patch-universal-lead-state.js'
import { normalizePatchToCanonical } from '@/lib/domain/lead-state/universal-lead-state-registry.js'

const THREAD = '+15551230099'

function makeSupabase(initial = {}) {
  let state = { thread_key: THREAD, ...initial }
  const writes = []
  const audits = []
  return {
    writes,
    audits,
    get state() { return { ...state } },
    from(table) {
      if (table === 'inbox_thread_state') {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: { ...state }, error: null }) }
              },
            }
          },
          upsert(row) {
            writes.push({ ...row })
            state = { ...state, ...row }
            return {
              select() {
                return { maybeSingle: async () => ({ data: { ...state }, error: null }) }
              },
            }
          },
        }
      }
      if (table === 'universal_lead_state_events') {
        return {
          insert(rows) {
            const list = Array.isArray(rows) ? rows : [rows]
            audits.push(...list)
            return {
              select: async () => ({ data: list.map((_, index) => ({ id: `audit-${audits.length + index}` })), error: null }),
            }
          },
        }
      }
      if (table === 'operator_entity_preferences') {
        return {
          upsert() {
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

test('operator automation aliases serialize to automation_state only', () => {
  assert.equal(normalizePatchToCanonical({ autopilot_mode: 'active' }).automation_state, 'running')
  assert.equal(normalizePatchToCanonical({ automation_state: 'paused' }).automation_state, 'paused')
  assert.equal(normalizePatchToCanonical({ autopilot_mode: 'human_controlled' }).automation_state, 'manual')
})

for (const [requested, persisted] of [
  ['active', 'running'],
  ['paused', 'paused'],
  ['human_controlled', 'manual'],
]) {
  test(`automation ${requested} persists as ${persisted} without touching execution status`, async () => {
    const supabase = makeSupabase({ automation_state: 'paused', automation_status: 'waiting' })
    const result = await patchUniversalLeadState({
      threadKey: THREAD,
      patch: { autopilot_mode: requested },
      meta: { change_source: 'manual' },
      supabase,
    })
    assert.equal(result.ok, true)
    assert.equal(supabase.writes.length, 1)
    assert.equal(supabase.writes[0].automation_state, persisted)
    assert.equal(Object.hasOwn(supabase.writes[0], 'automation_status'), false)
    assert.equal(result.row.automation_state, persisted)
    assert.equal(result.row.automation_status, 'waiting')
  })
}

test('invalid resume is rejected before an upsert and returns the previous row', async () => {
  const supabase = makeSupabase({ automation_state: 'paused', automation_status: 'suppressed', is_suppressed: true })
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { automation_state: 'running' },
    meta: { change_source: 'manual' },
    supabase,
  })
  assert.equal(result.ok, false)
  assert.equal(result.blocked, true)
  assert.match(result.reason, /automation_resume_blocked/)
  assert.equal(supabase.writes.length, 0)
  assert.equal(result.previous.automation_state, 'paused')
})

test('read/unread and manual stage lock return authoritative persisted fields', async () => {
  const supabase = makeSupabase({ is_read: false, manual_stage_lock: false })
  const read = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { is_read: true },
    meta: { change_source: 'manual' },
    supabase,
  })
  assert.equal(read.ok, true)
  assert.equal(read.row.is_read, true)
  assert.equal(supabase.writes.at(-1).last_read_at != null, true)

  const lock = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { manual_stage_lock: true },
    meta: { change_source: 'manual' },
    supabase,
  })
  assert.equal(lock.ok, true)
  assert.equal(lock.row.manual_stage_lock, true)
})

test('stage, status, and temperature stay dimension-separated in one authoritative row', async () => {
  const supabase = makeSupabase({
    lifecycle_stage: 'ownership_confirmation',
    operational_status: 'not_contacted',
    lead_temperature: 'cold',
  })
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: {
      lifecycle_stage: 'offer_interest',
      operational_status: 'active_communication',
      lead_temperature: 'hot',
    },
    meta: { change_source: 'manual', manual_stage_lock: true, manual_temperature_lock: true },
    supabase,
  })
  assert.equal(result.ok, true)
  assert.equal(result.row.lifecycle_stage, 'offer_interest')
  assert.equal(result.row.operational_status, 'active_communication')
  assert.equal(result.row.lead_temperature, 'hot')
  assert.equal(result.row.manual_stage_lock, true)
  assert.equal(result.row.manual_temperature_lock, true)
})

// The dashboard resolver is not the only guard. The API mutation boundary must
// independently refuse unknown or wrong-dimension values rather than normalize
// them to a valid-but-unrelated default.
test('wrong-dimension and unknown stage values are rejected without a fallback write', async () => {
  for (const invalid of ['mf_suppressed', 'new_reply', 'delivered', 'motivation_discovery']) {
    const supabase = makeSupabase({ lifecycle_stage: 'ownership_confirmation' })
    const result = await patchUniversalLeadState({
      threadKey: THREAD,
      patch: { lifecycle_stage: invalid },
      meta: { change_source: 'manual' },
      supabase,
    })
    assert.equal(result.ok, false, invalid)
    assert.equal(result.reason, 'no_allowed_patch_fields', invalid)
    assert.equal(supabase.writes.length, 0, invalid)
    assert.equal(supabase.state.lifecycle_stage, 'ownership_confirmation', invalid)
  }
})
