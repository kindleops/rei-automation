/**
 * ENTITY GRAPH → CAMPAIGN · STACKED COHORTS + OUTREACH STATE (2026-10-08).
 *
 *   - filter A → campaign X, filter B → the same X: ids union, dedupe, counts
 *     added / already present / held / ineligible with reasons
 *   - eligibility is the campaign target builder's own readiness rule
 *   - only DRAFTS without dynamic filters; never targets, status or a send
 *   - a large pinned list reaches Build/Reach in chunks (URL length)
 *   - grid outreach state: SMS eligible + reason, last contact, stage, status
 *
 * No network: Supabase is an in-memory fake.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { StackRefusal, classifyStackProperties, resolveStackPropertyIds, stackEntityGraphCohort } from '../../src/lib/domain/entity-graph/entity-graph-campaign-stack.js'
import { getEntityGraphOutreachState, latestContact, propertySmsEligibility } from '../../src/lib/domain/entity-graph/entity-graph-outreach-state.js'
import { compareGraphReadOrder, explicitPropertyChunkOptions, resolveCampaignTargetMode, explicitSelectedPropertyIds } from '../../src/lib/domain/campaigns/campaign-automation-service.js'
import { resolveCampaignTargetReadiness } from '../../src/lib/domain/campaigns/campaign-target-readiness.js'

/** A tiny PostgREST stand-in: eq / in / gt / not-like / order / limit over in-memory tables. */
function fakeSupabase(tables, log = []) {
  const from = (table) => {
    const state = { table, preds: [], order: null, limit: null, writes: null }
    const rows = () => (tables[table] || []).filter((r) => state.preds.every((p) => p(r)))
    const api = {
      select() { return api },
      eq(c, v) { state.preds.push((r) => String(r[c]) === String(v)); return api },
      in(c, vs) { const set = new Set(vs.map(String)); state.preds.push((r) => set.has(String(r[c]))); return api },
      gt(c, v) { state.preds.push((r) => String(r[c]) > String(v)); return api },
      not(c, op, v) { if (op === 'like') state.preds.push((r) => !String(r[c] ?? '').startsWith(String(v).replace(/%$/, ''))); return api },
      or() { return api },
      ilike() { return api },
      order(c) { state.order = c; return api },
      limit(n) { state.limit = n; return api },
      range() { return api },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }) },
      insert(v) { log.push({ table, insert: v }); return api },
      update(v) { log.push({ table, update: v }); return api },
      delete() { log.push({ table, delete: true }); return api },
      then(resolve, reject) {
        let out = rows()
        if (state.order) out = [...out].sort((a, b) => String(a[state.order]).localeCompare(String(b[state.order])))
        if (state.limit) out = out.slice(0, state.limit)
        log.push({ table, read: out.length })
        return Promise.resolve({ data: out, error: null }).then(resolve, reject)
      },
    }
    return api
  }
  return { from, rpc: async () => ({ data: [], error: null }) }
}

const ready = (property_id, extra = {}) => ({ property_id, queue_eligible: true, seller_person_key: `p-${property_id}`, canonical_e164: '+15550000000', timezone: 'America/Chicago', identity_alignment: 'verified', ...extra })

test('the readiness rule is the builder’s, and a property is eligible when any row is ready', () => {
  assert.equal(resolveCampaignTargetReadiness(ready('1')).ready, true)
  assert.equal(resolveCampaignTargetReadiness({ ...ready('1'), queue_eligible: false, queue_block_reason: 'suppression_blocked' }).blockReason, 'suppression_blocked')
  assert.deepEqual(propertySmsEligibility([]).reason, 'not_in_campaign_audience')
  assert.equal(propertySmsEligibility([{ ...ready('1'), queue_eligible: false, queue_block_reason: 'NO_PHONE' }, ready('1')]).eligible, true)
  const held = propertySmsEligibility([ready('1')], true)
  assert.equal(held.eligible, false)
  assert.equal(held.reason, 'entity_contact_requires_review')
  // a queue-eligible row's reason outranks a non-eligible row's
  const mixed = propertySmsEligibility([{ ...ready('1'), queue_eligible: false, queue_block_reason: 'NO_PHONE' }, { ...ready('1'), timezone: '' }])
  assert.equal(mixed.reason, 'missing_timezone')
})

