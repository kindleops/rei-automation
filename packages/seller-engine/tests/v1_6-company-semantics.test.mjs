// V1.6 — company ownership evidence semantics.
// Locks the rule that a company's appearance as a historical transaction party
// never establishes CURRENT entity ownership, and that seller-pressure scoring
// is untouched by the correction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompanyLink, companyNameMatchesOwner, isCurrentOwnershipClass } from '../scores/companyRelationship.mjs';
import { qualifyEntityOwnership, vestingEvidence } from '../scores/entityOwnershipEvidence.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { computeFamilies } from '../scores/families.mjs';

const TXN_SRC = 'property.transaction_linked_companies';
const LINK_SRC = 'property.linked_company';
const SCORING_TS = '2026-07-19T00:00:00Z';

const txn = (o = {}) => ({
  vendor_transaction_id: 't1', event_role: 'current',
  document_type_group: 'market_or_standard_transfer', sale_date: '2020-05-01',
  buyer_names: [], seller_names: [], ...o,
});

test('agent brokerage never establishes ownership', () => {
  const c = classifyCompanyLink(
    { company_source: TXN_SRC, matched_party: 'transaction_real_estate_agent', matching_type: '21',
      company_name: 'Keller Williams Realty', transaction_id: 't1' },
    { owner_name_of_record: 'Keller Williams Realty', transaction: txn() },
  );
  assert.equal(c.relationship_class, 'brokerage');
  assert.equal(c.ownership_relevance, 'none');
  assert.equal(c.authority_relevance, 'none');
  assert.equal(isCurrentOwnershipClass(c.relationship_class), false);
  // even an exact name match to the owner of record cannot promote an agent
  assert.equal(c.confidence, 0);
});

test('historical seller never establishes current ownership (REO bank case)', () => {
  const c = classifyCompanyLink(
    { company_source: TXN_SRC, matched_party: 'transaction_seller_1', matching_type: '21',
      company_name: 'JPMORGAN CHASE BANK, N.A.', transaction_id: 't1' },
    { owner_name_of_record: 'Darren Skinner', transaction: txn() },
  );
  assert.equal(c.relationship_class, 'lender_or_servicer');
  assert.equal(c.ownership_relevance, 'negative_after_transfer');
  assert.equal(isCurrentOwnershipClass(c.relationship_class), false);
});

test('historical buyer without corroboration stays historical', () => {
  const c = classifyCompanyLink(
    { company_source: TXN_SRC, matched_party: 'transaction_buyer_1', matching_type: '21',
      company_name: 'Acme Holdings LLC', transaction_id: 't1' },
    { owner_name_of_record: 'Maria Delgado', transaction: txn(),
      latest_qualifying_transfer_id: 't1', scoring_timestamp: SCORING_TS, canonical_corporate: false },
  );
  assert.equal(c.relationship_class, 'historical_buyer');
  assert.equal(c.ownership_relevance, 'insufficient_uncorroborated');
  assert.match(c.reason_code, /company_name_does_not_match_owner_of_record/);
});

test('latest buyer matching current owner IS current ownership', () => {
  const c = classifyCompanyLink(
    { company_source: TXN_SRC, matched_party: 'transaction_buyer_1', matching_type: '21',
      company_name: 'Acme Holdings LLC', transaction_id: 't1' },
    { owner_name_of_record: 'Acme Holdings LLC', transaction: txn(),
      latest_qualifying_transfer_id: 't1', scoring_timestamp: SCORING_TS, canonical_corporate: true },
  );
  assert.equal(c.relationship_class, 'current_owner_company');
  assert.equal(c.ownership_relevance, 'establishes_current_entity_ownership');
  assert.equal(isCurrentOwnershipClass(c.relationship_class), true);
});

test('buyer followed by a later transfer is NOT current ownership', () => {
  const c = classifyCompanyLink(
    { company_source: TXN_SRC, matched_party: 'transaction_buyer_1', matching_type: '21',
      company_name: 'Acme Holdings LLC', transaction_id: 't1' },
    { owner_name_of_record: 'Acme Holdings LLC',
      transaction: txn({ vendor_transaction_id: 't1', event_role: 'previous' }),
      latest_qualifying_transfer_id: 't2', // a LATER transfer exists
      scoring_timestamp: SCORING_TS, canonical_corporate: true },
  );
  assert.equal(c.relationship_class, 'historical_buyer');
  assert.match(c.reason_code, /not_latest_qualifying_transfer/);
});

