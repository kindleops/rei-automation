// ─── assignmentMarginPolicy.js ──────────────────────────────────────────────
// DEAL-AWARE PROFIT PRESERVATION
//
// WHAT WAS WRONG. offerCalculation() carved a FLAT DEFAULT_TARGET_ASSIGNMENT_FEE
// ($15,000) out of the authorized ceiling:
//
//   offer   = ceiling * (1 - haircut - motivation + demand) - TARGET
//   expFee  = ceiling - offer = TARGET + ceiling * (haircut + motivation - demand)
//
// so the expected assignment fee was ~$15k + ~1% of ceiling for EVERY deal, and
// the preserved margin collapsed as deals got larger:
//
//   ceiling   $100,000 -> ~$15,900  (15.9% of ceiling)
//   ceiling   $250,000 -> ~$17,200  ( 6.9%)
//   ceiling   $750,000 -> ~$21,500  ( 2.9%)
//   ceiling $1,200,000 -> ~$25,400  ( 2.1%)
//
// $15,000 was never meant to be a maximum; it behaved like one.
//
// WHERE THE POLICY COMES FROM. This does NOT invent tiers. The estate has NO
// realized assignment economics to calibrate against (seller_offers = 0,
// closing_cases = 0, zero opportunities carrying an offer amount; the 151
// non-null expected_assignment_fee values are engine OUTPUTS, not closed
// deals). So V1 reuses the dynamic-margin business rule that already exists in
// this codebase -- offerEconomics.dynamicMarginPct(), driven by
// MARGIN_BASE_PCT / MARGIN_MIN_USD / MARGIN_MAX_PCT in modelConstants.js. That
// rule was written for the V3 cash-offer path, which is disabled in production
// (ACQUISITION_ENGINE_V3_ENABLED=false), which is exactly why V2 still fell back
// to the flat constant.
//
// EMPIRICAL vs POLICY ASSUMPTION -- stated plainly:
//   * EMPIRICAL (measured this session): the ceiling itself, repairs, comp
//     count, valuation/overall confidence, buyer sample size and its
//     contamination verdict.
//   * POLICY ASSUMPTION (pre-existing business rules, NOT calibrated against
//     realized deals): MARGIN_BASE_PCT, MARGIN_MIN_USD, MARGIN_MAX_PCT, the
//     demand/confidence/exit-size adjustment steps, and the $15,000 floor.
//     None of these are backed by realized assignment data, because none
//     exists. They are transparent assumptions, not findings.
//
// INPUT TRUST AUDIT (mission section 3):
//   TRUSTED    effective_authorized_ceiling  - already clamped by the monetary
//                                              ceiling invariant; cannot be
//                                              expanded by buyer behavior
//   TRUSTED    asset family, repairs, confidence, valuation_confidence
//   CONDITIONAL buyer_demand_score / liquidity_score - these derive from the
//              SAME buyer_purchase_events_v2 sample that produced the
//              $21,284,800 and $122,278,300 contaminated ceilings. They are
//              used ONLY when the buyer-ceiling authority verdict says the
//              sample was defended. Otherwise the demand adjustment is skipped
//              in BOTH directions, so undefended buyer data can neither inflate
//              nor deflate profit expectations.
//   UNUSED     seller distress / motivation - deliberately not used to size
//              profit. It already discounts the offer elsewhere; letting it
//              also widen our margin would price off seller pressure twice.
//
// ── MARGIN VOCABULARY (each term means exactly one thing) ──────────────────
//
//   minimum_margin          HARD FLOOR. Below this a cash deal is not worth
//                           doing. Negotiation may never concede past it.
//   target_margin           ASPIRATIONAL. The amount the offer formula subtracts
//                           from the ceiling BEFORE the caller's own market
//                           adjustments. Those adjustments may move the realized
//                           fee above OR below this number. It is a goal, not a
//                           guarantee -- do not read it as protection.
//   protected_margin        ENFORCED FLOOR on the INITIAL automatic offer. The
//                           opening offer is clamped so the realized fee is never
//                           below it. V1 sets this equal to minimum_margin.
//   expected_assignment_fee ACTUAL, always derived, never an input:
//                             effective_authorized_ceiling - recommended_offer
//   negotiable_margin       expected_assignment_fee - minimum_margin. What the
//                           concession ladder is allowed to give away.
//
// Invariants:
//   expected_assignment_fee >= protected_margin      (clamped at offer time)
//   recommended_offer       <= effective_authorized_ceiling
//   negotiable_margin       >= 0
//
// DOUBLE-COUNTING. dynamicMarginPct() was written for V3's buildCashOffer(),
// where buyer demand and confidence appear ONCE -- inside the margin percentage
// -- and the margin is then subtracted INTO maximumSafe, so every derived price
// sits below it and the margin is structurally protected. V2's offerCalculation
// already expresses demand and confidence separately (demandPremium,
// confidenceHaircut, motivationDiscount) and applies them to the offer itself.
// Transplanting the V3 percentage wholesale therefore counted both signals
// TWICE in the same direction, amplifying them ~1.3-1.4x. Callers that apply
// their own market adjustments must say so, and the policy then contributes
// only the structural part (asset family + deal size) that the caller does not
// already model.

