import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerGraph } from '../owner-graph/build.mjs';
import { writePartition, readPartition } from '../lib/store.mjs';

// isolate this test's staging under a temp VAR by using a unique batch id
const B = `test_og_${Date.now()}`;
const AS_OF = '2026-07-01T00:00:00Z';

function seed() {
  writePartition('properties', B, [
    { id: 'p1', situs_state: 'TN', asset_class: 'single_family', raw_keep: { owner_hash: 'OH1', owner_name: 'SMITH, JOHN' } },
    { id: 'p2', situs_state: 'TN', asset_class: 'single_family', raw_keep: { owner_hash: 'OH1', owner_name: 'SMITH, JOHN' } },
    { id: 'p3', situs_state: 'GA', asset_class: 'single_family', raw_keep: { owner_hash: 'OH2', owner_name: 'SMITH, JOHN' } }, // same NAME, different hash
    { id: 'p4', situs_state: 'TX', asset_class: 'single_family', raw_keep: { owner_name: 'DOE, JANE' } }, // name only, no hash
    { id: 'p5', situs_state: 'FL', asset_class: 'single_family', raw_keep: { owner_name: 'MIXED, FORECLOSURE' } },
    { id: 'p6', situs_state: 'OH', asset_class: 'single_family', raw_keep: { owner_name: 'MIXED, LIEN' } },
    { id: 'p7', situs_state: 'TN', asset_class: 'single_family', raw_keep: { owner_hash: 'OH7', owner_name: 'OWNER, ALEX' } },
    { id: 'p8', situs_state: 'GA', asset_class: 'single_family', raw_keep: { owner_hash: 'OH8', owner_name: 'OWNER, ALEX' } },
    { id: 'p9', situs_state: 'TX', asset_class: 'single_family', raw_keep: { owner_hash: 'OH9', owner_name: 'RENTER, RITA' } },
    { id: 'p10', situs_state: 'FL', asset_class: 'single_family', raw_keep: { owner_hash: 'OH10', owner_name: 'WEAK, WENDY' } },
    { id: 'p11', situs_state: 'AZ', asset_class: 'single_family', raw_keep: { owner_hash: 'OH11', owner_name: 'OWNER, CASEY' } },
  ]);
  writePartition('property_ownerships', B, [
    { id: 'o1', property_id: 'p1', owner_hash: 'OH1', owner_name_raw: 'SMITH, JOHN' },
    { id: 'o2', property_id: 'p2', owner_hash: 'OH1', owner_name_raw: 'SMITH, JOHN' },
    { id: 'o3', property_id: 'p3', owner_hash: 'OH2', owner_name_raw: 'SMITH, JOHN' },
    { id: 'o4', property_id: 'p4', owner_hash: null, owner_name_raw: 'DOE, JANE' },
    { id: 'o5', property_id: 'p5', owner_hash: null, owner_name_raw: 'MIXED, FORECLOSURE' },
    { id: 'o6', property_id: 'p6', owner_hash: null, owner_name_raw: 'MIXED, LIEN' },
    { id: 'o7', property_id: 'p7', owner_hash: 'OH7', owner_name_raw: 'OWNER, ALEX' },
    { id: 'o8', property_id: 'p8', owner_hash: 'OH8', owner_name_raw: 'OWNER, ALEX' },
    { id: 'o9', property_id: 'p9', owner_hash: 'OH9', owner_name_raw: 'RENTER, RITA' },
    { id: 'o10', property_id: 'p10', owner_hash: 'OH10', owner_name_raw: 'WEAK, WENDY' },
    { id: 'o11', property_id: 'p11', owner_hash: 'OH11', owner_name_raw: 'OWNER, CASEY' },
  ]);
  writePartition('property_valuation_tax_snapshots', B, [
    { property_id: 'p1', as_of: '2026-06-01', estimated_value: 200000, estimated_equity: 120000, tax_delinquent: true, tax_delinquent_year: 2023 },
    { property_id: 'p2', as_of: '2026-06-01', estimated_value: 180000, estimated_equity: 100000, tax_delinquent: true, tax_delinquent_year: 2024 },
    { property_id: 'p3', as_of: '2026-06-01', estimated_value: 150000, estimated_equity: 90000 },
    { property_id: 'p4', as_of: '2026-08-01', estimated_value: 999000, estimated_equity: 999000, tax_delinquent: true },
    { property_id: 'p4', as_of: '2026-06-01', estimated_value: 250000, estimated_equity: 250000 },
    { property_id: 'p5', as_of: '2026-06-01', estimated_value: 175000, estimated_equity: 90000 },
    { property_id: 'p6', as_of: '2026-06-01', estimated_value: 160000, estimated_equity: 80000 },
  ]);
  writePartition('property_loans', B, [
    { property_id: 'p1', slot_class: 'current_recorded', estimated_balance: 80000 },
    { property_id: 'p2', slot_class: 'current_recorded', estimated_balance: 80000 },
  ]);
  writePartition('property_transactions', B, [
    { property_id: 'p1', event_role: 'current', sale_date: '2026-03-01' }, // recent disposition-window
    { property_id: 'p2', event_role: 'current', sale_date: '2012-01-01' },
    { property_id: 'p3', event_role: 'current', sale_date: '2010-01-01' },
    { property_id: 'p4', event_role: 'current', sale_date: '2026-08-01' },
    { property_id: 'p4', event_role: 'current', sale_date: '2009-01-01' },
  ]);
  writePartition('property_foreclosure_events', B, [
    { property_id: 'p4', stage: 'nod', recording_date: '2026-08-01' },
    {
      property_id: 'p5',
      stage: 'nod',
      recording_date: '2026-08-01',
      default_date: '2026-06-15',
    },
  ]);
  writePartition('property_liens', B, [
    { property_id: 'p4', lifecycle_class: 'creation', filing_date: '2026-08-01' },
    {
      property_id: 'p6',
      lifecycle_class: 'creation',
      filing_date: '2026-08-01',
      recording_date: '2026-06-10',
    },
  ]);
  writePartition('people', B, [
    {
      id: 'per_alex',
      individual_key: 'IK_ALEX',
      identity_tier: 'key',
      full_name: 'ALEX OWNER',
    },
    {
      id: 'per_rita',
      individual_key: 'IK_RITA',
      identity_tier: 'key',
      full_name: 'RITA RENTER',
    },
    {
      id: 'per_wendy',
      individual_key: 'IK_WENDY',
      identity_tier: 'key',
      full_name: 'WENDY WEAK',
    },
    {
      id: 'per_casey_1',
      individual_key: 'IK_CASEY_1',
      identity_tier: 'key',
      full_name: 'CASEY OWNER',
    },
    {
      id: 'per_casey_2',
      individual_key: 'IK_CASEY_2',
      identity_tier: 'key',
      full_name: 'CASEY OWNER',
    },
  ]);
  writePartition('property_person_links', B, [
    {
      property_id: 'p7',
      person_id: 'per_alex',
      renter_flag: false,
      link_tier: 'exact',
      is_matching_property_as_owner: true,
    },
    {
      property_id: 'p8',
      person_id: 'per_alex',
      renter_flag: false,
      link_tier: 'high',
      is_matching_property_as_owner: true,
    },
    {
      property_id: 'p9',
      person_id: 'per_rita',
      renter_flag: true,
      link_tier: 'exact',
      is_matching_property_as_owner: true,
    },
    {
      property_id: 'p10',
      person_id: 'per_wendy',
      renter_flag: false,
      link_tier: 'low',
      is_matching_property_as_owner: true,
    },
    {
      property_id: 'p11',
      person_id: 'per_casey_1',
      renter_flag: false,
      link_tier: 'exact',
      is_matching_property_as_owner: true,
    },
    {
      property_id: 'p11',
      person_id: 'per_casey_2',
      renter_flag: false,
      link_tier: 'exact',
      is_matching_property_as_owner: true,
    },
  ]);
  writePartition('property_company_links', B, []);
}