test('classification: ready, held (pinned), ineligible (not pinned) — by reason', async () => {
  const supabase = fakeSupabase({
    campaign_target_graph: [
      ready('A'),
      ready('B', { timezone: '' }),
      { property_id: 'C', queue_eligible: false, queue_block_reason: 'suppression_blocked' },
    ],
  })
  const out = await classifyStackProperties(['A', 'B', 'C', 'D'], { supabase, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) })
  assert.deepEqual(out.ready, ['A'])
  assert.deepEqual(out.held, ['B'])
  assert.deepEqual(out.heldByReason, { missing_timezone: 1 })
  assert.deepEqual(out.ineligible.sort(), ['C', 'D'])
  assert.deepEqual(out.ineligibleByReason, { suppression_blocked: 1, not_in_campaign_audience: 1 })
})

test('unreadable review flags refuse — eligibility is never assumed', async () => {
  const supabase = fakeSupabase({ campaign_target_graph: [ready('A')] })
  await assert.rejects(
    classifyStackProperties(['A'], { supabase, fetchEntityContactReviewBlocks: async () => ({ ok: false }) }),
    (e) => e instanceof StackRefusal && e.code === 'eligibility_unavailable',
  )
})

function campaignsFake(rows, log) {
  const store = new Map(rows.map((c) => [c.id, structuredClone(c)]))
  return {
    store,
    api: {
      getCampaign: async (id) => ({ campaign: store.has(id) ? structuredClone(store.get(id)) : null }),
      createCampaign: async (payload) => { log.push({ create: payload }); const id = 'new-1'; store.set(id, { id, name: payload.name, status: 'draft', metadata: { ...payload.metadata, target_filters: payload.target_filters } }); return { ok: true, campaign_id: id, campaign: store.get(id) } },
      // compare-and-set on updated_at, as the default does against campaigns (trigger-bumped)
      casUpdate: async (id, expected, patch) => {
        await new Promise((r) => setTimeout(r, 1))
        const c = store.get(id)
        if (!c || c.status !== 'draft' || c.updated_at !== expected) { log.push({ casConflict: id }); return false }
        log.push({ update: id, payload: patch })
        Object.assign(c, structuredClone(patch))
        c.updated_at = `v${Number(String(c.updated_at || 'v0').slice(1)) + 1}`
        return true
      },
      afterStackWrite: async (id) => { log.push({ synced: id }) },
      explicitSelectedPropertyIds,
      resolveCampaignTargetMode,
      normalizeCampaignStatus: (s) => String(s || '').toLowerCase(),
    },
  }
}

