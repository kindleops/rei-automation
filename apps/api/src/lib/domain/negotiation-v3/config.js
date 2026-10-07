// ─── negotiation-v3/config.js ───────────────────────────────────────────────
// Negotiation Engine v3 parameters (owner brief §41–58). Every number here is
// a PARAMETER, not a law: each carries the evidence it rests on, or says that
// evidence is missing. Change a value → bump NEGOTIATION_V3_CONFIG_VERSION
// (every plan and every logged quote records the version it ran under).
//
// NOTATION (all dollars, totals; MF per-unit = total / units)
//   C  ceiling           authoritative MAO from the offer authority (D: investor cluster × (1 − margin))
//   R  offer             the authority's recommended offer (R ≤ C or no plan)
//   I  investor price    D's investor price cluster (entity/LLC off-market purchases), when supplied
//   AL autonomous limit  R + autonomy_share × (C − R), and ≤ C × (1 − min_reserve_pct)
//   T  target            min(R, AL)  — "target = D's offer"
//   AF anchor floor      I × (1 − anchor_floor.discount_from_investor_price)  (none without I)
//   O  opening anchor    T × (1 − d),  d = clamp(d_base + Σ adjustments, d_min, d_max); O ≥ AF; O < ask
//   ladder               O → c1 → c2 → AL, steps = decreasing shares of (AL − O)
//
// OWNER 10-07: there is NO "value − repairs" floor (the value is already as-is;
// repairs are never subtracted again). NEVER BLANK: whenever the authority
// supplies C and R the plan carries numbers for the operator; only AUTONOMOUS
// sending is gated, by confidence_grade + fallback_rung (+ authorized, lane).
//
// Pressure / situation (A1) only moves d and the concession multipliers.
// C, R, T, AL and AF are pressure-INVARIANT (§57) — property-tested.

export const NEGOTIATION_V3_VERSION = "negotiation_engine_v3";
export const NEGOTIATION_V3_CONFIG_VERSION = "neg_v3_config_2026_10_07b";

