// Adversarial seller-scenario suite for seller_engine_deterministic_v1.
// Each scenario is a full staged bundle; checks are declarative so the test
// suite and the CSV report evaluate the SAME logic. Run directly to write
// SELLER_V1_SCENARIO_RESULTS.csv at the package root.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1 } from '../scores/deterministicV1.mjs';

export const AS_OF = '2026-07-01T00:00:00Z';
const D = 86_400_000;
const daysAgo = (n) => new Date(Date.parse(AS_OF) - n * D).toISOString().slice(0, 10);

const flags = (...codes) => JSON.stringify(codes.map((code) => ({ code })));

function base(over = {}) {
  const b = {
    property: { id: 'p', year_built: 1975, condition_raw: 'Average', condition_state: 'known', raw_keep: {} },
    valuation: { estimated_value: 200000, estimated_equity: 80000, equity_percent: 40, tax_delinquent: false },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 120000, recording_date: '2016-05-01', loan_type_raw: 'New Conventional', blanket_loan_flag: false, original_loan_amount: 130000 }],
    checksums: { num_of_mortgages: 1 },
    liens: [], foreclosure: [],
    transactions: [{ id: 't1', event_role: 'current', sale_date: '2016-04-15', sale_price: 150000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }],
    links: [{ id: 'k1', link_tier: 'high', matching_type: 'name_address', matching_flags: ['Likely Owner'], likely_owner_scalar: true, renter_flag: false, profile: {} }],
    phones: [{ phone_e164: '+15555550100', line_type: 'wireless', rank: 1, do_not_call: false, never_call: false }],
    emails: [], batchScalarLiveness: 0.2,
  };
  return deepMerge(b, over);
}
function deepMerge(t, o) {
  for (const [k, v] of Object.entries(o)) {
    t[k] = v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])
      ? deepMerge({ ...t[k] }, v) : v;
  }
  return t;
}
const snapshot = (over = {}) => ({
  id: 'mfs-test', as_of: AS_OF, valuation_low: 170000, valuation_high: 210000,
  valuation_confidence: 0.6, sale_velocity: 2.5, inventory_absorption: null, buyer_velocity: 1.0, ...over,
});

