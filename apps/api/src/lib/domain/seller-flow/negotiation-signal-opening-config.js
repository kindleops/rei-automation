// ─── negotiation-signal-opening-config.js ───────────────────────────────────
// CONFIG for the signal-based negotiation opening + concession ladder
// (negotiation-signal-opening.js). SHADOW ONLY behind NEGOTIATION_SIGNAL_OPENING
// (default OFF). Nothing here sends, prices live or writes.
//
// Every number below is versioned by SIGNAL_OPENING_CONFIG_VERSION; every
// shadow opening records the version it was computed under. Change a weight →
// bump the version.
//
// UNITS. A signal's `weight` is the most it can move the spread, in fractions
// of MAO (0.02 = 2% of MAO). A signal's score is in [-1, 1] AFTER its
// direction is applied: +1 = widen the spread (open lower: motivated seller /
// property risk), -1 = narrow it (open closer to MAO: the seller has a strong
// position or a non-starter number). contribution = weight × score.
//
// MODEL.  opening = MAO × (1 − spread)
//         spread  = clamp(base_spread + Σ contribution, min_spread, max_spread)
//         opening = max(opening, floor_pct × as_is_value)   (fair-offer floor)
//         floor > MAO  ⇒ no opening, human review.

export const SIGNAL_OPENING_CONFIG_VERSION = "neg_signal_opening_v1_2026_10_06";

