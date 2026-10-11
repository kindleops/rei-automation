/**
 * EG 8.6 · the Overview for EVERY scope (owner 2026-10-10: "universal across
 * all the tables, in one overview").
 *
 *   - registry per scope: properties, owners, people, contacts (phones),
 *     buyers, companies — each field in one of that scope's sections, every
 *     pinned key charted
 *   - the chart kind follows the field type (categorical bars, numeric
 *     histograms, beds / baths one bar per whole number, sqft ranges, money
 *     bands, age buckets, income / net asset value bands, dates, booleans,
 *     tokens, arrays, derived classes)
 *   - protected-class-adjacent fields are charted and MARKED sensitive; no
 *     pricing / negotiation module reads the Overview
 *   - click → filter round trip on every scope: every bucket's chip resolves
 *     on that scope's own catalog, and the bar's count predicate IS the chip's
 *     cohort predicate
 *   - no unbounded scan in live mode: the unfiltered universe is "computing"
 *     without a snapshot — no cohort statement runs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  OVERVIEW_TABS,
  getOverviewCatalog,
  moneyRangeFloor,
  numericBinsFor,
  overviewPinnedFor,
  overviewRegistry,
  overviewSectionsFor,
} from '../../src/lib/domain/entity-graph/entity-graph-overview-catalog.js'
import {
  bandedTextBuckets,
  buildEntityGraphOverview,
  compileCohort,
  isUnfiltered,
  OVERVIEW_SCOPE,
  paramList,
  UNIVERSE_COMPUTING,
  __overviewTest,
} from '../../src/lib/domain/entity-graph/entity-graph-overview-service.js'
import { resolveEntityGraphFieldFilters, applyEntityGraphFieldFilters } from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { compileFacetWhere } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { OVERVIEW_COLUMN_PROFILE } from '../../src/lib/domain/entity-graph/entity-graph-overview-profile.js'

/* the scope relations' columns, as information_schema would answer */
const BASE_COLUMNS = {
  master_owners: ['master_owner_id', 'owner_type_guess', 'priority_tier', 'follow_up_cadence', 'contactability_score', 'financial_pressure_score', 'urgency_score', 'priority_score', 'portfolio_total_value', 'portfolio_total_equity', 'portfolio_total_loan_balance', 'portfolio_total_loan_payment', 'portfolio_total_tax_amount', 'portfolio_total_units', 'property_count', 'tax_delinquent_count', 'oldest_tax_delinquent_year', 'active_lien_count', 'max_ownership_years', 'markets_text', 'routing_market'],
  prospects: ['prospect_id', 'individual_key', 'mob', 'language_preference', 'gender', 'marital_status', 'education_model', 'occupation_group', 'est_household_income', 'net_asset_value', 'buying_power', 'timezone', 'contact_window', 'matching_flags', 'person_flags_text', 'sms_eligible', 'email_eligible', 'contact_score_final'],
  phones: ['phone_id', 'phone_type', 'phone_owner', 'activity_status', 'usage_12_months', 'usage_2_months', 'wrong_number_at', 'contact_score_final'],
  eg_buyer_index: ['buyer_id', 'activity_status', 'days_since_last', 'trailing_90d', 'trailing_180d', 'trailing_365d', 'acquisition_count', 'acquisitions_per_year', 'last_acquisition', 'first_acquisition', 'archetype', 'hold_flip', 'cash_share', 'has_buybox', 'states', 'counties', 'zips', 'primary_market', 'dominant_family', 'asset_families', 'price_p50', 'price_p25', 'price_p75', 'portfolio_count', 'owned_count', 'sold_count', 'is_crossover', 'entity_type', 'confidence'],
  sub_owners: ['sub_owner_id', 'master_owner_id', 'owner_name', 'owner_address_state', 'owner_address_city', 'owner_address_zip'],
}
const TYPES = { states: 'ARRAY', counties: 'ARRAY', zips: 'ARRAY', asset_families: 'ARRAY', last_acquisition: 'date', first_acquisition: 'date', sms_eligible: 'boolean', email_eligible: 'boolean', has_buybox: 'boolean', is_crossover: 'boolean' }
const NUMERIC = /score|portfolio_total|count|years|year$|days|trailing|acquisitions_per|share|price|confidence|units/
const SCHEMA_ROWS = [
  ...Object.entries(OVERVIEW_COLUMN_PROFILE).map(([column_name, p]) => ({ table_name: 'v_entity_graph_properties', column_name, data_type: p.type })),
  { table_name: 'v_entity_graph_properties', column_name: 'property_flags_text', data_type: 'text' },
  { table_name: 'v_entity_graph_properties', column_name: 'rec_lien_categories', data_type: 'ARRAY' },
  ...Object.entries(BASE_COLUMNS).flatMap(([t, cols]) => cols.map((c) => ({ table_name: t, column_name: c, data_type: TYPES[c] || (NUMERIC.test(c) && !/_id$/.test(c) ? 'numeric' : 'text') }))),
]