export const SCENARIOS = [
  { id: 'S01', name: 'senior owner, high equity, tax delinquent', bundle: base({
    valuation: { estimated_equity: 150000, equity_percent: 75, tax_delinquent: true, tax_delinquent_year: 2023 },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 50000, recording_date: '2010-02-01', loan_type_raw: 'Reverse Mortgage', blanket_loan_flag: false, original_loan_amount: 60000 }],
    transactions: [{ id: 't1', event_role: 'current', sale_date: '1996-04-15', sale_price: 60000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }],
  }) },
  { id: 'S02', name: 'younger owner, low equity, tax delinquent', bundle: base({
    valuation: { estimated_equity: 16000, equity_percent: 8, tax_delinquent: true, tax_delinquent_year: 2023 },
    transactions: [{ id: 't1', event_role: 'current', sale_date: '2022-04-15', sale_price: 190000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }],
  }) },
  { id: 'S03', name: 'high-income owner with a small lien', bundle: base({
    valuation: { estimated_value: 300000, estimated_equity: 200000, equity_percent: 67 },
    liens: [{ id: 'a', base_type: 'lien', lifecycle_class: 'creation', filing_date: daysAgo(200), amount_due: 3000, doc_type_raw: 'LEN' }],
    links: [{ id: 'k1', link_tier: 'high', matching_type: 'name_address', matching_flags: ['Likely Owner'], likely_owner_scalar: true, renter_flag: false,
      profile: { est_household_income_code: '150', agg_credit_tier: 'Prime' } }],
  }) },
  { id: 'S04', name: 'low-income owner with a large lien relative to equity', bundle: base({
    valuation: { estimated_value: 200000, estimated_equity: 60000, equity_percent: 30 },
    liens: [{ id: 'a', base_type: 'judgment', lifecycle_class: 'judgment', filing_date: daysAgo(300), amount_due: 45000, doc_type_raw: 'JDGLEN' }],
    links: [{ id: 'k1', link_tier: 'high', matching_type: 'name_address', matching_flags: ['Likely Owner'], likely_owner_scalar: true, renter_flag: false,
      profile: { est_household_income_code: '20', agg_credit_tier: 'Sub Prime', card_balance: 'High' } }],
  }) },
  { id: 'S05', name: 'cash buyer, very low basis, long tenure', bundle: base({
    valuation: { estimated_value: 250000, estimated_equity: 237500, equity_percent: 95 },
    loans: [],
    checksums: { num_of_mortgages: 0 },
    transactions: [{ id: 't1', event_role: 'current', sale_date: '2008-04-15', sale_price: 50000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }],
  }) },
  { id: 'S06', name: 'cash buyer, recent high-price acquisition', bundle: base({
    valuation: { estimated_value: 250000, estimated_equity: 237500, equity_percent: 95 },
    loans: [],
    checksums: { num_of_mortgages: 0 },
    transactions: [{ id: 't1', event_role: 'current', sale_date: daysAgo(200), sale_price: 240000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }],
  }) },
  { id: 'S07', name: 'released judgment lien', bundle: base({
    liens: [
      { id: 'a', base_type: 'judgment', lifecycle_class: 'judgment', filing_date: '2022-03-01', amount_due: 20000, doc_type_raw: 'JDGLEN' },
      { id: 'b', base_type: 'judgment', lifecycle_class: 'release', filing_date: daysAgo(250), doc_type_raw: 'JDGLENREL' },
    ],
  }) },
  { id: 'S08', name: 'multiple active liens', bundle: base({
    liens: [
      { id: 'a', base_type: 'judgment', lifecycle_class: 'judgment', filing_date: daysAgo(400), amount_due: 20000, doc_type_raw: 'JDGLEN' },
      { id: 'b', base_type: 'federal_tax_lien', lifecycle_class: 'creation', filing_date: daysAgo(300), amount_due: 15000, doc_type_raw: 'FLN' },
      { id: 'c', base_type: 'lien', lifecycle_class: 'creation', filing_date: daysAgo(500), amount_due: 8000, doc_type_raw: 'LEN' },
    ],
  }) },
  { id: 'S09', name: 'foreclosure with no equity', bundle: base({
    valuation: { estimated_equity: 4000, equity_percent: 2 },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 190000, recording_date: '2021-05-01', loan_type_raw: 'New Conventional', blanket_loan_flag: false, original_loan_amount: 195000 }],
    foreclosure: [{ id: 'f1', stage: 'nos_nts', recording_date: daysAgo(45), auction_date: '2026-07-31', unpaid_balance: 195000 }],
  }) },
  { id: 'S10', name: 'foreclosure with substantial equity', bundle: base({
    valuation: { estimated_equity: 110000, equity_percent: 55 },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 90000, recording_date: '2015-05-01', loan_type_raw: 'New Conventional', blanket_loan_flag: false, original_loan_amount: 100000 }],
    foreclosure: [{ id: 'f1', stage: 'nos_nts', recording_date: daysAgo(45), auction_date: '2026-07-31', unpaid_balance: 95000 }],
  }) },
  { id: 'S11', name: 'absentee landlord, one property', bundle: base({
    property: { situs_state: 'TN', raw_keep: { property_flags: flags('absentee_owner'), owner_status: 'Absentee Owner', owner_address_state: 'GA', owner_hash: 'oh11' } },
    links: [{ id: 'k1', link_tier: 'high', matching_type: 'name_address', matching_flags: ['Likely Owner'], likely_owner_scalar: true, renter_flag: false, profile: { portfolio_total_properties_owned: 1 } }],
  }) },
  { id: 'S12', name: 'absentee landlord with a distressed portfolio', bundle: (() => {
    const b = base({
      property: { situs_state: 'TN', units_count: 2, raw_keep: { property_flags: flags('absentee_owner', 'tired_landlord'), owner_status: 'Absentee Owner', owner_address_state: 'GA', owner_hash: 'oh12' } },
      valuation: { tax_delinquent: true, tax_delinquent_year: 2024 },
      links: [{ id: 'k1', link_tier: 'high', matching_type: 'name_address', matching_flags: ['Likely Owner'], likely_owner_scalar: true, renter_flag: false,
        profile: { portfolio_total_properties_owned: 8, portfolio_total_equity: 500000, portfolio_total_mortgage_balance: 1500000 } }],
    });
    b.ownerIndex = new Map([['oh12', [
      { property_id: 'x1', last_sale_ms: Date.parse(AS_OF) - 200 * D },
      { property_id: 'x2', last_sale_ms: Date.parse(AS_OF) - 400 * D },
      { property_id: 'x3', last_sale_ms: Date.parse(AS_OF) - 3000 * D },
    ]]]);
    return b;
  })() },
  { id: 'S13', name: 'vacant inherited property', bundle: base({
    property: { raw_keep: { property_flags: flags('vacant_home') } },
    valuation: { estimated_equity: 160000, equity_percent: 80 },
    loans: [], checksums: { num_of_mortgages: 0 },
    liens: [{ id: 'a', base_type: 'affidavit_of_death', lifecycle_class: 'probate_life_event', filing_date: daysAgo(300), date_of_death: daysAgo(330), doc_type_raw: 'AFD' }],
    transactions: [{ id: 't1', event_role: 'current', sale_date: '2001-04-15', sale_price: 70000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }],
  }) },
  { id: 'S14', name: 'probate with unclear authority', bundle: base({
    liens: [
      { id: 'a', base_type: 'probate', lifecycle_class: 'probate_life_event', filing_date: daysAgo(150), doc_type_raw: 'PRO' },
      { id: 'b', base_type: 'affidavit_of_death', lifecycle_class: 'probate_life_event', filing_date: daysAgo(180), date_of_death: daysAgo(200), doc_type_raw: 'AFD' },
    ],
    links: [{ id: 'k1', link_tier: 'low', matching_type: 'surname_only', matching_flags: [], renter_flag: false, profile: {} }],
  }) },
  { id: 'S15', name: 'severe repairs in a liquid market', compSnapshot: snapshot({ sale_velocity: 6, valuation_low: 180000, buyer_velocity: 3 }), bundle: base({
    property: { condition_raw: 'Unsound' },
    valuation: { estimated_equity: 150000, equity_percent: 75 },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 40000, recording_date: '2012-05-01', loan_type_raw: 'New Conventional', blanket_loan_flag: false, original_loan_amount: 60000 }],
  }) },
  { id: 'S16', name: 'severe repairs in an illiquid market', compSnapshot: snapshot({ sale_velocity: 0.3, valuation_low: 88000, buyer_velocity: 0.1 }), bundle: base({
    property: { condition_raw: 'Unsound' },
    valuation: { estimated_equity: 150000, equity_percent: 75 },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 80000, recording_date: '2012-05-01', loan_type_raw: 'New Conventional', blanket_loan_flag: false, original_loan_amount: 100000 }],
  }) },
  { id: 'S17', name: 'strong distress but no valid phone', bundle: base({
    valuation: { estimated_equity: 90000, equity_percent: 45, tax_delinquent: true, tax_delinquent_year: 2022 },
    foreclosure: [{ id: 'f1', stage: 'nod', recording_date: daysAgo(60) }],
    phones: [], emails: [],
  }) },
  { id: 'S18', name: 'moderate distress, strong buyer demand, large spread', compSnapshot: snapshot({ sale_velocity: 5, valuation_low: 190000, buyer_velocity: 4 }), bundle: base({
    property: { condition_raw: 'Fair' },
    valuation: { tax_delinquent: true, tax_delinquent_year: 2025 },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 70000, recording_date: '2014-05-01', loan_type_raw: 'New Conventional', blanket_loan_flag: false, original_loan_amount: 90000 }],
  }) },
  { id: 'S19', name: 'likely renter collision', bundle: base({
    links: [{ id: 'k1', link_tier: 'high', matching_type: 'name_address', matching_flags: ['Likely Owner'], renter_flag: true, profile: {} }],
  }) },
  { id: 'S20', name: 'corporate owner with dissolved entity status', bundle: base({
    valuation: { tax_delinquent: true, tax_delinquent_year: 2024 },
    classifications: [{ classification: 'corporate', evidence_source: 'owner_status' }],
    companies: [{ existence_norm: 'inactive' }], companyLinks: [{ id: 'cl1' }],
  }) },
  { id: 'S21', name: 'listed property with repeated price reductions (expired)', bundle: base({
    property: { raw_keep: { property_flags: flags('expired_listing') } },
  }) },
  { id: 'S22', name: 'high propensity but likely retail expectations', bundle: base({
    property: { condition_raw: 'Very Good' },
    valuation: { estimated_value: 220000, estimated_equity: 66000, equity_percent: 30 },
    transactions: [{ id: 't1', event_role: 'current', sale_date: '2006-04-15', sale_price: 200000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }],
  }) },
];

