// 19 score families + execution priority composition. Families are computed
// separately (locked rule: never one opaque number). Three unit classes, never
// mixed inside one term:
//   - evidence families (points): propensity, financial, legal, foreclosure,
//     distress, obsolescence, fatigue, portfolio, discount, contactability
//   - multiplier families (0..~1.2): identity, authority, dealability + the
//     market scaler — gates and scalers, applied multiplicatively (IX-16/IX-17)
//   - context families (raw units): market_liquidity (sales/mo), buyer_demand,
//     expected_economic_value ($ spread) — blocked without an immutable snapshot
// All numeric knobs come from config family_params (single authority).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/hash.mjs';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'deterministic_v1.config.json');

export function loadV1Config() {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  return { cfg, versionId: `${cfg.engine}@${cfg.semver}+cfg.${sha256(raw).slice(0, 12)}` };
}

export const FAMILIES = [
  'seller_propensity', 'financial_pressure', 'legal_title_pressure', 'foreclosure_urgency',
  'property_distress', 'physical_obsolescence', 'repair_burden', 'landlord_fatigue',
  'portfolio_liquidation', 'ownership_complexity', 'authority_confidence', 'identity_confidence',
  'contactability', 'discount_potential', 'dealability', 'market_liquidity', 'buyer_demand',
  'expected_economic_value', 'execution_priority',
];

export function featureMap(features) {
  return new Map(features.map((f) => [f.feature_id, f]));
}

const TIER_ORDER = ['none', 'low', 'medium', 'high', 'exact'];