function fakeQuery({ total = 500, groups = [], tokens = [] } = {}) {
  const seen = []
  const query = async (sql, params) => {
    seen.push({ sql, params })
    if (/information_schema\.columns/.test(sql)) return { rows: SCHEMA_ROWS }
    if (/with c as materialized/.test(sql)) {
      const agg = { t: total }
      for (const m of sql.matchAll(/ as "(a\d+|h_m_[a-z0-9_]+|h_s_[a-z0-9_]+|h_st_[a-z0-9]+|h_known_equity|h_high_equity)"/g)) agg[m[1]] = 3
      const row = { agg }
      for (const m of sql.matchAll(/ as "(g\d+)"/g)) row[m[1]] = groups
      for (const m of sql.matchAll(/ as "(k\d+)"/g)) row[m[1]] = tokens
      return { rows: [row] }
    }
    return { rows: [] }
  }
  return { query, seen }
}
const deps = (q) => ({ query: q, skipSnapshot: true, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) })
const FILTER_BY_TAB = {
  properties: [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Los Angeles, CA'] }],
  master_owners: [{ field_key: 'master_owners.property_count', operator: 'gte', value: 2 }],
  people: [{ field_key: 'prospects.sms_eligible', operator: 'is_true', value: null }],
  contact_methods: [{ field_key: 'phones.phone_type', operator: 'is_any_of', value: ['W'] }],
  buyers: [{ field_key: 'buyers.acquisition_count', operator: 'gte', value: 2 }],
  organizations: [{ field_key: 'organizations.owner_address_state', operator: 'is_any_of', value: ['TX'] }],
}

test('every desk scope has a registry: its fields sit in its own sections, its pinned keys are charted', () => {
  assert.deepEqual([...OVERVIEW_TABS].sort(), ['buyers', 'contact_methods', 'master_owners', 'organizations', 'people', 'properties'])
  for (const tab of OVERVIEW_TABS) {
    const registry = overviewRegistry(tab)
    const sections = new Set(overviewSectionsFor(tab).map((s) => s.id))
    assert.ok(registry.length > 0, `${tab} charts nothing`)
    for (const f of registry) assert.ok(sections.has(f.section), `${tab} ${f.key} → ${f.section}`)
    for (const k of overviewPinnedFor(tab)) assert.ok(registry.some((f) => f.key === k), `${tab} pinned ${k} is not charted`)
    const catalog = getOverviewCatalog(tab)
    assert.equal(catalog.supported, true, tab)
    assert.ok(catalog.sections.some((s) => s.fields.length), `${tab} catalog sections are empty`)
  }
  assert.equal(getOverviewCatalog('zips').supported, false)
})

test('the chart follows the field type: beds/baths per whole number, sqft ranges, money bands, age buckets, income / NAV bands', () => {
  const kind = (tab, key) => overviewRegistry(tab).find((f) => f.key === key)?.kind
  assert.deepEqual(numericBinsFor('total_bedrooms').map((b) => b.label), ['0', '1', '2', '3', '4', '5', '6+'])
  assert.deepEqual(numericBinsFor('total_baths').map((b) => b.label), ['0', '1', '2', '3', '4', '5', '6+'])
  // a 2.5-bath home is in "2", never between two bars
  const baths = numericBinsFor('total_baths')
  assert.ok(baths.find((b) => b.label === '2').lo === 2 && baths.find((b) => b.label === '2').hi < 3 && baths.find((b) => b.label === '2').hi > 2.9)
  assert.ok(numericBinsFor('building_square_feet').every((b) => /sqft/.test(b.label)), 'square feet in sqft ranges')
  const fmt = (tab, key) => overviewRegistry(tab).find((f) => f.key === key)?.format
  assert.equal(fmt('properties', 'properties.estimated_value'), 'money')
  assert.ok(numericBinsFor('estimated_value', { format: fmt('properties', 'properties.estimated_value') }).some((b) => /\$/.test(b.label)), 'value in currency bins')
  assert.ok(numericBinsFor('portfolio_total_equity').some((b) => /\$/.test(b.label)), 'portfolio equity in currency bins')
  assert.deepEqual(numericBinsFor('age_years', { integer: true }).map((b) => b.label), ['Under 18', '18–34', '35–49', '50–64', '65–74', '75+'])
  assert.equal(kind('properties', 'properties.market'), 'categorical')
  assert.equal(kind('properties', 'properties.total_bedrooms'), 'numeric')
  assert.equal(kind('properties', 'properties.flags'), 'tokens')
  assert.equal(kind('people', 'prospects.age_years'), 'derived_number')
  assert.equal(kind('people', 'prospects.est_household_income'), 'banded_text')
  assert.equal(kind('people', 'prospects.net_asset_value'), 'banded_text')
  assert.equal(kind('people', 'prospects.gender'), 'categorical')
  assert.equal(kind('people', 'prospects.sms_eligible'), 'boolean')
  assert.equal(kind('people', 'prospects.email_eligible'), 'boolean')
  assert.equal(kind('people', 'prospects.matching_flags'), 'tokens')
  assert.equal(kind('buyers', 'buyers.last_acquisition'), 'date')
  assert.equal(kind('buyers', 'buyers.states'), 'array')
  assert.equal(kind('buyers', 'buyers.price_p50'), 'numeric')
  assert.equal(kind('contact_methods', 'phones.phone_owner'), 'categorical', 'a relationship code, not an identifier')
  assert.equal(kind('organizations', 'organizations.entity_class'), 'derived_categorical')
  assert.equal(kind('organizations', 'organizations.has_master_owner'), 'derived_boolean')
  assert.equal(kind('organizations', 'organizations.owner_address_state'), 'categorical')
})

test('income / net asset value: stored ranges fold into ordered bands, a band filters its exact stored values, nothing is lost', () => {
  assert.equal(moneyRangeFloor('$35,000-$39,999'), 35000)
  assert.equal(moneyRangeFloor('$250,000 or More'), 250000)
  assert.equal(moneyRangeFloor('$0-24,999'), 0)
  assert.equal(moneyRangeFloor('Unknown'), null)
  const field = overviewRegistry('people').find((f) => f.key === 'prospects.est_household_income')
  const group = { distinct: 6, values: [
    { key: '$35,000-$39,999', count: 10 }, { key: '$40,000-$44,999', count: 5 }, { key: '$0-$14,999', count: 4 },
    { key: '$250,000 or More', count: 2 }, { key: 'n/a', count: 1 }, { key: null, count: 3 },
  ] }
  const { buckets, known } = bandedTextBuckets(field, group, 25)
  const sum = buckets.reduce((s, b) => s + b.count, 0)
  assert.equal(sum, 25, 'Σ bands + other + not recorded = the cohort')
  assert.equal(known, 22)
  const band = buckets.find((b) => b.lo === 25000)
  assert.equal(band.count, 15)
  assert.deepEqual(band.filter, { field_key: 'prospects.est_household_income', operator: 'is_any_of', value: ['$35,000-$39,999', '$40,000-$44,999'] })
  const { resolved, unsupported } = resolveEntityGraphFieldFilters('people', [band.filter])
  assert.deepEqual(unsupported, [])
  assert.equal(resolved.length, 1)
  assert.equal(buckets.find((b) => b.key === '__other').filter, null)
})

test('sensitive fields are charted and marked; nothing in valuation / pricing / negotiation reads the Overview', () => {
  const people = overviewRegistry('people')
  for (const key of ['prospects.age_years', 'prospects.gender', 'prospects.marital_status', 'prospects.language_preference']) {
    assert.equal(people.find((f) => f.key === key)?.sensitive, true, key)
  }
  // 8.5.6 (IC8 fairness policy, owner + counsel): income / modeled wealth is a personal attribute too —
  // display and targeting only, never pricing — so its card carries the marker (it was unmarked before 8.5.6)
  assert.equal(people.find((f) => f.key === 'prospects.est_household_income')?.sensitive, true)
  // a non-personal field stays unmarked
  assert.equal(people.find((f) => f.key === 'prospects.sms_eligible')?.sensitive, false)
  // the Overview / campaign scope modules are read by Entity Graph and its routes only
  const root = new URL('../../src/', import.meta.url).pathname
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(js|mjs|ts)$/.test(name)) continue
      // Entity Graph itself, its cockpit routes and its internal snapshot job
      if (p.includes('/domain/entity-graph/') || p.includes('/api/cockpit/entity-graph/') || p.includes('/api/internal/entity-graph/')) continue
      if (/entity-graph-overview-(service|catalog)/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(root.length))
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], 'no pricing / negotiation / campaign path imports the Overview')
})