// A must strictly outrank B on execution priority
export const PAIR_CHECKS = [
  ['S01', 'S02', 'equity-backed tax distress must outrank thin-equity tax distress (payable + executable)'],
  ['S04', 'S03', 'large lien vs equity + strain must outrank cosmetic small lien on strong finances'],
  ['S05', 'S06', 'seasoned low-basis cash owner must outrank fresh full-price cash buyer'],
  ['S08', 'S07', 'active lien stack must outrank a released (netted) lien'],
  ['S10', 'S09', 'equity-backed foreclosure must outrank no-equity foreclosure (IX-17)'],
  ['S12', 'S11', 'distressed portfolio absentee must outrank single-property absentee'],
  ['S15', 'S16', 'same repairs: liquid market with real spread must outrank illiquid thin-spread market'],
  ['S17', 'S21', 'unreachable strong distress must outrank reachable mild propensity (IX-19: route, not sink)'],
  ['S18', 'S21', 'market-backed moderate distress must outrank flat mild propensity'],
];

export const PROP_CHECKS = [
  ['S09', (r) => r.route === 'short_sale_or_skip', 'no-equity late-stage foreclosure routes to short-sale/skip'],
  ['S13', (r) => r.route === 'probate_counsel_first' && r.horizon_days >= 180, 'unsettled estate routes to probate counsel with long horizon'],
  ['S14', (r) => r.route === 'owner_resolution_required' && r.families.identity_confidence.score <= 0.5, 'V1.3: unclear probate authority + unresolved owner routes to owner resolution (probate counsel only after a clean owner is resolved)'],
  ['S17', (r) => r.route === 'alternate_channel_escalation', 'distress+equity+unreachable escalates channel (IX-19)'],
  ['S19', (r) => r.route === 'manual_review_renter_owner_conflict'
    && r.families.execution_priority.person_contact_suppressed.some((s) => s.suppressed),
  'V1.3: renter/owner collision is person-suppressed + routed to manual review (not a property block)'],
  ['S20', (r) => r.families.authority_confidence.score <= 0.5 && r.execution_priority > 0, 'defunct entity damps authority but leaves a cure path'],
  ['S22', (r) => (r.families.discount_potential.score ?? 0) <= 4, 'pristine low-appreciation property has damped discount capacity'],
  ['S07', (r) => r.families.legal_title_pressure.score === 0
    && r.families.seller_propensity.components.some((c) => c.component === 'recent_title_cleanup'),
  'released lien: zero legal pressure, positive title-cleanup propensity (IX-03 sign flip)'],
  ['S06', (r) => r.families.seller_propensity.components.some((c) => /suppressor/.test(c.component)), 'recent purchase suppressor active'],
  ['S12', (r) => r.families.portfolio_liquidation.components.some((c) => c.component === 'liquidation_motion'), 'portfolio motion is the amplifier (IX-13 scope-degraded)'],
];

