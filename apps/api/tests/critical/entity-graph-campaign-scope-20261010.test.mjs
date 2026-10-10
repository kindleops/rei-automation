/**
 * EG 8.6 · CAMPAIGN → ENTITY GRAPH: the "Campaign: <name>" chip is the
 * campaign's EXACT target set, server-side.
 *
 *   - built campaign: distinct property ids of campaign_targets ∪ send_queue
 *     (count parity with the campaign's own rows); owners via the target, its
 *     property and its person; people by individual_key
 *   - draft: pinned ids; saved property filters; a non-property clause fails closed
 *   - an empty campaign is an empty cohort, an unprimed chip throws — the chip is
 *     never "no filter"
 *   - tabs: properties / owners / people only
 *   - owners / people pages run the id ordering on the direct pool (never a
 *     3,000-id PostgREST URL) and read rows by id
 *   - campaign outcome columns: latest send, delivery, the reply after the send
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMPAIGN_MEMBERSHIP_KEY,
  __campaignScopeTest,
  campaignOutcomes,
  primeCampaignScope,
  resolveCampaignScope,
} from '../../src/lib/domain/entity-graph/entity-graph-campaign-scope.js'
import { applyEntityGraphFieldFilters, resolveEntityGraphFieldFilters } from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { compileFacetWhere } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { browseEntityGraph } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import { compileCohort } from '../../src/lib/domain/entity-graph/entity-graph-overview-service.js'

const CID = '9799d345-06c7-46d8-9b4d-db8b8a4e2bdc'
const chip = (id = CID) => ({ field_key: CAMPAIGN_MEMBERSHIP_KEY, operator: 'is_any_of', value: [id] })

/** campaign_targets + send_queue rows, as the resolver's union reads them. */
function campaignDb({ campaign = { id: CID, name: 'HOT LEADS', status: 'active', metadata: {} }, targets = [], queue = [], propertyOwners = [], personOwners = [] } = {}) {
  const seen = []
  const query = async (sql, params) => {
    seen.push({ sql, params })
    if (/from public\.campaigns where id/.test(sql)) return { rows: campaign ? [campaign] : [] }
    if (/from public\.campaign_targets where campaign_id = \$1::uuid\s+union all/.test(sql)) {
      return { rows: [...targets.map((t) => ({ src: 'target', ...t })), ...queue.map((q) => ({ src: 'queue', primary_property_id: null, ...q }))] }
    }
    if (/from public\.properties where property_id = any/.test(sql)) return { rows: propertyOwners.map((m) => ({ master_owner_id: m })) }
    if (/from public\.prospects where individual_key = any/.test(sql)) return { rows: personOwners.map((m) => ({ master_owner_id: m })) }
    return { rows: [] }
  }
  return { query, seen }
}

test('a built campaign = distinct properties of its targets ∪ its queued / sent rows (count parity with the campaign’s own rows)', async () => {
  const targets = [
    { property_id: 'p1', primary_property_id: 'p1', master_owner_id: null, prospect_id: 'ind-1', status: 'queued' },
    { property_id: 'p2', primary_property_id: 'p2', master_owner_id: 'o2', prospect_id: 'ind-2', status: 'sent' },
    { property_id: 'p2', primary_property_id: 'p2', master_owner_id: 'o2', prospect_id: 'ind-2', status: 'sent' }, // a second phone / touch
    { property_id: 'p3', primary_property_id: 'p4', master_owner_id: null, prospect_id: null, status: 'blocked' },
  ]
  const queue = [{ property_id: 'p5', master_owner_id: null, prospect_id: 'ind-5', status: 'sent' }, { property_id: 'p1', master_owner_id: null, prospect_id: 'ind-1', status: 'sent' }]
  const { query } = campaignDb({ targets, queue, propertyOwners: ['o1'], personOwners: ['o5'] })
  const scope = await resolveCampaignScope(CID, { query })
  assert.equal(scope.mode, 'built')
  assert.equal(scope.targets, 4)
  const truth = new Set([...targets.flatMap((t) => [t.property_id, t.primary_property_id]), ...queue.map((q) => q.property_id)])
  assert.equal(scope.ids.properties.length, truth.size, 'count == distinct campaign_targets ∪ send_queue properties')
  assert.deepEqual([...scope.ids.properties].sort(), [...truth].sort())
  assert.deepEqual([...scope.ids.master_owners].sort(), ['o1', 'o2', 'o5'], 'owner via the target, its property, its person')
  assert.deepEqual([...scope.ids.people].sort(), ['ind-1', 'ind-2', 'ind-5'])

  // the chip compiles to exactly that id set on each tab's own key
  __campaignScopeTest.reset()
  __campaignScopeTest.seed(CID, scope)
  for (const [tab, column, n] of [['properties', 'property_id', truth.size], ['master_owners', 'master_owner_id', 3], ['people', 'individual_key', 3]]) {
    const { resolved, unsupported } = resolveEntityGraphFieldFilters(tab, [chip()])
    assert.deepEqual(unsupported, [])
    const sql = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, resolved))
    assert.equal(sql.where, `where "${column}" = any($1)`, tab)
    assert.equal(sql.params[0].length, n, `${tab} parity`)
  }
  // the Overview cohort is the same WHERE (+ the scope's own base clauses)
  const cohort = compileCohort({ tab: 'properties', field_filters: JSON.stringify([chip()]) }, { tab: 'properties' })
  assert.ok(cohort.clauses.some((c) => /"property_id" = any\(\$\d+\)/.test(c)))
  assert.ok(cohort.params.some((p) => Array.isArray(p) && p.length === truth.size))
})

