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
  ]);
  writePartition('property_ownerships', B, [
    { id: 'o1', property_id: 'p1', owner_hash: 'OH1', owner_name_raw: 'SMITH, JOHN' },
    { id: 'o2', property_id: 'p2', owner_hash: 'OH1', owner_name_raw: 'SMITH, JOHN' },
    { id: 'o3', property_id: 'p3', owner_hash: 'OH2', owner_name_raw: 'SMITH, JOHN' },
    { id: 'o4', property_id: 'p4', owner_hash: null, owner_name_raw: 'DOE, JANE' },
    { id: 'o5', property_id: 'p5', owner_hash: null, owner_name_raw: 'MIXED, FORECLOSURE' },
    { id: 'o6', property_id: 'p6', owner_hash: null, owner_name_raw: 'MIXED, LIEN' },
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