test('click → filter round trip on EVERY scope: each bar is that scope’s own chip, and its count predicate IS the chip’s cohort', async () => {
  for (const tab of OVERVIEW_TABS) {
    __overviewTest.reset()
    const { query, seen } = fakeQuery({
      groups: [{ gi: 0, k: 'Value A', n: 5, cnt: 2 }, { gi: 0, k: '$35,000-$39,999', n: 4, cnt: 2 }, { gi: 0, k: null, n: 3, cnt: 2 }],
      tokens: [{ k: 'likely owner', label: 'Likely Owner', n: 4 }],
    })
    const sections = ['pinned', 'headline', ...overviewSectionsFor(tab).map((s) => s.id).filter((id) => id !== 'headline')].join(',')
    const out = await buildEntityGraphOverview({ tab, field_filters: JSON.stringify(FILTER_BY_TAB[tab]), sections }, deps(query))
    assert.equal(out.supported, true, tab)
    assert.equal(out.unavailable.filter((u) => !/engagement|Engagement|eligib/.test(u.reason)).length, 0, `${tab}: ${JSON.stringify(out.unavailable)}`)
    let checked = 0
    for (const section of out.sections) {
      for (const f of section.fields) {
        for (const b of [...(f.buckets || []), ...(f.windows || [])]) {
          if (!b.filter) continue
          const { resolved, unsupported } = resolveEntityGraphFieldFilters(tab, [b.filter], { allowComputedFacts: tab === 'properties' })
          assert.deepEqual(unsupported, [], `${tab} ${f.key} ${b.key}`)
          assert.equal(resolved.length, 1)
          assert.equal(b.filter.field_key, f.key, 'a bar filters its own field')
          // the chip added to the rail compiles (the cohort refetches with it), never a 422
          compileCohort({ tab, field_filters: JSON.stringify([...FILTER_BY_TAB[tab], b.filter]) }, { tab })
          checked += 1
        }
      }
    }
    assert.ok(checked > 0, `${tab}: no clickable bar`)
    for (const m of out.headline?.metrics?.filter((x) => x.filter) || []) {
      assert.deepEqual(resolveEntityGraphFieldFilters(tab, [m.filter], { allowComputedFacts: tab === 'properties' }).unsupported, [], `${tab} metric ${m.key}`)
    }
    // the cohort statement reads the scope's own relation under the list's WHERE
    const stmt = seen.find((s) => /with c as materialized/.test(s.sql))
    assert.ok(stmt.sql.includes(`from public."${OVERVIEW_SCOPE[tab].relation}" where`), `${tab} reads ${OVERVIEW_SCOPE[tab].relation}`)
  }
})

