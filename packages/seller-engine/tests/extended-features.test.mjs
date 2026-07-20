import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../features/engine.mjs';
import { loadRegistry, IMPLEMENTED } from '../features/registry.mjs';

const AS_OF = '2026-07-01T00:00:00Z';
const FLAGS = JSON.stringify([{ code: 'tired_landlord' }, { code: 'absentee_owner' },
  { code: 'expired_listing' }, { code: 'hoa_lien' }, { code: 'likely_to_move' }]);

const rich = () => ({
  property: {
    id: 'p1', situs_state: 'IL', units_count: 3, year_built: 1940, effective_year_built: 1980,
    condition_raw: 'Poor', condition_state: 'known',
    raw_keep: {
      property_flags: FLAGS, owner_hash: 'oh1', Owner1OwnershipRights: 'Life Tenant (holds a life estate interest only)',
      owner_address_state: 'FL', owner_address_full: '1 Away St', owner_address_city: 'Naples',
      owner_address_zip: '34102', owner_address_line_1: '1 Away St', owner_status: 'Absentee Owner',
      HeatingType: 'Yes', AirConditioning: 'Window/Unit', RoofCover: 'Asphalt', ConstructionType: 'Frame',
      estimated_repair_cost: '42000', TaxAmt: '5200', owner_2_name: 'DOE, JIM',
    },
  },
  valuation: { estimated_value: 200000, estimated_equity: 120000, equity_percent: 60, tax_delinquent: true, tax_delinquent_year: 2023 },
  loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 60000,
    recording_date: '2015-03-01', loan_type_raw: 'Mortgage Modification', blanket_loan_flag: false, original_loan_amount: 70000 }],
  checksums: { num_of_mortgages: 1, total_loan_amount: 70000, total_open_lien_nbr: 2, owner_has_multiple_properties: true },
  liens: [
    { id: 'a', base_type: 'lien', lifecycle_class: 'creation', filing_date: '2023-01-05', amount_due: 12000, doc_type_raw: 'LENCNT' },
    { id: 'b', base_type: 'federal_tax_lien', lifecycle_class: 'creation', filing_date: '2024-01-05', amount_due: 8000, doc_type_raw: 'FLN' },
    { id: 'c', base_type: 'affidavit_of_death', lifecycle_class: 'probate_life_event', filing_date: '2025-06-01', date_of_death: '2025-05-01', doc_type_raw: 'AFD' },
    { id: 'd', base_type: 'assignment_of_rents', lifecycle_class: 'neutral', filing_date: '2019-02-01', doc_type_raw: 'ASR' },
    { id: 'e', base_type: 'hoa_lien', lifecycle_class: 'creation', filing_date: '2024-05-01', amount_due: 900, doc_type_raw: 'HOA LIEN', lien_type_raw: 'hoa_lien' },
  ],
  foreclosure: [], transactions: [
    { id: 't1', event_role: 'current', sale_date: '2009-03-01', sale_price: 80000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' },
  ],
  links: [{ id: 'k1', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: false, person_identity_tier: 'key',
    profile: { est_household_income_code: '25', net_asset_value: '$0-24,999', buying_power: 'Very High Risk',
      agg_credit_tier: 'Sub Prime', card_balance: 'High', investments: true, business_owner: false,
      length_of_residence: 14, portfolio_total_properties_owned: 6, portfolio_total_equity: 400000,
      portfolio_total_mortgage_balance: 600000, language_preference: 'Spanish', primary_decision_maker: true } }],
  phones: [], emails: [], batchScalarLiveness: 0.2,
  classifications: [{ classification: 'corporate', evidence_source: 'owner_status' }],
  companies: [{ existence_norm: 'inactive' }], companyLinks: [{ id: 'cl1' }],
});

