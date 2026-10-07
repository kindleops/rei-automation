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

// ── Offer events (owner 2026-10-07: "Parsed seller text can provide evidence.
// It cannot itself create a formal contract state." Same for Offer.) ─────────
export const OFFER_EVENT_SOURCES = Object.freeze(["engine", "operator"]);
export const OFFER_EVENT_QUOTE_TYPES = Object.freeze(["FORMAL_OFFER", "NEGOTIATION_ANCHOR", "CONCESSION"]);
const LIVE_OFFER_STATUSES = new Set(["active", "accepted", "sent", "superseded"]);

/**
 * E — asset-aware plausibility of an OFFER amount. Base deal-amount rules,
 * plus for an ENGINE (autonomous) offer: never above the authoritative ceiling
 * (MAO) and within [15%, 100%] of the as-is valuation_mid when present; a
 * multifamily total must be ≥ $10K per unit. An operator's typed offer passes
 * the base rules (a person priced it).
 */
export function assessOfferAmount(amount, { source = "engine", valuation_mid = null, estimated_value = null, arv = null, mao = null, units = null } = {}) {
  const base = assessDealAmount(amount, { estimated_value: estimated_value ?? valuation_mid, arv });
  if (!base.plausible) return base;
  const n = num(amount);
  const u = num(units);
  if (u && u >= 2 && n / u < MIN_PLAUSIBLE_PROPERTY_PRICE) return { plausible: false, rule: "below_per_unit_floor" };
  if (String(source).toLowerCase() === "engine") {
    const ceiling = num(mao);
    if (ceiling != null && n > ceiling) return { plausible: false, rule: "above_authoritative_ceiling" };
    const v = num(valuation_mid);
    if (v != null && v > 0 && (n > v || n < v * 0.15)) return { plausible: false, rule: "outside_valuation_band" };
  }
  return { plausible: true, rule: null };
}

/**
 * A REAL offer event: amount, source (engine | operator), engine_version or
 * operator id, timestamp, deal / conversation id, quote type — and a plausible
 * amount. Returns { valid, missing[], rule }.
 */
export function validateOfferEvent(ev = {}, valuation = {}) {
  const missing = [];
  const source = String(ev?.source || "").toLowerCase();
  if (!OFFER_EVENT_SOURCES.includes(source)) missing.push("source");
  if (source === "engine" && !String(ev?.engine_version ?? "").trim()) missing.push("engine_version");
  if (source === "operator" && !String(ev?.operator_id ?? "").trim()) missing.push("operator_id");
  if (!Number.isFinite(Date.parse(ev?.at || ""))) missing.push("timestamp");
  if (!String(ev?.opportunity_id ?? ev?.thread_key ?? "").trim()) missing.push("deal_or_conversation_id");
  if (!OFFER_EVENT_QUOTE_TYPES.includes(String(ev?.quote_type || "").toUpperCase())) missing.push("quote_type");
  // The event's own authority (seller_offers.valuation_mid / authorized_ceiling) wins over the row's.
  const amount = assessOfferAmount(ev?.amount, {
    source,
    ...valuation,
    ...(num(ev?.valuation_mid) != null ? { valuation_mid: num(ev.valuation_mid) } : {}),
    ...(num(ev?.mao) != null ? { mao: num(ev.mao) } : {}),
    ...(num(ev?.units) != null ? { units: num(ev.units) } : {}),
  });
  return { valid: missing.length === 0 && amount.plausible, missing, rule: amount.rule };
}

/** seller_offers row (the Offer Term Authority) → offer event. */
export function offerEventFromSellerOffer(row = {}) {
  const meta = row?.metadata?.offer_event || {};
  if (!LIVE_OFFER_STATUSES.has(String(row?.status || "").toLowerCase()) || !row?.sent_at) return null;
  const source = String(meta.source || (row.ade_snapshot_id || row.policy_version ? "engine" : "")).toLowerCase() || null;
  return {
    kind: "seller_offer",
    id: row.offer_id || null,
    amount: num(row.purchase_price),
    source,
    engine_version: meta.engine_version || (source === "engine" ? row.policy_version || row.ade_snapshot_id || null : null),
    operator_id: meta.operator_id || null,
    at: row.sent_at,
    opportunity_id: row.opportunity_id || null,
    thread_key: row.thread_key || null,
    quote_type: String(meta.quote_type || "FORMAL_OFFER").toUpperCase(),
    valuation_mid: num(row.valuation_mid),
    mao: num(row.authorized_ceiling),
    units: num(meta.units),
  };
}