test('stacking: filter A then filter B into the same draft — union, dedupe, counts; nothing built or sent', async () => {
  const log = []
  const supabase = fakeSupabase({
    campaign_target_graph: [ready('A'), ready('B'), ready('C', { timezone: '' }), { property_id: 'D', queue_eligible: false, queue_block_reason: 'NO_PHONE' }],
  }, log)
  const { api, store } = campaignsFake([{ id: 'X', name: 'Probate stack', status: 'draft', metadata: {}, updated_at: 'v0' }], log)
  const deps = { supabase, campaigns: api, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) }

  const first = await stackEntityGraphCohort({ campaign_id: 'X', scope: 'properties', mode: 'selection', ids: ['A', 'D'] }, deps)
  assert.equal(first.added, 1)
  assert.equal(first.added_ready, 1)
  assert.equal(first.ineligible, 1)
  assert.deepEqual(first.ineligible_by_reason, { NO_PHONE: 1 })
  assert.equal(first.total_after, 1)

  const second = await stackEntityGraphCohort({ campaign_id: 'X', scope: 'properties', mode: 'selection', ids: ['A', 'B', 'C'] }, deps)
  assert.equal(second.already_present, 1)
  assert.equal(second.added_ready, 1)
  assert.equal(second.added_held, 1)
  assert.deepEqual(second.held_by_reason, { missing_timezone: 1 })
  assert.equal(second.total_after, 3)
  assert.deepEqual([...explicitSelectedPropertyIds(store.get('X'))].sort(), ['A', 'B', 'C'])
  assert.equal(store.get('X').metadata.entity_graph_stack.length, 2)
  assert.equal(second.no_targets_built, true)
  assert.equal(second.no_send_queue_rows_created, true)
  // the only writes were the draft's definition — no targets, no queue, no status
  assert.ok(!log.some((e) => e.table === 'campaign_targets' || e.table === 'send_queue'))
  assert.ok(!log.some((e) => e.update && 'status' in (e.payload || {})))
  assert.ok(log.some((e) => e.synced === 'X'), 'campaign_filters + event synced after the write')
})

test('dry run counts and writes nothing', async () => {
  const log = []
  const supabase = fakeSupabase({ campaign_target_graph: [ready('A')] }, log)
  const { api } = campaignsFake([{ id: 'X', name: 'X', status: 'draft', metadata: {} }], log)
  const out = await stackEntityGraphCohort({ campaign_id: 'X', scope: 'properties', mode: 'selection', ids: ['A'], dry_run: true }, { supabase, campaigns: api, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) })
  assert.equal(out.dry_run, true)
  assert.equal(out.added_ready, 1)
  assert.ok(!log.some((e) => e.update || e.create))
})