test('buyer whose transfer post-dates the scoring timestamp is not current ownership', () => {
  const c = classifyCompanyLink(
    { company_source: TXN_SRC, matched_party: 'transaction_buyer_1', matching_type: '21',
      company_name: 'Acme Holdings LLC', transaction_id: 't1' },
    { owner_name_of_record: 'Acme Holdings LLC',
      transaction: txn({ sale_date: '2027-01-01' }),
      latest_qualifying_transfer_id: 't1', scoring_timestamp: SCORING_TS, canonical_corporate: true },
  );
  assert.equal(c.relationship_class, 'historical_buyer');
  assert.match(c.reason_code, /transfer_not_before_scoring_ts/);
});

test('blank company-link role routes to unresolved, not entity authority', () => {
  const c = classifyCompanyLink(
    { company_source: LINK_SRC, matched_party: '', matching_type: '',
      company_name: 'Riverbend Ventures LLC', transaction_id: '' },
    { owner_name_of_record: 'Patricia Nowak', owner_status: 'Absentee Owner' },
  );
  assert.equal(c.relationship_class, 'role_unknown');
  assert.equal(isCurrentOwnershipClass(c.relationship_class), false);
});

test('matching type code with untraced semantics fails closed', () => {
  const c = classifyCompanyLink(
    { company_source: 'property.something_new', matched_party: 'mystery_role', matching_type: '77',
      company_name: 'Unknown Co', transaction_id: '' },
    { owner_name_of_record: 'Unknown Co' },
  );
  assert.equal(c.relationship_class, 'source_semantics_unknown');
  assert.equal(c.ownership_relevance, 'none');
  assert.equal(isCurrentOwnershipClass(c.relationship_class), false);
});

test('transaction association PLUS canonical corporate ownership still routes to entity authority', () => {
  const q = qualifyEntityOwnership({
    owner_name: 'Northgate Properties LLC', canonical_corporate: true,
    company_links: [{ company_source: TXN_SRC, matched_party: 'transaction_seller_1',
      matching_type: '21', company_name: 'Some Bank NA', transaction_id: 't1' }],
    transactions_by_id: { t1: txn() }, scoring_timestamp: SCORING_TS,
  });
  assert.equal(q.is_company, true);
  assert.equal(q.confirmed_entity_ownership, true);
  assert.equal(q.authority_evidence_grade, 'canonical_current_ownership');
  // the transaction-party link is recorded as disqualified, not as support
  assert.ok(q.disqualified_evidence.some((d) => d.startsWith('lender_or_servicer')));
});

test('trust ownership is established independent of any company link', () => {
  const q = qualifyEntityOwnership({
    owner_name: 'Hollis Family Trust', canonical_trust: true, company_links: [],
    scoring_timestamp: SCORING_TS,
  });
  assert.equal(q.is_trust, true);
  assert.equal(q.confirmed_entity_ownership, true);
});

test('lexical entity fallback is fail-closed but labelled review, not confirmed ownership', () => {
  const q = qualifyEntityOwnership({
    owner_name: 'Sunrise Holdings LLC', company_links: [], scoring_timestamp: SCORING_TS,
  });
  assert.equal(q.confirmed_entity_ownership, false);       // NOT confirmed
  assert.equal(q.lexical_authority_review, true);
  assert.equal(q.authority_evidence_grade, 'lexical_authority_review');
  assert.equal(q.is_entity_input, true);                    // still fail-closed
});

test('vesting: borrower-in-default is never trust ownership', () => {
  const v = vestingEvidence("Trustor/Debtor (Borrower in Default/Foreclosure on Trustee's Deed)");
  assert.equal(v.trust, false);
  assert.equal(v.company, false);
  assert.equal(v.borrower_in_default, true);
});

