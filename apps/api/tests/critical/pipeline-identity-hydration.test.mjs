import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateOpportunityFromProperty } from '../../src/lib/domain/opportunity/opportunity-property-hydration.js';

/**
 * §18 — "Unknown Seller" was describing our join, not the world.
 *
 * Measured in production 2026-09-20: 769 opportunities, 48 with no
 * `seller_display_name`. The board rendered "Unknown Seller" for every one of
 * them — but 45 of those 48 had a real `properties.owner_name` a single join
 * away, and that join was already being performed for address and asset type.
 * Only 2 were genuinely unidentified.
 *
 * Saying "Unknown Seller" over a seller whose name we hold is worse than
 * saying nothing: it tells the operator the record is thin when the record is
 * fine and the read was lazy.
 */

test('a missing seller name is filled from the property owner', () => {
  const row = hydrateOpportunityFromProperty(
    { id: 'opp-1', primary_property_id: 'p-1', seller_display_name: null },
    { property_id: 'p-1', owner_name: 'Crystal H Hill' },
  );
  assert.equal(row.seller_display_name, 'Crystal H Hill');
  assert.equal(row.seller_name_source, 'property_owner_name');
});

test('a stored seller name always wins — hydration fills holes, never overwrites', () => {
  const row = hydrateOpportunityFromProperty(
    { id: 'opp-2', primary_property_id: 'p-2', seller_display_name: 'Estate of R. Holloway' },
    { property_id: 'p-2', owner_name: 'SOMETHING ELSE' },
  );
  assert.equal(row.seller_display_name, 'Estate of R. Holloway');
  assert.equal(row.seller_name_source, 'opportunity');
});

test('whitespace is not an identity', () => {
  const row = hydrateOpportunityFromProperty(
    { id: 'opp-3', primary_property_id: 'p-3', seller_display_name: '   ' },
    { property_id: 'p-3', owner_name: 'Real Name' },
  );
  assert.equal(row.seller_display_name, 'Real Name');
  assert.equal(row.seller_name_source, 'property_owner_name');
});

test('genuinely unidentified stays unidentified, and says so', () => {
  // The ~3 production rows with neither a stored name nor a property owner.
  const row = hydrateOpportunityFromProperty(
    { id: 'opp-4', primary_property_id: 'p-4', seller_display_name: null },
    { property_id: 'p-4', owner_name: null },
  );
  assert.equal(row.seller_display_name, null, 'no name is invented');
  assert.equal(row.seller_name_source, 'unresolved');
});

test('an unmatched property still reports its identity source', () => {
  const row = hydrateOpportunityFromProperty(
    { id: 'opp-5', primary_property_id: 'p-missing', seller_display_name: null },
    null,
  );
  assert.equal(row.property_hydrated, false);
  assert.equal(row.seller_name_source, 'unresolved');
});

test('no fuzzy matching — the name comes from the joined row or nowhere', () => {
  const row = hydrateOpportunityFromProperty(
    { id: 'opp-6', primary_property_id: 'p-6', seller_display_name: null, property_address_full: '11230 Rebel Rd' },
    { property_id: 'p-6' },
  );
  assert.equal(row.seller_display_name, null, 'an address is not a seller');
  assert.equal(row.seller_name_source, 'unresolved');
});
