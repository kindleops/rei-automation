/**
 * P0 2026-10-09 — PROPERTY FLAGS STACK.
 *
 * Owner: "When I click multiple property flags, it doesn't add them … it's
 * all the same amount." Several flags compiled to ONE or=(…) — any of — and
 * the common flags cover almost every flagged property, so on Dallas, TX
 * (7,738 properties, prod read 2026-10-09):
 *   any of  Tax Delinquent 738 → + Absentee Owner 5,766 → + High Equity 5,898
 *   all of  Tax Delinquent 738 → + Absentee Owner   737 → + High Equity   737 → + Vacant Home 44
 * "Has all of" (is_all_of) is the default for properties.flags: one or=(…)
 * per token, which PostgREST ANDs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'

import {
  applyEntityGraphFieldFilters,
  getEntityGraphFilterFields,
  resolveEntityGraphFieldFilters,
} from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { compileFacetWhere } from '../../src/lib/domain/entity-graph/entity-graph-facet-sql.js'
import { applyPropertyFilters, parseBrowseFilters } from '../../src/lib/domain/entity-graph/entity-graph-service.js'

const flags = (operator, value) => [{ field_key: 'properties.flags', operator, value }]

/** The PostgREST query string supabase-js builds for these filters (no network). */
async function postgrestParams(requested) {
  const { resolved, unsupported } = resolveEntityGraphFieldFilters('properties', requested)
  assert.deepEqual(unsupported, [])
  let url = null
  const fetchStub = async (u) => { url = new URL(String(u)); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const client = createClient('http://stub.local', 'stub', { global: { fetch: fetchStub }, auth: { persistSession: false } })
  await applyEntityGraphFieldFilters(client.from('v_entity_graph_properties').select('property_id'), resolved)
  return url.searchParams
}

/** Evaluate the compiled or=(…) groups against fixture rows (ilike → regex), to count. */
function countMatching(rows, requested) {
  const { resolved } = resolveEntityGraphFieldFilters('properties', requested)
  const groups = []
  const recorder = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : (...args) => { if (prop === 'or') groups.push(args[0]); return recorder }) })
  applyEntityGraphFieldFilters(recorder, resolved)
  const like = (pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
  const preds = groups.map((g) => g.split(',').map((part) => like(part.replace(/^property_flags_text\.ilike\./, ''))))
  return rows.filter((text) => preds.every((alts) => alts.some((re) => re.test(text ?? '')))).length
}

test('properties.flags offers "Has all of" first (the default) and "Has any of"', () => {
  const field = getEntityGraphFilterFields('properties').find((f) => f.key === 'properties.flags')
  assert.deepEqual(field.operators.map((o) => o.key), ['is_all_of', 'is_any_of'])
  // the other delimited token fields can stack too
  const people = getEntityGraphFilterFields('people')
  for (const key of ['prospects.matching_flags', 'prospects.person_flags_text']) {
    assert.ok(people.find((f) => f.key === key).operators.some((o) => o.key === 'is_all_of'), key)
  }
})

test('all of → one or=(…) per flag (PostgREST ANDs them); any of → one or=(…) of every flag', async () => {
  const all = await postgrestParams(flags('is_all_of', ['Tax Delinquent', 'Absentee Owner']))
  assert.deepEqual(all.getAll('or'), [
    '(property_flags_text.ilike.Tax Delinquent,property_flags_text.ilike.Tax Delinquent;%,property_flags_text.ilike.%; Tax Delinquent,property_flags_text.ilike.%; Tax Delinquent;%)',
    '(property_flags_text.ilike.Absentee Owner,property_flags_text.ilike.Absentee Owner;%,property_flags_text.ilike.%; Absentee Owner,property_flags_text.ilike.%; Absentee Owner;%)',
  ])
  const any = await postgrestParams(flags('is_any_of', ['Tax Delinquent', 'Absentee Owner']))
  assert.equal(any.getAll('or').length, 1)
  assert.equal(any.get('or').split(',').length, 8)
})

test('a single value as a string still resolves for all of', async () => {
  const p = await postgrestParams(flags('is_all_of', 'Vacant Home'))
  assert.equal(p.getAll('or').length, 1)
})

test('direct-SQL facet WHERE: all of is an AND of per-flag groups', () => {
  const { resolved } = resolveEntityGraphFieldFilters('properties', flags('is_all_of', ['Vacant Home', 'Tax Delinquent']))
  const { where } = compileFacetWhere((b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, parseBrowseFilters({})), resolved))
  assert.match(where, /\("property_flags_text" ilike \$\d+ or [^)]*\) and \("property_flags_text" ilike \$\d+ or [^)]*\)/)
})

test('multi-flag count NARROWS with all of (and only widens with any of)', () => {
  const rows = [
    'Tax Delinquent; Absentee Owner; High Equity',
    'Absentee Owner; High Equity',
    'Absentee Owner; High Equity; Vacant Home',
    'Tax Delinquent; Absentee Owner; Vacant Home',
    'High Equity',
    'Preforeclosure',
    null,
  ]
  const all = (v) => countMatching(rows, flags('is_all_of', v))
  const any = (v) => countMatching(rows, flags('is_any_of', v))
  assert.equal(all(['Tax Delinquent']), 2)
  assert.equal(all(['Tax Delinquent', 'Absentee Owner']), 2)
  assert.equal(all(['Tax Delinquent', 'Absentee Owner', 'Vacant Home']), 1)
  assert.equal(all(['Absentee Owner', 'High Equity']), 3)
  assert.equal(any(['Tax Delinquent', 'Absentee Owner']), 4)
  assert.equal(any(['Tax Delinquent', 'Absentee Owner', 'High Equity']), 5)
  // whole tokens: Foreclosure is not inside Preforeclosure
  assert.equal(all(['Foreclosure']), 0)
})