test('refusals: not a draft, dynamic filters, a search as a cohort, no filters', async () => {
  const supabase = fakeSupabase({ campaign_target_graph: [] })
  const { api } = campaignsFake([
    { id: 'L', name: 'Live', status: 'active', metadata: {} },
    { id: 'F', name: 'Filtered', status: 'draft', metadata: { target_filters: { properties: [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX'] }] } } },
  ], [])
  const deps = { supabase, campaigns: api, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) }
  await assert.rejects(stackEntityGraphCohort({ campaign_id: 'L', scope: 'properties', mode: 'selection', ids: ['A'] }, deps), (e) => e.code === 'campaign_not_draft' && e.status === 409)
  await assert.rejects(stackEntityGraphCohort({ campaign_id: 'F', scope: 'properties', mode: 'selection', ids: ['A'] }, deps), (e) => e.code === 'campaign_has_dynamic_filters')
  await assert.rejects(resolveStackPropertyIds({ scope: 'properties', mode: 'cohort', q: 'Atlanta' }, deps), (e) => e.code === 'search_is_not_a_cohort')
  await assert.rejects(resolveStackPropertyIds({ scope: 'properties', mode: 'cohort' }, deps), (e) => e.code === 'cohort_has_no_filters')
  await assert.rejects(stackEntityGraphCohort({ scope: 'properties', mode: 'selection', ids: ['A'] }, deps), (e) => e.code === 'destination_required')
})

test('a cohort resolves server-side by keyset over the browse source, with its filters', async () => {
  const props = Array.from({ length: 2500 }, (_, i) => ({ property_id: `P${String(i).padStart(5, '0')}`, tax_delinquent: i % 2 === 0 }))
  const supabase = fakeSupabase({ v_entity_graph_properties: props })
  const out = await resolveStackPropertyIds({ scope: 'properties', mode: 'cohort', field_filters: JSON.stringify([{ field_key: 'properties.tax_delinquent', operator: 'is_true' }]) }, { supabase })
  assert.equal(out.propertyIds.length, 1250, 'every page, not just the loaded rows — and only the filtered ones')
})

test('owners and people resolve to the properties their owner holds', async () => {
  const supabase = fakeSupabase({
    properties: [{ property_id: '1', master_owner_id: 'o1' }, { property_id: '2', master_owner_id: 'o1' }, { property_id: '3', master_owner_id: 'o2' }],
    prospects: [{ prospect_id: 'p1', master_owner_id: 'o1' }, { prospect_id: 'p2', master_owner_id: null }],
  })
  const owners = await resolveStackPropertyIds({ scope: 'master_owners', mode: 'selection', ids: ['o1'] }, { supabase })
  assert.deepEqual(owners.propertyIds.sort(), ['1', '2'])
  const people = await resolveStackPropertyIds({ scope: 'people', mode: 'selection', ids: ['p1', 'p2'] }, { supabase })
  assert.deepEqual(people.propertyIds.sort(), ['1', '2'])
  assert.ok(people.notes.some((n) => /no linked owner/.test(n)))
})

test('a large pinned list reaches Build/Reach in disjoint chunks, merged in the graph order', () => {
  const ids = Array.from({ length: 400 }, (_, i) => String(100000000 + i))
  const options = { catalog_filters: { supported: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: ids }, { field_key: 'properties.market', operator: 'is_any_of', value: ['x'] }] } }
  const parts = explicitPropertyChunkOptions(options)
  assert.equal(parts.length, 3)
  assert.deepEqual(parts.flatMap((p) => p.catalog_filters.supported[0].value), ids)
  assert.ok(parts.every((p) => p.catalog_filters.supported[1].field_key === 'properties.market'))
  assert.equal(explicitPropertyChunkOptions({ catalog_filters: { supported: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: ids.slice(0, 10) }] } }), null)
  const sorted = [
    { graph_id: 'b', queue_eligible: true, acquisition_score: null },
    { graph_id: 'a', queue_eligible: false, acquisition_score: 90 },
    { graph_id: 'c', queue_eligible: true, acquisition_score: 50 },
  ].sort(compareGraphReadOrder).map((r) => r.graph_id)
  assert.deepEqual(sorted, ['c', 'b', 'a'])
})

test('outreach state: eligibility + reason, last contact, stage/status by source, never a phone number', async () => {
  const supabase = fakeSupabase({
    campaign_target_graph: [ready('1', { last_outbound_at: '2026-10-01T10:00:00Z' }), { property_id: '2', queue_eligible: false, queue_block_reason: 'suppression_blocked', canonical_e164: '+15551112222' }],
    inbox_thread_state: [{ thread_key: 't1', property_id: '1', latest_message_at: '2026-10-05T12:00:00Z', latest_direction: 'inbound', last_inbound_at: '2026-10-05T12:00:00Z', latest_message_body: 'Yes I might sell', seller_stage: 'S2', conversation_status: 'open' }],
    acquisition_opportunities: [{ id: 'd1', primary_property_id: '1', acquisition_stage: 'offer_sent', opportunity_status: 'active' }],
    campaign_targets: [{ property_id: '1', campaign_id: 'c1', target_status: 'ready', created_at: '2026-09-01T00:00:00Z' }],
    campaigns: [{ id: 'c1', name: 'Dallas S1', status: 'built' }],
  })
  const { states } = await getEntityGraphOutreachState({ property_ids: '1,2,3' }, { supabase })
  assert.deepEqual([states['1'].sms.eligible, states['1'].sms.reason], [true, null])
  assert.equal(states['2'].sms.reason, 'suppression_blocked')
  assert.equal(states['3'].sms.reason, 'not_in_campaign_audience')
  assert.deepEqual(states['1'].lastContact, { at: '2026-10-05T12:00:00Z', direction: 'inbound', channel: 'sms', source: 'inbox' })
  assert.deepEqual(states['1'].stage, { value: 'offer_sent', source: 'pipeline' })
  assert.deepEqual(states['1'].status, { value: 'active', source: 'pipeline' })
  assert.equal(states['1'].campaigns.count, 1)
  assert.equal(states['1'].campaigns.latest.name, 'Dallas S1')
  assert.equal(states['3'].lastContact, null)
  assert.ok(!JSON.stringify(states).includes('+1555'), 'no phone number leaves the server')
  assert.equal(latestContact({ graphRows: [{ last_outbound_at: '2026-01-01' }, { last_inbound_at: '2026-02-01' }] }).direction, 'inbound')
})