test('all 81 implemented features emit a result; only the 6 blocked ids may be value_state=blocked', () => {
  const { features } = computeFeatures(rich(), AS_OF);
  const byId = new Map(features.map((f) => [f.feature_id, f]));
  const reg = loadRegistry();
  const missing = reg.filter((r) => r.implementation === 'implemented' && !byId.has(r.feature_id));
  assert.deepEqual(missing.map((m) => m.feature_id), [], 'every implemented feature must emit');
  const wrongBlocked = features.filter((f) => f.value_state === 'blocked'
    && IMPLEMENTED.has(f.feature_id)
    && !['F-057', 'F-060', 'F-061', 'F-062', 'F-056', 'F-058', 'F-052', 'F-130', 'F-132'].includes(f.feature_id));
  assert.deepEqual(wrongBlocked.map((f) => f.feature_id), [], 'implemented features may only be runtime-blocked if snapshot-gated');
  assert.equal(new Set(features.map((f) => f.feature_id)).size, features.length, 'no duplicate feature ids');
});

test('key extended behaviors on a rich bundle', () => {
  const { features } = computeFeatures(rich(), AS_OF);
  const f = (id) => features.find((x) => x.feature_id === id);
  assert.equal(f('F-002').value.events, 1);                       // life event (AFD)
  assert.equal(f('F-003').value, true);                            // expired listing flag
  assert.equal(f('F-010').value.modifications, 1);                 // modification churn
  assert.ok(f('F-016').value.docs >= 1);                           // HOA lien
  assert.equal(f('F-017').value, 1);                               // federal tax lien
  assert.equal(f('F-030').value >= 2, true);                       // tired-landlord composite (flag + structural)
  assert.equal(f('F-031').value, 'out_of_state');                  // owner distance band
  assert.equal(f('F-033').value, 6);                               // portfolio scale
  assert.equal(f('F-036').value, 'death_or_probate_evidence');     // estate stage
  assert.equal(f('F-038').value, true);                            // owner_2 multiparty
  assert.equal(f('F-039').value, true);                            // life estate vesting
  assert.equal(f('F-041').value, 'entity_defunct');                // dissolved entity
  assert.equal(f('F-044').value.keyed, 1);                         // identity key coverage
  assert.equal(f('F-048').value, 'Spanish');                       // language routing
  assert.ok(f('F-050').value > 0);                                 // pressure-to-equity
  assert.equal(f('F-051').value, 'market_acquisition');            // basis class
  assert.ok(f('F-053').value.blockers.includes('defunct_entity')); // dealability blockers
  assert.equal(f('F-122').confidence <= 0.35, true);               // buying_power version-partitioned low conf
  assert.match(f('F-120').explanation_fragment, /band code/);      // income tier
  assert.equal(f('F-105').value, false);                           // portfolio guard not tripped
});

test('portfolio magnitude guard voids portfolio features (T-01 family)', () => {
  const b = rich();
  b.links[0].profile.portfolio_total_equity = -15_039_096_114;
  const { features } = computeFeatures(b, AS_OF);
  assert.equal(features.find((f) => f.feature_id === 'F-105').value, true);
  assert.equal(features.find((f) => f.feature_id === 'F-033').value_state, 'unknown');
});

test('families consume extended features: landlord fatigue, ownership complexity, authority gate', async () => {
  const { computeFamilies } = await import('../scores/families.mjs');
  const { features } = computeFeatures(rich(), AS_OF);
  const fam = computeFamilies(features);
  assert.equal(fam.landlord_fatigue.score_state, 'scored');
  assert.ok(fam.landlord_fatigue.score > 0);
  assert.ok(fam.ownership_complexity.score >= 12); // estate + entity + fractional + life estate
  // defunct entity x0.5, estate unsettled x0.75, life estate x0.9 on 1.0 base
  // (decision-maker bonus) => 0.34; every authority blocker now actually bites
  assert.equal(fam.authority_confidence.score, 0.34);
  assert.equal(fam.execution_priority.score_state, 'scored');
});
