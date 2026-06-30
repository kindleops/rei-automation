import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateAcquisitionDecision,
  evaluateCompEligibility,
  loadComparableProperties,
  loadSubjectProperty,
  normalizePropertyFeatures,
  scoreBatch,
  scoreComparable,
  scoreProperty,
} from '@/lib/acquisition/acquisitionDecisionEngine.js';
import {
  handleScorePropertyRequest,
} from '@/app/api/internal/acquisition/score-property/route.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

const SUBJECT = {
  property_id: '12345678',
  property_address_full: '100 Main St, Dallas, TX 75201',
  property_address_city: 'Dallas',
  property_address_state: 'TX',
  property_address_zip: '75201',
  market: 'Dallas, TX',
  latitude: 32.7767,
  longitude: -96.797,
  normalized_asset_class: 'single_family',
  property_type: 'Single Family',
  property_class: 'Residential',
  total_bedrooms: 3,
  total_baths: 2,
  building_square_feet: 1800,
  units_count: 1,
  year_built: 1988,
  effective_year_built: 2008,
  lot_square_feet: 7500,
  subdivision_name: 'Central',
  school_district_name: 'Dallas ISD',
  zoning: 'R-7.5',
  flood_zone: 'X',
  hoa1_name: 'Central HOA',
  building_condition: 'Average',
  building_quality: 'Good',
  construction_type: 'Frame',
  exterior_walls: 'Brick',
  interior_walls: 'Drywall',
  floor_cover: 'Mixed',
  roof_cover: 'Composition',
  roof_type: 'Gable',
  estimated_repair_cost: 32_000,
  air_conditioning: 'Central',
  heating_type: 'Forced Air',
  heating_fuel_type: 'Gas',
  sewer: 'Public',
  water: 'Public',
  basement: 'No',
  garage: 'Yes',
  sum_garage_sqft: 420,
  pool: 'No',
  porch: 'Yes',
  patio: 'Yes',
  deck: 'No',
  driveway: 'Yes',
  stories: 1,
  style: 'Ranch',
  sum_buildings_nbr: 1,
  sum_commercial_units: 0,
  estimated_value: 360_000,
  equity_percent: 62,
  total_loan_balance: 125_000,
  ownership_years: 14,
  out_of_state_owner: true,
  tax_delinquent: false,
  active_lien: false,
  structured_motivation_score: 74,
  tag_distress_score: 58,
  seller_tags_text: 'vacant tired landlord',
  mls_current_listing_price: 350_000,
  mls_market_status: 'Off Market',
};

function ownerSituationSubject(overrides = {}) {
  return {
    ...SUBJECT,
    property_id: 'phase2-subject',
    property_flags_text: '',
    property_flags_json: [],
    seller_tags_text: '',
    seller_tags_json: [],
    podio_tags: '',
    structured_motivation_score: 0,
    tag_distress_score: 0,
    final_acquisition_score: 0,
    out_of_state_owner: false,
    owner_location: 'Owner Occupied',
    tax_delinquent: false,
    tax_delinquent_year: null,
    past_due_amount: 0,
    active_lien: false,
    is_foreclosure: false,
    is_preforeclosure: false,
    is_hot_preforeclosure: false,
    estimated_household_income: 120_000,
    estimated_net_asset_value: 450_000,
    buying_power: null,
    total_loan_payment: 1_000,
    tax_amt: 3_000,
    sale_price: 220_000,
    estimated_value: 360_000,
    equity_amount: 160_000,
    equity_percent: 44,
    total_loan_balance: 200_000,
    estimated_repair_cost: 12_000,
    ownership_years: 8,
    building_condition: 'Good',
    rehab_level: 'Light',
    ...overrides,
  };
}