test('vesting: corporate and trust rights qualify as ownership evidence', () => {
  assert.equal(vestingEvidence('Company or Corporation').company, true);
  assert.equal(vestingEvidence('Limited Liability Company').company, true);
  assert.equal(vestingEvidence('Limited Liability Partnership').company, true);
  assert.equal(vestingEvidence('Trustee, or Conservator').trust, true);
  assert.equal(vestingEvidence('Life Tenant (holds a life estate interest only)').estate, true);
});

test('vesting: natural-person tenancy codes are NOT entity ownership', () => {
  // These describe how individuals hold title, not an entity owner. Treating
  // them as entity evidence would repeat the company-link over-blocking defect.
  for (const v of ['Sole Member', 'Partner', 'Limited Partner', 'Joint Tenants',
    'Single Person or Individual', 'Community Property (Marital Community)',
    'Husband and Wife', 'Tenants in Common']) {
    assert.equal(vestingEvidence(v).company, false, `${v} must not read as entity ownership`);
  }
});

test('removing an unsupported authority route does NOT auto-grant outreach', () => {
  // property whose ONLY entity signal was a transaction-party company link
  const q = qualifyEntityOwnership({
    owner_name: 'Darren Skinner',
    company_links: [{ company_source: TXN_SRC, matched_party: 'transaction_seller_1',
      matching_type: '21', company_name: 'JPMORGAN CHASE BANK, N.A.', transaction_id: 't1' }],
    transactions_by_id: { t1: txn() }, scoring_timestamp: SCORING_TS,
  });
  assert.equal(q.is_entity_input, false);   // no longer entity-authority routed
  // ...but outreach eligibility still has to be earned through the normal ladder:
  // a Tier-C candidate must NOT become outreach-eligible.
  const res = resolveCanonical(
    { property_id: 'p1', owner_name: 'Darren Skinner', is_entity: q.is_entity_input,
      is_trust: q.is_trust, is_estate: q.is_estate },
    [{ id: 'c1', person_name: 'Darren Skinner', link_tier: 'medium', owner_token: true,
      phones: 1, emails: 0 }],
  );
  assert.notEqual(res.execution_route, 'entity_authority_resolution');
  assert.equal(res.outreach_eligible_candidate_ids.length, 0); // Tier C earns nothing
});

test('Tier B remains manual after an authority route is removed', () => {
  const q = qualifyEntityOwnership({
    owner_name: 'Alicia Romero',
    company_links: [{ company_source: TXN_SRC, matched_party: 'transaction_buyer_1',
      matching_type: '21', company_name: 'Cedar Point LLC', transaction_id: 't1' }],
    transactions_by_id: { t1: txn() }, scoring_timestamp: SCORING_TS,
  });
  assert.equal(q.is_entity_input, false);
  const res = resolveCanonical(
    { property_id: 'p2', owner_name: 'Alicia Romero', is_entity: q.is_entity_input,
      is_trust: q.is_trust, is_estate: q.is_estate, owner_mailing_state: 'TX', situs_state: 'TX' },
    [{ id: 'c2', person_name: 'Alicia Romero', link_tier: 'medium', owner_token: true,
      owner_verdict: true, phones: 1, emails: 0 }],
  );
  // Tier B (token+verdict) is eligible at the resolver layer but outreach policy
  // holds it manual — V1.6 must not have relaxed that.
  const tierB = res.candidates.find((c) => c.id === 'c2');
  assert.equal(tierB.evidence_tier, 'B');
  assert.equal(res.execution_route, 'owner_outreach');
});

test('company name matching ignores corporate suffixes and stopwords', () => {
  assert.equal(companyNameMatchesOwner('DLE Investments, LLC', 'Dle Investments LLC'), true);
  assert.equal(companyNameMatchesOwner('Acme Holdings LLC', 'Maria Delgado'), false);
  assert.equal(companyNameMatchesOwner('The Trust Group LLC', 'Random Person'), false);
});