import {
  MARGIN_BASE_PCT,
  MARGIN_MIN_USD,
  MARGIN_MAX_PCT,
  clamp,
  num,
  round,
  roundMoney,
} from './modelConstants.js';

export const ASSIGNMENT_MARGIN_POLICY_VERSION = 'assignment_margin_v1';

/** Lower bound on a margin percentage, mirroring offerEconomics.dynamicMarginPct. */
const MARGIN_MIN_PCT = 0.04;

/** Asset-family key resolution, tolerant of the engine's several spellings. */
function familyKey(assetFamily) {
  const f = String(assetFamily ?? '').trim().toUpperCase();
  if (f === 'RESIDENTIAL' || f === 'RESIDENTIAL_SINGLE' || f === 'SFR') return 'RESIDENTIAL_SINGLE';
  if (f === 'SMALL_MULTI') return 'SMALL_MULTI';
  if (f === 'MULTIFAMILY') return 'MULTIFAMILY';
  if (f === 'COMMERCIAL') return 'COMMERCIAL';
  if (f === 'LAND') return 'LAND';
  if (f === 'SPECIAL') return 'SPECIAL';
  return 'UNKNOWN';
}

/**
 * How much spread should this specific deal try to preserve?
 *
 * @param {object}  args
 * @param {number}  args.effective_authorized_ceiling  the SAFE monetary ceiling
 * @param {string}  args.asset_family
 * @param {number}  args.buyer_demand_score            0-100 (conditional trust)
 * @param {number}  args.liquidity_score               0-100 (conditional trust)
 * @param {number}  args.confidence                    overall engine confidence
 * @param {number}  args.valuation_confidence
 * @param {boolean} args.buyer_ceiling_authoritative   was the buyer sample defended?
 * @param {number}  args.minimum_margin_floor          absolute floor (default $15,000)
 * @returns {{minimum_margin:number, target_margin:number, protected_margin:number,
 *            max_available_margin:number, margin_pct:number, policy_version:string,
 *            reasons:string[], inputs:object}}
 */