test('owner_hash groups holdings into one node; distinct hashes never merge on shared name', () => {
  seed();
  const { nodes } = buildOwnerGraph({ batches: [B], asOf: AS_OF });
  const oh1 = nodes.find((n) => n.owner_key === 'oh:OH1');
  const oh2 = nodes.find((n) => n.owner_key === 'oh:OH2');
  assert.equal(oh1.portfolio_holdings, 2, 'OH1 holds p1+p2');
  assert.equal(oh2.portfolio_holdings, 1, 'OH2 separate despite same owner NAME');
  assert.ok(oh1.owner_key !== oh2.owner_key);
});

test('name-only owner becomes an unresolved node, never a confident merge', () => {
  const { nodes } = buildOwnerGraph({ batches: [B], asOf: AS_OF });
  const jane = nodes.find((n) => n.name_sample.includes('DOE, JANE'));
  assert.ok(jane.owner_kind.startsWith('unresolved'));
  assert.equal(jane.confidence, 'low');
});

test('systemic distress + liquidation signals computed at owner level (IX-13)', () => {
  const { nodes } = buildOwnerGraph({ batches: [B], asOf: AS_OF });
  const oh1 = nodes.find((n) => n.owner_key === 'oh:OH1');
  assert.equal(oh1.simultaneous_distressed_holdings, 2, 'both p1,p2 tax-delinquent');
  assert.equal(oh1.systemic_distress, true);
  assert.equal(oh1.disposition_velocity_2y, 1, 'p1 sold within 2y window');
  assert.equal(oh1.liquidation_indicator, true);
  assert.equal(oh1.portfolio_leverage, Math.round((160000 / 380000) * 1000) / 1000);
});

