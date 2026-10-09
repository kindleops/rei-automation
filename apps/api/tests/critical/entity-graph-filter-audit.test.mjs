/**
 * ENTITY GRAPH FILTER AUDIT (2026-10-08). Every left-rail filter was checked
 * end-to-end against the table its tab reads (information_schema + a 2%
 * sample on prod, read-only). These pin the defects that audit found:
 *
 *   1. Five Decision Engine fields (aos_score, decision_tier, …) were offered
 *      on Properties but do not exist on properties / v_entity_graph_properties:
 *      any filter on them failed the whole query.
 *   2. Delimited-list columns (property_flags_text, matching_flags,
 *      person_flags_text) compiled "is any of" to whole-string equality.
 *   3. "Age bucket" compiled to prospects.mob — month of birth (YYYYMM).
 *   4. "Equity 60%+" read the vendor equity_percent, which is 100% whenever no
 *      loan is on file: 164,245 properties vs 67,328 with KNOWN equity ≥ 60.
 *   5. The Contacts → Emails list ignored every field filter.
 *
 * No network: queries are recorded, not run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENTITY_GRAPH_UNEXECUTABLE_FIELDS,
  ageMobBounds,
  applyEntityGraphFieldFilters,
  flagTokenPatterns,
  getEntityGraphFilterFields,
  orFilterValue,
  resolveEntityGraphFieldFilters,
} from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { compileFacetWhere, splitLogicalParts } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { browseEntityGraph } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import { buildEntityGraphComposition, getCompositionCatalog } from '../../src/lib/domain/entity-graph/entity-graph-composition.js'

const resolveOne = (tab, filter) => resolveEntityGraphFieldFilters(tab, [filter])

test('fields that do not exist on the browsed table are not offered and fail closed', () => {
  const offered = new Set(getEntityGraphFilterFields('properties').map((f) => f.key))
  for (const key of ['properties.aos_score', 'properties.decision_tier', 'properties.acquisition_confidence', 'properties.transaction_probability_365', 'properties.best_strategy']) {
    assert.ok(ENTITY_GRAPH_UNEXECUTABLE_FIELDS[key], key)
    assert.ok(!offered.has(key), `${key} is still offered`)
    const { resolved, unsupported } = resolveOne('properties', { field_key: key, operator: 'gte', value: 1 })
    assert.equal(resolved.length, 0)
    assert.equal(unsupported[0].reason, 'field_not_executable_on_entity_graph')
  }
  assert.ok(!getEntityGraphFilterFields('people').some((f) => f.key === 'prospects.age_bucket'))
})

test('delimited lists match whole tokens, never the whole string', () => {
  const props = resolveOne('properties', { field_key: 'properties.property_flags_text', operator: 'is_any_of', value: ['Vacant Home'] })
  assert.equal(props.unsupported.length, 0)
  const calls = []
  const rec = new Proxy({}, { get: (_t, m) => (m === 'then' ? undefined : (...args) => { calls.push([m, ...args]); return rec }) })
  applyEntityGraphFieldFilters(rec, props.resolved)
  assert.equal(calls[0][0], 'or')
  assert.match(calls[0][1], /property_flags_text\.ilike\.Vacant Home,property_flags_text\.ilike\.Vacant Home;%/)
  assert.ok(!calls.some(([m]) => m === 'in'), 'no whole-string equality')

  const people = resolveOne('people', { field_key: 'prospects.matching_flags', operator: 'is_any_of', value: ['Likely Owner'] })
  const { where, params } = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, people.resolved))
  assert.match(where, /"matching_flags" ilike \$1 or "matching_flags" ilike \$2/)
  // ", "-separated: the comma is quoted inside the or() so PostgREST does not split on it
  assert.deepEqual(params, ['Likely Owner', 'Likely Owner,%', '%, Likely Owner', '%, Likely Owner,%'])
})

test('token patterns and or-values', () => {
  assert.deepEqual(flagTokenPatterns('Senior'), ['Senior', 'Senior;%', '%; Senior', '%; Senior;%'])
  assert.deepEqual(flagTokenPatterns('Family', ', '), ['Family', 'Family,%', '%, Family', '%, Family,%'])
  assert.equal(orFilterValue('a,b'), '"a,b"')
  assert.equal(orFilterValue('plain'), 'plain')
})

test('the facet recorder reads nested and()/or() groups and quoted values', () => {
  assert.deepEqual(splitLogicalParts('a.eq.1,and(b.gt.0,c.lt.2),d.ilike."x, y"'), ['a.eq.1', 'and(b.gt.0,c.lt.2)', 'd.ilike."x, y"'])
  const { where, params } = compileFacetWhere((b) => b.or('and(total_loan_balance.gt.0,equity_percent.gte.60),and(estimated_value.gt.0,or(total_loan_balance.is.null,total_loan_balance.eq.0))'))
  assert.equal(where, 'where (("total_loan_balance" > $1 and "equity_percent" >= $2) or ("estimated_value" > $3 and ("total_loan_balance" is null or "total_loan_balance" = $4)))')
  assert.deepEqual(params, ['0', '60', '0', '0'])
})

test('known equity never counts a missing loan as equity', () => {
  const { resolved, unsupported } = resolveOne('properties', { field_key: 'properties.known_equity_percent', operator: 'gte', value: 60 })
  assert.equal(unsupported.length, 0)
  const { where } = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, resolved))
  // branch a: a loan on file and a value; branch b: no loan + the Free And Clear flag
  assert.match(where, /"total_loan_balance" > \$1 and "estimated_value" > \$2 and "equity_percent" >= \$3/)
  assert.match(where, /"total_loan_balance" is null or "total_loan_balance" = \$\d+/)
  assert.match(where, /"property_flags_text" ilike/)
  // below 100 % the Free And Clear branch cannot apply
  const capped = resolveOne('properties', { field_key: 'properties.known_equity_percent', operator: 'between', value: [20, 50] })
  const low = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, capped.resolved))
  assert.ok(!/property_flags_text/.test(low.where))
  assert.match(low.where, /"equity_percent" >= \$3::numeric and "equity_percent" <= \$4::numeric/)
})

test('age is a month-of-birth range, blanks excluded', () => {
  const now = new Date(Date.UTC(2026, 9, 8))
  assert.deepEqual(ageMobBounds({ lo: 65, hi: null }, now), { lower: '190001', upper: '196110' })
  assert.deepEqual(ageMobBounds({ lo: null, hi: 39 }, now), { lower: '198611', upper: '209912' })
  const { resolved } = resolveOne('people', { field_key: 'prospects.age_years', operator: 'between', value: [55, 64] })
  const { where } = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, resolved))
  assert.match(where, /"mob" >= \$1 and "mob" <= \$2/)
})

test('the Emails list refuses field filters instead of ignoring them', async () => {
  const supabase = { from() { throw new Error('must not query') } }
  await assert.rejects(
    browseEntityGraph({ tab: 'contact_methods', subtype: 'email', field_filters: JSON.stringify([{ field_key: 'phones.phone_type', operator: 'is_any_of', value: ['Wireless'] }]) }, { supabase }),
    (error) => error.code === 'unsupported_entity_graph_filters',
  )
})

test('people, owners and phones have facets, counted by one grouped query over their own table', async () => {
  for (const tab of ['people', 'master_owners', 'contact_methods']) {
    assert.ok(getCompositionCatalog(tab).dimensions.length >= 3, tab)
  }
  const seen = []
  const deps = {
    facetsAvailable: () => true,
    groupedTokenCounts: async (args) => {
      seen.push(args)
      const { where } = compileFacetWhere(args.applyFilters)
      assert.match(where, /"language_preference" = any/)
      return { tokens: [{ value: 'Likely Owner', count: 5 }, { value: 'Family', count: 3 }], total: 7 }
    },
  }
  const out = await buildEntityGraphComposition({ tab: 'people', dimension: 'matching', all: '1', field_filters: JSON.stringify([{ field_key: 'prospects.language_preference', operator: 'is_any_of', value: ['Spanish'] }]) }, deps)
  assert.equal(seen[0].source, 'prospects')
  assert.equal(seen[0].split, ', ')
  assert.equal(out.buckets[0].filter.field_key, 'prospects.matching_flags')
  assert.equal(out.buckets[0].value, 5)
})