export const NEGOTIATION_V3_DEFAULTS = Object.freeze({
  // ── §48 AUTONOMOUS LIMIT ─────────────────────────────────────────────────
  // Evidence (prod, 2026-10-06, the 7 offer-authoritative rows under current
  // policy; negotiation-signal-opening-config.js): C − R is 10.0% / 10.7% /
  // 20.2% of C (P5/P50/P95). Half of that reserve ⇒ AL ≈ C − 5.4% at the median,
  // close to the owner's illustration (255 → 235 is −7.8%). NO outcome evidence
  // exists yet (0 live negotiations) — this is a starting parameter.
  autonomy_share_of_reserve: 0.5,
  min_reserve_pct: 0.03, // AL never closer than 3% to C, even when R ≈ C

  // ── §43 TARGET ───────────────────────────────────────────────────────────
  // The engine's recommended offer already prices the target assignment fee
  // (evidence.engine.target_assignment_fee = $15K). Not the min comp, not the
  // ask, not the ceiling.
  target_basis: "engine_recommended",

  // ── ANCHOR FLOOR (owner 10-07) — relative to the INVESTOR price ─────────
  // The anchor is never below I × (1 − 0.25). Owner example: investors buy at
  // $130K, we're ~$110–115K (C ≈ I × 0.87); the deepest anchor is $97.5K.
  // Evidence for 0.25: owner instruction ("e.g. −25%"); no outcome data yet.
  // Without I (prod v2 rows) the anchor is bounded only by d_max below target.
  anchor_floor: Object.freeze({ basis: "investor_price", discount_from_investor_price: 0.25 }),

  // ── AUTONOMY GATE (owner 10-07) — by GRADE, never by blankness ───────────
  // A QUOTE leaves without a human only when: authority.authorized, fresh,
  // confidence_grade ∈ grades, fallback_rung ≤ max_fallback_rung, lane ∈ lanes,
  // units resolved, no identity conflict — AND both flags on. Everything else
  // is a HUMAN proposal with the numbers shown. Grades/rungs are D's scale
  // (CONTRACT_offer_authority.md); ungraded prod-v2 rows fall back to
  // `authorized` alone ("authorized_only") until D grades them.
  autonomy: Object.freeze({
    grades: Object.freeze(["A", "B"]),
    max_fallback_rung: 1,
    lanes: Object.freeze(["sfr"]), // MF 2–4 / 5+ stay human until the owner approves
    ungraded: "authorized_only",
  }),

  // ── §44 OPENING ANCHOR DEPTH (fraction below T) ──────────────────────────
  // Illustration §45: C 260 / T 225 / ask 245 → 210–220 (d 2–7%). Evidence for
  // the adjustments themselves: none yet (0 live negotiations, 0 outcomes) —
  // they are bounded, small and logged; calibrate after ≥ 30 negotiations.
  anchor: Object.freeze({
    d_base: 0.04,
    d_min: 0.02,
    d_max: 0.12,
    ask_gap_k: 0.1, // + k × min((ask − T)/T, cap)
    ask_gap_cap: 0.6,
    pressure_threshold: 60, // A1 component (0–100) at/above which pressure counts
    pressure_k: 0.02, // + k × (p − threshold)/(100 − threshold)
    fatigue_k: 0.01,
    equity_rich_low_urgency: -0.01, // §56: high equity + low urgency ⇒ don't assume distress
    buyer_depth_strong: -0.01,
    buyer_depth_weak: 0.01,
    condition_unknown: 0.01, // hedge only; repairs are IN the ceiling, never re-subtracted
    tenant_occupied: 0.01,
  }),

  // ── §46–47 LADDER ────────────────────────────────────────────────────────
  // Decreasing planned shares of (AL − O): shrinking moves signal the limit
  // (same shape as the owner-approved signal-opening ladder 0.40/0.25/0.20/0.15,
  // compressed to the brief's anchor → c1 → c2 → final-autonomous).
  ladder: Object.freeze({
    shares: Object.freeze([0.45, 0.3, 0.25]),
    // Counter behaviour multipliers (identical semantics to LADDER in
    // negotiation-signal-opening-config.js):
    closing_gap_pct: 8, // seller within 8% of our number ⇒ close faster
    closing_multiplier: 1.5,
    flexible_move_pct: 5, // seller moved ≥ 5% ⇒ we stay firmer
    firm_multiplier: 0.5,
    high_pressure_multiplier: 0.75, // pressured seller ⇒ smaller steps (never a higher ceiling)
    max_consecutive_holds: 2,
    min_step: 500,
  }),

  rounding: Object.freeze([
    Object.freeze({ at_or_above: 100_000, step: 1_000 }),
    Object.freeze({ at_or_above: 0, step: 500 }),
  ]),

  // ── §58 UNREALISTIC (same thresholds as Conversation v3 V3_CONFIG) ───────
  far_above_ratio: 1.5,
  far_above_delta: 100_000,

  // ── no-false-comp-claim (§51, owner lock 3) ──────────────────────────────
  comp_claim: Object.freeze({
    band: 0.1, // a comp "supports" X when its price is within ±10% of X
    min_support: 2,
    sfr_radius_miles: 1.0,
    sfr_max_age_months: 12,
    mf_radius_miles: 3.0,
    mf_max_age_months: 18,
    min_sale_price: 10_000,
  }),

  // ── §53–54 MULTIFAMILY ───────────────────────────────────────────────────
  mf: Object.freeze({
    per_unit_step: 1_000, // "we'd likely be around $Z a door" (Z floored to $1K)
    band_step: 1_000, // "similar buildings are trading around $X–Y a door" (D's per-door band)
  }),

  // Conversation order: Autopilot v2 asks condition before any number (§31).
  require_condition_before_number: true,
});

export default NEGOTIATION_V3_DEFAULTS;