/**
 * The quote type an operator's own words carry (rules only). A definite price
 * with terms or "my offer" / "I'd be at" / "I can offer" / a contract offer →
 * FORMAL_OFFER; a hedged figure ("around", "ballpark", "probably", "range",
 * "similar homes sold for") → NEGOTIATION_ANCHOR; otherwise null (ambiguous →
 * no offer event, no stage change).
 */
export function classifyOfferWording(body = "") {
  const t = String(body || "");
  // A hedge counts only when it qualifies the AMOUNT ("around $315K", "range of
  // $200-220K"), not the rest of the sentence ("in the range you'd consider",
  // "close in approximately seven days").
  const amount_hedge = /\b(?:around|about|roughly|ballpark|probably|likely|somewhere\s+(?:near|around)|in\s+the\s+range\s+of|range\s+of|between|alrededor\s+de|aproximadamente|unos)\s+\$\s*\d/i.test(t) || /\$\s*\d[\d,.]*\s*k?\s*(?:-|–|to|a)\s*\$?\s*\d/i.test(t);
  const value_talk = /\b(?:similar\s+(?:homes|houses|properties|buildings)|sold\s+for|comps?|arv|assessed|accessed|appraised|valued\s+at|repair\s+cost|in\s+repairs?)\b|\bvalor\b|\breparaciones\b/i.test(t);
  const firm = /\b(?:my\s+offer|i'?d\s+be\s+at|i\s+would\s+be\s+at|i\s+can\s+(?:do|offer|pay)|i\s+could\s+do|i'?m\s+good\s+to\s+move\s+forward\s+at|offer\s+(?:you|of)|purchase\s+agreement|close\s+in\s+\d+)\b|\bpuedo\s+(?:ofrecer|pagar)|\b(?:redactar|preparo|preparar)\s+(?:un\s+|el\s+)?contrato\b/i.test(t);
  if (amount_hedge) return "NEGOTIATION_ANCHOR";
  if (firm) return "FORMAL_OFFER";
  if (value_talk) return "NEGOTIATION_ANCHOR";
  return null;
}

/** negotiation_quotes row → offer event (anchor / formal offer / concession / an observed operator offer). */
export function offerEventFromQuote(row = {}) {
  const t = String(row?.quote_type || "").toLowerCase();
  const observed = t === "observed_offer";
  const quote_type = observed
    // f09a89d2 observed outbound offers: only an unambiguous (high-confidence) extraction whose wording names its kind.
    ? (String(row?.extraction_confidence || "").toLowerCase() === "high" ? String(row?.evidence?.offer_kind || row?.offer_kind || "").toUpperCase() || null : null)
    : t === "anchor" || t === "negotiation_anchor" ? "NEGOTIATION_ANCHOR" : t === "formal_offer" ? "FORMAL_OFFER" : t === "concession" ? "CONCESSION" : null;
  if (!quote_type) return null;
  const manual = String(row?.quote_source || "").toLowerCase() === "manual";
  return {
    kind: "negotiation_quote",
    id: row.quote_key || row.id || null,
    amount: num(row.amount),
    source: manual ? "operator" : "engine",
    engine_version: manual ? null : row.engine_version || null,
    operator_id: manual ? row.operator_id || row.quoted_by || row.operator_action_id || row?.evidence?.operator_action_id || null : null,
    at: row.quoted_at || row.created_at || null,
    opportunity_id: row.opportunity_id || null,
    thread_key: row.thread_key || null,
    quote_type,
  };
}

/**
 * May this opportunity move to `to_stage`?
 * @returns {{ ok: true } | { ok: false, error, code, message, guard }}
 */
export function evaluateStageAdvance({ current = {}, to_stage = null, source = null, live_closing_case = false, offer_events = [], valuation = {} } = {}) {
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
    const value = { estimated_value: current?.estimated_value, arv: current?.arv, ...valuation };
    // STRICT: a real offer EVENT (current_offer > 0 alone is no longer enough).
    const checked = (Array.isArray(offer_events) ? offer_events : []).filter(Boolean).map((ev) => ({ ev, ...validateOfferEvent(ev, value) }));
    if (!checked.some((c) => c.valid)) {
      return block("OFFER_EVENT_REQUIRED", "An automated move to Offer needs a recorded offer event (amount, engine or operator, time, quote type).", {
        current_offer: num(current?.current_offer),
        offer_events_seen: checked.map((c) => ({ id: c.ev.id || null, missing: c.missing, rule: c.rule })),
      });
    }
    if (num(current?.asking_price) != null) {
      const ask = assessDealAmount(current.asking_price, value);
      if (!ask.plausible) {
        return block("ASKING_PRICE_IMPLAUSIBLE", "The asking price on the deal is not a plausible property price; the stage is held.", { asking_price: num(current.asking_price), ask_rule: ask.rule });
      }
    }
  }
  return { ok: true };
}