test('linked-entity columns: owner via master owner, contact from the campaign graph (primary + count, no number), scores, entities', async () => {
  const { getEntityGraphColumnEnrichment, parseEntityGraphColumnFields } = await import('../../src/lib/domain/entity-graph/entity-graph-column-enrichment.js')
  assert.deepEqual(parseEntityGraphColumnFields('owner.priority_tier,owner.row_hash,contact.person,contact.canonical_e164,year_built,x.y'), ['owner.priority_tier', 'contact.person', 'year_built'])
  const supabase = fakeSupabase({
    properties: [{ property_id: '1', master_owner_id: 'o1', year_built: 1950 }, { property_id: '2', master_owner_id: null, year_built: 2001 }],
    master_owners: [{ master_owner_id: 'o1', priority_tier: 'A' }],
    property_acquisition_scores: [{ property_id: '2', decision_tier: 'B' }],
    campaign_target_graph: [
      { property_id: '2', seller_full_name: 'Ana Ruiz', seller_person_key: 'k1', canonical_e164: '+15550001111', best_phone_score: 80, phone_type: 'Wireless' },
      { property_id: '2', seller_full_name: 'Luis Ruiz', seller_person_key: 'k2', canonical_e164: '+15550002222', best_phone_score: 40, phone_type: 'Landline' },
    ],
    sub_owners: [{ master_owner_id: 'o1', owner_name: 'Ruiz Family Trust' }],
  })
  const { values } = await getEntityGraphColumnEnrichment({ property_ids: '1,2', fields: 'year_built,owner.priority_tier,scores.decision_tier,contact.person,contact.person_count,contact.phone_count,contact.line_type,entity.name,entity.count' }, { supabase })
  assert.deepEqual(values['1'], { 'owner.priority_tier': 'A', 'entity.name': 'Ruiz Family Trust', 'entity.count': 1, year_built: 1950 })
  assert.equal(values['2']['contact.person'], 'Ana Ruiz')
  assert.equal(values['2']['contact.person_count'], 2)
  assert.equal(values['2']['contact.phone_count'], 2)
  assert.equal(values['2']['contact.line_type'], 'Wireless')
  assert.equal(values['2']['scores.decision_tier'], 'B')
  assert.ok(!JSON.stringify(values).includes('+1555'))
})

test('two concurrent adds to the same draft both land — compare-and-set, no lost update', async () => {
  const log = []
  const supabase = fakeSupabase({ campaign_target_graph: ['A', 'B', 'C', 'D', 'E'].map((id) => ready(id)) }, log)
  const { api, store } = campaignsFake([{ id: 'X', name: 'Race', status: 'draft', metadata: {}, updated_at: 'v0' }], log)
  const deps = { supabase, campaigns: api, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) }
  const [first, second] = await Promise.all([
    stackEntityGraphCohort({ campaign_id: 'X', scope: 'properties', mode: 'selection', ids: ['A', 'B', 'C'] }, deps),
    stackEntityGraphCohort({ campaign_id: 'X', scope: 'properties', mode: 'selection', ids: ['C', 'D', 'E'] }, deps),
  ])
  assert.deepEqual([...explicitSelectedPropertyIds(store.get('X'))].sort(), ['A', 'B', 'C', 'D', 'E'])
  assert.ok(log.some((e) => e.casConflict), 'the second writer hit the stale token and retried')
  // the overlap is counted once: whoever wrote second reports C as already present
  assert.equal(first.added + second.added, 5)
  assert.equal(store.get('X').metadata.entity_graph_stack.length, 2)
})

