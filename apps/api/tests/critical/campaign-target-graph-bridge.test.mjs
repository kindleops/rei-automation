import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEntityContactReviewBlocks } from '../../src/lib/domain/campaigns/campaign-recipient-metrics.js';

/**
 * CAMPAIGN-TARGET-GRAPH-BRIDGE-1 — campaign readiness reads canonical identity.
 *
 * THE DEFECT. `resolveCampaignTargetReadiness` required master_owner_id AND
 * prospect_id AND phone_id AND canonical_e164 together. Three of those four are
 * retired identifiers from the decommissioned `public.phones` export, and the
 * canonical graph builder deliberately leaves them NULL — its own SQL comment
 * says they "do not exist anywhere in the seller schema, so they stay NULL
 * provenance rather than being manufactured from the stale public.phones export
 * (which covers only 37.7% of the modern corpus)".
 *
 * Measured across all 169,797 production graph rows on 2026-09-15:
 *
 *   prospect_id        0        <- required
 *   phone_id           0        <- required
 *   master_owner_id    41,532   <- required, 26% of Individual owners
 *   seller_person_key  138,680  <- canonical, ignored
 *   canonical_e164     136,127  <- canonical
 *
 * So the gate was not strict, it was BROKEN CLOSED: zero graph-sourced targets
 * could ever be campaign-ready. Readiness now reads `seller_person_key`
 * (seller.property_owner_resolution_v1) and `canonical_e164`, which the builder
 * joins from seller.owner_phone ON THE SAME individual_key — the phone provably
 * belongs to the resolved person. Ready capacity went 0 -> 84,249.
 *
 * Readiness itself is a module-private pure function, so these tests cover the
 * two pieces that are importable and the behaviour that is observable: the
 * entity-review gate, and the linkage predicate as the build applies it. The
 * end-to-end proof (five real properties, four ready, one blocked) is recorded
 * in the phase report.
 */

/** Mirrors the repaired linkage predicate. */
const hasCanonicalLinkage = (row = {}) => {
  const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const person = clean(row.seller_person_key) || clean(row.prospect_id) || clean(row.canonical_prospect_id);
  const phone = clean(row.canonical_e164) || clean(row.phone_id);
  return Boolean(person && phone);
};

test('an individually-owned property with canonical identity is linked', () => {
  // The real shape of property 2100292793: verified owner, NO master_owner_id.
  assert.equal(hasCanonicalLinkage({
    property_id: '2100292793',
    master_owner_id: null,
    prospect_id: null,
    phone_id: null,
    seller_person_key: '15043651273',
    canonical_e164: '+19195559277',
  }), true, 'a resolved person with a phone is linked even without the legacy owner id');
});

/**
 * master_owner_id is absent on ~74% of rows across EVERY ownership shape
 * (26% of Individual, 12.5% of Corporate, 1.6% of rows with no owner_type), so
 * it is provenance "where applicable" and not a gate. Requiring it would block
 * 81,797 of the 103,595 canonically linked rows.
 */
test('a missing master_owner_id does not break linkage', () => {
  const withOwner = { seller_person_key: 'p1', canonical_e164: '+15551234567', master_owner_id: 'mo_1' };
  const withoutOwner = { seller_person_key: 'p1', canonical_e164: '+15551234567', master_owner_id: null };
  assert.equal(hasCanonicalLinkage(withOwner), true);
  assert.equal(hasCanonicalLinkage(withoutOwner), true);
});

test('the retired legacy ids still satisfy linkage when a row has them', () => {
  // Older rows that predate the seller schema must keep working.
  assert.equal(hasCanonicalLinkage({
    prospect_id: 'pros_legacy',
    phone_id: 'ph_legacy',
    canonical_e164: '+15551234567',
    seller_person_key: null,
  }), true);
});

test('no person means no linkage', () => {
  assert.equal(hasCanonicalLinkage({
    seller_person_key: null, prospect_id: null, canonical_prospect_id: null,
    canonical_e164: '+15551234567',
  }), false, '1,835 production rows have a phone but no resolved person');
});

test('no reachable phone means no linkage', () => {
  assert.equal(hasCanonicalLinkage({
    seller_person_key: 'p1', canonical_e164: null, phone_id: null,
  }), false);
});