test('a draft: its pinned ids; its saved property filters; a clause on another domain fails closed', async () => {
  const pinned = campaignDb({ campaign: { id: CID, name: 'D', status: 'draft', metadata: { target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: ['a', 'b', 'a'] }] } } }, propertyOwners: ['oa'] })
  const s1 = await resolveCampaignScope(CID, { query: pinned.query })
  assert.equal(s1.mode, 'explicit')
  assert.deepEqual(s1.ids.properties, ['a', 'b'])
  assert.deepEqual(s1.ids.master_owners, ['oa'])
  assert.equal(s1.ids.people, null, 'a draft pins properties, not people')

  const defined = campaignDb({ campaign: { id: CID, name: 'F', status: 'draft', metadata: { target_filters: { properties: [{ field_key: 'properties.tax_delinquent', operator: 'is_true' }] } } } })
  const s2 = await resolveCampaignScope(CID, { query: defined.query })
  assert.equal(s2.mode, 'definition')
  __campaignScopeTest.reset(); __campaignScopeTest.seed(CID, s2)
  const { resolved } = resolveEntityGraphFieldFilters('properties', [chip()])
  const sql = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, resolved))
  assert.equal(sql.where, 'where "tax_delinquent" is true', 'the draft’s own saved filter, compiled by the same resolver')
  // the people tab cannot see a filter-defined draft: refused, never widened
  const people = resolveEntityGraphFieldFilters('people', [chip()]).resolved
  assert.throws(() => compileFacetWhere((b) => applyEntityGraphFieldFilters(b, people)), (e) => e.name === 'CampaignScopeError')

  const foreign = campaignDb({ campaign: { id: CID, name: 'G', status: 'draft', metadata: { target_filters: { prospects: [{ field_key: 'prospects.gender', operator: 'is_any_of', value: ['F'] }] } } } })
  const s3 = await resolveCampaignScope(CID, { query: foreign.query })
  __campaignScopeTest.reset(); __campaignScopeTest.seed(CID, s3)
  const r3 = resolveEntityGraphFieldFilters('properties', [chip()]).resolved
  assert.throws(() => compileFacetWhere((b) => applyEntityGraphFieldFilters(b, r3)), (e) => e.code === 'campaign_scope_definition_not_property')
})

test('never "no filter": an empty campaign is an empty cohort; an unprimed chip throws; an unknown campaign is a 404', async () => {
  const empty = campaignDb({ campaign: { id: CID, name: 'E', status: 'draft', metadata: {} } })
  const scope = await resolveCampaignScope(CID, { query: empty.query })
  assert.equal(scope.mode, 'empty')
  __campaignScopeTest.reset(); __campaignScopeTest.seed(CID, scope)
  const { resolved } = resolveEntityGraphFieldFilters('properties', [chip()])
  const sql = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, resolved))
  assert.equal(sql.where, 'where "property_id" = any($1)')
  assert.deepEqual(sql.params[0], ['__no_campaign_members__'])

  __campaignScopeTest.reset()
  const r = resolveEntityGraphFieldFilters('properties', [chip()]).resolved
  assert.throws(() => compileFacetWhere((b) => applyEntityGraphFieldFilters(b, r)), (e) => e.code === 'campaign_scope_not_primed')

  const missing = campaignDb({ campaign: null })
  await assert.rejects(resolveCampaignScope(CID, { query: missing.query }), (e) => e.code === 'campaign_scope_not_found')
  await assert.rejects(resolveCampaignScope('not-a-uuid', { query: missing.query }), (e) => e.code === 'campaign_scope_invalid_id')
})

test('the chip narrows properties, owners and people only; operators other than is_any_of are refused', () => {
  for (const tab of ['buyers', 'contact_methods', 'organizations']) {
    const { unsupported } = resolveEntityGraphFieldFilters(tab, [chip()])
    assert.equal(unsupported[0]?.reason, 'campaign_scope_not_on_this_tab', tab)
  }
  assert.equal(resolveEntityGraphFieldFilters('properties', [{ ...chip(), operator: 'is_not_any_of' }]).unsupported[0].reason, 'unsupported_operator')
  assert.equal(resolveEntityGraphFieldFilters('properties', [{ ...chip(), value: ['x'] }]).unsupported[0].reason, 'missing_value')
})