export function runScenarios() {
  const rows = [];
  for (const sc of SCENARIOS) {
    const { features } = computeFeatures(sc.bundle, AS_OF, { compSnapshot: sc.compSnapshot ?? null });
    const scored = scoreDeterministicV1(features);
    rows.push({ id: sc.id, name: sc.name, features, ...scored });
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const checks = [];
  for (const [a, b, why] of PAIR_CHECKS) {
    checks.push({ kind: 'pair', a, b, why, pass: byId.get(a).execution_priority > byId.get(b).execution_priority });
  }
  for (const [id, fn, why] of PROP_CHECKS) {
    checks.push({ kind: 'prop', a: id, b: '', why, pass: Boolean(fn(byId.get(id))) });
  }
  return { rows, checks, byId };
}

const csvq = (s) => `"${String(s).replaceAll('"', '""')}"`;
export function writeCsv() {
  const { rows, checks } = runScenarios();
  const famCols = ['seller_propensity', 'financial_pressure', 'legal_title_pressure', 'foreclosure_urgency',
    'property_distress', 'landlord_fatigue', 'portfolio_liquidation', 'discount_potential',
    'identity_confidence', 'authority_confidence', 'dealability'];
  const header = ['scenario', 'name', 'execution_priority', 'route', 'horizon_days',
    ...famCols, 'activated_features', 'suppressed_or_gated', 'interactions',
    'positive_explanation', 'negative_explanation', 'ranking_checks'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const activated = r.features.filter((f) => f.value_state === 'known' && f.explanation_fragment).map((f) => f.feature_id).join(' ');
    const gated = r.explanations.filter((e) => e.direction === 'negative' || (e.direction === 'gate' && typeof e.contribution === 'number' && e.contribution < 1))
      .map((e) => e.component).join(' | ');
    const interactions = r.explanations.filter((e) => /IX-|suppressor|damper|strain|short_sale|market|recency|_x0|_x1/.test(e.component))
      .map((e) => e.component).join(' | ');
    const pos = r.explanations.filter((e) => e.direction === 'positive' && typeof e.contribution === 'number')
      .sort((x, y) => y.contribution - x.contribution).slice(0, 4)
      .map((e) => `${e.component}=+${e.contribution}`).join(' | ');
    const neg = r.explanations.filter((e) => e.direction === 'negative' || e.direction === 'blocked').slice(0, 4)
      .map((e) => e.component + (typeof e.contribution === 'number' ? `=${e.contribution}` : '')).join(' | ');
    const myChecks = checks.filter((c) => c.a === r.id || c.b === r.id)
      .map((c) => `${c.pass ? 'PASS' : 'FAIL'}: ${c.why}`).join(' | ');
    lines.push([r.id, csvq(r.name), r.execution_priority, r.route, r.horizon_days,
      ...famCols.map((f2) => r.families[f2]?.score ?? ''),
      csvq(activated), csvq(gated), csvq(interactions), csvq(pos), csvq(neg), csvq(myChecks)].join(','));
  }
  const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'SELLER_V1_SCENARIO_RESULTS.csv');
  writeFileSync(outPath, `${lines.join('\n')}\n`);
  return { outPath, failed: checks.filter((c) => !c.pass) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { outPath, failed } = writeCsv();
  console.log(`wrote ${outPath}`);
  if (failed.length) {
    console.error('FAILED CHECKS:');
    for (const f of failed) console.error(` - [${f.a}${f.b ? `>${f.b}` : ''}] ${f.why}`);
    process.exit(1);
  }
  console.log('all ranking checks passed');
}
