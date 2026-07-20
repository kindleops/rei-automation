// Phase 3.5 feature completion: every feature implementable from staged data
// without inventing values. Same 9-field result contract as engine.mjs.
// Cohort-relative aspects that require comp snapshots are explicitly degraded
// or blocked — never silently borrowed from national assumptions.
import { toMs } from '../lib/timeSafety.mjs';
import { resolveOwner, nameSignals, ENTITY_NAME_RE } from '../scores/ownerResolution.mjs';

export const EXT_FORMULA_VERSION = 'fe-ext-2026.07.17-p35';
const DAY = 86_400_000;

function res(id, value, state, conf, evidence, asOf, missing = [], explanation = '') {
  return { feature_id: id, value, value_state: state, confidence: conf, source_evidence: evidence,
    as_of: asOf, formula_version: EXT_FORMULA_VERSION, missing_dependencies: missing,
    explanation_fragment: explanation };
}

const flagSet = (raw) => new Set((String(raw ?? '').match(/"code"\s*:\s*"([a-z_0-9]+)"/g) ?? [])
  .map((m) => m.match(/"([a-z_0-9]+)"$/)?.[1] ?? m.split('"')[3]));

export function computeExtendedFeatures(bundle, asOf, { compSnapshot = null, ownerIndex = null } = {}) {
  const out = [];
  const { property: p = {}, valuation: v = {}, loans = [], liens = [], foreclosure = [],
    transactions = [], links = [], phones = [], emails = [], checksums = null,
    listing = [] } = bundle;
  const raw = p.raw_keep ?? {};
  const flags = flagSet(raw.property_flags);
  const asOfMs = toMs(asOf);
  const value = v.estimated_value ?? null;
  const dated = (d) => toMs(d) !== null;

  // ---------- seller_propensity ----------
  // F-002 life_event_evidence
  const lifeDocs = liens.filter((l) => l.lifecycle_class === 'probate_life_event' || l.date_of_death || l.date_of_divorce);
  const estateDeed = transactions.find((t) => t.document_type_group === 'death_or_estate_transfer');
  const lifeEv = [...lifeDocs.map((l) => ({ kind: 'lien_doc', id: l.id, type: l.doc_type_raw, date: l.filing_date ?? l.recording_date })),
    ...(estateDeed ? [{ kind: 'transaction', id: estateDeed.id, group: 'death_or_estate_transfer' }] : [])];
  const newestLife = lifeDocs.map((l) => toMs(l.date_of_death ?? l.filing_date ?? l.recording_date)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  out.push(lifeEv.length
    ? res('F-002', { events: lifeEv.length, newest_days_ago: newestLife ? Math.round((asOfMs - newestLife) / DAY) : null },
        'known', 0.8, lifeEv.slice(0, 4), asOf, [],
        `${lifeEv.length} life-event document(s) (death/probate/heirship/divorce)${newestLife ? `, newest ${Math.round((asOfMs - newestLife) / DAY)}d ago` : ''}.`)
    : res('F-002', false, 'known', 0.5, [], asOf, [], 'No life-event evidence observed (absence is weak).'));

  // F-003 failed_listing_history + active-listing routing state. When a
  // versioned listing snapshot exists (observed at-or-before as-of) it is the
  // authority (IX-10); the vendor flag corroborates. ~1-2% coverage: absent
  // MLS evidence leaves the flag-only path (weak), never a default.
  const lst = listing
    .filter((s) => toMs(s.observed_at) === null || toMs(s.observed_at) <= asOfMs)
    .sort((a, b) => (String(b.observed_at ?? '') < String(a.observed_at ?? '') ? -1 : 1))[0] ?? null;
  if (lst) {
    const failed = flags.has('expired_listing') || /expired|withdrawn|cancel/i.test(lst.status ?? '');
    const active = lst.is_active === true || /^active/i.test(lst.status ?? '');
    out.push(res('F-003', {
      failed, active,
      price_cut_pct: lst.price_cut_pct, days_on_market: lst.days_on_market,
      relisted: lst.relisting_observed === true,
      status: lst.status,
    }, 'known', 0.8,
    [{ kind: 'listing_snapshot', id: lst.id, observed_at: lst.observed_at, status: lst.status }], asOf, [],
    active ? `ACTIVE listing (${lst.status ?? 'active'}${lst.days_on_market != null ? `, ${lst.days_on_market} DOM` : ''}${lst.price_cut_pct ? `, ${(lst.price_cut_pct * 100).toFixed(0)}% cut from peak list` : ''}) — agent-flow routing, not owner outreach.`
      : failed ? `Failed retail attempt (${lst.status ?? 'expired flag'}${lst.price_cut_pct ? ` after ${(lst.price_cut_pct * 100).toFixed(0)}% price reduction` : ''}${lst.relisted ? ', relisting behavior observed' : ''}).`
        : `Listing history observed (${lst.status ?? 'unknown status'}).`));
  } else {
    out.push(res('F-003', flags.has('expired_listing'), 'known', flags.has('expired_listing') ? 0.75 : 0.4,
      flags.has('expired_listing') ? [{ kind: 'flag', code: 'expired_listing' }] : [], asOf,
      ['listing snapshots (MLS coverage ~1-2%)'],
      flags.has('expired_listing') ? 'Expired listing flag: failed retail attempt.' : ''));
  }

  // F-004 vendor_likely_to_move (corroboration-only)
  out.push(res('F-004', flags.has('likely_to_move'), 'known', 0.4,
    [], asOf, [], flags.has('likely_to_move') ? 'Vendor likely-to-move flag (corroboration only, refresh cadence unknown).' : ''));

  // F-010 prior_modification_or_refi_churn
  const mods = loans.filter((l) => /modification/i.test(l.loan_type_raw ?? ''));
  const refiCount = loans.filter((l) => l.slot_class === 'previous' || /refi/i.test(l.loan_type_raw ?? '')).length;
  out.push(res('F-010', { modifications: mods.length, prior_loans: refiCount },
    loans.length ? 'known' : 'unknown', mods.length ? 0.8 : 0.5,
    mods.map((l) => ({ kind: 'loan', id: l.id })), asOf, loans.length ? [] : ['property_loans'],
    mods.length ? `${mods.length} mortgage modification(s) recorded — prior distress evidence.` : ''));

  // F-133 exists in core. F-134 cash_purchase_indicator
  const current = transactions.find((t) => t.event_role === 'current' && dated(t.sale_date));
  if (current) {
    const saleMs = toMs(current.sale_date);
    const acqLoan = loans.some((l) => dated(l.recording_date) && Math.abs(toMs(l.recording_date) - saleMs) < 90 * DAY);
    out.push(res('F-134', !acqLoan, 'known', acqLoan ? 0.8 : 0.55, [{ kind: 'transaction', id: current.id }], asOf, [],
      acqLoan ? 'Purchase-money loan recorded near acquisition.' : 'No loan near acquisition (cash purchase indicator; absence-of-evidence caveat).'));
  } else out.push(res('F-134', null, 'unknown', 0, [], asOf, ['transactions.current'], ''));

  // ---------- financial pressure / person tiers (OD-11 group 1) ----------
  const profile = links.map((l) => l.profile).find((pr) => pr) ?? null;
  const tier = (id, name, val2, rank, note = '', conf = 0.6) => out.push(val2 === null || val2 === undefined || val2 === ''
    ? res(id, null, 'unknown', 0, [], asOf, [`prospects.${name}`], '')
    : res(id, { raw: val2, rank }, 'known', conf, [{ kind: 'profile', field: name }], asOf, [],
        `${name}: ${val2}${note}`));
  const incomeCode = profile?.est_household_income_code ?? null;
  tier('F-120', 'income_tier', incomeCode && incomeCode !== '0' ? incomeCode : null,
    incomeCode ? Number(incomeCode) : null, ' (band code; $0 code treated unknown per OD-7)');
  tier('F-121', 'net_asset_value', profile?.net_asset_value ?? null, null);
  const bp = profile?.buying_power ?? null;
  out.push(bp
    ? res('F-122', { raw: bp, version_family: /Buyers/.test(bp) ? 'tier_labels' : 'risk_labels' }, 'known', 0.35,
        [{ kind: 'profile', field: 'buying_power' }], asOf, ['OD-5 vendor answer (two label families)'],
        `buying_power "${bp}" — version-partitioned, low confidence until OD-5 resolves.`)
    : res('F-122', null, 'unknown', 0, [], asOf, ['prospects.buying_power'], ''));
  tier('F-123', 'agg_credit_tier', profile?.agg_credit_tier ?? null,
    { 'Super Prime': 1, Prime: 2, 'Near Prime': 3, 'Sub Prime': 4 }[profile?.agg_credit_tier] ?? null);
  tier('F-124', 'investments', profile?.investments ?? null, null);
  tier('F-125', 'business_owner', profile?.business_owner ?? null, null);
  tier('F-126', 'length_of_residence', profile?.length_of_residence ?? null, profile?.length_of_residence ?? null,
    ' years (1 may mean ≤1; cap 52)');
  // F-012 person_financial_strain composite (corroboration-only per IX-18)
  const strainInputs = [profile?.agg_credit_tier === 'Sub Prime', profile?.card_balance === 'High',
    incomeCode !== null && incomeCode !== '0' && Number(incomeCode) <= 25].filter(Boolean).length;
  out.push(profile
    ? res('F-012', strainInputs, 'known', 0.5, [{ kind: 'profile' }], asOf, [],
        strainInputs ? `${strainInputs} vendor strain indicator(s) (corroboration-only until holdout-validated).` : '')
    : res('F-012', null, 'unknown', 0, [], asOf, ['prospect profile'], ''));

  // ---------- legal & title ----------
  // F-014 litigation_pendency (owner-side gated where parties known).
  // IX-02 router: when a foreclosure episode exists, lis-pendens documents are
  // stage evidence and must not re-count as litigation pressure.
  const fcActive = foreclosure.some((f) => f.stage && f.stage !== 'none');
  const lit = liens.filter((l) => ['litigation', 'judgment'].includes(l.lifecycle_class)
    && !(fcActive && l.base_type === 'lis_pendens'));
  out.push(res('F-014', lit.length, liens.length ? 'known' : 'unknown', lit.length ? 0.75 : 0.5,
    lit.slice(0, 3).map((l) => ({ kind: 'lien', id: l.id, class: l.lifecycle_class })), asOf,
    liens.length ? [] : ['property_liens'],
    lit.length ? `${lit.length} litigation/judgment document(s).` : ''));
  // F-015 title_complexity
  const clutter = liens.filter((l) => ['neutral', 'ucc_context', 'ambiguous'].includes(l.lifecycle_class)).length
    + transactions.filter((t) => ['leasehold_not_ownership', 'seller_financed_or_contract'].includes(t.document_type_group)).length;
  out.push(res('F-015', Math.min(clutter, 9), 'known', 0.6, [], asOf, [],
    clutter ? `${clutter} title-clutter document(s) (easements/leases/contracts/UCC/ambiguous).` : ''));
  // F-021 redemption_window (RED/foreclosure_related docs)
  const red = liens.filter((l) => l.lifecycle_class === 'foreclosure_related');
  const newestRed = red.map((l) => toMs(l.filing_date ?? l.recording_date)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  out.push(res('F-021', red.length ? { docs: red.length, newest_days_ago: newestRed ? Math.round((asOfMs - newestRed) / DAY) : null } : false,
    'known', red.length ? 0.7 : 0.5, red.slice(0, 2).map((l) => ({ kind: 'lien', id: l.id, type: l.doc_type_raw })), asOf,
    red.length ? ['jurisdiction_process (statutory window unpopulated — confidence degraded, timeline NOT invented)'] : [],
    red.length ? `${red.length} redemption/tax-sale-stage document(s); statutory window unknown.` : ''));

  // F-016 hoa_pressure
  const hoaDocs = liens.filter((l) => /hoa/i.test(l.doc_type_raw ?? '') || l.base_type === 'hoa_lien' || l.lien_type_raw === 'hoa_lien');
  out.push(res('F-016', hoaDocs.length ? { docs: hoaDocs.length, amount: hoaDocs.map((l) => l.amount_due).find((x) => x != null) ?? null } : false,
    'known', hoaDocs.length ? 0.7 : 0.5, hoaDocs.slice(0, 2).map((l) => ({ kind: 'lien', id: l.id })), asOf,
    ['HOA fee value/frequency (4% coverage — fee-burden component degraded)'],
    hoaDocs.length ? `${hoaDocs.length} HOA lien document(s).` : ''));
  // F-017 support_or_government_lien
  const gov = liens.filter((l) => ['federal_tax_lien', 'state_tax_lien', 'support', 'levy'].includes(l.base_type ?? '')
    || /doj/.test(l.action_modifier ?? ''));
  out.push(res('F-017', gov.length, liens.length ? 'known' : 'unknown', gov.length ? 0.8 : 0.5,
    gov.slice(0, 2).map((l) => ({ kind: 'lien', id: l.id, base: l.base_type })), asOf,
    liens.length ? [] : ['property_liens'],
    gov.length ? `${gov.length} government/support lien(s) — high-rank creditors.` : ''));

  // ---------- foreclosure ----------
  // F-020 default_depth
  const fcAmt = foreclosure.map((f) => f.unpaid_balance).find((x) => x !== null && x !== undefined) ?? null;
  out.push(fcAmt !== null && value
    ? res('F-020', Math.round((fcAmt / value) * 1000) / 1000, 'known', 0.8,
        [{ kind: 'foreclosure', unpaid_balance: fcAmt }], asOf, [],
        `Unpaid balance ${(100 * fcAmt / value).toFixed(1)}% of value.`)
    : res('F-020', null, foreclosure.length ? 'unknown' : 'not_applicable', 0.3, [], asOf,
        foreclosure.length ? ['foreclosure.unpaid_balance or valuation'] : [], ''));
  // F-136 episode_resolution_recency: stage evidence dated but auction passed with no distress transfer
  const pastAuction = foreclosure.find((f) => dated(f.auction_date) && toMs(f.auction_date) < asOfMs);
  const distressTransfer = transactions.find((t) => t.document_type_group === 'distress_transfer' && dated(t.sale_date) && toMs(t.sale_date) > (pastAuction ? toMs(pastAuction.auction_date) - 30 * DAY : 0));
  out.push(res('F-136', Boolean(pastAuction && !distressTransfer), 'known', pastAuction ? 0.55 : 0.5,
    pastAuction ? [{ kind: 'foreclosure', auction_date: pastAuction.auction_date }] : [], asOf, [],
    pastAuction && !distressTransfer ? 'Auction date passed with no distress transfer recorded — possible near-miss/resolution; review.' : ''));

  // ---------- property distress ----------
  // F-022 vacancy (is_vacant ∪ vacant_home ∪ zombie; flag/scalar cross-check)
  const vacScalar = String(raw.is_vacant ?? '') === '1' || String(raw.is_vacant ?? '').toLowerCase() === 'true';
  const vacFlag = flags.has('vacant_home') || flags.has('zombie_property');
  out.push(res('F-022', vacScalar || vacFlag, 'known', vacScalar && vacFlag ? 0.85 : (vacScalar || vacFlag ? 0.7 : 0.5),
    [], asOf, [], vacScalar || vacFlag
      ? `Vacancy signal${flags.has('zombie_property') ? ' (zombie: vacancy + default)' : ''}${vacScalar !== vacFlag ? ' — single-source, cross-check partial' : ''}.`
      : ''));
  // F-024 utility_municipal_liens
  const muniDocs = liens.filter((l) => /city|county|utility|sewer/.test(l.action_modifier ?? '')
    || /LENCNT|LENUTL|LENSWR|LENCTY/.test(l.doc_type_raw ?? ''));
  const openMuni = muniDocs.filter((l) => l.lifecycle_class === 'creation').length;
  out.push(res('F-024', muniDocs.length ? { docs: muniDocs.length, open: openMuni } : false,
    'known', muniDocs.length ? 0.75 : 0.5, muniDocs.slice(0, 2).map((l) => ({ kind: 'lien', id: l.id })), asOf, [],
    muniDocs.length ? `${muniDocs.length} municipal/utility lien document(s) (${openMuni} open-class) — occupancy/maintenance distress.` : ''));

  // F-137 deferred_maintenance_proxy
  const condRank = { Excellent: 1, 'Very Good': 2, Good: 3, Average: 4, Fair: 5, Poor: 6, Unsound: 7 }[p.condition_raw] ?? null;
  const muni = liens.filter((l) => /city|county|utility|sewer/.test(l.action_modifier ?? '') || /LENCNT|LENUTL|LENSWR|LENCTY/.test(l.doc_type_raw ?? ''));
  const ageGap = (p.year_built && p.effective_year_built) ? p.effective_year_built - p.year_built : null;
  const dmParts = [(condRank ?? 0) >= 5, muni.length > 0, flags.has('vacant_home') || flags.has('zombie_property')].filter(Boolean).length;
  out.push(res('F-137', dmParts, 'known', dmParts ? 0.7 : 0.45,
    muni.slice(0, 2).map((l) => ({ kind: 'lien', id: l.id })), asOf, [],
    dmParts ? `${dmParts}/3 neglect components (condition≥Fair-worse, municipal/utility liens, vacancy) — descriptive composite; each part scores once in its own family.` : ''));

  // ---------- physical ----------
  // F-027 systems_obsolescence (presence/type-conflation honored)
  const systems = [];
  if (raw.HeatingType === 'Yes') systems.push('heating_present_type_unknown');
  else if (raw.HeatingType) systems.push(`heating:${raw.HeatingType}`);
  if (raw.AirConditioning) systems.push(`ac:${raw.AirConditioning}`);
  if (raw.RoofCover) systems.push(`roof:${raw.RoofCover}`);
  if (raw.ConstructionType) systems.push(`construction:${raw.ConstructionType}`);
  out.push(systems.length
    ? res('F-027', systems, 'known', 0.55, [{ kind: 'property', fields: 'systems' }], asOf,
        ['climate/cohort context (degraded: class list only, no cap-ex costing)'],
        `Systems observed: ${systems.slice(0, 3).join(', ')}${systems.length > 3 ? '…' : ''}.`)
    : res('F-027', null, 'unknown', 0, [], asOf, ['systems fields'], ''));
  // F-029 repair_cost_baseline (rule-9 baseline only)
  const rc = Number(raw.estimated_repair_cost ?? NaN);
  out.push(Number.isFinite(rc)
    ? res('F-029', rc, 'known', 0.3, [{ kind: 'vendor_baseline' }], asOf, [],
        `Vendor repair baseline $${rc.toLocaleString()} (baseline-comparison only, never canonical).`)
    : res('F-029', null, 'unknown', 0, [], asOf, ['estimated_repair_cost'], ''));

  // ---------- landlord fatigue ----------
  const absentee = flags.has('absentee_owner') || /absentee/i.test(raw.owner_status ?? raw.owner_location ?? '');
  const outOfState = flags.has('out_of_state_owner')
    || (raw.owner_address_state && p.situs_state && raw.owner_address_state !== p.situs_state);
  const renterLinked = links.some((l) => l.renter_flag);
  // F-031 owner_distance (band-level: geodesic needs geocoded mailing address)
  out.push(res('F-031', outOfState ? 'out_of_state' : absentee ? 'absentee_in_state' : 'local_or_occupant',
    'known', 0.6, [{ kind: 'ownership', owner_state: raw.owner_address_state ?? null }], asOf,
    ['geocoded mailing address (degraded to state-band)'],
    outOfState ? `Owner mails from ${raw.owner_address_state} (out of state).` : ''));
  // F-030 tired_landlord_composite — flag NEVER alone (structural corroboration
  // required), and corroborations must be RENTAL-CONTEXT facts (absentee,
  // tenant/multi-unit, assignment-of-rents leverage). Physical condition is
  // property_distress evidence and is deliberately excluded here so one fact
  // never scores in two motivation families.
  const asr = liens.filter((l) => (l.base_type === 'assignment_of_rents'));
  const asrRel = asr.filter((l) => l.lifecycle_class === 'release').length;
  const structural = [absentee || outOfState, renterLinked || (p.units_count ?? 1) > 1,
    asr.length > 0].filter(Boolean).length;
  const tired = flags.has('tired_landlord') && structural >= 1 ? 1 + structural : (structural >= 2 ? structural : 0);
  out.push(res('F-030', tired, 'known', tired ? 0.65 : 0.45, [], asOf, [],
    tired ? `Tired-landlord composite ${tired} (flag ${flags.has('tired_landlord') ? 'present' : 'absent'} + ${structural} rental-context corroborations).` : ''));
  // F-032 assignment_of_rents_activity
  out.push(res('F-032', asr.length ? { filings: asr.length, releases: asrRel } : false, 'known',
    asr.length ? 0.6 : 0.45, asr.slice(0, 2).map((l) => ({ kind: 'lien', id: l.id })), asOf, [],
    asr.length ? `${asr.length} assignment-of-rents document(s) (${asrRel} released) — leveraged-rental context.` : ''));

  // ---------- portfolio ----------
  const pf = profile ?? {};
  const guardTripped = [pf.portfolio_total_equity, pf.portfolio_total_mortgage_balance]
    .some((x) => x !== null && x !== undefined && Math.abs(x) >= 1e9);
  // F-105 portfolio_magnitude_guard
  out.push(res('F-105', guardTripped, profile ? 'known' : 'unknown', 0.8, [], asOf,
    profile ? [] : ['prospect portfolio'], guardTripped ? 'Portfolio magnitudes outside plausibility bounds — portfolio features voided.' : ''));
  // F-033 portfolio_scale
  const scale = pf.portfolio_total_properties_owned ?? null;
  out.push(scale !== null && !guardTripped
    ? res('F-033', Math.min(scale, 100), 'known', 0.65, [{ kind: 'profile', field: 'portfolio_total_properties_owned' }], asOf,
        scale >= 100 ? ['vendor cap at 100'] : [], `Owner holds ${scale}${scale >= 100 ? '+' : ''} properties.`)
    : res('F-033', null, 'unknown', 0, [], asOf, ['portfolio snapshot (or guard tripped)'], ''));
  // F-127 portfolio_ownership_indicator (with checksum fallback per OD-12)
  const multi = (scale !== null && scale > 1) || checksums?.owner_has_multiple_properties === true;
  out.push(res('F-127', multi, scale !== null || checksums ? 'known' : 'unknown', scale !== null ? 0.7 : 0.5,
    [], asOf, [], multi ? 'Multi-property owner (portfolio or vendor fallback).' : ''));
  // F-034 portfolio_leverage
  const pe = pf.portfolio_total_equity; const pm = pf.portfolio_total_mortgage_balance;
  out.push(!guardTripped && pe !== null && pe !== undefined && pm !== null && pm !== undefined && (pe + pm) > 0
    ? res('F-034', Math.round((pm / Math.max(pe + pm, 1)) * 1000) / 1000, 'known', 0.55,
        [{ kind: 'profile' }], asOf, [], `Portfolio leverage ${(100 * pm / Math.max(pe + pm, 1)).toFixed(0)}% of portfolio value.`)
    : res('F-034', null, 'unknown', 0, [], asOf, ['portfolio equity+balance (or guard)'], ''));
  // F-035 liquidation_motion — dispositions among staged holdings sharing owner_hash (degraded scope)
  if (ownerIndex && raw.owner_hash) {
    const sibs = (ownerIndex.get(raw.owner_hash) ?? []).filter((s) => s.property_id !== p.id);
    const recentSales = sibs.filter((s) => s.last_sale_ms && asOfMs - s.last_sale_ms < 730 * DAY).length;
    out.push(res('F-035', sibs.length ? { sibling_holdings: sibs.length, recent_dispositions: recentSales } : false,
      'known', sibs.length ? 0.5 : 0.4, [], asOf, ['cross-batch holdings (degraded to in-corpus owner_hash scope)'],
      recentSales ? `${recentSales} recent disposition(s) among ${sibs.length} in-corpus sibling holdings.` : ''));
  } else out.push(res('F-035', null, 'unknown', 0, [], asOf, ['owner_hash index'], ''));

  // ---------- ownership complexity ----------
  const cls = bundle.classifications ?? [];
  const vest = raw.Owner1OwnershipRights ?? '';
  // F-036 estate_probate_state
  const estateStage = estateDeed || cls.some((c) => c.classification === 'estate')
    ? 'estate_transfer_or_vesting'
    : lifeDocs.some((l) => /distribution/i.test(l.action_modifier ?? '')) ? 'distribution'
      : lifeDocs.length ? 'death_or_probate_evidence' : 'none';
  out.push(res('F-036', estateStage, 'known', estateStage === 'none' ? 0.5 : 0.75,
    lifeEv.slice(0, 3), asOf, [], estateStage !== 'none' ? `Estate stage: ${estateStage}.` : ''));
  // F-037 entity_layering
  const entities = new Set(cls.filter((c) => ['corporate', 'trust'].includes(c.classification)).map((c) => c.classification));
  const companyLinked = (bundle.companyLinks ?? []).length > 0;
  out.push(res('F-037', { classes: [...entities], company_linked: companyLinked },
    'known', entities.size || companyLinked ? 0.7 : 0.5, [], asOf, [],
    entities.size ? `Entity ownership: ${[...entities].join('+')}${companyLinked ? ' (registry-linked)' : ''}.` : ''));
  // F-038 fractional_or_multiparty
  const multiParty = Boolean(raw.owner_2_name) || /tenants in common|et al/i.test(vest);
  out.push(res('F-038', multiParty, 'known', 0.6, [], asOf, [],
    multiParty ? 'Multiple owners / fractional vesting — all signatures required.' : ''));
  // F-039 life_estate_split
  const lifeEstate = /life tenant|life estate|remainderman/i.test(vest);
  out.push(res('F-039', lifeEstate, 'known', 0.65, [], asOf, [],
    lifeEstate ? 'Life-estate vesting: life tenant + remainderman both required.' : ''));

  // ---------- authority ----------
  // F-040 decision_maker_link
  const pdm = links.some((l) => l.profile?.primary_decision_maker);
  out.push(res('F-040', pdm, links.length ? 'known' : 'unknown', pdm ? 0.7 : 0.45, [], asOf,
    links.length ? [] : ['person links'], pdm ? 'Linked contact is flagged primary decision maker.' : ''));
  // F-041 entity_signing_authority (officers dormant → degraded)
  const dissolved = (bundle.companies ?? []).some((c) => c.existence_norm === 'inactive');
  out.push(res('F-041', companyLinked ? (dissolved ? 'entity_defunct' : 'entity_active_officers_unknown') : 'not_entity_owned',
    'known', companyLinked ? 0.5 : 0.6, [], asOf,
    companyLinked ? ['company_officers (dormant source)'] : [],
    dissolved ? 'Owning entity appears defunct — authority cure required (also a motivation signal).' : ''));
  // F-042 fiduciary_present
  const fiduciary = /trustee|executor|administrator|conservator|power of attorney|guardian|personal representative/i.test(vest)
    || liens.some((l) => l.base_type === 'power_of_attorney')
    || (bundle.lienParties ?? []).some((lp) => /administrator|executor/i.test(lp.role_raw ?? ''));
  out.push(res('F-042', fiduciary, 'known', 0.6, [], asOf, [],
    fiduciary ? 'Fiduciary (trustee/executor/POA) present in vesting or documents.' : ''));

  // ---------- identity / contact ----------
  // F-045 cross_source_agreement
  const checks = [];
  if (raw.owner_hash) checks.push(['owner_hash', true]);
  const linkStates = links.filter((l) => l.matching_type);
  if (linkStates.length) checks.push(['link_evidence', true]);
  out.push(res('F-045', checks.length, 'known', 0.5, [], asOf, [],
    `${checks.length} cross-source agreement check(s) available.`));
  // F-043 person_property_link_strength (tier + corroboration detail; F-110 is the tier gate)
  const bestLink = links.filter((l) => l.link_tier && l.link_tier !== 'none')
    .sort((a, b) => ({ exact: 4, high: 3, medium: 2, low: 1 }[b.link_tier] ?? 0) - ({ exact: 4, high: 3, medium: 2, low: 1 }[a.link_tier] ?? 0))[0] ?? null;
  const corroborations = bestLink
    ? [(bestLink.matching_flags ?? []).length > 1, bestLink.is_matching_property_as_owner === true,
        bestLink.likely_owner_scalar === true].filter(Boolean).length : 0;
  out.push(res('F-043', bestLink ? { tier: bestLink.link_tier, corroborations } : null,
    bestLink ? 'known' : 'unknown', bestLink ? 0.7 : 0.3, [], asOf,
    bestLink ? [] : ['property_person_links'],
    bestLink ? `Link strength ${bestLink.link_tier} with ${corroborations} corroboration(s).` : ''));
  // F-044 person_identity_key_coverage
  const idTiers = (bundle.identityTiers ?? links.map((l) => l.person_identity_tier).filter(Boolean));
  out.push(idTiers.length
    ? res('F-044', { keyed: idTiers.filter((t) => t === 'key').length, total: idTiers.length },
        'known', 0.6, [], asOf, [],
        `${idTiers.filter((t) => t === 'key').length}/${idTiers.length} linked people carry a vendor individual_key.`)
    : res('F-044', null, 'unknown', 0.3, [], asOf, ['people identity tiers'], ''));
  // F-113 link_evidence_stability (batch metric surfaced per property)
  out.push(res('F-113', bundle.batchScalarLiveness ?? null,
    bundle.batchScalarLiveness === null || bundle.batchScalarLiveness === undefined ? 'unknown' : 'known',
    0.6, [], asOf, [], `Batch scalar liveness ${bundle.batchScalarLiveness?.toFixed?.(3) ?? 'n/a'} (drift monitor input).`));

  // ---- F-114 owner_resolution (V1.3): evidence-aware owner resolution +
  // identity route. Separates person_contact_suppressed (per person) from the
  // property-level owner_resolution_status. Renter flags NEVER directly set the
  // property route — they suppress the person; the route follows owner
  // resolution. See scores/ownerResolution.mjs.
  const ownerName114 = raw.owner_name ?? null;
  const isEntityOwner = companyLinked
    || cls.some((c) => ['corporate', 'trust', 'estate'].includes(c.classification))
    || (ownerName114 ? ENTITY_NAME_RE.test(ownerName114) : false);
  const resolPersons = links.map((l) => {
    const tokens = Array.isArray(l.matching_flags) ? l.matching_flags : [];
    const ns = nameSignals(ownerName114, l.person_name);
    const tier = l.link_tier ?? 'none';
    const verdict = l.is_matching_property_as_owner === true;
    const idTier = l.person_identity_tier ?? l.profile?.person_identity_tier ?? null;
    return {
      id: l.person_id ?? l.id ?? null, identity_tier: idTier,
      renter_flag: l.renter_flag === true, link_tier: tier,
      owner_token: tokens.some((t) => /likely owner|potential owner/i.test(String(t))),
      owner_verdict: verdict, name_match: ns.name_match, surname_match: ns.surname_match,
      exact_key_owner: verdict && idTier === 'key' && ns.name_match,
    };
  });
  const ownerRes = resolveOwner({
    owner_name: ownerName114, owner_hash: raw.owner_hash ?? null, is_entity: isEntityOwner,
    situs_state: p.situs_state ?? null, mailing_state: raw.owner_address_state ?? null, persons: resolPersons,
  });
  out.push(res('F-114', ownerRes, 'known', 0.7,
    [{ kind: 'owner_resolution', status: ownerRes.owner_resolution_status }], asOf, [],
    `Owner resolution: ${ownerRes.owner_resolution_status} → route ${ownerRes.identity_route}; ${ownerRes.person_contact_suppressed.filter((s) => s.suppressed).length} contact(s) suppressed.`));
  // F-048 language_routing
  const lang = links.map((l) => l.profile?.language_preference).find(Boolean) ?? null;
  out.push(res('F-048', lang ?? 'default_english_low_confidence', lang ? 'known' : 'unknown',
    lang ? 0.7 : 0.3, [], asOf, lang ? [] : ['prospects.language_preference'],
    lang ? `Outreach language: ${lang}.` : ''));
  // F-049 mailing_address_quality
  const mailParts = [raw.owner_address_full, raw.owner_address_line_1, raw.owner_address_city, raw.owner_address_state, raw.owner_address_zip].filter(Boolean).length;
  out.push(res('F-049', mailParts >= 3 ? 'deliverable' : mailParts >= 1 ? 'partial' : 'absent',
    'known', 0.6, [], asOf, [], `Mailing address completeness ${mailParts}/5${raw.MailingCOName ? ' (care-of present)' : ''}.`));

  // ---------- discount / EEV ----------
  // F-050 pressure_to_equity_ratio. The foreclosure unpaid balance is the
  // defaulted MORTGAGE's balance — already netted out of estimated_equity and
  // already in the recorded-loan payoff — so only its excess over recorded
  // balances (arrears/fees) counts as additional pressure. Counting it whole
  // double-charged the same debt.
  const eqAmt = v.estimated_equity ?? null;
  const mortgageBal = loans.filter((l) => l.slot_class === 'current_recorded')
    .reduce((s, l) => s + (l.estimated_balance ?? 0), 0);
  const lienAmts = liens.filter((l) => ['creation', 'judgment'].includes(l.lifecycle_class))
    .reduce((s, l) => s + (l.amount_due ?? 0), 0);
  const fcExcess = fcAmt !== null ? Math.max(0, fcAmt - mortgageBal) : 0;
  const pressureAmts = lienAmts + fcExcess;
  out.push(eqAmt !== null && eqAmt > 0
    ? res('F-050', Math.round(Math.min(pressureAmts / eqAmt, 2) * 1000) / 1000, 'known', 0.65,
        [{ kind: 'derived', pressure_amount: pressureAmts, equity: eqAmt }], asOf, [],
        pressureAmts ? `Dated pressure $${pressureAmts.toLocaleString()} (liens + default excess over recorded balance) vs $${eqAmt.toLocaleString()} equity.` : 'No dated pressure amounts against equity.')
    : res('F-050', null, 'unknown', 0, [], asOf, ['estimated_equity (positive)'], 'Blocked: equity unknown or non-positive.'));
  // F-051 prior_non_market_transfer (basis class)
  const basisClass = current?.document_type_group === 'distress_transfer' ? 'distress_acquisition'
    : current?.document_type_group === 'death_or_estate_transfer' ? 'estate_acquisition'
      : current?.document_type_group === 'non_arms_length_transfer' ? 'family_acquisition'
        : current?.price_qualifier_class === 'distress_context' ? 'distress_price_class' : (current ? 'market_acquisition' : null);
  out.push(basisClass
    ? res('F-051', basisClass, 'known', 0.7, [{ kind: 'transaction', id: current.id }], asOf, [],
        basisClass !== 'market_acquisition' ? `Acquired via ${basisClass.replace(/_/g, ' ')} — low-basis context.` : '')
    : res('F-051', null, 'unknown', 0, [], asOf, ['transactions.current'], ''));
  // F-052 condition_discount_headroom — MEASURED renovated-vs-as-is spread
  // (snapshot interface v2) scaled by the subject's own condition distance.
  const rs = (compSnapshot?.snapshot_interface_version ?? 1) >= 2 ? compSnapshot.renovated_spread : null;
  if (rs && rs.spread_abs_for_subject > 0) {
    const condDistance = Math.max(0, (condRank ?? 4) - 3) / 4;   // 0 (Good+) .. 1 (Unsound)
    out.push(res('F-052', {
      spread_abs: rs.spread_abs_for_subject,
      condition_distance: Math.round(condDistance * 100) / 100,
      headroom: Math.round(rs.spread_abs_for_subject * condDistance),
    }, 'known', Math.min(rs.confidence ?? 0.4, 0.7),
    [{ kind: 'comp_snapshot', id: compSnapshot.id, good_n: rs.good_n, poor_n: rs.poor_n }], asOf, [],
    condDistance > 0
      ? `Renovated-comp spread $${rs.spread_abs_for_subject.toLocaleString()} × condition distance ${condDistance.toFixed(2)} = $${Math.round(rs.spread_abs_for_subject * condDistance).toLocaleString()} discount headroom.`
      : 'Condition at/above cohort Good — no as-is discount headroom from condition.'));
  } else {
    out.push(res('F-052', null, 'blocked', 0, [], asOf,
      [rs === null ? 'renovated-vs-as-is comp spread (snapshot v2 with measurable condition split)' : 'positive measured spread'],
      'Discount headroom blocked: no measured renovated-comp spread.'));
  }
  // F-132 repair_ratio_normalized — vendor repair baseline vs value AND vs the
  // measured renovated spread (rule 9: baseline-comparison only)
  const rb = (compSnapshot?.snapshot_interface_version ?? 1) >= 2 ? compSnapshot.repair_burden : null;
  const rcRaw = Number(raw.estimated_repair_cost ?? NaN);
  if (rb || (Number.isFinite(rcRaw) && rcRaw > 0 && value)) {
    const toValue = rb?.repair_to_value ?? Math.round((rcRaw / value) * 100) / 100;
    const toSpread = rb?.repair_to_renovated_spread
      ?? (rs && rs.spread_abs_for_subject > 0 && Number.isFinite(rcRaw) ? Math.round((rcRaw / rs.spread_abs_for_subject) * 100) / 100 : null);
    out.push(res('F-132', { repair_to_value: toValue, repair_to_renovated_spread: toSpread },
      'known', toSpread !== null ? 0.55 : 0.4,
      [{ kind: rb ? 'comp_snapshot' : 'vendor_baseline' }], asOf,
      toSpread === null ? ['measured renovated spread (repair-vs-spread leg degraded)'] : [],
      `Repair baseline ${(toValue * 100).toFixed(0)}% of value${toSpread !== null ? `, ${(toSpread * 100).toFixed(0)}% of renovated spread` : ''} (vendor baseline, never canonical).`));
  } else {
    out.push(res('F-132', null, 'blocked', 0, [], asOf,
      ['vendor repair baseline + value (or snapshot v2 repair_burden)'],
      'Repair ratio blocked: no baseline/value.'));
  }
  // F-053 dealability clear-path (gate stack summary)
  const blockers = [];
  if (links.some((l) => l.renter_flag)) blockers.push('renter_contact');
  if (dissolved) blockers.push('defunct_entity');
  if (estateStage === 'death_or_probate_evidence') blockers.push('estate_unsettled');
  if (lifeEstate) blockers.push('life_estate_split');
  if (flags.has('bank_owned')) blockers.push('reo');
  out.push(res('F-053', { blockers, clear: blockers.length === 0 }, 'known', 0.6, [], asOf, [],
    blockers.length ? `Deal blockers: ${blockers.join(', ')}.` : 'No hard blockers observed.'));
  // F-054 occupancy_disposition
  const occ = flags.has('vacant_home') || flags.has('zombie_property') ? 'vacant'
    : renterLinked ? 'tenant_occupied' : /owner occupied/i.test(raw.owner_status ?? raw.owner_location ?? '') ? 'owner_occupied' : 'unknown';
  out.push(res('F-054', occ, occ === 'unknown' ? 'unknown' : 'known', occ === 'unknown' ? 0.3 : 0.6, [], asOf, [],
    occ !== 'unknown' ? `Occupancy at close: ${occ.replace('_', ' ')}.` : ''));
  // F-055 seller_finance_openness proxy
  const sf = flags.has('free_and_clear') || loans.some((l) => /seller take-back|land contract/i.test(l.loan_type_raw ?? ''))
    || transactions.some((t) => t.document_type_group === 'seller_financed_or_contract');
  out.push(res('F-055', sf, 'known', 0.5, [], asOf, [], sf ? 'Free-and-clear / prior seller-financing behavior — terms-offer candidate.' : ''));

  // F-131 tax_burden_ratio (ratio-only; cohort percentile degraded)
  const taxAmt = Number(raw.TaxAmt ?? NaN);
  out.push(Number.isFinite(taxAmt) && value
    ? res('F-131', Math.round((taxAmt / value) * 10000) / 10000, 'known', 0.55,
        [{ kind: 'valuation' }], asOf, ['cohort percentile (comp snapshot)'],
        `Annual tax ${(100 * taxAmt / value).toFixed(2)}% of value (cohort-degraded).`)
    : res('F-131', null, 'unknown', 0, [], asOf, ['TaxAmt + value'], ''));

  // ---------- OD-12 quality (F-102 F-103 F-104) ----------
  if (checksums) {
    const slotAmt = loans.filter((l) => l.slot_class === 'current_recorded').reduce((s, l) => s + (l.original_loan_amount ?? 0), 0);
    const delta = checksums.total_loan_amount !== null && checksums.total_loan_amount !== undefined
      ? Math.abs(checksums.total_loan_amount - slotAmt) : null;
    out.push(res('F-102', delta === null ? null : { delta, rel: slotAmt ? Math.round((delta / Math.max(slotAmt, 1)) * 1e4) / 1e4 : null },
      delta === null ? 'unknown' : 'known', 0.7, [], asOf, delta === null ? ['loan checksums'] : [],
      delta !== null && delta > Math.max(1, slotAmt * 0.001) ? `Loan-amount checksum breaks by $${delta.toLocaleString()}.` : ''));
    const openLiens = liens.filter((l) => ['creation', 'judgment', 'litigation'].includes(l.lifecycle_class)).length;
    const toln = checksums.total_open_lien_nbr;
    out.push(res('F-103', toln === null || toln === undefined ? null : { vendor_open: toln, netted_open_docs: openLiens, disagree: toln !== openLiens },
      toln === null || toln === undefined ? 'unknown' : 'known', 0.6, [], asOf, [],
      toln !== null && toln !== undefined && toln !== openLiens ? `Vendor open-lien fallback ${toln} vs netted ${openLiens} — review.` : ''));
  } else {
    out.push(res('F-102', null, 'unknown', 0, [], asOf, ['loan_checksums'], ''));
    out.push(res('F-103', null, 'unknown', 0, [], asOf, ['loan_checksums'], ''));
  }
  const corpCls = cls.filter((c) => c.classification === 'corporate').map((c) => c.evidence_source);
  const corpConflict = corpCls.length > 0 && corpCls.length < ['owner_status', 'is_corporate_owner', 'corp_owner'].filter((s) => cls.some((c) => c.evidence_source === s)).length + (corpCls.length ? 0 : 0)
    ? false : false; // structural conflict computed at import (conflict report); here: mixed evidence check
  const corpSources = new Set(corpCls);
  const hasCorpFlag = flags.has('corporate_owner');
  const disagreeCorp = (corpSources.size > 0) !== hasCorpFlag && (corpSources.size > 0 || hasCorpFlag);
  out.push(res('F-104', disagreeCorp, 'known', 0.6, [], asOf, [],
    disagreeCorp ? 'Corporate classification sources disagree (status/scalar vs flag) — multi-classification retained, review.' : ''));

  // ---------- market (snapshot-dependent) ----------
  // F-057 price_band_liquidity + F-060 expected_spread + F-062 confidence-discounted
  if (compSnapshot) {
    out.push(res('F-057', compSnapshot.inventory_absorption ?? null,
      compSnapshot.inventory_absorption === null ? 'unknown' : 'known',
      compSnapshot.valuation_confidence ?? 0.5, [{ kind: 'comp_snapshot', id: compSnapshot.id }], asOf, [],
      'Inventory/absorption from immutable snapshot.'));
    // payoff: the defaulted loan's unpaid balance supersedes (not adds to) its
    // recorded balance; liens and default-excess enter once via pressureAmts
    const payoff = Math.max(mortgageBal, fcAmt ?? 0) + lienAmts;
    const spread = compSnapshot.valuation_low !== null && !loans.some((l) => l.blanket_loan_flag)
      ? compSnapshot.valuation_low - payoff : null;
    out.push(spread === null
      ? res('F-060', null, 'unknown', 0.2, [], asOf, ['guarded payoff or valuation'], '')
      : res('F-060', Math.round(spread), 'known', Math.min(compSnapshot.valuation_confidence ?? 0.5, 0.7),
          [{ kind: 'comp_snapshot', id: compSnapshot.id }], asOf,
          ['repair class costing (spread excludes repairs — conservative upper bound)'],
          `Guarded spread $${Math.round(spread).toLocaleString()} (valuation_low − payoff − dated pressure; repairs not deducted).`));
    // best clean owner-link tier (rank order, renter-flagged links excluded);
    // the previous alphabetical sort could pick 'low' over 'medium'
    const TIER_RANK = { exact: 4, high: 3, medium: 2, low: 1, none: 0 };
    const bestTier = links.filter((l) => !l.renter_flag)
      .map((l) => l.link_tier).filter(Boolean)
      .sort((a, b) => (TIER_RANK[b] ?? 0) - (TIER_RANK[a] ?? 0))[0] ?? 'none';
    const tierMul2 = { exact: 1, high: 0.95, medium: 0.8, low: 0.5, none: 0.15 }[bestTier] ?? 0.15;
    out.push(spread === null
      ? res('F-062', null, 'unknown', 0.2, [], asOf, ['F-060'], '')
      : res('F-062', Math.round(spread * tierMul2), 'known', 0.5, [], asOf, [],
          `Spread confidence-discounted by link tier (×${tierMul2}).`));
    out.push(spread === null
      ? res('F-061', null, 'unknown', 0.2, [], asOf, ['F-060'], '')
      : res('F-061', spread >= 100000 ? 'large' : spread >= 40000 ? 'medium' : spread >= 10000 ? 'small' : 'thin',
          'known', 0.5, [], asOf, [], `Deal size band from guarded spread (never masks thin-margin risk).`));
  } else {
    for (const [id, name] of [['F-057', 'price_band_liquidity'], ['F-060', 'expected_spread'],
      ['F-061', 'deal_size_band'], ['F-062', 'confidence_discounted_value']]) {
      out.push(res(id, null, 'blocked', 0, [], asOf, ['market_feature_snapshot (P2-2)'], `${name} blocked: no comp snapshot.`));
    }
  }
  // F-008, F-028, F-059: remain blocked — rent context has NO source data
  // (snapshot v2 carries rent_context=null + warning), cohort layout norms and
  // buyer exit-mix labels are still structurally absent. F-052/F-132 became
  // snapshot-v2-gated above; F-056/F-058/F-130 are owned by the core engine.
  for (const [id, why] of [
    ['F-008', 'local rent/income context (no rent source in corpus)'],
    ['F-028', 'cohort layout norms (comp snapshot v3)'],
    ['F-059', 'buyer exit-mix labels (buyer intel)'],
  ]) {
    out.push(res(id, null, 'blocked', 0, [], asOf, [why], `Blocked: ${why}.`));
  }

  return out;
}
