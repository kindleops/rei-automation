/**
 * THE CANONICAL PROPERTY TYPE (owner P0 2026-10-10: the Property type facet
 * showed the vendor's raw strings — "Single Family", "Multi-Family",
 * "Multi-family", "Apartment", "Other", "SFR", "Townhouse", "Multifamily 5+" —
 * and the owner asked for storage / mixed use / office instead of "Other").
 *
 *   - one classification (entity-graph-property-class.js), a pure function of
 *     the vendor evidence; never invents (no evidence → null)
 *   - precedence: observed property use → credible unit count → vendor asset
 *     class / flags → vendor type (normalized) → property class
 *   - it is a facts column (facts.property_type_class) delivered by an
 *     ADDENDUM: the base eg_property_facts migration is byte-identical, the
 *     refresh writes only columns the table has, reads take the live path
 *     until a full refresh wrote the addendum
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROPERTY_TYPES,
  PROPERTY_TYPE_GROUP_OF,
  PROPERTY_TYPE_TAXONOMY,
  classifyPropertyType,
  classifyPropertyUse,
  credibleUnits,
  normalizeVendorPropertyType,
} from '../../src/lib/domain/entity-graph/entity-graph-property-class.js'
import { COMPUTED_FACTS, FACT_BY_COL, PTYPE_ADDENDUM, computeFacts } from '../../src/lib/domain/entity-graph/entity-graph-facts.js'
import {
  factsAddenda,
  factsTableColumns,
  generateFactsAddendumRollbackSql,
  generateFactsAddendumSql,
  generateFactsMigrationSql,
} from '../../src/lib/domain/entity-graph/entity-graph-facts-ddl.js'
import { addendaWritten, computedColumnsOf, factsUpsertSql, writableFactsColumns } from '../../src/lib/domain/entity-graph/entity-graph-facts-refresh.js'
import { tableServes } from '../../src/lib/domain/entity-graph/entity-graph-facts-query.js'
import { getEntityGraphFilterFields } from '../../src/lib/domain/entity-graph/entity-graph-field-filters.js'
import { getCompositionCatalog } from '../../src/lib/domain/entity-graph/entity-graph-composition.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const T = (row, uses = []) => classifyPropertyType(row, { uses })

test('taxonomy: every type belongs to exactly one group; the owner list is covered', () => {
  for (const t of ['Single Family', 'Townhouse', 'Condo', 'Mobile/Manufactured', 'Duplex', 'Triplex', 'Fourplex', 'Multifamily 5+']) assert.equal(PROPERTY_TYPE_GROUP_OF[t], 'Residential')
  assert.equal(PROPERTY_TYPE_GROUP_OF.Land, 'Land')
  for (const t of ['Retail/Strip Center', 'Office', 'Industrial/Warehouse', 'Self Storage', 'Mixed Use', 'Hotel/Motel', 'Mobile Home Park', 'Other Commercial']) assert.equal(PROPERTY_TYPE_GROUP_OF[t], 'Commercial')
  assert.equal(PROPERTY_TYPES.length, Object.values(PROPERTY_TYPE_TAXONOMY).flat().length)
})

test('every vendor property use observed on prod (2026-10-10, 46 values) maps or is explicitly "says nothing"', () => {
  const prodUses = ['Single Family Residential', 'Duplex (2 units, any combination)', 'Multi-Family Dwellings (Generic, 2+)', 'Apartments (generic)',
    'Triplex (3 units, any combination)', 'Quadruplex (4 units, any combination)', 'Residential (General) (Single)', 'Commercial (General)',
    'Mini-Warehouse, Self-Storage', 'Apartment house (5+ units)', 'Single Family Residential (Assumed)', 'Neighborhood Shopping Center, Strip Center/Mall, Enterprise Zone',
    'Residential Income (General) (Multi-Family)', 'Residential-Vacant Land', 'Bungalow (Residential)', 'Car wash', 'Multi-Family-Vacant Land', 'Hotel',
    'Vacant Land (General)', 'Commercial-Vacant Land', 'Exempt (full or partial)', 'Highrise Apartments', 'Townhouse (Residential)', 'Governmental/Public Use (General)',
    'Mobile/Manufactured Home (regardless of Land ownership)', 'County Owned', 'Warehouse (Industrial)', 'Planned Unit Development (PUD Residential)',
    'Boarding House, Rooming House, Apt Hotel, Transient Lodgings, Hostel', 'Miscellaneous (General)', 'Parcels with improvements, Use Not Specified',
    'Recreational-Vacant Land', 'Light Industrial', 'Retired, Handicap, Convalescent, Nursing Home', 'Retail/Residential (mixed use)', 'Rural/Agricultural Residence',
    'Farm land', 'Department Store (apparel, household goods, furniture)', 'Commercial/Office/Residential (mixed use)', 'Commercial Building', 'Agricultural / Rural',
    'Parking Lot', 'Misc Residential Improvement', 'Manufacturing (light)', 'Industrial-Vacant Land', 'Restaurant', 'Retail Stores (Personal Services, Photography, Travel)']
  const out = Object.fromEntries(prodUses.map((u) => [u, classifyPropertyUse(u)]))
  for (const [u, hit] of Object.entries(out)) assert.notEqual(hit.how, 'unmapped', `unmapped use: ${u}`)
  assert.equal(out['Mini-Warehouse, Self-Storage'].type, 'Self Storage')
  assert.equal(out['Neighborhood Shopping Center, Strip Center/Mall, Enterprise Zone'].type, 'Retail/Strip Center')
  assert.equal(out['Retail/Residential (mixed use)'].type, 'Mixed Use')
  assert.equal(out['Commercial/Office/Residential (mixed use)'].type, 'Mixed Use')
  assert.equal(out.Hotel.type, 'Hotel/Motel')
  assert.equal(out['Warehouse (Industrial)'].type, 'Industrial/Warehouse')
  assert.equal(out['Multi-Family-Vacant Land'].type, 'Land', 'vacant multifamily land is land, not a building')
  assert.equal(out['Apartments (generic)'].how, 'generic')
  assert.equal(out['Parcels with improvements, Use Not Specified'].how, 'skip')
})

test('named uses win (high); a contradicting unit count grades them down, never re-types them', () => {
  assert.deepEqual(T({ property_type: 'Multi-Family', units_count: 2 }, ['Duplex (2 units, any combination)']), { type: 'Duplex', group: 'Residential', confidence: 'high', basis: 'property_use' })
  assert.equal(T({ property_type: 'Multi-Family', units_count: 1 }, ['Duplex (2 units, any combination)']).confidence, 'medium')
  assert.equal(T({ property_type: 'Single Family', units_count: 2, building_square_feet: 2400 }, ['Single Family Residential']).type, 'Single Family')
  assert.equal(T({ property_type: 'Single Family', units_count: 2, building_square_feet: 2400 }, ['Single Family Residential']).confidence, 'medium')
  // the townhome recorded with its complex's 12 units (unitCountCredible's own example) is not credible → no downgrade
  assert.equal(T({ property_type: 'Single Family', units_count: 12, building_square_feet: 2468 }, ['Single Family Residential']).confidence, 'high')
  assert.equal(T({ property_type: 'Other' }, ['Mini-Warehouse, Self-Storage']).type, 'Self Storage')
  assert.equal(T({ property_type: 'Single Family' }, ['Single Family Residential (Assumed)']).confidence, 'medium')
})

test('generic multifamily: the CREDIBLE unit count decides (≥ 350 sq ft per unit), else "units unknown" — never invented', () => {
  const g = ['Apartments (generic)']
  assert.equal(T({ property_type: 'Apartment', units_count: 3 }, g).type, 'Triplex')
  assert.equal(T({ property_type: 'Apartment', units_count: 4, building_square_feet: 3200 }, g).type, 'Fourplex')
  assert.equal(T({ property_type: 'Apartment', units_count: 24, building_square_feet: 18000 }, g).type, 'Multifamily 5+')
  assert.deepEqual(T({ property_type: 'Apartment', units_count: 12, building_square_feet: 2468 }, g), { type: 'Multifamily (units unknown)', group: 'Residential', confidence: 'low', basis: 'property_use' })
  assert.equal(T({ property_type: 'Multi-Family', units_count: 0 }, ['Multi-Family Dwellings (Generic, 2+)']).type, 'Multifamily (units unknown)')
  assert.equal(T({ property_type: 'Multi-family', units_count: 2 }).type, 'Duplex', 'compact-import rows with no observation use the vendor type + units')
  assert.equal(T({ property_type: 'Multi-family', units_count: 2 }).basis, 'vendor_type_units')
  assert.equal(credibleUnits(2, 600), null)
  assert.equal(credibleUnits(2, null), 2)
  assert.equal(credibleUnits(0, 1000), null)
})

test('vendor raw junk is normalized: SFR, Town, Multi-family, Multifamily 5+, case variants', () => {
  assert.equal(normalizeVendorPropertyType('SFR').type, 'Single Family')
  assert.equal(normalizeVendorPropertyType('single family').type, 'Single Family')
  assert.equal(normalizeVendorPropertyType('Town').type, 'Townhouse')
  assert.equal(normalizeVendorPropertyType('Townhouse').type, 'Townhouse')
  assert.equal(normalizeVendorPropertyType('Mobile Home').type, 'Mobile/Manufactured')
  assert.equal(normalizeVendorPropertyType('Vacant Land').type, 'Land')
  assert.equal(normalizeVendorPropertyType('Multifamily 5+').type, 'Multifamily 5+')
  assert.equal(normalizeVendorPropertyType('Multi-family').generic, true)
  assert.equal(normalizeVendorPropertyType('MULTI-FAMILY').generic, true)
  assert.equal(T({ property_type: 'SFR', units_count: 1 }).type, 'Single Family')
})

test('"Other" with no use: storage / strip from the vendor flags; else the property class; else not classified', () => {
  assert.equal(T({ property_type: 'Other', property_flags_text: 'High Equity; Storage Units' }).type, 'Self Storage')
  assert.equal(T({ property_type: 'Other', property_flags_text: 'Strip Malls' }).type, 'Retail/Strip Center')
  assert.equal(T({ property_type: 'Other', asset_subclass: 'Storage Facility' }).basis, 'vendor_asset_class')
  assert.equal(T({ property_type: 'Other', property_class: 'Commercial' }).type, 'Other Commercial')
  assert.equal(T({ property_type: 'Other', property_class: 'Exempt' }).type, 'Government/Exempt')
  assert.deepEqual(T({ property_type: 'Other', property_class: 'Residential' }, ['Parcels with improvements, Use Not Specified']), { type: null, group: null, confidence: null, basis: null })
  assert.deepEqual(T({}), { type: null, group: null, confidence: null, basis: null })
  // "flags" is whole-token: "Storage Units Nearby" is not the token
  assert.notEqual(T({ property_type: 'Other', property_flags_text: 'Storage Units Nearby' }).type, 'Self Storage')
})

test('two observations naming different types are not resolved by guessing', () => {
  assert.equal(T({ property_type: 'Multi-Family' }, ['Duplex (2 units, any combination)', 'Triplex (3 units, any combination)']).type, null)
  // two observations that agree on the type (named + generic) keep it, graded low
  const r = T({ property_type: 'Multi-Family', units_count: 2 }, ['Duplex (2 units, any combination)', 'Multi-Family Dwellings (Generic, 2+)'])
  assert.equal(r.type, 'Duplex')
  assert.equal(r.confidence, 'low')
})

test('facts: the canonical type is computed from the base row + the observed use (input "use"), keyed or scanned alike', async () => {
  const base = [
    { property_id: 'a', property_type: 'Apartment', units_count: 3, building_square_feet: 2700 },
    { property_id: 'b', property_type: 'Other', property_class: 'Commercial' },
    { property_id: 'c', property_type: 'Single Family' },
  ]
  const uses = [{ property_id: 'a', property_use: 'Apartments (generic)' }, { property_id: 'b', property_use: 'Hotel' }, { property_id: 'zz', property_use: 'Hotel' }]
  const seen = []
  const query = async (sql, params = []) => {
    seen.push(sql)
    if (/from seller\.property_use_observation/.test(sql)) return { rows: params[0] ? uses.filter((u) => params[0].includes(u.property_id)) : uses }
    return { rows: [] }
  }
  const cols = ['property_type_class', 'property_type_group', 'property_type_confidence', 'property_type_basis', 'property_use_raw']
  const keyed = await computeFacts(base, cols, { query })
  const scanned = await computeFacts(base, cols, { query, keyedMax: 0 })
  assert.deepEqual(keyed, scanned)
  assert.deepEqual(keyed.get('a'), { property_type_class: 'Triplex', property_type_group: 'Residential', property_type_confidence: 'medium', property_type_basis: 'property_use_units', property_use_raw: 'Apartments (generic)' })
  assert.equal(keyed.get('b').property_type_class, 'Hotel/Motel')
  assert.deepEqual(keyed.get('c'), { property_type_class: 'Single Family', property_type_group: 'Residential', property_type_confidence: 'medium', property_type_basis: 'vendor_type', property_use_raw: null })
  // only the use input is read for these columns (no campaign graph, no prospects)
  assert.ok(seen.every((s) => /property_use_observation/.test(s)), seen.join('\n'))
})

test('ADDENDUM: the base migration is unchanged; the six columns arrive by their own ALTER TABLE', () => {
  const committed = fs.readFileSync(path.join(repo, 'supabase/migrations/PROPOSED_20261009180000_eg_property_facts.sql'), 'utf8')
  assert.equal(generateFactsMigrationSql(), committed)
  assert.ok(!/property_type_class/.test(committed))
  assert.deepEqual(factsAddenda(), [PTYPE_ADDENDUM])
  const add = generateFactsAddendumSql(PTYPE_ADDENDUM)
  assert.equal(add, fs.readFileSync(path.join(repo, `supabase/migrations/PROPOSED_${PTYPE_ADDENDUM}.sql`), 'utf8'))
  assert.equal(generateFactsAddendumRollbackSql(PTYPE_ADDENDUM), fs.readFileSync(path.join(repo, `supabase/migrations/PROPOSED_${PTYPE_ADDENDUM}_rollback.sql`), 'utf8'))
  for (const c of ['property_type_class', 'property_type_group', 'property_type_confidence', 'property_type_basis', 'property_use_raw', 'person_source']) {
    assert.match(add, new RegExp(`add column if not exists "${c}" text;`))
    assert.equal(FACT_BY_COL.get(c).addendum, PTYPE_ADDENDUM)
  }
  assert.match(add, /egpf_property_type_class_k on public\.eg_property_facts \("property_type_class", "property_id"\)/)
  assert.equal(factsTableColumns({ addenda: false }).length + 6, factsTableColumns().length)
  assert.ok(COMPUTED_FACTS.filter((f) => f.addendum).length === 6)
})

test('the refresh writes only the columns the table has; an addendum is readable only after a FULL run wrote it', () => {
  const all = factsTableColumns()
  const base = new Set(factsTableColumns({ addenda: false }).map((c) => c.col))
  const before = writableFactsColumns(base, all)
  assert.ok(!before.some((c) => c.addendum), 'no addendum column is written before its ALTER TABLE')
  assert.ok(!/property_type_class/.test(factsUpsertSql(before)))
  assert.ok(!computedColumnsOf(before).includes('property_type_class'))
  assert.deepEqual(addendaWritten(before), [])
  const after = writableFactsColumns(new Set(all.map((c) => c.col)), all)
  assert.deepEqual(addendaWritten(after), [PTYPE_ADDENDUM])
  // no table at all (dry run): base columns only
  assert.ok(!writableFactsColumns(null, all).some((c) => c.addendum))
})

test('reads: the table serves an addendum column only when it exists AND its addendum was written', () => {
  const cols = new Set(factsTableColumns().map((c) => c.col))
  assert.equal(tableServes({ mode: 'table', columns: cols, addenda: new Set() }, ['property_type_class']), false)
  assert.equal(tableServes({ mode: 'table', columns: new Set(factsTableColumns({ addenda: false }).map((c) => c.col)), addenda: new Set([PTYPE_ADDENDUM]) }, ['property_type_class']), false)
  assert.equal(tableServes({ mode: 'table', columns: cols, addenda: new Set([PTYPE_ADDENDUM]) }, ['property_type_class']), true)
  assert.equal(tableServes({ mode: 'table', columns: cols, addenda: new Set() }, ['sms_status', 'market']), true, 'base columns are unaffected')
  assert.equal(tableServes({ mode: 'live' }, ['market']), false)
})

test('EG fields: "Property type" is the canonical type; the vendor string is "Property type (vendor raw)"', () => {
  const fields = getEntityGraphFilterFields('properties')
  const by = (k) => fields.find((f) => f.key === k)
  assert.equal(by('facts.property_type_class').label, 'Property type')
  assert.equal(by('facts.property_type_class').type, 'enum')
  assert.equal(by('properties.property_type').label, 'Property type (vendor raw)')
  assert.equal(by('facts.property_use_raw').label, 'Property use (vendor)')
  const dims = getCompositionCatalog('properties').dimensions
  assert.equal(dims.find((d) => d.key === 'ptype').label, 'Property type')
  assert.equal(dims.find((d) => d.key === 'property_type').label, 'Property type (vendor raw)')
  // the default dimension stays the cheap raw column (first)
  assert.equal(dims[0].key, 'property_type')
})