test('future-dated evidence is excluded from owner portfolio and distress signals', () => {
  const { nodes } = buildOwnerGraph({ batches: [B], asOf: AS_OF });
  const jane = nodes.find((n) => n.name_sample.includes('DOE, JANE'));

  assert.equal(jane.portfolio_value, 250000, 'post-cutoff valuation excluded');
  assert.equal(jane.portfolio_equity, 250000, 'post-cutoff equity excluded');
  assert.equal(jane.simultaneous_distressed_holdings, 0, 'future lien/foreclosure/tax evidence excluded');
  assert.equal(jane.disposition_velocity_2y, 0, 'future sale never counts as a recent disposition');
  assert.equal(jane.liquidation_indicator, false);
});

test('mixed-date distress evidence accepts any valid pre-cutoff date', () => {
  const { nodes } = buildOwnerGraph({ batches: [B], asOf: AS_OF });

  const foreclosure = nodes.find((n) =>
    n.name_sample.includes('MIXED, FORECLOSURE'));
  const lien = nodes.find((n) =>
    n.name_sample.includes('MIXED, LIEN'));

  assert.equal(
    foreclosure.simultaneous_distressed_holdings,
    1,
    'past default date remains valid when recording date is future',
  );
  assert.equal(
    lien.simultaneous_distressed_holdings,
    1,
    'past recording date remains valid when filing date is future',
  );
});

test('name-shared-across-keys surfaces as a candidate conflict, not an edge', () => {
  const { conflicts } = buildOwnerGraph({ batches: [B], asOf: AS_OF });
  assert.ok(conflicts.some((c) => c.kind === 'name_shared_across_owner_keys' && c.resolution === 'candidate_only_not_merged'));
});


test('qualified individual_key outranks owner_hash and groups holdings', () => {
  const { nodes } = buildOwnerGraph({
    batches: [B],
    asOf: AS_OF,
  });

  const alex = nodes.find((n) =>
    n.owner_key === 'ik:IK_ALEX');

  assert.equal(alex.owner_kind, 'individual_key');
  assert.equal(alex.confidence, 'high');
  assert.equal(alex.portfolio_holdings, 2);
  assert.deepEqual(
    [...alex.property_ids].sort(),
    ['p7', 'p8'],
  );
  assert.equal(
    nodes.some((n) => n.owner_key === 'oh:OH7'),
    false,
  );
  assert.equal(
    nodes.some((n) => n.owner_key === 'oh:OH8'),
    false,
  );
});