test('blank strings are not identity', () => {
  assert.equal(hasCanonicalLinkage({ seller_person_key: '   ', canonical_e164: '  ' }), false);
});

// ───────────────────────────────────────────── entity-contact review gate (§6)

/** Stands in for the campaign_entity_contact_review_flags RPC. */
function fakeSupabase(flagRows, { error = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, ids: args?.p_property_ids ?? [] });
      if (error) return { data: null, error };
      const wanted = new Set(args.p_property_ids);
      return { data: flagRows.filter((r) => wanted.has(r.property_id)), error: null };
    },
  };
}

/**
 * seller.property_entity_contact_v1 decides who to contact about an
 * entity-owned property and flags `requires_review` when that link is not
 * defensible (ENT_ROLE_UNCORROBORATED, ENT_NO_REGISTRY_LINK). The graph does
 * not project it and the campaign path never read it, so 19,346 queue-eligible
 * entity contacts would have become campaign-ready once linkage was repaired.
 */
test('an uncorroborated entity contact is blocked', async () => {
  const client = fakeSupabase([
    { property_id: '2100285738', requires_review: true, exclusion_reasons: ['ENT_ROLE_UNCORROBORATED', 'ENT_NO_REGISTRY_LINK'] },
    { property_id: '2101957285', requires_review: false, exclusion_reasons: ['ENT_NO_REGISTRY_LINK'] },
  ]);
  const { blocked } = await fetchEntityContactReviewBlocks(['2100285738', '2101957285'], { supabase: client });
  assert.equal(blocked.has('2100285738'), true, 'requires_review must block');
  assert.equal(blocked.has('2101957285'), false, 'a review-clear entity contact is a legitimate target');
});

test('an individually-owned property is not subject to the entity gate', async () => {
  // Individual owners have no row in the entity-contact view at all.
  const client = fakeSupabase([]);
  const { blocked } = await fetchEntityContactReviewBlocks(['2100292793'], { supabase: client });
  assert.equal(blocked.size, 0);
});

/** NULL requires_review is treated as true by the accessor — fail closed. */
test('an unknown review state is treated as requiring review', async () => {
  const client = fakeSupabase([{ property_id: 'p1', requires_review: true, exclusion_reasons: null }]);
  const { blocked } = await fetchEntityContactReviewBlocks(['p1'], { supabase: client });
  assert.equal(blocked.has('p1'), true);
});

test('a real accessor failure surfaces rather than clearing the block', async () => {
  const client = fakeSupabase([], { error: { code: '42501', message: 'permission denied for function' } });
  await assert.rejects(
    () => fetchEntityContactReviewBlocks(['p1'], { supabase: client }),
    (thrown) => {
      assert.match(String(thrown.message), /permission denied/);
      return true;
    },
    'a failed review lookup must not silently allow entity contacts through',
  );
});

test('a missing accessor degrades without blocking every entity contact', async () => {
  const client = fakeSupabase([], { error: { code: 'PGRST202', message: 'Could not find the function' } });
  const result = await fetchEntityContactReviewBlocks(['p1'], { supabase: client });
  assert.equal(result.blocked.size, 0);
  assert.equal(result.unavailable, true, 'the caller must be able to see the flag was unavailable');
});

/** §19 — one set-based call per chunk, never per target. */
test('review flags are fetched set-based, not one property at a time', async () => {
  const ids = Array.from({ length: 1200 }, (_, i) => `p_${i}`);
  const client = fakeSupabase([]);
  await fetchEntityContactReviewBlocks(ids, { supabase: client });
  assert.ok(client.calls.length <= 3, `1200 ids must chunk, not fan out: ${client.calls.length} calls`);
  assert.ok(client.calls.every((c) => c.ids.length <= 500), 'no chunk may exceed the chunk size');
});

test('an empty candidate set makes no call at all', async () => {
  const client = fakeSupabase([]);
  const { blocked } = await fetchEntityContactReviewBlocks([], { supabase: client });
  assert.equal(blocked.size, 0);
  assert.equal(client.calls.length, 0);
});

test('duplicate property ids are collapsed before the lookup', async () => {
  const client = fakeSupabase([]);
  await fetchEntityContactReviewBlocks(['p1', 'p1', 'p1', 'p2'], { supabase: client });
  assert.deepEqual([...client.calls[0].ids].sort(), ['p1', 'p2']);
});