test('priming reads each campaign once (cached) and only when a chip names it', async () => {
  __campaignScopeTest.reset()
  const db = campaignDb({ targets: [{ property_id: 'p1', primary_property_id: 'p1', master_owner_id: 'o1', prospect_id: 'i1' }], propertyOwners: [], personOwners: [] })
  assert.deepEqual(await primeCampaignScope({ field_filters: '[]' }, { query: db.query }), [])
  assert.equal(db.seen.length, 0)
  await primeCampaignScope({ field_filters: JSON.stringify([chip()]) }, { query: db.query })
  const n = db.seen.length
  await primeCampaignScope({ field_filters: JSON.stringify([chip()]) }, { query: db.query })
  assert.equal(db.seen.length, n, 'second prime is cached')
})

test('owners / people in a campaign scope: ids ordered on the direct pool, rows read by id — exact total, no giant PostgREST URL', async () => {
  __campaignScopeTest.reset()
  __campaignScopeTest.seed(CID, { id: CID, name: 'X', status: 'active', mode: 'built', targets: 3, ids: { properties: ['p1'], master_owners: ['o1', 'o2', 'o3'], people: ['i1'] } })
  const sqls = []
  const directQuery = async (sql, params) => {
    sqls.push({ sql, params })
    return { rows: [{ id: 'o2', n: 3 }, { id: 'o1', n: 3 }] }
  }
  const inCalls = []
  const supabase = {
    from(table) {
      const b = {
        select() { return b },
        in(col, ids) { inCalls.push({ table, col, ids }); return Promise.resolve({ data: ids.map((id) => ({ master_owner_id: id, display_name: `Owner ${id}` })), error: null }) },
      }
      return b
    },
  }
  const res = await browseEntityGraph({ tab: 'master_owners', field_filters: JSON.stringify([chip()]), page_size: 2 }, { supabase, directQuery })
  assert.equal(res.pagination.total, 3, 'count(*) over () — the exact scoped total')
  assert.deepEqual(res.results.map((r) => r.entityId), ['o2', 'o1'], 'the direct-PG order is kept')
  assert.ok(/from public\."master_owners" where .*"master_owner_id" = any\(\$\d+\).* order by "display_name" desc nulls last, "master_owner_id" asc offset \$\d+ limit \$\d+/s.test(sqls[0].sql), sqls[0].sql)
  assert.deepEqual(inCalls, [{ table: 'master_owners', col: 'master_owner_id', ids: ['o2', 'o1'] }])
})

test('campaign outcome columns: the latest send, its delivery, the first reply AFTER the send and an opt-out after it', async () => {
  const query = async (sql) => {
    if (/from public\.send_queue/.test(sql)) return { rows: [
      { property_id: 'p1', template_id: '11111111-1111-4111-8111-111111111111', queue_status: 'sent', sent_at: '2026-10-01T15:00:00Z', delivered_at: '2026-10-01T15:00:05Z', touch_number: 1 },
      { property_id: 'p2', template_id: null, use_case_template: 'ownership_check', queue_status: 'failed', sent_at: null, failed_reason: 'carrier_blocked', touch_number: 1 },
    ] }
    if (/from public\.campaign_targets/.test(sql)) return { rows: [{ property_id: 'p1', target_status: 'sent', block_reason: null, touch_number: 1 }, { property_id: 'p3', target_status: 'blocked', block_reason: 'no_phone' }] }
    if (/from public\.sms_templates/.test(sql)) return { rows: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Ownership check v3' }] }
    if (/from public\.message_events/.test(sql)) return { rows: [
      { property_id: 'p1', detected_intent: 'ownership_denied', is_opt_out: false, at: '2026-09-30T10:00:00Z' }, // BEFORE the send: not this campaign's reply
      { property_id: 'p1', detected_intent: 'asking_price', is_opt_out: false, at: '2026-10-01T16:00:00Z' },
      { property_id: 'p1', detected_intent: 'stop', is_opt_out: true, at: '2026-10-02T09:00:00Z' },
    ] }
    return { rows: [] }
  }
  const out = await campaignOutcomes(CID, ['p1', 'p2', 'p3', 'p9'], { query })
  assert.deepEqual(out.get('p1'), { template: 'Ownership check v3', sent_at: '2026-10-01T15:00:00.000Z', delivery: 'Delivered', target_status: 'sent', touch: 1, reply_intent: 'asking price', replied_at: '2026-10-01T16:00:00.000Z', opted_out: true })
  assert.equal(out.get('p2').delivery, 'Failed · carrier_blocked')
  assert.equal(out.get('p2').template, 'ownership_check')
  assert.equal(out.get('p2').opted_out, null, 'never sent: opt-out is not "no"')
  assert.equal(out.get('p3').target_status, 'blocked · no phone')
  assert.equal(out.has('p9'), false, 'not in the campaign: absent, never a blank row')
})
