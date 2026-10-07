// ─── negotiation-v3/disclosure.js ───────────────────────────────────────────
// SELLER-FACING DISCLOSURE POLICY (owner decision 10-07).
// Internal intelligence ≠ mandatory disclosure. The operator sees every number
// (ceiling, investor band, comps); the SELLER hears only our position.
//
//   DEFAULT        position-only.
//                  SFR: "Based on the condition and the numbers, we'd need to be around $X to make it work."
//                  MF:  "Based on the building, the condition and the numbers, we'd need to be around $Z a unit to make it work."
//   PUSHBACK ONLY  comp evidence, selectively, when it is TRUE and SUPPORTS our
//                  position: ≥ 2 qualifying nearby comps at or below our number
//                  AND the median of ALL qualifying comps is at or below our
//                  number (citing the low end of a pool that sits above us
//                  would be cherry-picking). The figure quoted is the median of
//                  the supporting comps (≤ our number), with its evidence ids.
//   NEVER          a comp / market / band figure above the quoted amount;
//                  comp or market language outside the pushback branch;
//                  a claim that cannot be verified against its evidence ids;
//                  internal facts (scores, situation, ceilings, limits).
//
// B renders the APPROVED template for `branch` in the thread language. The
// English strings here are the reference wording and the test fixture.
// validateSellerFacing() must pass on the rendered text before send.

export const DISCLOSURE_POLICY_VERSION = "neg_disclosure_v1_2026_10_07";

export const LANGUAGE_BRANCHES = Object.freeze({
  POSITION: "position",
  POSITION_PER_UNIT: "position_per_unit",
  COMPS_SUPPORT: "comps_support", // pushback only
  CREATIVE: "creative",
  UNREALISTIC_CLOSE: "unrealistic_close",
  CONFIRM: "confirm_basics",
  DISCOVERY: "discovery",
});
const L = LANGUAGE_BRANCHES;

export const REFERENCE_WORDING_EN = Object.freeze({
  position: "Based on the condition and the numbers, we'd need to be around {{amount}} to make it work.",
  position_per_unit: "Based on the building, the condition and the numbers, we'd need to be around {{per_unit}} a unit to make it work.",
  comps_support: "I understand. For reference, comparable homes nearby recently sold around {{comp_figure}}, which is why we're at {{amount}}.",
  comps_support_per_unit: "I understand. For reference, comparable buildings nearby recently sold around {{comp_figure}} a unit, which is why we're at {{per_unit}} a unit.",
});

export const DISCLOSURE_RULES = Object.freeze({
  min_supporting_comps: 2,
  // median(all qualifying comps) ≤ amount × this. 1.0 = the typical nearby sale is not above us.
  max_pool_median_over_amount: 1.0,
  figure_step: 1_000,
});