test('a band’s FILTER count compiles to exactly the predicate its chip adds to the cohort (bar = chip cohort)', () => {
  const norm = (sql) => sql.replace(/\$\d+/g, '?')
  const cases = [
    ['people', { field_key: 'prospects.age_years', operator: 'between', value: [65, 74] }],
    ['properties', { field_key: 'properties.total_bedrooms', operator: 'between', value: [3, 3.9999] }],
    ['organizations', { field_key: 'organizations.entity_class', operator: 'is_any_of', value: ['Trust'] }],
    ['buyers', { field_key: 'buyers.trailing_90d', operator: 'gte', value: 1 }],
  ]
  for (const [tab, chip] of cases) {
    const { resolved } = resolveEntityGraphFieldFilters(tab, [chip])
    const pred = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, resolved))
    const P = paramList()
    const embedded = P.embed(pred.clauses, pred.params)
    const base = compileCohort({ tab }, { tab })
    const withChip = compileCohort({ tab, field_filters: JSON.stringify([chip]) }, { tab })
    // the cohort = the base clauses + exactly this predicate
    assert.equal(withChip.clauses.length, base.clauses.length + pred.clauses.length, tab)
    assert.equal(norm(withChip.clauses.slice(base.clauses.length).join(' and ')), norm(embedded), `${tab} ${chip.field_key}`)
    assert.deepEqual(withChip.params.slice(base.params.length), P.list, `${tab} params`)
  }
})

