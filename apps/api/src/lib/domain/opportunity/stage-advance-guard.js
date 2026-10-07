// ─── stage-advance-guard.js ─────────────────────────────────────────────────
// FAIL-CLOSED money gate on lifecycle promotion (2026-10-07 deal-attribution
// audit: property 227876842 reached formal_contract on a "$4,100" misparse,
// 296670809 on a "$331" asking price, "2024" was read as a price, and 16
// opportunities sat at Offer with current_offer = 0).
//
//   • S5 offer — an AUTOMATED promotion needs a real offer (current_offer > 0
//     and plausible, or an active offer record) and, when an asking price is on
//     the row, a PLAUSIBLE one. Owner number rules: a bare year is never a
//     price; anything under $10,000 (a 3-digit fragment, a 1,3 rent amount) is
//     not a property price; an ask the plausibility rules call implausible
//     against the value is not one either.
//   • S6 formal_contract … S9 — ONLY an explicit contract event: the closing
//     authority's own transition, or a live (non-cancelled) closing case for the
//     opportunity created through the canonical path. Never a parsed reply.
//   • S10 closed is already the closing authority's alone (unchanged).
// Pure; the caller supplies whether a live closing case exists.

import { assessAskingPricePlausibility } from "@/lib/domain/classification/price-plausibility.js";

export const STAGE_ADVANCE_GUARD_VERSION = "stage_advance_money_guard_v1_2026_10_07";
export const MIN_PLAUSIBLE_PROPERTY_PRICE = 10_000;

const STAGES = ["ownership_confirmation", "offer_interest", "asking_price", "property_condition", "offer", "formal_contract", "disposition", "under_contract", "prepared_to_close", "closed"];
const rank = (s) => STAGES.indexOf(String(s || "").trim().toLowerCase());
const OFFER = rank("offer");
const FORMAL = rank("formal_contract");
const CLOSED = rank("closed");

/** Sources that are a person deciding, not a parsed reply. */
const MANUAL_SOURCES = new Set(["operator", "pipeline", "closing_desk", "manual"]);
/** The canonical contract path. */
const CONTRACT_SOURCES = new Set(["closing_authority"]);
/** Closing cases that are not a contract any more. */
export const DEAD_CLOSING_STATUSES = new Set(["cancelled", "canceled", "voided", "void", "terminated", "dead"]);

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Is this a plausible property price? { plausible, rule }.
 * Rules: missing / ≤ 0 → zero; an integer 1900–2100 → year; < $10,000 →
 * below_property_price_floor (3-digit fragments, 1,3 rents); implausible against
 * the property's value (price-plausibility) → its rule.
 */
export function assessDealAmount(amount, { estimated_value = null, arv = null } = {}) {
  const n = num(amount);
  if (n == null || n <= 0) return { plausible: false, rule: "zero_or_missing" };
  if (Number.isInteger(n) && n >= 1900 && n <= 2100) return { plausible: false, rule: "bare_year" };
  if (n < MIN_PLAUSIBLE_PROPERTY_PRICE) return { plausible: false, rule: "below_property_price_floor" };
  const p = assessAskingPricePlausibility({ amount: n, valuation: { estimated_value: num(estimated_value), arv_estimate: num(arv) } });
  if (p.implausible) return { plausible: false, rule: `implausible_vs_value:${p.rule}` };
  return { plausible: true, rule: null };
}

/**
 * May this opportunity move to `to_stage`?
 * @returns {{ ok: true } | { ok: false, error, code, message, guard }}
 */
export function evaluateStageAdvance({ current = {}, to_stage = null, source = null, live_closing_case = false } = {}) {
  const to = rank(to_stage);
  const from = rank(current?.acquisition_stage);
  if (to < 0 || to <= from || to >= CLOSED) return { ok: true };
  const src = String(source || "operator").trim().toLowerCase();
  const block = (code, message, extra = {}) => ({
    ok: false,
    error: "stage_advance_blocked",
    code,
    message,
    guard: { version: STAGE_ADVANCE_GUARD_VERSION, to_stage, from_stage: current?.acquisition_stage || null, source: src, ...extra },
  });

  if (to >= FORMAL) {
    if (CONTRACT_SOURCES.has(src) || live_closing_case === true) return { ok: true };
    return block("CONTRACT_EVENT_REQUIRED", "Formal Contract and later stages need a contract created through the Closing Desk, never a parsed reply.");
  }

  if (to === OFFER && !MANUAL_SOURCES.has(src)) {
    const valuation = { estimated_value: current?.estimated_value, arv: current?.arv };
    const offer = assessDealAmount(current?.current_offer, valuation);
    const has_offer_record = Boolean(String(current?.active_offer_id ?? "").trim());
    if (!offer.plausible && !has_offer_record) {
      return block("VALID_OFFER_REQUIRED", "An automated move to Offer needs a real offer on the deal.", { current_offer: num(current?.current_offer), offer_rule: offer.rule });
    }
    if (num(current?.asking_price) != null) {
      const ask = assessDealAmount(current.asking_price, valuation);
      if (!ask.plausible) {
        return block("ASKING_PRICE_IMPLAUSIBLE", "The asking price on the deal is not a plausible property price; the stage is held.", { asking_price: num(current.asking_price), ask_rule: ask.rule });
      }
    }
  }
  return { ok: true };
}