test('a draft that stops being a draft mid-run is not written', async () => {
  const log = []
  const supabase = fakeSupabase({ campaign_target_graph: [ready('A')] }, log)
  const { api, store } = campaignsFake([{ id: 'X', name: 'X', status: 'draft', metadata: {}, updated_at: 'v0' }], log)
  const origCas = api.casUpdate
  api.casUpdate = async (...args) => { store.get('X').status = 'built'; store.get('X').updated_at = 'v9'; return origCas(...args) }
  await assert.rejects(
    stackEntityGraphCohort({ campaign_id: 'X', scope: 'properties', mode: 'selection', ids: ['A'] }, { supabase, campaigns: api, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) }),
    (e) => e.code === 'campaign_not_draft',
  )
  assert.equal(explicitSelectedPropertyIds(store.get('X')).size, 0)
})

test('a legacy param that narrows nothing on this scope is not a cohort', async () => {
  const supabase = fakeSupabase({})
  await assert.rejects(resolveStackPropertyIds({ scope: 'properties', mode: 'cohort', score_min: '50' }, { supabase }), (e) => e.code === 'cohort_has_no_filters')
  await assert.rejects(resolveStackPropertyIds({ scope: 'people', mode: 'cohort', market: 'Dallas' }, { supabase }), (e) => e.code === 'cohort_has_no_filters')
})

test('contact discovery: linked-prospect phones show as masked candidates with resolution, eligibility untouched', async () => {
  const { getEntityGraphOutreachState, contactCandidates, maskPhone } = await import('../../src/lib/domain/entity-graph/entity-graph-outreach-state.js')
  assert.equal(maskPhone('+15551234567'), '•••-4567')
  const supabase = fakeSupabase({
    campaign_target_graph: [{ property_id: '9', queue_eligible: false, queue_block_reason: 'missing_phone', seller_person_key: 'ik1', canonical_e164: null }],
    properties: [{ property_id: '9', master_owner_id: null }],
    prospects: [
      { prospect_id: 'a', individual_key: 'ik1', master_owner_id: null, full_name: 'Ana Ruiz', linked_property_ids_json: ['9'], phones_json: [{ canonical_e164: '+15550001111', phone_type: 'W', phone_score: 81 }] },
      { prospect_id: 'b', individual_key: 'ik2', master_owner_id: null, full_name: 'Luis Ruiz', linked_property_ids_json: ['9'], phones_json: [{ canonical_e164: '+15550002222', phone_type: 'L' }] },
    ],
  })
  // the fake has no .contains — add a tiny one for jsonb array containment
  const from = supabase.from
  supabase.from = (t) => { const q = from(t); q.contains = (c, vs) => { q.__c = [c, vs]; return q.in('prospect_id', (t === 'prospects' ? ['a', 'b'] : [])) }; return q }
  const { states } = await getEntityGraphOutreachState({ property_ids: '9' }, { supabase })
  const st = states['9']
  assert.equal(st.sms.eligible, false, 'eligibility is still the graph verdict')
  assert.equal(st.sms.reason, 'missing_phone')
  assert.equal(st.contactCandidates.people, 2)
  assert.equal(st.contactCandidates.phones, 2)
  assert.deepEqual(st.contactCandidates.candidates.map((c) => c.resolution), ['graph_person', 'linked_unresolved'])
  assert.ok(!JSON.stringify(states).includes('+1555'), 'no raw number leaves the server')
  assert.equal(contactCandidates({ prospects: [{ master_owner_id: 'o1', full_name: 'X', phones_json: [{ canonical_e164: '+15550003333' }] }], propertyOwnerId: 'o1' })[0].resolution, 'resolved_owner')
})