export function computeFamilies(features, cfgIn = null) {
  const cfg = cfgIn ?? loadV1Config().cfg;
  const P = cfg.family_params;
  const fm = featureMap(features);
  const val = (id) => {
    const f = fm.get(id);
    return f && f.value_state === 'known' ? f.value : null;
  };
  const state = (id) => fm.get(id)?.value_state ?? 'unknown';
  const out = {};
  const put = (family, score, scoreState, confidence, parts = [], extra = {}) => {
    out[family] = { family, score, score_state: scoreState, confidence, components: parts, ...extra };
  };

  // ---- foreclosure urgency: stage ladder x recency decay + auction clock
  const FU = P.foreclosure_urgency;
  const stage = val('F-018');
  const days = val('F-019');
  const stageAge = fm.get('F-018')?.source_evidence?.[0]?.age_days ?? null;
  const pastUnresolved = val('F-136') === true;
  const stageRaw = stage !== null ? (FU.stage_map[stage] ?? 0) : null;
  const stageDecayMult = stageRaw === null || stageRaw === 0 ? 1
    : pastUnresolved ? FU.past_auction_unresolved_mult
      : (stageAge !== null && stageAge > FU.stage_stale_days ? FU.stage_stale_mult : 1);
  const stagePts = stageRaw === null ? null : Math.round(stageRaw * stageDecayMult);
  const clockPts = days !== null && stage && stage !== 'none' && stage !== 'reo'
    ? Math.min(FU.clock_cap, FU.clock_curve / Math.max(days, FU.clock_floor_days)) : 0;
  put('foreclosure_urgency', stagePts === null ? null : Math.round(stagePts + clockPts),
    stagePts === null ? 'insufficient' : 'scored', stagePts === null ? 0 : 0.9,
    [{ component: 'stage', contribution: stagePts },
      { component: 'stage_recency_mult', contribution: stageDecayMult },
      { component: 'clock', contribution: Math.round(clockPts) }]);

  // ---- legal/title: severity-classed, age-decayed, equity-relative stack
  const LT = P.legal_title_pressure;
  const lp = val('F-013');
  let lienPts = null;
  let lienParts = [];
  if (lp !== null) {
    if (typeof lp === 'number') { lienPts = 0; lienParts = [{ component: 'no_open_episodes', contribution: 0 }]; }
    else {
      const classPts = Object.entries(LT.class_weights).map(([k, w]) => {
        const c = Math.min(lp.classes?.[k] ?? 0, LT.class_episode_cap);
        return { component: `class:${k}`, contribution: Math.round(w * c) };
      }).filter((c) => c.contribution > 0);
      const ratio = lp.amount_to_equity ?? lp.amount_to_value ?? 0;
      const amtPts = Math.round(LT.amount_ratio_weight * Math.min(ratio, 1));
      lienPts = Math.min(LT.cap, classPts.reduce((s, c) => s + c.contribution, 0) + amtPts);
      lienParts = [...classPts, { component: lp.amount_to_equity !== null && lp.amount_to_equity !== undefined ? 'amount_to_equity' : 'amount_to_value', contribution: amtPts }];
    }
  }
  put('legal_title_pressure', lienPts, lienPts === null ? 'insufficient' : 'scored',
    lienPts === null ? 0 : 0.8, lienParts);

  // ---- property distress: tax depth + condition + vacancy
  const PD = P.property_distress;
  const tax = val('F-023');
  const cond = val('F-025');
  const vacant = val('F-022') === true;
  let distress = 0; let dConf = 0.4; const dParts = [];
  if (tax && tax.delinquent) {
    const p = PD.tax_base + PD.tax_per_year * Math.min(tax.years_deep ?? 0, PD.tax_years_cap);
    distress += p; dConf = 0.85; dParts.push({ component: 'tax_delinquency', contribution: p });
  }
  if (cond !== null && cond >= 5) {
    const p = PD.condition_map[String(cond)] ?? 0;
    distress += p; dParts.push({ component: 'condition', contribution: p });
  }
  if (vacant) { distress += PD.vacancy_points; dParts.push({ component: 'vacancy', contribution: PD.vacancy_points }); }
  distress = Math.min(PD.cap, distress);
  put('property_distress', Math.round(distress), 'scored', dConf, dParts);

  // ---- financial pressure: ONE leverage term (equity preferred, LTV fallback,
  // never both: arithmetic complements per IX-01) + structures + strain corro
  const FP = P.financial_pressure;
  const ltv = val('F-006');
  const eq = val('F-007');
  let fin = 0; const fParts = [];
  if (eq !== null) {
    const p = eq < 0 ? FP.equity_negative_points : eq < FP.equity_thin_pct ? FP.equity_thin_points : 0;
    if (p) { fin += p; fParts.push({ component: eq < 0 ? 'negative_equity' : 'thin_equity', contribution: p }); }
  } else if (ltv !== null) {
    const p = ltv > FP.ltv_high ? FP.ltv_high_points : ltv > FP.ltv_mid ? FP.ltv_mid_points : 0;
    if (p) { fin += p; fParts.push({ component: 'high_ltv_fallback', contribution: p }); }
  }
  if (val('F-009') === true) { fin += FP.rate_reset_points; fParts.push({ component: 'rate_reset', contribution: FP.rate_reset_points }); }
  if (val('F-011') === true) { fin += FP.reverse_mortgage_points; fParts.push({ component: 'reverse_mortgage', contribution: FP.reverse_mortgage_points }); }
  if ((val('F-010')?.modifications ?? 0) > 0) { fin += FP.modification_points; fParts.push({ component: 'modification_churn', contribution: FP.modification_points }); }
  const tierNow = val('F-110') ?? 'none';
  const strain = val('F-012');
  if (strain !== null && strain >= FP.strain_min_indicators && TIER_ORDER.indexOf(tierNow) >= 2 && fin > 0) {
    const before = fin;
    fin = Math.min(FP.cap, Math.round(fin * FP.strain_mult));
    fParts.push({ component: 'person_strain_corroboration_x1.15', contribution: fin - before });
  }
  fin = Math.min(FP.cap, fin);
  put('financial_pressure', Math.round(fin), eq === null && ltv === null ? 'insufficient' : 'scored',
    eq !== null || ltv !== null ? 0.8 : 0.4, fParts);

  // ---- seller propensity: tenure curve (distress-gated short end) + life
  // events (recency-decayed) + failed listing + title cleanup; F-004 vendor
  // flag is corroboration-only (confidence, never points, IX-18)
  const SP = P.seller_propensity;
  const tenure = val('F-001');
  const openEpisodes = typeof lp === 'object' && lp !== null ? lp.open_episodes : 0;
  const distressContext = (stagePts ?? 0) > 0 || (tax?.delinquent === true) || openEpisodes > 0;
  let prop = 0; const pParts = [];
  if (tenure !== null) {
    const p = tenure >= SP.tenure_long_years ? SP.tenure_long_points
      : tenure <= SP.tenure_short_years ? (distressContext ? SP.tenure_short_distress_points : SP.tenure_base_points)
        : SP.tenure_base_points;
    prop += p; pParts.push({ component: 'tenure_curve', contribution: p });
  }
  const life = val('F-002');
  if (life && typeof life === 'object' && life.events > 0) {
    const age = life.newest_days_ago;
    const mult = age === null || age === undefined ? SP.life_mid_mult
      : age <= SP.life_recent_days ? 1 : age <= SP.life_mid_days ? SP.life_mid_mult : SP.life_old_mult;
    const p = Math.round(SP.life_event_points * mult);
    prop += p; pParts.push({ component: 'life_event_evidence', contribution: p });
  }
  const f3 = val('F-003');
  const failedListing = f3 === true || (f3 !== null && typeof f3 === 'object' && f3.failed === true);
  const activeListing = f3 !== null && typeof f3 === 'object' && f3.active === true;
  if (failedListing && !activeListing) {
    let p = SP.failed_listing_points;
    // failed after chasing the market down = proven motivated retail failure
    if (typeof f3 === 'object' && (f3.price_cut_pct ?? 0) >= SP.failed_cuts_pct) p += SP.failed_after_cuts_bonus;
    prop += p; pParts.push({ component: (typeof f3 === 'object' && (f3.price_cut_pct ?? 0) >= SP.failed_cuts_pct) ? 'failed_listing_after_price_cuts' : 'failed_listing', contribution: p });
  }
  if (val('F-135') === true) { prop += SP.title_cleanup_points; pParts.push({ component: 'recent_title_cleanup', contribution: SP.title_cleanup_points }); }
  const hardDistress = distress + (stagePts ?? 0) + (lienPts ?? 0);
  const suppressed = val('F-005') === true && hardDistress < SP.suppressor_distress_override;
  if (suppressed) { prop = Math.round(prop * SP.suppressor_mult); pParts.push({ component: 'recent_purchase_suppressor_x0.3', contribution: 0 }); }
  prop = Math.min(SP.cap, prop);
  let pConf = tenure === null ? 0.3 : 0.7;
  if (val('F-004') === true && prop > 0) { pConf = Math.min(0.9, pConf + 0.05); pParts.push({ component: 'vendor_likely_to_move_corroboration', contribution: 0 }); }
  put('seller_propensity', Math.round(prop), tenure === null && !life ? 'insufficient' : 'scored', pConf, pParts);

  // ---- physical obsolescence
  const PO = P.physical_obsolescence;
  const age = val('F-026');
  put('physical_obsolescence', age === null ? null : (age >= PO.age_old ? PO.age_old_points : age >= PO.age_mid ? PO.age_mid_points : 0),
    age === null ? 'insufficient' : 'scored', age === null ? 0 : 0.6,
    [{ component: 'effective_age', contribution: age }]);

  // repair burden: measured inputs only (snapshot v2); vendor baseline is
  // rule-9 comparison data, never canonical. NOT in the motivation sum —
  // condition already scores disengagement once in property_distress (IX-04);
  // this family quantifies the CAPEX load and feeds discount/dealability.
  const RB = P.repair_burden;
  const rr132 = val('F-132');
  const hr052 = val('F-052');
  if (rr132 === null && hr052 === null) {
    put('repair_burden', null, 'blocked', 0,
      [{ component: 'requires snapshot v2 measured spread / repair baseline (F-132/F-052)', contribution: null }]);
  } else {
    let rb = 0; const rbParts = [];
    const tv = rr132?.repair_to_value ?? null;
    if (tv !== null) {
      const p = tv >= RB.to_value_heavy ? RB.to_value_heavy_points
        : tv >= RB.to_value_mid ? RB.to_value_mid_points
          : tv >= RB.to_value_light ? RB.to_value_light_points : 0;
      if (p) { rb += p; rbParts.push({ component: 'repair_to_value', contribution: p }); }
    }
    const tsp = rr132?.repair_to_renovated_spread ?? null;
    if (tsp !== null && tsp > RB.spread_exceeded_ratio) {
      rb += RB.spread_exceeded_points;
      rbParts.push({ component: 'repairs_exceed_renovated_spread', contribution: RB.spread_exceeded_points });
    }
    rb = Math.min(RB.cap, rb);
    put('repair_burden', rb, 'scored', tsp !== null ? 0.55 : 0.4,
      rbParts.length ? rbParts : [{ component: 'no_material_repair_load', contribution: 0 }]);
  }

  // ---- landlord fatigue (F-030 composite carries ASR internally — no re-add)
  const LF = P.landlord_fatigue;
  const tiredComposite = val('F-030');
  put('landlord_fatigue', tiredComposite === null ? null : Math.min(LF.cap, tiredComposite * LF.per_composite_point),
    tiredComposite === null ? 'insufficient' : 'scored', tiredComposite === null ? 0.2 : 0.6,
    [{ component: 'tired_composite', contribution: tiredComposite }]);

  // ---- portfolio liquidation (motion dominates; leverage amplifies; guard voids)
  const PL = P.portfolio_liquidation;
  const guard = val('F-105') === true;
  const scale = val('F-033');
  const motion = val('F-035');
  const plev = val('F-034');
  let port = null; const plParts = [];
  if (!guard && (scale !== null || motion !== null)) {
    port = 0;
    const sp2 = scale !== null ? (scale >= PL.scale_large ? PL.scale_large_points : scale >= 2 ? PL.scale_multi_points : 0) : 0;
    if (sp2) { port += sp2; plParts.push({ component: 'portfolio_scale', contribution: sp2 }); }
    const disp = motion && typeof motion === 'object' ? Math.min(PL.disposition_cap, (motion.recent_dispositions ?? 0) * PL.per_disposition) : 0;
    if (disp) { port += disp; plParts.push({ component: 'liquidation_motion', contribution: disp }); }
    if (plev !== null && plev >= PL.leverage_high && (scale ?? 0) >= 2) { port += PL.leverage_points; plParts.push({ component: 'debt_concentration', contribution: PL.leverage_points }); }
    port = Math.min(PL.cap, port);
  }
  put('portfolio_liquidation', port, guard ? 'insufficient' : (port === null ? 'insufficient' : 'scored'),
    guard ? 0.1 : (port === null ? 0.2 : 0.55),
    guard ? [{ component: 'magnitude_guard_voided', contribution: null }] : plParts);

  // ---- ownership complexity: horizon descriptor, NOT motivation (IX-14)
  const OC = P.ownership_complexity;
  const estate = val('F-036');
  const cxParts = [
    ['estate', estate && estate !== 'none' ? OC.estate_points : 0],
    ['entity', (val('F-037')?.classes ?? []).length ? OC.entity_points : 0],
    ['fractional', val('F-038') === true ? OC.fractional_points : 0],
    ['life_estate', val('F-039') === true ? OC.life_estate_points : 0],
  ];
  const cxScore = cxParts.reduce((s, [, p2]) => s + p2, 0);
  const horizonDays = cxScore >= OC.horizon_high_at ? OC.horizon_days.high
    : cxScore >= OC.horizon_mid_at ? OC.horizon_days.mid : OC.horizon_days.base;
  put('ownership_complexity', cxScore, 'scored', 0.6,
    cxParts.filter(([, p2]) => p2).map(([component, contribution]) => ({ component, contribution })),
    { horizon_days: horizonDays });

  // ---- authority confidence (multiplier: who can actually sign)
  const AC = P.authority_confidence;
  const entAuth = val('F-041');
  const fiduciary = val('F-042') === true;
  let auth = AC.base + (val('F-040') === true ? AC.decision_maker_bonus : 0);
  auth = Math.min(1, auth);
  const aParts = [{ component: `base${val('F-040') === true ? '+decision_maker' : ''}`, contribution: Math.round(auth * 100) / 100 }];
  if (entAuth === 'entity_defunct') { auth *= AC.entity_defunct_mult; aParts.push({ component: 'entity_defunct_x0.5', contribution: null }); }
  else if (entAuth === 'entity_active_officers_unknown') { auth *= AC.officers_unknown_mult; aParts.push({ component: 'officers_unknown_x0.85', contribution: null }); }
  if (estate === 'death_or_probate_evidence') {
    auth *= fiduciary ? AC.estate_with_fiduciary_mult : AC.estate_unsettled_mult;
    aParts.push({ component: fiduciary ? 'estate_with_fiduciary_x0.95' : 'estate_unsettled_x0.75', contribution: null });
  }
  if (val('F-039') === true) { auth *= AC.life_estate_mult; aParts.push({ component: 'life_estate_x0.9', contribution: null }); }
  auth = Math.max(AC.floor, Math.round(auth * 100) / 100);
  put('authority_confidence', auth, 'scored', 0.55, aParts);

  // ---- identity confidence (multiplier; F-111 = one tier STEP per config)
  const tierMap = cfg.gates.link_tier_multiplier.map;
  const tier = val('F-110') ?? 'none';
  const stepped = val('F-111') === true
    ? TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(tier) + 1)] : tier;
  const idMul = tierMap[stepped] ?? 0.15;
  put('identity_confidence', idMul, 'scored', 0.85,
    [{ component: `link_tier:${tier}${stepped !== tier ? `->${stepped} (scalar corroboration)` : ''}`, contribution: idMul }]);

  // ---- contactability
  const CT = P.contactability;
  const ph = val('F-046');
  const em = val('F-047');
  const chans = (ph?.compliant_phones ?? 0) + (em ?? 0);
  const contactPts = ph === null ? 0 : (ph.wireless >= 1 ? CT.wireless_points : chans >= 1 ? CT.any_channel_points : 0);
  put('contactability', ph === null ? null : contactPts,
    ph === null ? 'insufficient' : 'scored', 0.8,
    [{ component: 'compliant_channels', contribution: chans }]);

  // ---- discount potential: payability (equity/basis) x psychology (anchors)
  const DP = P.discount_potential;
  const basis = val('F-133');
  const basisClass = val('F-051');
  const cash = val('F-134');
  const p2e = val('F-050');
  let dp = null; const dpParts = [];
  if (eq !== null || basis !== null || basisClass !== null || hr052 !== null) {
    dp = 0;
    if (eq !== null && eq >= DP.equity_mid_pct) {
      const p = eq >= DP.equity_deep_pct ? DP.equity_deep_points : DP.equity_mid_points;
      dp += p; dpParts.push({ component: 'equity_headroom', contribution: p });
    }
    if (basis !== null) {
      const band = DP.basis_bands.find(([t]) => basis >= t);
      if (band) { dp += band[1]; dpParts.push({ component: 'basis_appreciation', contribution: band[1] }); }
    }
    if (basisClass !== null && DP.low_basis_classes.includes(basisClass)) {
      dp += DP.low_basis_points; dpParts.push({ component: `low_basis:${basisClass}`, contribution: DP.low_basis_points });
    }
    if (cash === true && tenure !== null && tenure >= DP.cash_tenure_min_years) {
      dp += DP.cash_points; dpParts.push({ component: 'seasoned_cash_basis', contribution: DP.cash_points });
    }
    if (p2e !== null && p2e >= DP.payable_pressure_ratio) {
      dp += DP.payable_pressure_points; dpParts.push({ component: 'payable_pressure_lever (IX-01)', contribution: DP.payable_pressure_points });
    }
    // IX-04: condition creates discount rationale only where renovated comps
    // PROVE the spread exists and repairs don't consume it
    if (hr052 && typeof hr052 === 'object' && hr052.headroom > 0) {
      const cover = rr132?.repair_to_renovated_spread ?? null;
      const p = cover !== null && cover <= DP.rehab_cover_strong ? DP.rehab_cover_strong_points
        : (cover === null || cover <= DP.rehab_cover_ok) ? DP.rehab_cover_ok_points : 0;
      if (p) { dp += p; dpParts.push({ component: 'rehab_headroom_measured (IX-04)', contribution: p }); }
    }
    // retail-expectation damper: pristine house + little embedded gain =>
    // owner anchored at retail; discount capacity is psychological, not just fiscal
    if (cond !== null && cond <= DP.retail_condition_max_rank && basis !== null && basis < DP.retail_basis_below) {
      dp = Math.round(dp * DP.retail_expectation_mult);
      dpParts.push({ component: 'retail_expectation_damper_x0.5', contribution: null });
    }
    dp = Math.min(DP.cap, dp);
  }
  put('discount_potential', dp, dp === null ? 'insufficient' : 'scored',
    basis !== null ? 0.6 : (eq !== null ? 0.5 : 0.3), dpParts);

  // ---- market context families (raw units; blocked without snapshot)
  for (const [fam, fid] of [['market_liquidity', 'F-056'], ['buyer_demand', 'F-058'], ['expected_economic_value', 'F-060']]) {
    const st = state(fid);
    put(fam, st === 'known' ? val(fid) : null, st === 'known' ? 'scored' : 'blocked',
      st === 'known' ? 0.6 : 0, [{ component: fid, contribution: st === 'known' ? val(fid) : null }]);
  }

  // ---- V1.3 owner resolution (identity route governs the property action;
  // renter flags are person-scoped and NEVER directly set the property route)
  const ownerRes = val('F-114') ?? null;
  const identityRoute = ownerRes?.identity_route
    ?? (val('F-112') === true ? 'blocked_not_owner' : 'owner_outreach_eligible');
  const ownerResolved = identityRoute === 'owner_outreach_eligible';

  // ---- dealability (multiplier: can this close as an owner purchase). A hard
  // property block is now the CONFIRMED renter-only case (no owner of record) or
  // REO — never a bare person-level renter flag when an owner exists.
  const DL = P.dealability;
  const blockers = val('F-053')?.blockers ?? [];
  const occ = val('F-054');
  const reo = stage === 'reo' || blockers.includes('reo');
  const confirmedBlock = identityRoute === 'blocked_not_owner';
  const shortSaleRoute = DL.short_sale_stage.includes(stage) && eq !== null && eq < DL.equity_critical_pct;
  let deal = 1.0; const dlParts = [];
  if (confirmedBlock || reo) { deal = 0; dlParts.push({ component: confirmedBlock ? 'confirmed_not_owner_block' : 'reo_exclusion', contribution: 0 }); }
  else if (activeListing) {
    // IX-10: an ACTIVE listing is a routing gate — the agent represents the
    // property; owner-outreach dealability collapses, motivation untouched
    deal = DL.active_listing_mult;
    dlParts.push({ component: 'active_listing_agent_flow (IX-10)', contribution: deal });
  } else if (shortSaleRoute) { deal = DL.short_sale_route_mult; dlParts.push({ component: 'short_sale_route_x0.35 (IX-17)', contribution: deal }); }
  else {
    if (eq !== null) {
      const m = eq < DL.equity_critical_pct ? DL.equity_critical_mult
        : eq < DL.equity_thin_pct ? DL.equity_thin_mult
          : eq >= DL.equity_deep_pct ? DL.equity_deep_mult
            : eq >= DL.equity_strong_pct ? DL.equity_strong_mult : 1;
      if (m !== 1) { deal *= m; dlParts.push({ component: `equity_headroom_x${m}`, contribution: m }); }
    }
    if (occ === 'tenant_occupied') { deal *= DL.tenant_occupied_mult; dlParts.push({ component: 'tenant_occupied_x0.95', contribution: DL.tenant_occupied_mult }); }
    if (!dlParts.length) dlParts.push({ component: 'no_hard_blockers_observed', contribution: 1 });
  }
  deal = Math.round(deal * 1000) / 1000;
  put('dealability', deal, 'scored', eq !== null ? 0.65 : 0.45, dlParts);

  // ---- market scaler (scales value/feasibility, NEVER motivation — IX-11)
  const MS = P.market_scaler;
  const spread = out.expected_economic_value.score;
  const velocity = out.market_liquidity.score;
  let mkt = 1.0; const mktParts = [];
  if (spread !== null) {
    const m = spread >= MS.spread_strong ? MS.spread_strong_mult
      : spread >= MS.spread_ok ? MS.spread_ok_mult
        : spread > 0 ? MS.spread_thin_mult : MS.spread_negative_mult;
    mkt *= m; mktParts.push({ component: `guarded_spread_x${m}`, contribution: m });
  }
  if (velocity !== null) {
    const m = velocity >= MS.velocity_strong ? MS.velocity_strong_mult
      : velocity < MS.velocity_thin ? MS.velocity_thin_mult : 1;
    if (m !== 1) { mkt *= m; mktParts.push({ component: `sale_velocity_x${m}`, contribution: m }); }
  }
  if (spread === null && velocity === null) mktParts.push({ component: 'market_blocked_neutral_x1.0', contribution: 1 });
  mkt = Math.max(MS.clamp[0], Math.min(MS.clamp[1], Math.round(mkt * 1000) / 1000));

  // ---- execution priority: gates x scalers x (motivation + value terms)
  const motivationFams = ['seller_propensity', 'financial_pressure', 'legal_title_pressure',
    'foreclosure_urgency', 'property_distress', 'physical_obsolescence', 'landlord_fatigue', 'portfolio_liquidation'];
  const motivation = motivationFams.reduce((s, f) => s + (out[f].score ?? 0), 0);
  const coverage = motivationFams.filter((f) => out[f].score_state === 'scored').length / motivationFams.length;
  const f102 = val('F-102');
  const qualityDisagree = val('F-101')?.disagree === true
    || (f102 !== null && typeof f102 === 'object' && (f102.rel ?? 0) > 0.001);

  // V1.3 routing: property state (reo) first; then owner-resolution route when
  // the owner is NOT cleanly outreach-eligible (entity/conflict/resolution/
  // confirmed-block); only a resolved owner reaches the property-state routing
  // (active listing / short sale / IX-19 / probate / owner_outreach). A renter
  // flag alone never routes the property — it suppresses the person.
  const unreachable = (ph?.compliant_phones ?? 0) === 0 && (em ?? 0) === 0;
  const ix19Distress = ['nod', 'nos_nts', 'auction_scheduled'].includes(stage)
    || (tax?.delinquent === true && (tax.years_deep ?? 0) >= 2);
  const route = reo ? 'excluded_reo'
    : !ownerResolved ? identityRoute      // entity_authority_resolution | manual_review_renter_owner_conflict | owner_resolution_required | blocked_not_owner
      : activeListing ? 'agent_flow_active_listing'
        : shortSaleRoute ? 'short_sale_or_skip'
          : (ix19Distress && eq !== null && eq >= 30 && unreachable) ? 'alternate_channel_escalation'
            : (estate === 'death_or_probate_evidence' && !fiduciary) ? 'probate_counsel_first'
              : 'owner_outreach';

  // priority gate: only a CONFIRMED not-owner block (or REO via dealability=0)
  // zeroes priority. Unresolved/conflict/entity routes keep their computed
  // (identity-damped) priority so they rank in their resolution queues.
  const blockZero = route === 'blocked_not_owner' ? 0 : 1;
  const gates = blockZero * idMul * auth;
  const scalers = deal * mkt;
  const priority = Math.round(gates * scalers * (motivation + (dp ?? 0) + contactPts));
  const conf = Math.min(0.95, 0.35 + 0.35 * idMul + 0.15 * coverage + (qualityDisagree ? 0 : 0.1));
  const contactSuppressed = ownerRes?.person_contact_suppressed ?? [];
  put('execution_priority', priority, 'scored', Math.round(conf * 100) / 100,
    [{ component: 'motivation_families', contribution: motivation },
      { component: 'discount_potential', contribution: dp ?? 0 },
      { component: 'contactability_points', contribution: contactPts },
      { component: 'identity_multiplier', contribution: idMul },
      { component: 'authority_multiplier', contribution: auth },
      { component: 'dealability_multiplier', contribution: deal },
      { component: 'market_multiplier', contribution: mkt },
      { component: 'owner_resolution_gate', contribution: blockZero },
      { component: 'quality_haircut_applied', contribution: qualityDisagree ? P.quality_haircut.confidence_mult_on_disagree : 1 }],
    { route, horizon_days: horizonDays, motivation_coverage: Math.round(coverage * 100) / 100,
      owner_resolution_status: ownerRes?.owner_resolution_status ?? null,
      person_contact_suppressed: contactSuppressed,
      outreach_eligible_person_ids: ownerRes?.outreach_eligible_person_ids ?? [] });
  return out;
}