function comp(index, price, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    property_id: `sold-${index}`,
    property_address_full: `${100 + index} Main St, Dallas, TX 75201`,
    property_address_city: 'Dallas',
    property_address_state: 'TX',
    property_address_zip: '75201',
    market: 'Dallas, TX',
    latitude: 32.7767 + index * 0.001,
    longitude: -96.797 + index * 0.001,
    normalized_asset_class: 'single_family',
    property_type: 'Single Family',
    property_class: 'Residential',
    total_bedrooms: 3,
    total_baths: 2,
    building_square_feet: 1760 + index * 12,
    units_count: 1,
    year_built: 1986 + index,
    effective_year_built: 2006 + index,
    lot_square_feet: 7300 + index * 50,
    subdivision_name: 'Central',
    school_district_name: 'Dallas ISD',
    zoning: 'R-7.5',
    flood_zone: 'X',
    hoa_1_name: 'Central HOA',
    building_condition: 'Average',
    building_quality: 'Good',
    construction_type: 'Frame',
    exterior_walls: 'Brick',
    interior_walls: 'Drywall',
    floor_cover: 'Mixed',
    roof_cover: 'Composition',
    roof_type: 'Gable',
    estimated_repair_cost: 28_000,
    air_conditioning: 'Central',
    heating_type: 'Forced Air',
    heating_fuel_type: 'Gas',
    sewer: 'Public',
    water: 'Public',
    basement: 'No',
    garage: 'Yes',
    garage_square_feet: 400,
    pool: 'No',
    porch: 'Yes',
    patio: 'Yes',
    deck: 'No',
    driveway: 'Yes',
    stories: 1,
    property_style: 'Ranch',
    sum_buildings_nbr: 1,
    sum_commercial_units: 0,
    mls_sold_price: price,
    mls_sold_date: `2026-0${Math.min(index, 5)}-15`,
    source: 'buyer_comp_properties_v2',
    ...overrides,
  };
}

function buyerPurchase(index, price) {
  return {
    id: `purchase-${index}`,
    buyer_key: `buyer-${index % 5}`,
    buyer_name: `Buyer ${index % 5}`,
    buyer_type: index % 2 ? 'Investor' : 'Corporate',
    is_corporate_buyer: index % 2 === 0,
    purchase_date: `2026-0${Math.min(index, 5)}-01`,
    purchase_price: price,
    property_address_full: `${200 + index} Main St, Dallas, TX 75201`,
    property_city: 'Dallas',
    property_state: 'TX',
    property_zip: '75201',
    market: 'Dallas, TX',
    latitude: 32.77 + index * 0.002,
    longitude: -96.79 + index * 0.002,
    normalized_asset_class: 'single_family',
    property_type: 'Single Family',
    beds: 3,
    baths: 2,
    sqft: 1750 + index * 10,
    units_count: 1,
    year_built: 1990,
    likely_strategy: 'rental investor',
  };
}

const GOOD_COMPS = [
  comp(1, 330_000),
  comp(2, 338_000),
  comp(3, 342_000),
  comp(4, 348_000),
  comp(5, 355_000),
  comp(6, 362_000, { mls_sold_date: '2025-12-15' }),
];

const BUYER_PURCHASES = Array.from(
  { length: 12 },
  (_, index) => buyerPurchase(index + 1, 248_000 + index * 4_000),
);