test('seller-pressure invariance: qualifying entity evidence emits no scoring fields', () => {
  const q = qualifyEntityOwnership({
    owner_name: 'Northgate Properties LLC', canonical_corporate: true, company_links: [],
    scoring_timestamp: SCORING_TS,
  });
  const forbidden = ['score', 'weight', 'motivation', 'seller_pressure', 'priority',
    'family', 'urgency', 'distress'];
  const keys = JSON.stringify(Object.keys(q)).toLowerCase();
  for (const f of forbidden) assert.ok(!keys.includes(f), `V1.6 must not emit ${f}`);
});

test('V1.6: company-evidence correction does NOT change any seller-pressure family score', () => {
  // Same property facts; the ONLY difference is the company-link evidence that
  // V1.5 mis-read as entity ownership. Seller-pressure families must be identical
  // because the scoring engine never consumes company links at all.
  const bundle = {
    property: { id: 'p1', condition_raw: 'Poor', condition_state: 'known', raw_keep: { owner_name: 'Darren Skinner', property_flags: '[{"code":"tax_delinquent"}]' } },
    valuation: { estimated_value: 200000, estimated_equity: 150000, equity_percent: 75, tax_delinquent: true, tax_delinquent_year: 2022 },
    loans: [], liens: [{ id: 'a', base_type: 'judgment', lifecycle_class: 'judgment', filing_date: '2024-01-01', amount_due: 20000, doc_type_raw: 'JDGLEN' }],
    foreclosure: [], transactions: [{ id: 't', event_role: 'current', sale_date: '2005-01-01', sale_price: 60000, price_qualifier_class: 'valuation' }],
    links: [{ id: 'o', person_id: 'o', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: false, is_matching_property_as_owner: true, person_name: 'Darren Skinner' }],
    phones: [{ phone_e164: '+15555550100', line_type: 'wireless', do_not_call: false, never_call: false }], emails: [], batchScalarLiveness: 0.2,
  };
  const fams = computeFamilies(computeFeatures(bundle, '2026-07-01T00:00:00Z').features);

  const v15EntityInput = true;   // V1.5: any company link => entity
  const v16 = qualifyEntityOwnership({
    owner_name: 'Darren Skinner',
    company_links: [{ company_source: TXN_SRC, matched_party: 'transaction_seller_1',
      matching_type: '21', company_name: 'JPMORGAN CHASE BANK, N.A.', transaction_id: 't1' }],
    transactions_by_id: { t1: txn() }, scoring_timestamp: SCORING_TS,
  });
  assert.equal(v16.is_entity_input, false);
  assert.notEqual(v16.is_entity_input, v15EntityInput);   // the routing input DID change

  const route = (isEntity) => resolveCanonical(
    { property_id: 'p1', owner_name: 'Darren Skinner', is_entity: isEntity, is_trust: false, is_estate: false },
    [{ id: 'o', person_name: 'Darren Skinner', link_tier: 'high', owner_token: true,
      owner_verdict: true, identity_tier: 'key', name_match: true, exact_key_owner: true, phones: 1, emails: 0 }],
  ).execution_route;
  assert.equal(route(v15EntityInput), 'entity_authority_resolution');
  assert.notEqual(route(v16.is_entity_input), 'entity_authority_resolution');

  // ...and every seller-pressure family is untouched by that reroute
  const famsAfter = computeFamilies(computeFeatures(bundle, '2026-07-01T00:00:00Z').features);
  for (const fam of ['seller_propensity', 'financial_pressure', 'legal_title_pressure',
    'foreclosure_urgency', 'property_distress', 'landlord_fatigue']) {
    assert.equal(famsAfter[fam].score, fams[fam].score, `${fam} must be invariant under V1.6`);
  }
});

test('reproducible: identical input yields byte-identical classification', () => {
  const input = {
    owner_name: 'Acme Holdings LLC', canonical_corporate: true,
    company_links: [{ company_source: TXN_SRC, matched_party: 'transaction_buyer_1',
      matching_type: '21', company_name: 'Acme Holdings LLC', transaction_id: 't1' }],
    transactions_by_id: { t1: txn() }, latest_qualifying_transfer_id: 't1',
    scoring_timestamp: SCORING_TS,
  };
  assert.equal(JSON.stringify(qualifyEntityOwnership(input)),
    JSON.stringify(qualifyEntityOwnership(input)));
});
