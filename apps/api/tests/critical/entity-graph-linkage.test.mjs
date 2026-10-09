/**
 * ENTITY GRAPH · LINKAGE + RECORDED DOCUMENTS (owner, 2026-10-08, production):
 *   - "MANY FIELDS ARE BLANK, including prospect info" / "People in contact 0,
 *     Title entity 0" — every owner/person read keyed on
 *     properties.master_owner_id, set on ~23% of properties; the link lives on
 *     prospects.linked_property_ids_json (+ master_owners.joined_property_ids_json).
 *   - "Liens column showing 'Financing Statement'" — seller.property_lien is
 *     every non-mortgage recorded document; only lien/judgment classes are liens.
 *   - hover card "High (flag)" vs grid "$111M · 100%" — the network read
 *     `properties` (no recorded mortgages) while the grid read the view.
 * Fixtures are prod-shaped (ids, JSON arrays, categories as stored).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRecordedDocument, recordedDocumentLabel, splitRecordedCategories } from '../../src/lib/domain/entity-graph/entity-graph-recorded-docs.js'
import { prospectsLinkedToProperties, resolvePropertyOwners } from '../../src/lib/domain/entity-graph/entity-graph-owner-link.js'
import { getEntityNetwork, shapeRecords } from '../../src/lib/domain/entity-graph/entity-network-service.js'
import { getEntityGraphColumnEnrichment } from '../../src/lib/domain/entity-graph/entity-graph-column-enrichment.js'

/** A filtering supabase stand-in: eq / neq / in / is / not / or(cs) / limit / order / maybeSingle. */
function db(tables, reads = []) {
  const view = (name) => (name === 'v_entity_graph_properties' ? 'properties' : name)
  return {
    rpc: async () => ({ data: null, error: null }),
    from(name) {
      const preds = []
      let lim = Infinity
      const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
      const q = {
        select() { return q },
        eq(c, v) { preds.push((r) => String(r[c]) === String(v)); return q },
        neq(c, v) { preds.push((r) => String(r[c]) !== String(v)); return q },
        in(c, vs) { preds.push((r) => vs.map(String).includes(String(r[c]))); return q },
        is(c, v) { preds.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return q },
        not() { return q }, gt() { return q }, ilike() { return q }, order() { return q },
        contains(c, v) { const want = parse(v); preds.push((r) => want.every((x) => (parse(r[c]) || []).includes(x))); return q },
        or(expr) {
          const terms = expr.split(/,(?=linked_property_ids_json\.cs\.)/).map((t) => t.match(/^linked_property_ids_json\.cs\.\["(.+)"\]$/)?.[1]).filter(Boolean)
          preds.push((r) => terms.some((id) => (parse(r.linked_property_ids_json) || []).includes(id)))
          return q
        },
        limit(n) { lim = n; return q },
        rows() { reads.push(name); return (tables[view(name)] || []).filter((r) => preds.every((p) => p(r))).slice(0, lim) },
        maybeSingle() { return Promise.resolve({ data: q.rows()[0] ?? null, error: null }) },
        then(res, rej) { return Promise.resolve({ data: q.rows(), error: null }).then(res, rej) },
      }
      return q
    },
  }
}

/* prod-shaped: property 216455040 has NO master_owner_id; its prospects carry it */
const TABLES = () => ({
  properties: [
    { property_id: '216455040', master_owner_id: null, property_address_full: '4417 ELM ST', owner_name: 'RUIZ FAMILY TRUST', estimated_value: 111363200, total_loan_balance: 0, property_flags_text: 'High Equity', units_count: 392, property_type: 'Apartment', rec_mortgage_count: 0, rec_mortgage_balance: null, rec_lien_categories: ['FINANCING STATEMENT', 'LIEN <GENERAL>'] },
    { property_id: '216455041', master_owner_id: 'mo_6ae6ed8a02724ee3e8366fdd', property_address_full: '12 OAK AVE', estimated_value: 300000, rec_lien_categories: ['AFFIDAVIT', 'PROBATE'] },
    { property_id: '216455099', master_owner_id: null, property_address_full: '9 NOWHERE RD', estimated_value: 200000 },
  ],
  master_owners: [{ master_owner_id: 'mo_6ae6ed8a02724ee3e8366fdd', display_name: 'RUIZ FAMILY TRUST', property_count: 2, joined_property_ids_json: '["216455040","216455041"]' }],
  prospects: [
    { prospect_id: 'pros_aaaaaaaaaaaaaaaaaaaaaaaa', master_owner_id: 'mo_6ae6ed8a02724ee3e8366fdd', full_name: 'ANA RUIZ', linked_property_ids_json: ['216455040'], rank_position: 1, is_primary_prospect: true, language_preference: 'Spanish', mob: '195403', phones_json: [{ canonical_e164: '+15550000001', phone_type: 'W' }] },
    { prospect_id: 'pros_bbbbbbbbbbbbbbbbbbbbbbbb', master_owner_id: 'mo_6ae6ed8a02724ee3e8366fdd', full_name: 'LUIS RUIZ', linked_property_ids_json: ['216455041'], rank_position: 2 },
  ],
  sub_owners: [{ sub_owner_id: 'so_1', master_owner_id: 'mo_6ae6ed8a02724ee3e8366fdd', owner_name: 'RUIZ HOLDINGS LLC' }],
  phones: [], emails: [], campaign_target_graph: [], inbox_thread_state: [], send_queue: [], mv_map_sold_comps: [],
})