function queryResult(result) {
  const builder = {
    select() {
      return builder;
    },
    in() {
      return Promise.resolve(result);
    },
    limit() {
      return builder;
    },
    eq() {
      return builder;
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return builder;
}

function terminalQuery(result) {
  const builder = {
    eq() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return builder;
}

function ownerContextSupabase({
  missingProspectColumn = null,
  missingPhoneColumn = null,
  requiredSubjectError = null,
} = {}) {
  const selectAttempts = [];
  const supabase = {
    from(table) {
      return {
        select(select) {
          selectAttempts.push({ table, select });
          if (table === 'properties') {
            return terminalQuery(
              requiredSubjectError
                ? { data: null, error: requiredSubjectError }
                : {
                    data: {
                      ...SUBJECT,
                      master_owner_id: 'owner-1',
                    },
                    error: null,
                  },
            );
          }
          if (table === 'acquisition_contacts') {
            return terminalQuery({
              data: null,
              error: {
                code: 'PGRST205',
                message: "Could not find the table 'public.acquisition_contacts'",
              },
            });
          }
          if (table === 'master_owners') {
            return terminalQuery({
              data: [
                {
                  master_owner_id: 'owner-1',
                  owner_type_guess: 'Individual',
                  owner_location_text: 'Out of State',
                  financial_pressure_score: 30,
                },
              ],
              error: null,
            });
          }
          if (
            table === 'prospects' &&
            missingProspectColumn &&
            select.split(',').includes(missingProspectColumn)
          ) {
            return terminalQuery({
              data: null,
              error: {
                code: 'PGRST204',
                message: `Could not find the '${missingProspectColumn}' column of 'prospects' in the schema cache`,
              },
            });
          }
          if (table === 'prospects') {
            return terminalQuery({
              data: [
                {
                  prospect_id: 'prospect-1',
                  master_owner_id: 'owner-1',
                  est_household_income: '100000',
                  net_asset_value: '500000',
                  property_count: 2,
                  owner_type_guess: 'Individual',
                },
              ],
              error: null,
            });
          }
          if (
            table === 'phones' &&
            missingPhoneColumn &&
            select.split(',').includes(missingPhoneColumn)
          ) {
            return terminalQuery({
              data: null,
              error: {
                code: 'PGRST204',
                message: `Could not find the '${missingPhoneColumn}' column of 'phones' in the schema cache`,
              },
            });
          }
          if (table === 'phones') {
            return terminalQuery({
              data: [
                {
                  phone_id: 'phone-1',
                  master_owner_id: 'owner-1',
                  sort_rank: 1,
                  activity_status: 'active',
                  linked_prospect_ids_json: ['prospect-1'],
                },
              ],
              error: null,
            });
          }
          return terminalQuery({ data: [], error: null });
        },
      };
    },
  };
  return { supabase, selectAttempts };
}

test('RPC comp candidates are enriched from v_recent_sold_comps', async () => {
  const tables = [];
  const compId = '00000000-0000-4000-8000-000000000099';
  const supabase = {
    rpc: async () => ({
      data: [
        {
          comp_id: compId,
          property_id: 'sold-99',
          address: '199 Main St, Dallas, TX 75201',
          zip: '75201',
          latitude: 32.777,
          longitude: -96.798,
          sale_price: 340_000,
          sale_date: '2026-04-01',
          asset_class: 'single_family',
          property_type: 'Single Family',
          beds: 3,
          baths: 2,
          sqft: 1780,
          units_count: 1,
          year_built: 1990,
          distance_miles: 0.2,
        },
      ],
      error: null,
    }),
    from(table) {
      tables.push(table);
      if (table === 'v_recent_sold_comps') {
        return queryResult({
          data: [
            {
              id: compId,
              property_id: 'sold-99',
              property_address_full: '199 Main St, Dallas, TX 75201',
              property_address_zip: '75201',
              property_class: 'Residential',
              effective_year_built: 2010,
              building_condition: 'Good',
              computed_ppsf: 191.01,
            },
          ],
          error: null,
        });
      }
      return queryResult({ data: [], error: null });
    },
  };

  const rows = await loadComparableProperties(SUBJECT, { supabase, now: NOW });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'v_recent_sold_comps');
  assert.equal(rows[0].property_class, 'Residential');
  assert.equal(rows[0].effective_year_built, 2010);
  assert.equal(rows[0].computed_ppsf, 191.01);
  assert.ok(tables.includes('v_recent_sold_comps'));
  assert.ok(!tables.includes('recently_sold_properties'));
});

test('stale comp select columns fail loudly instead of becoming empty evidence', async () => {
  const supabase = {
    rpc: async () => ({
      data: [{ comp_id: '00000000-0000-4000-8000-000000000099' }],
      error: null,
    }),
    from() {
      return queryResult({
        data: null,
        error: {
          code: 'PGRST204',
          message: "Could not find the 'stale_column' column",
        },
      });
    },
  };

  await assert.rejects(
    loadComparableProperties(SUBJECT, { supabase, now: NOW }),
    (error) => {
      assert.equal(error.code, 'PGRST204');
      assert.match(error.message, /stale_column/);
      return true;
    },
  );
});

test('multifamily subject matches multifamily comp on raw RPC rows after normalization', () => {
  const subject = normalizePropertyFeatures(
    {
      property_id: 'mf-subject',
      property_type: 'Multifamily',
      normalized_asset_class: 'multifamily',
      units_count: 4,
      building_square_feet: 3200,
      latitude: 33.45,
      longitude: -112.07,
      property_address_zip: '85001',
      sale_price: 500_000,
      sale_date: '2024-06-01',
    },
    { now: NOW },
  );

  const rawRpcComp = {
    comp_id: 'mf-comp-1',
    address: '200 Oak St, Phoenix, AZ 85001',
    property_type: 'Duplex',
    normalized_asset_class: 'multifamily',
    units_count: 2,
    building_square_feet: 1800,
    sale_price: 280_000,
    sale_date: '2026-01-15',
    distance_miles: 1.2,
    latitude: 33.46,
    longitude: -112.08,
    property_address_zip: '85001',
  };

  const rawEligibility = evaluateCompEligibility(subject, rawRpcComp, NOW);
  const scored = scoreComparable(subject, rawRpcComp, { now: NOW });

  assert.ok(
    rawEligibility.reasons.includes('asset_type_mismatch'),
    'raw RPC rows lack normalized asset_type and must not be compared directly',
  );
  assert.equal(scored.eligible, true);
  assert.ok(!scored.reasons?.includes('asset_type_mismatch'));
  assert.equal(scored.comp.asset_family, 'multifamily');
});

test('multifamily lane matches across residential-labeled multi-unit comps', () => {
  const subject = normalizePropertyFeatures(
    { property_type: 'Multifamily', normalized_asset_class: 'multifamily', units_count: 8, building_square_feet: 6200 },
    { now: NOW },
  );
  const comp = normalizePropertyFeatures(
    {
      property_type: 'Residential',
      units_count: 4,
      building_square_feet: 3100,
      sale_price: 720_000,
      sale_date: '2026-03-10',
      latitude: 33.46,
      longitude: -112.08,
      property_address_zip: '85001',
      distance_miles: 1.4,
    },
    { now: NOW },
  );

  assert.equal(subject.asset_family, 'multifamily');
  assert.equal(comp.asset_family, 'multifamily');
  assert.equal(evaluateCompEligibility(subject, comp, NOW).eligible, true);
});

test('multi-unit properties without explicit MF label normalize to multifamily family', () => {
  const subject = normalizePropertyFeatures(
    { property_type: 'Residential', units_count: 4, building_square_feet: 2800 },
    { now: NOW },
  );
  const comp = normalizePropertyFeatures(
    { property_type: 'Residential', units_count: 3, building_square_feet: 2100, sale_price: 410_000, sale_date: '2026-02-01' },
    { now: NOW },
  );

  assert.equal(subject.asset_family, 'multifamily');
  assert.equal(comp.asset_family, 'multifamily');
  assert.equal(evaluateCompEligibility(subject, comp, NOW).eligible, true);
});

test('advanced comp scoring treats missing fields as confidence loss, not a mismatch penalty', () => {
  const subject = normalizePropertyFeatures(SUBJECT, { now: NOW });
  const sparse = scoreComparable(
    subject,
    {
      ...comp(1, 340_000),
      building_quality: null,
      interior_walls: null,
      floor_cover: null,
      roof_cover: null,
      heating_fuel_type: null,
      patio: null,
    },
    { now: NOW },
  );

  assert.equal(sparse.eligible, true);
  assert.ok(sparse.comp_score >= 70, 'known matching features should remain strongly scored');
  assert.ok(sparse.data_completeness < 100, 'missing features must lower completeness');
  assert.equal(
    sparse.feature_match_breakdown.quality_condition.features
      .find((feature) => feature.feature === 'quality')?.status,
    'missing',
  );
});

test('valuation rejects an obvious price outlier and does not use the highest comp as ARV', () => {
  const decision = calculateAcquisitionDecision({
    subject: SUBJECT,
    comps: [...GOOD_COMPS, comp(7, 900_000)],
    buyerPurchases: BUYER_PURCHASES,
    now: NOW,
  });

  assert.equal(decision.selected_comps.length, 6);
  assert.ok(
    decision.rejected_comps.some((entry) => entry.reasons?.includes('adjusted_price_outlier')),
    'outlier must be rejected with evidence',
  );
  assert.ok(decision.valuation.mid < 500_000);
  assert.ok(decision.valuation.low < decision.valuation.mid);
  assert.ok(decision.valuation.high > decision.valuation.mid);
  assert.ok(decision.evidence.selected_comps.length > 0);
  assert.ok(decision.evidence.valuation_calculation_summary.weighted_inputs.length > 0);
  assert.ok(decision.evidence.valuation_calculation_summary.weighted_value_total > 0);
  assert.ok(decision.evidence.valuation_calculation_summary.total_weight > 0);
  assert.equal(
    decision.evidence.selected_comps[0].comp_id,
    decision.evidence.selected_comps[0].id,
  );
  assert.equal(
    decision.evidence.selected_comps[0].adjusted_value,
    decision.evidence.selected_comps[0].adjusted_price,
  );
  assert.equal(
    decision.evidence.selected_comps[0].score,
    decision.evidence.selected_comps[0].comp_score,
  );
  assert.ok(decision.evidence.selected_comps[0].match_breakdown.core);
});

test('AUTO_HARD_OFFER hard gate is enforced when fewer than four comps exist', () => {
  const decision = calculateAcquisitionDecision({
    subject: SUBJECT,
    comps: GOOD_COMPS.slice(0, 3),
    buyerPurchases: BUYER_PURCHASES,
    now: NOW,
    targetAssignmentFee: 10_000,
  });

  assert.notEqual(decision.decision.tier, 'AUTO_HARD_OFFER');
  assert.equal(decision.decision.hard_gate_checks.comp_count_at_least_4, false);
  assert.ok(
    decision.decision.reasons.includes('hard_gate_failed:comp_count_at_least_4'),
  );
});

test('no-comp scoring is explicit, confidence-capped, and cannot auto hard offer', () => {
  const decision = calculateAcquisitionDecision({
    subject: SUBJECT,
    comps: [],
    buyerPurchases: BUYER_PURCHASES,
    now: NOW,
  });

  assert.notEqual(decision.decision.tier, 'AUTO_HARD_OFFER');
  assert.ok(decision.confidence <= 45);
  assert.equal(decision.evidence.comp_data_status.status, 'no_comps_found');
  assert.equal(decision.evidence.comp_data_status.no_comps_found, true);
  assert.match(decision.evidence.comp_data_status.message, /No comps found/);
  assert.equal(
    decision.evidence.valuation_calculation_summary.reason,
    'no_comps_found',
  );
  assert.equal(decision.evidence.confidence_breakdown.confidence_cap, 45);
  assert.equal(
    decision.evidence.decision_tier_reasoning.hard_gate_checks.comp_count_at_least_4,
    false,
  );
});

test('high-equity fatigued landlord leads with seller finance and wealth preservation', () => {
  const decision = calculateAcquisitionDecision({
    subject: ownerSituationSubject({
      property_flags_text: 'Tired Landlord; Absentee Owner; Long Term Owner',
      seller_tags_text: 'rental tenant issue landlord fatigue',
      owner_location: 'Absentee Owner',
      estimated_household_income: '$100,000-$119,999',
      estimated_net_asset_value: '$250,000-$499,999',
      total_loan_payment: 0,
      total_loan_balance: 0,
      equity_amount: 420_000,
      equity_percent: 100,
      estimated_value: 420_000,
      estimated_repair_cost: 45_000,
      ownership_years: 24,
    }),
    comps: [],
    buyerPurchases: [],
    now: NOW,
  });

  assert.equal(
    decision.owner_situation.recommended_offer_stack.primary_offer_to_lead_with,
    'SELLER_FINANCE',
  );
  assert.match(
    decision.owner_situation.recommended_conversation_angle,
    /LANDLORD_FATIGUE_AND_WEALTH_PRESERVATION/,
  );
  assert.ok(decision.owner_situation.landlord_fatigue_score >= 70);
  assert.ok(
    decision.owner_situation.owner_situation_scores.WEALTH_PRESERVATION >= 60,
  );
});

test('tax-delinquent vacant repair-heavy property has high forced-sale pressure', () => {
  const decision = calculateAcquisitionDecision({
    subject: ownerSituationSubject({
      property_flags_text: 'Vacant; Code Violation',
      tax_delinquent: true,
      tax_delinquent_year: 2022,
      past_due_amount: 18_000,
      estimated_household_income: 50_000,
      estimated_net_asset_value: 90_000,
      estimated_repair_cost: 95_000,
      estimated_value: 240_000,
      equity_amount: 150_000,
      equity_percent: 63,
      total_loan_balance: 90_000,
      total_loan_payment: 900,
    }),
    comps: [],
    buyerPurchases: [],
    now: NOW,
  });

  assert.ok(decision.owner_situation.forced_sale_pressure_score >= 65);
  assert.ok(decision.owner_situation.seller_financial_pressure_score >= 55);
  assert.ok(
    decision.evidence.forced_sale_foreclosure_risk_reasoning
      .forced_sale_pressure.factors.some(
        (factor) => factor.reason === 'vacant_and_repair_heavy',
      ),
  );
});

test('high-debt low-equity foreclosure profile leads with subject-to', () => {
  const decision = calculateAcquisitionDecision({
    subject: ownerSituationSubject({
      is_foreclosure: true,
      foreclosure_status: 'Active',
      foreclosure_stage: 'Notice of Sale',
      estimated_household_income: 60_000,
      estimated_net_asset_value: 25_000,
      estimated_value: 300_000,
      equity_amount: 15_000,
      equity_percent: 5,
      total_loan_balance: 285_000,
      total_loan_payment: 2_700,
      past_due_amount: 12_000,
      estimated_repair_cost: 10_000,
    }),
    comps: [],
    buyerPurchases: [],
    now: NOW,
  });

  assert.ok(decision.owner_situation.debt_pressure_score >= 70);
  assert.ok(decision.owner_situation.foreclosure_risk_score >= 70);
  assert.equal(
    decision.owner_situation.recommended_offer_stack.primary_offer_to_lead_with,
    'SUBJECT_TO',
  );
  assert.match(
    decision.owner_situation.recommended_conversation_angle,
    /DEBT_RELIEF_AND_ARREARS_CURE/,
  );
});

test('owner-occupied clean low-pressure profile stays low probability and nurture', () => {
  const decision = calculateAcquisitionDecision({
    subject: ownerSituationSubject(),
    comps: [],
    buyerPurchases: [],
    now: NOW,
  });

  assert.ok(decision.owner_situation.seller_financial_pressure_score < 30);
  assert.ok(decision.owner_situation.transaction_probability_90 < 25);
  assert.equal(
    decision.owner_situation.recommended_offer_stack.primary_offer_to_lead_with,
    'NURTURE',
  );
  assert.equal(
    decision.owner_situation.recommended_conversation_angle,
    'LOW_PRESSURE_NURTURE',
  );
});

test('missing seller financial data creates safe defaults and lower confidence', () => {
  const complete = calculateAcquisitionDecision({
    subject: ownerSituationSubject(),
    comps: [],
    buyerPurchases: [],
    now: NOW,
  });
  const missing = calculateAcquisitionDecision({
    subject: ownerSituationSubject({
      estimated_household_income: null,
      estimated_net_asset_value: null,
      total_loan_payment: null,
      tax_amt: null,
      sale_price: null,
      estimated_repair_cost: null,
    }),
    comps: [],
    buyerPurchases: [],
    now: NOW,
  });

  assert.ok(
    missing.owner_situation.data_confidence.score <
      complete.owner_situation.data_confidence.score,
  );
  assert.equal(
    missing.evidence.safeguards.missing_data_creates_pressure,
    false,
  );
  assert.ok(missing.owner_situation.seller_financial_pressure_score < 30);
  assert.equal(missing.evidence.ratios_used.housing_burden_ratio, null);
  assert.equal(missing.evidence.ratios_used.repair_burden_ratio, null);
});

test('missing optional prospect column degrades owner evidence without failing scoring', async () => {
  const { supabase, selectAttempts } = ownerContextSupabase({
    missingProspectColumn: 'buying_power',
  });
  const result = await scoreProperty('12345678', {
    supabase,
    now: NOW,
    loadComparableProperties: async () => GOOD_COMPS,
    loadBuyerPurchases: async () => BUYER_PURCHASES,
    persistAcquisitionScore: async (row) => ({ id: 'score-prospect-drift', ...row }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.owner_context_loading.loaded, true);
  assert.ok(
    result.evidence.owner_context_loading.missing_optional_owner_fields.includes(
      'prospects.buying_power',
    ),
  );
  assert.equal(
    result.evidence.owner_context_loading.sources.prospects.status,
    'loaded',
  );
  assert.equal(
    result.evidence.owner_context_loading.sources.prospects.attempts,
    2,
  );
  assert.ok(
    result.evidence.owner_context_loading.skipped_optional_sources.some(
      (entry) =>
        entry.source === 'acquisition_contacts' &&
        entry.reason === 'source_unavailable:PGRST205',
    ),
  );
  assert.equal(
    selectAttempts.filter((attempt) => attempt.table === 'prospects').length,
    2,
  );
});

test('missing optional phone column degrades owner evidence without failing scoring', async () => {
  const { supabase, selectAttempts } = ownerContextSupabase({
    missingPhoneColumn: 'phone_type',
  });
  const result = await scoreProperty('12345678', {
    supabase,
    now: NOW,
    loadComparableProperties: async () => GOOD_COMPS,
    loadBuyerPurchases: async () => BUYER_PURCHASES,
    persistAcquisitionScore: async (row) => ({ id: 'score-phone-drift', ...row }),
  });

  assert.equal(result.ok, true);
  assert.ok(
    result.evidence.owner_context_loading.missing_optional_owner_fields.includes(
      'phones.phone_type',
    ),
  );
  assert.equal(
    result.evidence.owner_context_loading.sources.phones.status,
    'loaded',
  );
  assert.equal(
    result.evidence.owner_context_loading.sources.phones.attempts,
    2,
  );
  assert.equal(result.evidence.safeguards.phone_type_used_for_pressure_or_decision, false);
  assert.equal(
    selectAttempts.filter((attempt) => attempt.table === 'phones').length,
    2,
  );
});

test('missing required subject column still fails loudly', async () => {
  const requiredError = {
    code: 'PGRST204',
    message: "Could not find the 'property_id' column of 'properties' in the schema cache",
  };
  const { supabase } = ownerContextSupabase({
    requiredSubjectError: requiredError,
  });

  await assert.rejects(
    loadSubjectProperty('12345678', { supabase }),
    (error) => {
      assert.equal(error, requiredError);
      return true;
    },
  );
});

test('score-property route returns JSON and logs the actual server-side failure', async () => {
  const entries = [];
  const routeError = Object.assign(
    new Error("Could not find the 'property_id' column of 'properties'"),
    { code: 'PGRST204' },
  );
  const response = await handleScorePropertyRequest(
    new Request('http://localhost/api/internal/acquisition/score-property', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-secret': 'test',
      },
      body: JSON.stringify({ property_id: '12345678' }),
    }),
    {
      scoreProperty: async () => {
        throw routeError;
      },
      logger: {
        error(event, meta) {
          entries.push({ event, meta });
        },
      },
    },
  );

  assert.equal(response.status, 500);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'score_property_failed',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'acquisition.score_property.failed');
  assert.equal(entries[0].meta.failure_code, 'score_property_failed');
  assert.equal(entries[0].meta.property_id, '12345678');
  assert.equal(entries[0].meta.error_code, 'PGRST204');
  assert.match(entries[0].meta.error_message, /property_id/);
});

test('scoreProperty writes one explainable score row and no queue/message records', async () => {
  const writes = [];
  const result = await scoreProperty('12345678', {
    now: NOW,
    targetAssignmentFee: 12_000,
    loadSubjectProperty: async () => SUBJECT,
    loadComparableProperties: async () => GOOD_COMPS,
    loadBuyerPurchases: async () => BUYER_PURCHASES,
    persistAcquisitionScore: async (row) => {
      writes.push({ table: 'property_acquisition_scores', row });
      return { id: 'score-1', ...row };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, 'property_acquisition_scores');
  assert.equal(result.score.property_id, '12345678');
  assert.equal(result.score.comp_count, 6);
  assert.equal(result.evidence.selected_comps.length, 6);
  assert.equal(
    result.evidence.valuation_calculation_summary.method,
    'weighted_adjusted_comp_value',
  );
  assert.equal(
    result.evidence.valuation_calculation_summary.selected_comp_count,
    6,
  );
  assert.equal(result.evidence.safeguards.sends_messages, false);
  assert.equal(result.evidence.safeguards.writes_queue_tables, false);
  assert.deepEqual(result.evidence.safeguards.writes_only, ['property_acquisition_scores']);
  assert.equal(typeof result.score.transaction_probability_90, 'number');
  assert.equal(typeof result.score.owner_situation_primary, 'string');
  assert.equal(typeof result.score.owner_situation_scores, 'object');
  assert.equal(typeof result.score.recommended_offer_stack, 'object');
});

test('scoreBatch scores 10 properties and persists 10 score rows', async () => {
  const writes = [];
  const properties = Array.from({ length: 10 }, (_, index) => ({
    property_id: String(80000000 + index),
  }));
  const result = await scoreBatch(
    { limit: 10, only_missing: true },
    {
      now: NOW,
      concurrency: 3,
      loadBatchProperties: async () => properties,
      loadSubjectProperty: async (propertyId) => ({
        ...SUBJECT,
        property_id: propertyId,
      }),
      loadComparableProperties: async () => GOOD_COMPS,
      loadBuyerPurchases: async () => BUYER_PURCHASES,
      persistAcquisitionScore: async (row) => {
        writes.push(row);
        return { id: `score-${row.property_id}`, ...row };
      },
    },
  );

  assert.equal(result.processed_count, 10);
  assert.equal(result.success_count, 10);
  assert.equal(result.failed_count, 0);
  assert.equal(writes.length, 10);
  assert.equal(result.sample_rows.length, 10);
});

test('engine source never references messaging, send, or queue tables', () => {
  const sourcePath = path.join(
    process.cwd(),
    'src/lib/acquisition/acquisitionDecisionEngine.js',
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(
    source,
    /\.from\(\s*['"](?:send_queue|message_events|email_send_queue|follow_up_queue)['"]\s*\)/,
  );
});

test('Phase 2 migration does not alter queue, send, or message tables', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20260613224827_acquisition_owner_situation_phase2.sql',
  );
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS seller_financial_pressure_score/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS recommended_offer_stack/i);
  assert.doesNotMatch(
    migration,
    /ALTER\s+TABLE\s+(?:public\.)?(?:send_queue|message_events|email_send_queue|follow_up_queue)/i,
  );
});