// ═══════════════════════════════════════════════════════════════════════════
// SPREAD BOUNDS (per asset class) — SFR ONLY. Every other class is human.
// ═══════════════════════════════════════════════════════════════════════════
// Calibration (read-only, prod 2026-10-06, the 7 offer-authoritative rows
// computed under the current policy): MAO − recommended_cash_offer is 10.0% /
// 10.7% / 20.2% of MAO (P5 / P50 / P95). base 0.10 + the signals of a typical
// list lead (≈ +0.04–0.06: dated condition, high equity, absentee, long
// tenure) lands ≈ 0.14–0.16; open_at_or_below_recommended raises the
// effective min_spread to 1 − recommended/MAO so the opening is never inside
// the offer range (owner goal: "open below our offer range") — unless the
// fair-offer floor is higher, and the floor wins. min 0.06 still leaves ≥ 6%
// of MAO to concede; max 0.22 sits at the fair-offer floor for a typical deal
// (MAO ≈ 0.63 × as-is ⇒ 0.78 × 0.63 ≈ 0.49 × as-is). Preliminary shadow run
// (v1 weights, base 0.12) pinned most leads near max — weights reduced.
// On a $165K MAO: base $19.8K, max $36.3K below MAO; on a $500K MAO the max is
// $110K — the owner's "$20K to six figures".
export const SPREAD_BOUNDS = Object.freeze({
  sfr: Object.freeze({ min_spread: 0.06, base_spread: 0.1, max_spread: 0.22, open_at_or_below_recommended: true }),
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIR-OFFER FLOOR — applies to EVERY seller.
// ═══════════════════════════════════════════════════════════════════════════
// floor = floor_pct × as_is_value, as_is_value = Decision Engine comp value
// (valuation_mid) − estimated repairs. Default 0.50:
//   • prod (same 7 rows): MAO / as-is = 0.61 / 0.63 / 0.65 (P5/P50/P95) and
//     recommended / as-is = 0.49 / 0.56 / 0.59. A floor at 0.55 sits ON the
//     recommended offer (no room to open below the offer range) and 0.65 is
//     ABOVE MAO for most deals, so the brief's 0.55–0.65 band cannot hold
//     without collapsing the opening onto MAO.
//   • 0.50 ⇒ no seller is ever opened at less than half of the house's as-is
//     value, whatever their signals — the protection binds hardest exactly on
//     heavy-distress deals, where a low opening would be most exploitative.
// Missing repairs ⇒ as-is = valuation_mid (a HIGHER floor: errs for the seller).
export const FAIR_OFFER_FLOOR = Object.freeze({ floor_pct: 0.5, as_is_basis: "valuation_mid_minus_estimated_repairs" });

// ═══════════════════════════════════════════════════════════════════════════
// CONCESSION LADDER
// ═══════════════════════════════════════════════════════════════════════════
// Planned rungs are DECREASING shares of the opening→walk-away gap (standard
// practice: shrinking moves signal the limit). Counters scale the next rung:
//   flexible seller (moved ≥ flexible_move_pct of their prior position) → we stay FIRM (× firm_multiplier)
//   closing seller  (their counter within closing_gap_pct of our offer)  → FASTER (× closing_multiplier)
//   no movement after our number                                         → HOLD (no concession)
// Never above walk-away (≤ MAO), never a concession larger than the
// remaining gap, never above the seller's own counter, monotone.
export const LADDER = Object.freeze({
  max_rounds: 4,
  rung_shares: Object.freeze([0.4, 0.25, 0.2, 0.15]),
  firm_multiplier: 0.5,
  closing_multiplier: 1.5,
  flexible_move_pct: 5,
  closing_gap_pct: 8,
  max_consecutive_holds: 2,
  min_step: 500,
  // Walk-away basis. "mao" = effective_authorized_ceiling (the owner's MAO,
  // as Autopilot v2). NOTE: in today's engine rows that ceiling equals the
  // buyer ceiling, so paying MAO leaves NO assignment fee; "margin_protected"
  // walks away at MAO − assignment_margin_floor instead. Owner decision.
  walk_away_basis: "mao",
});

// Rounding: openings are rounded DOWN to these steps, then re-clamped to
// [floor, walk-away].
export const ROUNDING = Object.freeze([
  Object.freeze({ at_or_above: 100_000, step: 1_000 }),
  Object.freeze({ at_or_above: 0, step: 500 }),
]);

// ═══════════════════════════════════════════════════════════════════════════
// SIGNALS — owner-approved inputs, each with direction + weight.
// `class` personal_attribute = prospect-level attribute (IC8 fairness class):
// fairness report + counsel required before any go-live.
// ═══════════════════════════════════════════════════════════════════════════
export const SIGNALS = Object.freeze([
  // ── Property ────────────────────────────────────────────────────────────
  { key: "condition", group: "property", weight: 0.015, direction: "worse condition widens" },
  { key: "repair_ratio", group: "property", weight: 0.012, direction: "repairs / as-is value: higher widens" },
  { key: "vacancy", group: "property", weight: 0.015, direction: "vacant widens" },
  { key: "listing_status", group: "property", weight: 0.015, direction: "actively listed narrows; expired/withdrawn widens" },
  { key: "days_on_market", group: "property", weight: 0.01, direction: "longer sitting widens" },
  { key: "flood_risk", group: "property", weight: 0.01, direction: "FEMA high-risk zone widens" },
  { key: "building_age", group: "property", weight: 0.003, direction: "older widens; < 20 yrs narrows" },
  // ── Financial ───────────────────────────────────────────────────────────
  { key: "equity", group: "financial", weight: 0.015, direction: "high equity widens; < 20% narrows" },
  { key: "loan_to_mao", group: "financial", weight: 0.015, direction: "loan balance near MAO narrows (a lower number cannot close)" },
  { key: "liens", group: "financial", weight: 0.01, direction: "active lien widens" },
  { key: "tax_delinquency", group: "financial", weight: 0.015, direction: "delinquent widens (more with ≥ 2 years)" },
  { key: "years_owned", group: "financial", weight: 0.008, direction: "long tenure widens; < 3 yrs narrows" },
  // ── Situation ───────────────────────────────────────────────────────────
  { key: "absentee", group: "situation", weight: 0.008, direction: "out-of-state / absentee widens" },
  { key: "tired_landlord", group: "situation", weight: 0.008, direction: "tired-landlord evidence widens" },
  { key: "inherited_probate_trust", group: "situation", weight: 0.015, direction: "probate / inherited widens; trust half" },
  { key: "code_violations", group: "situation", weight: 0.01, direction: "code violation widens" },
  { key: "portfolio_size", group: "situation", weight: 0.01, direction: "larger portfolio (sophisticated seller) narrows" },
  { key: "distress", group: "situation", weight: 0.02, direction: "preforeclosure / foreclosure / auction widens" },
  // ── Conversation ────────────────────────────────────────────────────────
  { key: "urgency_language", group: "conversation", weight: 0.02, direction: "stated urgency widens" },
  { key: "reply_latency", group: "conversation", weight: 0.005, direction: "fast replies widen; > 24 h narrows" },
  { key: "price_question", group: "conversation", weight: 0.01, direction: "dodged the price question widens; answered 0" },
  { key: "counter_behaviour", group: "conversation", weight: 0.01, direction: "seller already dropping widens; refused to move narrows" },
  // ── Prospect financial demographics (personal_attribute) ────────────────
  { key: "household_income", group: "prospect_financial", weight: 0.005, class: "personal_attribute", direction: "lower income widens" },
  { key: "net_asset_value", group: "prospect_financial", weight: 0.005, class: "personal_attribute", direction: "lower net assets widens" },
  { key: "buying_power", group: "prospect_financial", weight: 0.005, class: "personal_attribute", direction: "weaker buying power widens" },
  // ── Owner-included, guarded (per-state × per-field policy below) ────────
  { key: "marital_status", group: "guarded", weight: 0.01, class: "personal_attribute", guarded: true, direction: "divorce / separation stated widens; married / single = 0" },
  { key: "age", group: "guarded", weight: 0.01, class: "personal_attribute", guarded: true, direction: "70+ widens (nominal) — EFFECTIVE WEIGHT 0 by default" },
]);

// ═══════════════════════════════════════════════════════════════════════════
// PER-STATE × PER-FIELD POLICY
// ═══════════════════════════════════════════════════════════════════════════
// mode: "enabled"     computed, logged, weighted
//       "shadow_only" computed, logged, effective weight 0
//       "off"         not computed (value withheld from the record)
// Resolution: owner_overrides[field][market] ?? owner_overrides[field][state]
//   ?? (covered state/market ⇒ covered_mode) ?? owner_overrides[field].default
//   ?? default_mode. Unknown / missing state ⇒ unknown_state_mode.
//
// MARITAL STATUS — OFF where the state statute governing real-property
// transactions covers marital status (citations in MARITAL_STATUS_STATE_LAW).
// AGE — shadow_only EVERYWHERE until the owner confirms with counsel; states
// (and markets) whose real-property law covers age stay shadow_only even if
// the owner flips the default — only an explicit per-state override moves them.
//
// Statute review 2026-10-06 (state real-property / fair-housing statutes for
// every state with a canonical market). NOT LEGAL ADVICE — counsel must
// confirm before any go-live. Federal baseline: FHA 42 U.S.C. §§3604-3605
// covers neither marital status nor age; ECOA 15 U.S.C. §1691(a) covers both
// but only in CREDIT transactions (relevant to seller finance / subject-to).
export const STATE_LAW = Object.freeze({
  // state: { marital: citation|null, age: citation|null, local: note }
  AL: { marital: null, age: null, cite: "Ala. Code §24-8-4" },
  AZ: { marital: null, age: null, cite: "A.R.S. §41-1491.14" },
  CA: { marital: "Gov. Code §12955", age: "Civ. Code §§51, 51.2 (Unruh)", cite: "Gov. Code §12955" },
  CO: { marital: "C.R.S. §24-34-502", age: null, cite: "C.R.S. §24-34-502", local: "Denver adds age 40+" },
  CT: { marital: "C.G.S. §46a-64c", age: "C.G.S. §46a-64c", cite: "C.G.S. §46a-64c" },
  FL: { marital: null, age: null, cite: "Fla. Stat. §760.23", local: "Miami-Dade Code ch. 11A adds marital status + age" },
  GA: { marital: null, age: null, cite: "O.C.G.A. §8-3-202", local: "Atlanta ordinance adds marital status + age (section unverified)" },
  IA: { marital: null, age: null, cite: "Iowa Code §216.8" },
  ID: { marital: null, age: null, cite: "Idaho Code §67-5909(8)" },
  IL: { marital: "775 ILCS 5/3-102, 5/1-103(Q)", age: "775 ILCS 5/1-103(A) (40+)", cite: "775 ILCS 5/3-102", local: "Cook County HRO §42-38, Chicago HRO" },
  IN: { marital: null, age: null, cite: "Ind. Code 22-9.5-5" },
  KS: { marital: null, age: null, cite: "K.S.A. §44-1016" },
  KY: { marital: null, age: null, cite: "KRS §344.360" },
  LA: { marital: null, age: null, cite: "La. R.S. 51:2606" },
  MD: { marital: "Md. State Gov't §20-705", age: null, cite: "Md. State Gov't §20-705" },
  MI: { marital: "MCL §37.2502", age: "MCL §37.2502", cite: "MCL §37.2502 (ELCRA, real estate transactions)" },
  MN: { marital: "Minn. Stat. §363A.09 subd. 1", age: null, cite: "Minn. Stat. §363A.09", local: "Minneapolis Code ch. 139 and St. Paul ch. 183 add age" },
  MO: { marital: null, age: null, cite: "RSMo §213.040" },
  NC: { marital: null, age: null, cite: "N.C.G.S. §41A-4" },
  NE: { marital: null, age: null, cite: "Neb. Rev. Stat. §20-318" },
  NM: { marital: "NMSA §28-1-7(G) (spousal affiliation)", age: null, cite: "NMSA §28-1-7(G)" },
  NV: { marital: null, age: null, cite: "NRS §118.100" },
  NY: { marital: "N.Y. Exec. Law §296(5)", age: "N.Y. Exec. Law §296(5)", cite: "N.Y. Exec. Law §296(5)" },
  OH: { marital: null, age: null, cite: "ORC §4112.02(H)", local: "Columbus City Code ch. 2331 adds age" },
  OK: { marital: null, age: null, cite: "25 O.S. §1452" },
  PA: { marital: null, age: "43 P.S. §955(h) (40+)", cite: "43 P.S. §955(h)", local: "Philadelphia + Pittsburgh ordinances add marital status" },
  RI: { marital: "R.I.G.L. §34-37-4", age: "R.I.G.L. §34-37-4", cite: "R.I.G.L. §34-37-4" },
  TN: { marital: null, age: null, cite: "T.C.A. §4-21-601" },
  TX: { marital: null, age: null, cite: "Tex. Prop. Code §301.021", local: "Austin City Code ch. 5-1 adds marital status + age" },
  UT: { marital: null, age: null, cite: "Utah Code §57-21-5" },
  VA: { marital: null, age: "Va. Code §36-96.3 (elderliness, 55+)", cite: "Va. Code §36-96.3" },
  WA: { marital: "RCW 49.60.222", age: null, cite: "RCW 49.60.222", local: "Seattle adds age" },
  WI: { marital: "Wis. Stat. §106.50(1)", age: "Wis. Stat. §106.50(1m) (18+)", cite: "Wis. Stat. §106.50" },
});

// Markets whose CITY/COUNTY ordinance adds the field even though the state
// statute does not (conservative: treated like a covering state).
export const LOCAL_ORDINANCE_MARKETS = Object.freeze({
  marital_status: Object.freeze(["austin-tx", "miami-fl", "atlanta-ga", "philadelphia-pa", "pittsburgh-pa"]),
  age: Object.freeze(["minneapolis-mn", "austin-tx", "miami-fl", "atlanta-ga", "columbus-oh", "seattle-wa"]),
});

const coveringStates = (field) =>
  Object.freeze(Object.entries(STATE_LAW).filter(([, v]) => Boolean(v[field])).map(([s]) => s));

export const MARITAL_COVERED_STATES = coveringStates("marital");
export const AGE_COVERED_STATES = coveringStates("age");

export const FIELD_MODES = Object.freeze({ ENABLED: "enabled", SHADOW_ONLY: "shadow_only", OFF: "off" });

/**
 * Per-field × per-state policy. Owner changes go in `owner_overrides`
 * ({ marital_status: { TX: "off" }, age: { TX: "enabled" } }) passed to the
 * resolver; a covered state/market can only be enabled by an explicit
 * per-state (or per-market) override — never by the default.
 */
export const FIELD_STATE_POLICY = Object.freeze({
  marital_status: Object.freeze({
    default_mode: FIELD_MODES.ENABLED,
    covered_mode: FIELD_MODES.OFF,
    covered_states: MARITAL_COVERED_STATES,
    covered_markets: LOCAL_ORDINANCE_MARKETS.marital_status,
    unknown_state_mode: FIELD_MODES.OFF,
  }),
  age: Object.freeze({
    // Owner: shadow-only everywhere until confirmed with counsel.
    default_mode: FIELD_MODES.SHADOW_ONLY,
    covered_mode: FIELD_MODES.SHADOW_ONLY,
    covered_states: AGE_COVERED_STATES,
    covered_markets: LOCAL_ORDINANCE_MARKETS.age,
    unknown_state_mode: FIELD_MODES.SHADOW_ONLY,
  }),
  household_income: Object.freeze({ default_mode: FIELD_MODES.ENABLED, covered_mode: FIELD_MODES.ENABLED, covered_states: [], covered_markets: [], unknown_state_mode: FIELD_MODES.SHADOW_ONLY }),
  net_asset_value: Object.freeze({ default_mode: FIELD_MODES.ENABLED, covered_mode: FIELD_MODES.ENABLED, covered_states: [], covered_markets: [], unknown_state_mode: FIELD_MODES.SHADOW_ONLY }),
  buying_power: Object.freeze({ default_mode: FIELD_MODES.ENABLED, covered_mode: FIELD_MODES.ENABLED, covered_states: [], covered_markets: [], unknown_state_mode: FIELD_MODES.SHADOW_ONLY }),
});

export const SIGNAL_OPENING_EXCLUDED_NOTE =
  "race/ethnicity (incl. area racial composition), national origin, language (selects reply language only), sex/gender, religion, disability, familial status, area demographic composition";

// NEVER pricing inputs. The pricing module never reads any of these keys from
// any source; tests/critical/negotiation-signal-opening.test.mjs fails if it
// does (Proxy-instrumented sources + a static scan of the module text).
export const EXCLUDED_PRICING_FIELDS = Object.freeze([
  // race / ethnicity / national origin
  "race", "ethnicity", "ethnic_group", "national_origin", "nationality", "ancestry", "citizenship", "country_of_origin",
  // language — selects the reply language only
  "language", "language_preference", "best_language", "thread_language", "seller_language", "preferred_language",
  // sex / gender
  "sex", "gender", "gender_identity", "sexual_orientation",
  // religion
  "religion", "creed",
  // disability / health
  "disability", "handicap", "health", "medical",
  // familial status
  "familial_status", "family_status", "children", "household_size", "presence_of_children", "pregnancy",
  // area demographic composition
  "census_demographics", "area_demographics", "tract_demographics", "racial_composition", "pct_minority",
  "minority_pct", "situs_census_tract", "census_tract", "block_group",
  // persona / names (identity proxies)
  "agent_persona", "agent_family", "owner_name", "full_name", "first_name", "owner_1_firstname", "owner_1_lastname", "cnam",
  // IC8 opaque composites (may embed anything)
  "ai_score", "final_acquisition_score", "structured_motivation_score", "tag_distress_score", "deal_strength_score",
]);

// Tag tokens that are protected-class proxies: ignored by the tag reader.
export const EXCLUDED_TAG_TOKENS = Object.freeze(["empty nester", "young family", "family", "children", "single parent", "disabled", "veteran"]);
// Tag tokens that are AGE proxies: routed to the guarded `age` signal only.
export const AGE_PROXY_TAG_TOKENS = Object.freeze(["senior owner", "senior", "elderly", "retiree"]);

export default {
  SIGNAL_OPENING_CONFIG_VERSION,
  SPREAD_BOUNDS,
  FAIR_OFFER_FLOOR,
  LADDER,
  ROUNDING,
  SIGNALS,
  EXCLUDED_PRICING_FIELDS,
};