test('recorded documents: only lien / judgment classes are liens; UCC, affidavits, probate are filings', () => {
  assert.equal(classifyRecordedDocument('FINANCING STATEMENT'), 'ucc')
  assert.equal(recordedDocumentLabel('FINANCING STATEMENT'), 'UCC financing statement')
  assert.equal(classifyRecordedDocument('LIEN <GENERAL>'), 'lien')
  assert.equal(classifyRecordedDocument('FEDERAL TAX LIEN'), 'lien')
  assert.equal(classifyRecordedDocument('IMPROVEMENT DISTRICT LIEN'), 'lien')
  assert.equal(classifyRecordedDocument(null, 'hoa_lien'), 'lien')
  assert.equal(classifyRecordedDocument('JUDGMENT'), 'judgment')
  assert.equal(classifyRecordedDocument('LIS PENDENS'), 'lis_pendens')
  assert.equal(classifyRecordedDocument('AFFIDAVIT OF DEATH'), 'death')
  assert.equal(classifyRecordedDocument('PROBATE'), 'probate')
  assert.equal(classifyRecordedDocument('AGREEMENT'), 'other')
  assert.equal(classifyRecordedDocument('NOTICE OF CANCELLATION or DISCHARGE or RELEASE or TERMINATION'), 'release')
  const split = splitRecordedCategories(['FINANCING STATEMENT', 'LIEN <GENERAL>', 'AFFIDAVIT'])
  assert.deepEqual(split.liens.map((d) => d.label), ['General lien'])
  assert.deepEqual(split.filings.map((d) => d.label), ['UCC financing statement', 'Affidavit'])
  assert.equal(split.amountIsLiens, false, 'the summary amount sums every document — not a lien amount when filings are mixed in')
  assert.equal(splitRecordedCategories(['MECHANICS LIEN']).amountIsLiens, true)
  assert.deepEqual(splitRecordedCategories(['FINANCING STATEMENT']).liens, [])
})

test('network records: totals.liens counts true liens; every document keeps its class', () => {
  const r = shapeRecords({ mortgages: [], liens: [{ doc_category: 'FINANCING STATEMENT' }, { doc_category: 'LIEN <GENERAL>', amount_due: 5000 }, { lien_type: 'hoa_lien', hoa_lien_amount: 900 }, { doc_category: 'AFFIDAVIT OF DEATH' }], sales: [], foreclosures: [] })
  assert.equal(r.totals.liens, 2)
  assert.equal(r.totals.filings, 2)
  assert.deepEqual(r.liens.map((l) => [l.label, l.isLien]), [['UCC financing statement', false], ['General lien', true], ['HOA lien', true], ['Affidavit of death', false]])
})

test('owner link: a property without master_owner_id resolves through its linked prospects (one owner), else stays unlinked', async () => {
  const sb = db(TABLES())
  const linked = await prospectsLinkedToProperties(sb, ['216455040', '216455099'])
  assert.equal(linked.get('216455040').length, 1)
  assert.equal(linked.has('216455099'), false)
  const owners = await resolvePropertyOwners(sb, TABLES().properties)
  assert.deepEqual(owners.get('216455040'), { ownerId: 'mo_6ae6ed8a02724ee3e8366fdd', basis: 'prospect_link' })
  assert.deepEqual(owners.get('216455041'), { ownerId: 'mo_6ae6ed8a02724ee3e8366fdd', basis: 'property' })
  assert.equal(owners.has('216455099'), false)
  // two different owners among the linked prospects = ambiguous = no link
  const t = TABLES(); t.prospects[1].linked_property_ids_json = ['216455040']; t.prospects[1].master_owner_id = 'mo_other'
  assert.equal((await resolvePropertyOwners(db(t), [{ property_id: '216455040' }])).has('216455040'), false)
})

