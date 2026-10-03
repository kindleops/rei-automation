import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCanonicalLanguages } from '../../src/lib/domain/campaigns/campaign-recipient-metrics.js';
import { applyCanonicalSellerName, launchCandidateFromTarget } from '../../src/lib/domain/campaigns/campaign-automation-service.js';
import { enrichSampleRows } from '../../src/lib/domain/campaigns/campaign-composer.js';
import { resolveSellerIdentity } from '../../src/lib/domain/outbound/supabase-candidate-feeder.js';

/**
 * CAMPAIGN-SELLER-NAME-HYDRATION — the greeting needs the messaged PERSON's name.
 *
 * campaign_target_graph.seller_first_name / seller_full_name are NULL on all
 * 169,797 rows (the seller_contact_bridge refresh never projects them). The
 * only name a target carried was owner_name — the deed owner. On an
 * entity-owned property that is the company ("Rci Holdings Inc") while the
 * phone belongs to the resolved representative, so "Hi {first_name}" rendered
 * "Hi , …", the render lint refused it and the seller was held (Composer:
 * "1 of 3 samples didn't render", Minneapolis 2026-10-03).
 */

function fakeSupabase({ prospects = [], owners = [] } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const builder = {
        select(columns) { calls.push({ table, columns }); return builder; },
        in(_column, ids) {
          const rows = table === 'prospects'
            ? prospects.filter((r) => ids.includes(r.individual_key))
            : owners.filter((r) => ids.includes(r.master_owner_id));
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };
}

const REP = { individual_key: '150548280606', first_name: 'Robert', full_name: 'Robert D Axelrod', language_preference: null };

test('the person name comes from the same prospects read as language (no extra query)', async () => {
  const supabase = fakeSupabase({ prospects: [REP] });
  const lookup = await fetchCanonicalLanguages([{ seller_person_key: '150548280606', master_owner_id: null }], { supabase });
  assert.deepEqual(lookup.resolveName({ seller_person_key: '150548280606' }), { first_name: 'Robert', full_name: 'Robert D Axelrod' });
  assert.equal(supabase.calls.filter((c) => c.table === 'prospects').length, 1);
  assert.match(supabase.calls[0].columns, /first_name/);
});

test('an unknown person has no name — never borrowed from the owner entity', async () => {
  const lookup = await fetchCanonicalLanguages([{ seller_person_key: 'pk_x', master_owner_id: 'mo_x' }], {
    supabase: fakeSupabase({ prospects: [], owners: [{ master_owner_id: 'mo_x', best_language: 'English' }] }),
  });
  assert.equal(lookup.resolveName({ seller_person_key: 'pk_x', master_owner_id: 'mo_x' }), null);
  assert.equal(lookup.resolveName({}), null);
});

test('applyCanonicalSellerName fills blanks only and never overwrites a graph name', () => {
  const lookup = { resolveName: () => ({ first_name: 'Robert', full_name: 'Robert D Axelrod' }) };
  const blank = applyCanonicalSellerName({ seller_person_key: 'k', owner_name: 'Rci Holdings Inc' }, lookup);
  assert.equal(blank.seller_first_name, 'Robert');
  assert.equal(blank.seller_full_name, 'Robert D Axelrod');
  assert.equal(blank.seller_name_source, 'prospect');
  assert.equal(blank.owner_name, 'Rci Holdings Inc', 'the deed owner stays the deed owner');

  const named = applyCanonicalSellerName({ seller_first_name: 'Ann', seller_full_name: 'Ann Lee' }, lookup);
  assert.equal(named.seller_first_name, 'Ann');
  assert.equal(named.seller_name_source, undefined);

  const unknown = applyCanonicalSellerName({ seller_person_key: 'k' }, { resolveName: () => null });
  assert.equal(unknown.seller_first_name, undefined);
});

test('an entity-owned sample greets the representative, not the company', async () => {
  const row = {
    target_status: 'ready',
    master_owner_id: 'mo_557783c6b41dec967aa0a683',
    property_id: '273588014',
    owner_name: 'Rci Holdings Inc',
    language: null,
    metadata: {
      candidate_snapshot: {
        property_id: '273588014',
        owner_name: 'Rci Holdings Inc',
        seller_first_name: null,
        seller_full_name: null,
        seller_person_key: '150548280606',
        to_phone_number: '6125550100',
      },
    },
  };
  const [enriched] = await enrichSampleRows([row], { supabase: fakeSupabase({ prospects: [{ ...REP, language_preference: 'English' }] }) });
  assert.equal(enriched.metadata.candidate_snapshot.seller_first_name, 'Robert');
  assert.equal(enriched.language, 'English');
  assert.equal(row.metadata.candidate_snapshot.seller_first_name, null, 'input rows are not mutated');

  const candidate = launchCandidateFromTarget(enriched, { market: 'Minneapolis, MN' });
  assert.equal(candidate.seller_full_name, 'Robert D Axelrod');
  const identity = resolveSellerIdentity({ ...candidate, identity_alignment: { status: 'entity_company_linked' } });
  assert.equal(identity.seller_first_name, 'Robert');
  assert.equal(identity.seller_name_missing, false);
});

test('without a canonical name the entity sample is still greeting-less (held, not guessed)', async () => {
  const row = { target_status: 'ready', owner_name: 'Rci Holdings Inc', metadata: { candidate_snapshot: { owner_name: 'Rci Holdings Inc', seller_person_key: 'pk_none' } } };
  const [enriched] = await enrichSampleRows([row], { supabase: fakeSupabase({ prospects: [] }) });
  assert.equal(enriched.metadata.candidate_snapshot.seller_first_name ?? null, null);
});