export function resolveTargetAssignmentMargin({
  effective_authorized_ceiling = null,
  asset_family = 'UNKNOWN',
  buyer_demand_score = null,
  liquidity_score = null,
  confidence = null,
  valuation_confidence = null,
  buyer_ceiling_authoritative = false,
  minimum_margin_floor = 15_000,
  // Set by callers (like V2 offerCalculation) that already apply their own
  // demand / confidence adjustments to the offer. Prevents double-counting.
  market_adjustments_applied_by_caller = false,
} = {}) {
  const reasons = [];
  const ceiling = num(effective_authorized_ceiling);
  const floor = Math.max(0, num(minimum_margin_floor) ?? 0);
  const family = familyKey(asset_family);

  // No ceiling => no authority => no margin to reason about.
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return {
      minimum_margin: floor,
      target_margin: floor,
      protected_margin: floor,
      max_available_margin: 0,
      margin_pct: 0,
      policy_version: ASSIGNMENT_MARGIN_POLICY_VERSION,
      reasons: ['no_authorized_ceiling'],
      inputs: { effective_authorized_ceiling: null, asset_family: family },
    };
  }

  // ── percentage of the authorized ceiling to preserve ───────────────────────
  let pct = MARGIN_BASE_PCT[family] ?? MARGIN_BASE_PCT.UNKNOWN;
  reasons.push(`base_${family.toLowerCase()}_${round(pct * 100, 1)}pct`);

  const demand = num(buyer_demand_score);
  const conf = num(confidence);
  const vc = num(valuation_confidence);

  if (market_adjustments_applied_by_caller) {
    // The caller models demand/confidence itself; contributing them again here
    // would count the same evidence twice in the same direction.
    reasons.push('market_adjustments_applied_by_caller');
  } else {
  // Buyer-behavior signals are used ONLY when the buyer sample was actually
  // defended. Undefended behavior may neither inflate nor deflate our margin.
  if (buyer_ceiling_authoritative && Number.isFinite(demand)) {
    if (demand < 40) {
      pct += 0.03;
      reasons.push('weak_buyer_demand_widens_margin');
    } else if (demand > 70) {
      pct -= 0.02;
      reasons.push('strong_buyer_demand_narrows_margin');
    }
  } else if (Number.isFinite(demand)) {
    reasons.push('buyer_demand_ignored_undefended_buyer_evidence');
  }

  if (Number.isFinite(conf)) {
    if (conf < 50) {
      pct += 0.03;
      reasons.push('low_confidence_widens_margin');
    } else if (conf > 80) {
      pct -= 0.01;
      reasons.push('high_confidence_narrows_margin');
    }
  }

  if (Number.isFinite(vc) && vc < 65) {
    pct += 0.02;
    reasons.push('thin_valuation_evidence_widens_margin');
  }
  }

  if (ceiling > 1_000_000) {
    pct -= 0.02;
    reasons.push('large_deal_narrows_margin_pct');
  } else if (ceiling < 150_000) {
    pct += 0.02;
    reasons.push('small_deal_widens_margin_pct');
  }

  pct = clamp(pct, MARGIN_MIN_PCT, MARGIN_MAX_PCT);

  // ── the four margin quantities ─────────────────────────────────────────────
  // The percentage margin is what the deal can support; the floor is what makes
  // any cash deal worth doing at all. Taking the max means the policy can only
  // ever preserve MORE than the old flat constant, never less, so no deal
  // becomes easier to approve than it is today.
  const pctMargin = roundMoney(ceiling * pct);
  const target = Math.max(floor, pctMargin);
  const maxAvailable = Math.max(floor, roundMoney(ceiling * MARGIN_MAX_PCT));

  if (target === floor && pctMargin < floor) {
    reasons.push('minimum_floor_governs_small_deal');
  } else {
    reasons.push('deal_supports_margin_above_floor');
  }

  return {
    minimum_margin: floor,
    // ASPIRATIONAL -- the caller's market adjustments may undercut this.
    target_margin: target,
    // ENFORCED -- the initial automatic offer is clamped so the realized fee
    // never falls below this. V1 protects exactly the hard floor.
    protected_margin: floor,
    max_available_margin: maxAvailable,
    margin_pct: round(pct, 4),
    policy_version: ASSIGNMENT_MARGIN_POLICY_VERSION,
    reasons,
    inputs: {
      effective_authorized_ceiling: roundMoney(ceiling),
      asset_family: family,
      buyer_demand_score: demand,
      liquidity_score: num(liquidity_score),
      confidence: conf,
      valuation_confidence: vc,
      buyer_ceiling_authoritative: Boolean(buyer_ceiling_authoritative),
      minimum_margin_floor: floor,
    },
  };
}

/**
 * How far may negotiation concede? Margin may be given up down to the minimum,
 * never below, and conceding never touches the authorized ceiling.
 *
 * @returns {{concession_floor:number, may_concede:boolean, remaining_margin:number}}
 */
export function resolveConcessionFloor(policy = {}, already_conceded = 0, starting_margin = null) {
  const minimum = num(policy?.minimum_margin) ?? 0;
  // Negotiation gives away the margin the offer ACTUALLY preserved (the realized
  // expected fee), not the aspirational target.
  const start = num(starting_margin) ?? num(policy?.target_margin) ?? minimum;
  const conceded = Math.max(0, num(already_conceded) ?? 0);
  const remaining = Math.max(minimum, start - conceded);
  return {
    concession_floor: minimum,
    starting_margin: roundMoney(start),
    negotiable_margin: roundMoney(Math.max(0, start - minimum)),
    remaining_margin: roundMoney(remaining),
    may_concede: remaining > minimum,
  };
}

export default resolveTargetAssignmentMargin;