test('property network: owner, people, phones and title entities appear for a property with no master_owner_id', async () => {
  const n = await getEntityNetwork('property', '216455040', { supabase: db(TABLES()) })
  assert.equal(n.owner.id, 'mo_6ae6ed8a02724ee3e8366fdd')
  assert.ok(n.people.some((p) => p.id === 'pros_aaaaaaaaaaaaaaaaaaaaaaaa'), 'People 0 — the linked prospect is missing')
  assert.ok(n.entities.some((e) => e.name === 'Ruiz Holdings LLC'), 'Title entity 0')
  // equity from the same source as the grid: no recorded mortgage → the whole value, not "High (flag)"
  const p = n.properties.find((x) => x.id === '216455040')
  assert.equal(p.equityRule, 'no_recorded_mortgage')
  assert.equal(p.equity, 111363200)
  assert.deepEqual(p.recordedLiens, ['General lien'])
  assert.deepEqual(p.recordedFilings, ['UCC financing statement'])
  // a 392-unit apartment never carries a repair figure (valuation lanes)
  assert.equal(p.repairReference, null)
  assert.ok(!('repairEstimate' in p))
  // phone/email/entity nodes carry what they open
  const entityNode = n.graph.nodes.find((x) => x.type === 'entity')
  assert.equal(entityNode.meta.ownerId, 'mo_6ae6ed8a02724ee3e8366fdd')
})

test('property network: a prospect linked to the property under another owner still shows, linked to the property', async () => {
  const t = TABLES()
  t.prospects.push({ prospect_id: 'pros_cccccccccccccccccccccccc', master_owner_id: 'mo_elsewhere', full_name: 'GRACE PATEL', linked_property_ids_json: ['216455041'], phones_json: [{ canonical_e164: '+15550000009', phone_type: 'L' }] })
  const n = await getEntityNetwork('property', '216455041', { supabase: db(t) })
  const grace = n.people.find((p) => p.id === 'pros_cccccccccccccccccccccccc')
  assert.ok(grace, 'property-linked person missing')
  assert.equal(grace.linkedBy, 'property')
  assert.ok(n.graph.edges.some((e) => e.from === 'property:216455041' && e.to === 'person:pros_cccccccccccccccccccccccc'))
  assert.ok(n.phones.some((ph) => ph.personId === 'pros_cccccccccccccccccccccccc'))
})

test('person network: person → the properties the person is linked to', async () => {
  const t = TABLES()
  t.master_owners[0].joined_property_ids_json = '[]'
  const n = await getEntityNetwork('person', 'pros_aaaaaaaaaaaaaaaaaaaaaaaa', { supabase: db(t) })
  assert.ok(n, 'the person network did not load')
  assert.equal(n.anchor.nodeId, 'person:pros_aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.ok(n.graph.nodes.some((x) => x.id === n.anchor.nodeId))
  assert.ok(n.properties.some((p) => p.id === '216455040'))
})

test('column enrichment: owner.* and person.* fill for properties linked only through prospects', async () => {
  const { values } = await getEntityGraphColumnEnrichment({ property_ids: '216455040,216455099', fields: 'owner.display_name,entity.name,person.language_preference,person.age' }, { supabase: db(TABLES()) })
  assert.equal(values['216455040']['owner.display_name'], 'RUIZ FAMILY TRUST')
  assert.equal(values['216455040']['entity.name'], 'RUIZ HOLDINGS LLC')
  assert.equal(values['216455040']['person.language_preference'], 'Spanish')
  assert.equal(typeof values['216455040']['person.age'], 'number')
  assert.equal(values['216455099'], undefined, 'no source data stays absent')
})

test('Add to campaign: an owner cohort adds every property the owner holds, not only the 23% carrying master_owner_id', async () => {
  const { resolveStackPropertyIds } = await import('../../src/lib/domain/entity-graph/entity-graph-campaign-stack.js')
  const t = TABLES()
  t.master_owners[0].joined_property_ids_json = '["216455040","216455041","prop_875d0ee2eacd14798bb4adf4","canaryprop_1"]'
  const out = await resolveStackPropertyIds({ scope: 'master_owners', mode: 'selection', ids: ['mo_6ae6ed8a02724ee3e8366fdd'] }, { supabase: db(t) })
  assert.deepEqual([...out.propertyIds].sort(), ['216455040', '216455041'], 'joined ids (FK-less 216455040 included), export-form + test ids skipped, deduped')
})