const MARKET_LANGUAGE_RE = /\b(?:sales?|sold|selling|trad(?:e|es|ed|ing)|comps?|comparables?|comparable|market|similar\s+(?:homes|houses|buildings|properties)|nearby|neighbo(?:u)?rhood|per\s+door)\b/i;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?/g;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const floorTo = (v, step) => (v == null ? null : Math.floor(v / step) * step);
function median(list) {
  const s = [...list].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function displayMoney(v) {
  const n = num(v);
  if (n == null) return null;
  if (n >= 1_000_000) return `$${(Math.floor(n / 10_000) / 100).toString()}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `$${n / 1_000}K`;
  return `$${Math.floor(n).toLocaleString("en-US")}`;
}

/**
 * Comps that may be cited on pushback. MF compares per unit, same unit count only.
 * Returns allowed=false unless the evidence is truthful AND supportive.
 */
export function supportiveComps(plan, amount, rules = DISCLOSURE_RULES) {
  const amt = num(amount);
  const none = { allowed: false, ids: [], prices: [], figure: null, reason: null };
  if (amt == null || amt <= 0 || !plan?.ok) return { ...none, reason: "no_amount" };
  const mf = plan.asset === "multifamily";
  const units = plan.per_unit?.units ?? null;
  if (mf && !units) return { ...none, reason: "no_unit_count" };
  const x = mf ? amt / units : amt;
  const pool = (plan.screened_comps || []).filter((c) => (mf ? c.units === units : true)).map((c) => ({ id: c.id, v: mf ? c.sale_price / units : c.sale_price }));
  if (pool.length < rules.min_supporting_comps) return { ...none, reason: "too_few_qualifying_comps" };
  const poolMedian = median(pool.map((c) => c.v));
  if (poolMedian > x * rules.max_pool_median_over_amount) return { ...none, reason: "typical_comp_above_our_number" };
  const support = pool.filter((c) => c.v <= x);
  if (support.length < rules.min_supporting_comps) return { ...none, reason: "too_few_comps_at_or_below_our_number" };
  const figure = Math.min(floorTo(median(support.map((c) => c.v)), rules.figure_step), floorTo(x, rules.figure_step));
  return { allowed: true, ids: support.map((c) => c.id), prices: support.map((c) => Math.round(c.v)), figure, per_unit: mf, reason: "supportive_truthful" };
}

/**
 * The seller-facing reply for a money move: branch + variables + verifiable claims.
 * Position-only unless the move is the pushback branch AND comps are supportive.
 */
export function sellerFacingReply(plan, move) {
  const amount = num(move?.amount ?? move?.proposal?.amount);
  if (amount == null) return null;
  const mf = plan?.asset === "multifamily" && plan?.per_unit?.units;
  const per = mf ? floorTo(amount / plan.per_unit.units, plan.config?.mf?.per_unit_step || 1000) : null;
  const variables = { amount: displayMoney(amount), per_unit: mf ? displayMoney(per) : null, comp_figure: null };
  let branch = mf ? L.POSITION_PER_UNIT : L.POSITION;
  let claims = [];
  const wantsComps = (move?.language_branch ?? move?.proposal?.language_branch) === L.COMPS_SUPPORT;
  if (wantsComps) {
    const s = supportiveComps(plan, amount);
    if (s.allowed) {
      branch = L.COMPS_SUPPORT;
      variables.comp_figure = displayMoney(s.figure);
      claims = [{ figure: s.figure, per_unit: s.per_unit, evidence_ids: s.ids, evidence_prices: s.prices }];
    }
  }
  const key = branch === L.COMPS_SUPPORT ? (mf ? "comps_support_per_unit" : "comps_support") : branch;
  const text_en = REFERENCE_WORDING_EN[key].replace(/\{\{(\w+)\}\}/g, (_, k) => variables[k] ?? "");
  return { policy_version: DISCLOSURE_POLICY_VERSION, branch, template_key: key, variables, claims, quoted_amount: amount, quoted_per_unit: per, text_en };
}

function parseMoney(text = "") {
  const out = [];
  for (const m of String(text).matchAll(MONEY_RE)) {
    let v = Number(m[1].replace(/,/g, ""));
    const suf = (m[2] || "").toLowerCase();
    if (suf === "k") v *= 1_000;
    if (suf === "m") v *= 1_000_000;
    out.push(v);
  }
  return out;
}

/**
 * Gate on the RENDERED seller text (any language with $ figures) + its claims.
 * Fails closed: any violation ⇒ ok:false ⇒ the caller must not send.
 */
export function validateSellerFacing({ text = "", branch = null, claims = [], quoted_amount = null, quoted_per_unit = null, plan = null } = {}) {
  const violations = [];
  const amt = num(quoted_amount);
  const per = num(quoted_per_unit);
  const ceilingFig = per ?? amt;
  for (const v of parseMoney(text)) {
    if (ceilingFig == null) violations.push(`figure_${v}_without_quoted_amount`);
    else if (v > ceilingFig) violations.push(`figure_${v}_above_quoted_${ceilingFig}`);
  }
  const marketWords = MARKET_LANGUAGE_RE.test(String(text));
  if (branch !== L.COMPS_SUPPORT) {
    if (claims?.length) violations.push("comp_claim_outside_pushback_branch");
    if (marketWords) violations.push("market_language_outside_pushback_branch");
  } else {
    if (!claims?.length) violations.push("comps_branch_without_claim");
    const ids = new Set((plan?.screened_comps || []).map((c) => c.id));
    for (const c of claims || []) {
      if (!c.evidence_ids?.length || c.evidence_ids.some((id) => !ids.has(id))) violations.push("claim_evidence_not_verifiable");
      const prices = c.evidence_prices || [];
      if (!prices.length || c.figure < Math.floor(Math.min(...prices) / 1000) * 1000 || c.figure > Math.max(...prices)) violations.push("claim_figure_not_supported_by_evidence");
      if (ceilingFig != null && c.figure > ceilingFig) violations.push("claim_figure_above_quoted");
    }
  }
  return { ok: violations.length === 0, violations, policy_version: DISCLOSURE_POLICY_VERSION };
}