test('the organization classes partition every entity (exclusive, first match wins)', () => {
  const sqlFor = (value) => {
    const { resolved } = resolveEntityGraphFieldFilters('organizations', [{ field_key: 'organizations.entity_class', operator: 'is_any_of', value: [value] }])
    return compileFacetWhere((b) => applyEntityGraphFieldFilters(b, resolved))
  }
  const trust = sqlFor('Trust')
  assert.ok(/not \("owner_name" ilike/.test(trust.where), 'Trust excludes LLC/Corporation names')
  assert.ok(trust.params.includes('%trust%'))
  const other = sqlFor('Other')
  assert.ok(/"owner_name" is null/.test(other.where), 'a nameless entity is Other')
})

test('NO unbounded scan in live mode: the unfiltered universe is "computing" (no cohort statement) until the snapshot exists', async () => {
  for (const tab of ['properties', 'master_owners', 'people']) {
    __overviewTest.reset()
    const { query, seen } = fakeQuery()
    const out = await buildEntityGraphOverview({ tab, sections: 'pinned,headline' }, deps(query))
    assert.equal(out.computing, true, tab)
    assert.equal(seen.filter((s) => /with c as materialized/.test(s.sql)).length, 0, `${tab} scanned the universe live`)
    assert.ok(out.sections.every((s) => s.computing && s.unavailable === UNIVERSE_COMPUTING))
    assert.ok(out.unavailable.some((u) => u.computing))
  }
  // a filtered cohort is live
  const cohort = compileCohort({ tab: 'people', field_filters: JSON.stringify(FILTER_BY_TAB.people) }, { tab: 'people' })
  assert.equal(isUnfiltered(cohort, {}), false)
  assert.equal(isUnfiltered(compileCohort({ tab: 'master_owners' }, { tab: 'master_owners' }), {}), true, 'test-owner exclusion alone is not a filter')
})

test('the properties headline: distress × market and the signal stack ride on the section’s one scan, from the distress chips’ own predicates', async () => {
  __overviewTest.reset()
  const { query, seen } = fakeQuery()
  const out = await buildEntityGraphOverview({ tab: 'properties', field_filters: JSON.stringify(FILTER_BY_TAB.properties), sections: 'pinned,headline' }, deps(query))
  const stmts = seen.filter((s) => /with c as materialized/.test(s.sql))
  assert.equal(stmts.length, 1, 'one scan for pinned + headline')
  assert.ok(/as "h_mkt"/.test(stmts[0].sql) && /from c group by 1 order by \("market" is null\)/.test(stmts[0].sql))
  assert.ok(/as "h_st_s4"/.test(stmts[0].sql) && />= 4\)/.test(stmts[0].sql))
  assert.ok(/as "h_ids"/.test(stmts[0].sql), 'the cohort ids for keyed engagement come off the same scan')
  assert.deepEqual(out.headline.stack.map((b) => b.label), ['None', '1 signal', '2 signals', '3 signals', '4+ signals'])
  assert.ok(out.headline.metrics.some((m) => m.key === 'distressed'))
  assert.ok(out.headline.metrics.some((m) => m.key === 'pipeline'))
})