test('renter and weak keyed links never establish ownership', () => {
  const { nodes } = buildOwnerGraph({
    batches: [B],
    asOf: AS_OF,
  });

  assert.ok(nodes.some((n) => n.owner_key === 'oh:OH9'));
  assert.ok(nodes.some((n) => n.owner_key === 'oh:OH10'));
  assert.equal(
    nodes.some((n) => n.owner_key === 'ik:IK_RITA'),
    false,
  );
  assert.equal(
    nodes.some((n) => n.owner_key === 'ik:IK_WENDY'),
    false,
  );
});

test('multiple qualified individual keys fail closed', () => {
  const { nodes, conflicts } = buildOwnerGraph({
    batches: [B],
    asOf: AS_OF,
  });

  const ambiguous = nodes.find((n) =>
    n.property_ids.includes('p11'));

  assert.equal(
    ambiguous.owner_kind,
    'unresolved_individual_key_conflict',
  );
  assert.equal(ambiguous.confidence, 'low');
  assert.equal(
    nodes.some((n) =>
      n.owner_key === 'ik:IK_CASEY_1'
      || n.owner_key === 'ik:IK_CASEY_2'),
    false,
  );
  assert.ok(conflicts.some((conflict) =>
    conflict.kind === 'multiple_qualified_individual_keys'
    && conflict.property_id === 'p11'
    && conflict.resolution === 'unresolved_not_merged'));
});

test('owner graph rejects missing or invalid asOf timestamps', () => {
  assert.throws(
    () => buildOwnerGraph({
      batches: [B],
      asOf: '',
    }),
    /requires a valid asOf timestamp/,
  );

  assert.throws(
    () => buildOwnerGraph({
      batches: [B],
      asOf: 'not-a-date',
    }),
    /requires a valid asOf timestamp/,
  );
});


test('owner graph reads identity evidence from the prospects batch', () => {
  const propertyBatch = `test_og_props_${Date.now()}`;
  const identityBatch = `test_og_identity_${Date.now()}`;

  writePartition('properties', propertyBatch, [
    {
      id: 'split_p1',
      situs_state: 'TN',
      raw_keep: {
        owner_hash: 'SPLIT_OH',
        owner_name: 'OWNER, TAYLOR',
      },
    },
  ]);
  writePartition('property_ownerships', propertyBatch, [
    {
      id: 'split_o1',
      property_id: 'split_p1',
      owner_hash: 'SPLIT_OH',
      owner_name_raw: 'OWNER, TAYLOR',
    },
  ]);

  for (const table of [
    'property_valuation_tax_snapshots',
    'property_loans',
    'property_transactions',
    'property_foreclosure_events',
    'property_liens',
    'property_company_links',
  ]) {
    writePartition(table, propertyBatch, []);
  }

  writePartition('people', identityBatch, [
    {
      id: 'split_person',
      individual_key: 'IK_TAYLOR',
      identity_tier: 'key',
      full_name: 'TAYLOR OWNER',
    },
  ]);
  writePartition('property_person_links', identityBatch, [
    {
      property_id: 'split_p1',
      person_id: 'split_person',
      renter_flag: false,
      link_tier: 'exact',
      is_matching_property_as_owner: true,
    },
  ]);

  const { nodes } = buildOwnerGraph({
    batches: [propertyBatch],
    identityBatches: [identityBatch],
    asOf: AS_OF,
  });

  const owner = nodes.find((node) =>
    node.property_ids.includes('split_p1'));

  assert.equal(owner.owner_key, 'ik:IK_TAYLOR');
  assert.equal(owner.owner_kind, 'individual_key');
});
