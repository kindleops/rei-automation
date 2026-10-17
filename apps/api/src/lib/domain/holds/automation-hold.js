// ─── automation-hold.js ─────────────────────────────────────────────────────
// THE single hold authority (P0 containment, owner directive 2026-10-16).
//
// An automation hold is an internal, audited operator decision that a thread /
// property / opportunity / owner must not be advanced or contacted by any
// automated path. It is NOT an external offer withdrawal: nothing is sent to the
// seller, no offer row is modified, and every inbound is still recorded.
//
// Authority: public.automation_holds (append-only; released by an audited
// update, never deleted), read through public.automation_hold_for(...). The
// database also enforces the hold with BEFORE triggers on seller_offers,
// closing_cases, acquisition_opportunities and send_queue, so a code path this
// module does not reach is still refused at the row.
//
// FAIL-CLOSED. A lookup error, a missing client, or a missing RPC is reported as
// HELD (fail_closed: true). Callers on advancement / outbound paths must treat
// held === true as "do nothing automated".
//
// Matching: a hold covers an action when ANY of the hold's non-null scope keys
// equals the corresponding key of the action AND the capability is in the
// hold's blocked_capabilities. (Same predicate as automation_hold_for in SQL;
// matchAutomationHolds below is the in-memory twin for batch paths.)
//
// This module also carries the RULE-BASED ACCEPTANCE GUARD (exposure audit
// 2026-10-16): an acceptance is never automated when the active offer is
// operator-originated, its price exceeds the MAO or the authorized ceiling, the
// valuation is missing, the opportunity is archived / dead / suppressed /
// cancelled, or a hold applies. The acceptance is routed to human review with
// its evidence recorded; nothing is accepted and no closing case is created.

import crypto from "node:crypto";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

export const AUTOMATION_HOLD_VERSION = "automation_hold_v1";

export const HOLD_CAPABILITIES = Object.freeze({
  OFFER_ACCEPTANCE: "offer_acceptance",
  OFFER_WRITE: "offer_write",
  CLOSING_CASE_CREATE: "closing_case_create",
  STAGE_ADVANCE: "stage_advance",
  AUTO_REPLY: "auto_reply",
  AI_ACTION: "ai_action",
  FOLLOW_UP: "follow_up",
  CAMPAIGN: "campaign",
  WORKFLOW: "workflow",
  OUTBOUND_SEND: "outbound_send",
  RECOVERY: "recovery",
  MANUAL_SEND: "manual_send",
});
export const ALL_HOLD_CAPABILITIES = Object.freeze(Object.values(HOLD_CAPABILITIES));

export const HOLD_TYPES = Object.freeze({ OPERATOR_HOLD: "operator_hold", PERMANENT_EXCLUSION: "permanent_exclusion" });

/** Queue statuses the runner can send from (or is sending in). Mirrors the DB trigger. */
export const SENDABLE_QUEUE_STATUSES = Object.freeze(["queued", "pending", "approved", "ready", "scheduled", "processing", "sending"]);

export const ACCEPTANCE_REVIEW_REASONS = Object.freeze({
  AUTOMATION_HOLD: "automation_hold",
  HOLD_LOOKUP_FAILED: "automation_hold_lookup_failed",
  GUARD_LOOKUP_FAILED: "acceptance_guard_lookup_failed",
  OPERATOR_ORIGINATED: "operator_originated_offer",
  ORIGIN_UNVERIFIED: "offer_origin_unverified",
  VALUATION_MISSING: "valuation_missing",
  ABOVE_MAO: "price_above_mao",
  ABOVE_CEILING: "price_above_authorized_ceiling",
  OPPORTUNITY_INACTIVE: "opportunity_inactive",
  OPPORTUNITY_AUTOMATION_CANCELLED: "opportunity_automation_cancelled",
  OPPORTUNITY_MISSING: "opportunity_missing",
});

export const ACCEPTANCE_REVIEW_OUTCOME = "routed_to_human_review";

const INACTIVE_OPPORTUNITY_STATUSES = new Set(["archived", "dead", "suppressed", "lost"]);
const INACTIVE_AUTOMATION_STATES = new Set(["cancelled", "canceled", "paused"]);
const OPERATOR_SOURCES = new Set(["operator", "manual", "manual_composer", "manual_inbox", "inbox", "manual_reply", "operator_offer"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_RESOLVER_KEY = "__lcAutomationHoldTestResolver";

function clean(value) {
  return String(value ?? "").trim();
}
function lower(value) {
  return clean(value).toLowerCase();
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function uuidOrNull(value) {
  const v = clean(value);
  return UUID_RE.test(v) ? v : null;
}
function obj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Stage rank shared with public.automation_hold_stage_rank (SQL). Both stage
 * vocabularies in acquisition_opportunities_stage_check are ranked; unknown
 * and needs_review rank 0, so any move OUT of them counts as an advance.
 */
export const AUTOMATION_HOLD_STAGE_RANK = Object.freeze({
  needs_review: 0,
  ownership_confirmation: 1,
  offer_interest: 2, interest_qualification: 2,
  asking_price: 3, price_discovery: 3,
  property_condition: 4, underwriting: 4,
  offer: 5, decision_and_offer: 5,
  formal_contract: 6, contract_to_close: 6,
  disposition: 7,
  under_contract: 8,
  prepared_to_close: 9,
  closed: 10,
});
export function automationHoldStageRank(stage) {
  return AUTOMATION_HOLD_STAGE_RANK[lower(stage)] ?? 0;
}
export function isStageAdvance(fromStage, toStage) {
  return automationHoldStageRank(toStage) > automationHoldStageRank(fromStage);
}

/**
 * STATIC PERMANENT EXCLUSIONS (code-level, deploy-to-change). OWNER DECISION 2026-10-14: the thread at
 * 3746 Baltimore Ave (Maxwell) is owner-handled, permanently. Matched by the sha256 of its thread_key
 * (the key itself is never stored in code) and by the property address prefix. This is the SAME list
 * conversation-ai/send-policy.js carried for the AI paths only (rc-8.5.16+); here it applies to EVERY
 * capability and does not depend on the database (a registry outage cannot un-exclude it). Reversible
 * holds (Hartford) live only in public.automation_holds.
 */
export const STATIC_PERMANENT_EXCLUSIONS = Object.freeze([
  Object.freeze({ key: "owner_handled_20261014:maxwell", thread_key_sha256: "a4d8943f54734c853e4ef6450db73a0fe8adae6c7351aeff6732c64a8c6effd6", property_id: "251027062", address_prefix: "3746 baltimore" }),
]);
function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}
function normalizeAddress(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
/** Pure, synchronous: is this thread / property / address statically excluded? */
export function staticExclusionFor({ thread_key = null, property_id = null, property_address = null } = {}) {
  const tk = clean(thread_key);
  const tkHash = tk ? sha256(tk) : null;
  const addr = normalizeAddress(property_address);
  return (
    STATIC_PERMANENT_EXCLUSIONS.find(
      (x) => (tkHash && x.thread_key_sha256 === tkHash) || (clean(property_id) && x.property_id === clean(property_id)) || (addr && addr.startsWith(x.address_prefix))
    ) || null
  );
}
/** send-policy compatible name (rc-8.5.16+ callers). */
export function isOwnerHandledThread(args = {}) {
  return Boolean(staticExclusionFor(args));
}
function staticHoldRow(x) {
  return { id: null, hold_key: x.key, hold_type: HOLD_TYPES.PERMANENT_EXCLUSION, reason: "static permanent exclusion (code)", static: true };
}

/** Normalize the scope of an action. Unknown keys are ignored. */
export function normalizeHoldScope(scope = {}) {
  const s = obj(scope);
  return {
    thread_key: clean(s.thread_key ?? s.threadKey) || null,
    inbox_thread_id: uuidOrNull(s.inbox_thread_id ?? s.inboxThreadId),
    property_id: clean(s.property_id ?? s.propertyId) || null,
    opportunity_id: uuidOrNull(s.opportunity_id ?? s.opportunityId),
    master_owner_id: clean(s.master_owner_id ?? s.masterOwnerId ?? s.ownerId) || null,
  };
}

function hasAnyKey(scope) {
  return Boolean(scope.thread_key || scope.inbox_thread_id || scope.property_id || scope.opportunity_id || scope.master_owner_id);
}

/**
 * An explicit, audited operator override: { approval_ref, reason, operator_id }.
 * All three are required; anything less is no override.
 */
export function holdOverrideOf(value) {
  const o = obj(value);
  const approval_ref = clean(o.approval_ref);
  const reason = clean(o.reason);
  const operator_id = clean(o.operator_id);
  if (!approval_ref || !reason || !operator_id) return null;
  return { approval_ref, reason, operator_id };
}

/**
 * Pure in-memory twin of automation_hold_for: active holds (released_at null)
 * whose any non-null scope key equals the action's key and that block the
 * capability.
 */
export function matchAutomationHolds(holds = [], scope = {}, capability = null) {
  const s = normalizeHoldScope(scope);
  if (!hasAnyKey(s)) return [];
  const cap = clean(capability) || null;
  const statically = staticExclusionFor({ thread_key: s.thread_key, property_id: s.property_id });
  const fromRegistry = (Array.isArray(holds) ? holds : []).filter((h) => {
    if (!h || h.released_at) return false;
    const caps = Array.isArray(h.blocked_capabilities) && h.blocked_capabilities.length ? h.blocked_capabilities : ALL_HOLD_CAPABILITIES;
    if (cap && !caps.includes(cap)) return false;
    return (
      (h.thread_key && s.thread_key && clean(h.thread_key) === s.thread_key) ||
      (h.inbox_thread_id && s.inbox_thread_id && lower(h.inbox_thread_id) === lower(s.inbox_thread_id)) ||
      (h.property_id && s.property_id && clean(h.property_id) === s.property_id) ||
      (h.opportunity_id && s.opportunity_id && lower(h.opportunity_id) === lower(s.opportunity_id)) ||
      (h.master_owner_id && s.master_owner_id && clean(h.master_owner_id) === s.master_owner_id)
    );
  });
  return statically && !(cap && !ALL_HOLD_CAPABILITIES.includes(cap)) ? [...fromRegistry, staticHoldRow(statically)] : fromRegistry;
}

function summarize(holds = []) {
  return holds.map((h) => ({ id: h.id || null, hold_key: h.hold_key || null, hold_type: h.hold_type || null, reason: h.reason || null }));
}

function heldResult(capability, holds, extra = {}) {
  return { held: true, fail_closed: false, capability, holds: summarize(holds), hold_ids: holds.map((h) => h.id).filter(Boolean), reason: "automation_hold", version: AUTOMATION_HOLD_VERSION, ...extra };
}
function failClosed(capability, error) {
  return { held: true, fail_closed: true, capability, holds: [], hold_ids: [], reason: "automation_hold_lookup_failed", error: clean(error) || "lookup_failed", version: AUTOMATION_HOLD_VERSION };
}
function clear(capability, extra = {}) {
  return { held: false, fail_closed: false, capability, holds: [], hold_ids: [], reason: null, version: AUTOMATION_HOLD_VERSION, ...extra };
}

/** Test seam: install a resolver (scope, opts) => result. null restores production behaviour. */
export function __setAutomationHoldResolverForTests(fn = null) {
  if (typeof fn === "function") globalThis[TEST_RESOLVER_KEY] = fn;
  else delete globalThis[TEST_RESOLVER_KEY];
}

/**
 * Is this action held? Never throws.
 * @returns {Promise<{held:boolean, fail_closed:boolean, capability, holds, hold_ids, reason}>}
 */
export async function resolveAutomationHold(scope = {}, { capability = null, supabase: injected = null } = {}) {
  const cap = clean(capability) || null;
  const s = normalizeHoldScope(scope);
  const testResolver = globalThis[TEST_RESOLVER_KEY];
  if (typeof testResolver === "function") {
    try {
      const r = await testResolver(s, { capability: cap, supabase: injected });
      return r && typeof r === "object" ? { holds: [], hold_ids: [], fail_closed: false, capability: cap, ...r } : clear(cap);
    } catch (error) {
      return failClosed(cap, error?.message);
    }
  }
  if (!hasAnyKey(s)) return clear(cap, { reason: "no_scope_keys" });
  const statically = staticExclusionFor({ thread_key: s.thread_key, property_id: s.property_id });
  if (statically && !(cap && !ALL_HOLD_CAPABILITIES.includes(cap))) return heldResult(cap, [staticHoldRow(statically)], { static_exclusion: statically.key });
  let supabase = injected;
  try {
    supabase = supabase || getDefaultSupabaseClient();
  } catch {
    supabase = null;
  }
  if (!supabase || typeof supabase.rpc !== "function") return failClosed(cap, "missing_supabase_rpc");
  try {
    const { data, error } = await supabase.rpc("automation_hold_for", {
      p_thread_key: s.thread_key,
      p_inbox_thread_id: s.inbox_thread_id,
      p_property_id: s.property_id,
      p_opportunity_id: s.opportunity_id,
      p_master_owner_id: s.master_owner_id,
      p_capability: cap,
    });
    if (error) return failClosed(cap, error.message || error.code);
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    // Re-apply the predicate locally: a widened server answer can only add holds.
    const holds = rows.length ? rows.filter((h) => !h?.released_at) : [];
    return holds.length ? heldResult(cap, holds) : clear(cap);
  } catch (error) {
    return failClosed(cap, error?.message);
  }
}

/** Load every active hold (the table is tiny) for batch paths. Never throws. */
export async function loadActiveAutomationHolds({ supabase: injected = null } = {}) {
  const testResolver = globalThis[TEST_RESOLVER_KEY];
  if (typeof testResolver === "function" && typeof testResolver.loadAll === "function") {
    try {
      return { ok: true, holds: await testResolver.loadAll() };
    } catch (error) {
      return { ok: false, holds: [], error: error?.message || "load_failed" };
    }
  }
  if (typeof testResolver === "function") return { ok: true, holds: [] };
  let supabase = injected;
  try {
    supabase = supabase || getDefaultSupabaseClient();
  } catch {
    supabase = null;
  }
  if (!supabase || typeof supabase.from !== "function") return { ok: false, holds: [], error: "missing_supabase" };
  try {
    const { data, error } = await supabase
      .from("automation_holds")
      .select("id,hold_key,hold_type,thread_key,inbox_thread_id,property_id,opportunity_id,master_owner_id,blocked_capabilities,reason,released_at")
      .is("released_at", null)
      .limit(5000);
    if (error) return { ok: false, holds: [], error: error.message || error.code || "load_failed" };
    return { ok: true, holds: Array.isArray(data) ? data : [] };
  } catch (error) {
    return { ok: false, holds: [], error: error?.message || "load_failed" };
  }
}

/** Append one audit row to automation_hold_events. Never throws; returns ok. */
export async function recordAutomationHoldEvent({ event_type, scope = {}, capability = null, hold_ids = [], actor = null, approval_ref = null, evidence = {}, supabase: injected = null } = {}) {
  const s = normalizeHoldScope(scope);
  const row = {
    event_type: clean(event_type) || "advancement_blocked",
    capability: clean(capability) || null,
    hold_ids: (Array.isArray(hold_ids) ? hold_ids : []).filter((id) => UUID_RE.test(clean(id))),
    thread_key: s.thread_key,
    inbox_thread_id: s.inbox_thread_id,
    property_id: s.property_id,
    opportunity_id: s.opportunity_id,
    master_owner_id: s.master_owner_id,
    actor: clean(actor) || "automation",
    approval_ref: clean(approval_ref) || null,
    evidence: obj(evidence),
  };
  info("[AUTOMATION_HOLD_EVENT]", { event_type: row.event_type, capability: row.capability, hold_ids: row.hold_ids, opportunity_id: row.opportunity_id, property_id: row.property_id });
  let supabase = injected;
  try {
    supabase = supabase || getDefaultSupabaseClient();
    if (!supabase || typeof supabase.from !== "function") return { ok: false, reason: "missing_supabase" };
    const { error } = await supabase.from("automation_hold_events").insert(row);
    if (error) {
      warn("[AUTOMATION_HOLD_EVENT_WRITE_FAILED]", { event_type: row.event_type, error: error.message || error.code });
      return { ok: false, reason: error.message || "insert_failed" };
    }
    return { ok: true };
  } catch (error) {
    warn("[AUTOMATION_HOLD_EVENT_WRITE_FAILED]", { event_type: row.event_type, error: error?.message });
    return { ok: false, reason: error?.message || "insert_failed" };
  }
}

// ── Rule-based acceptance guard ─────────────────────────────────────────────

/** Was this offer composed / recorded by an operator (not the autopilot)? */
export function isOperatorOriginatedOffer(offer = {}) {
  const md = obj(offer?.metadata);
  const ev = obj(md.offer_event);
  return Boolean(
    OPERATOR_SOURCES.has(lower(ev.source)) ||
      OPERATOR_SOURCES.has(lower(md.source)) ||
      OPERATOR_SOURCES.has(lower(md.origin)) ||
      OPERATOR_SOURCES.has(lower(offer?.offer_type)) ||
      clean(ev.operator_id) ||
      clean(md.operator_id) ||
      md.manual_offer_override ||
      md.manual_offer
  );
}

function ceilingFromEvidence(snapshot) {
  const calc = obj(obj(obj(snapshot).evidence).offer_calculation);
  return num(calc.effective_authorized_ceiling) ?? num(calc.valuation_based_ceiling);
}
function minOf(values) {
  const v = values.filter((x) => x !== null && x > 0);
  return v.length ? Math.min(...v) : null;
}

/**
 * The economic authority for an acceptance. MAO and ceiling are the LOWEST of
 * every source present (conservative): the offer row's own frozen
 * authorized_ceiling, property_acquisition_scores (minimum_acceptable_offer =
 * the MAO the dossiers cite; evidence.offer_calculation.effective_authorized_ceiling),
 * and the opportunity's ADE snapshot (max_allowable_offer / minimum_acceptable_offer).
 */
export function resolveAcceptanceEconomics({ offer = null, score = null, opportunity = null } = {}) {
  const ade = obj(obj(opportunity?.metadata).ade_snapshot);
  const sc = obj(score);
  const mao = minOf([num(sc.minimum_acceptable_offer), num(ade.minimum_acceptable_offer), num(ade.max_allowable_offer)]);
  const ceiling = minOf([num(offer?.authorized_ceiling), ceilingFromEvidence(sc), ceilingFromEvidence(ade)]);
  const valuation_mid = num(sc.valuation_mid) ?? num(ade.valuation_mid) ?? num(offer?.valuation_mid);
  return { mao, ceiling, valuation_mid };
}

/**
 * PURE: may this acceptance be automated?
 * @returns {{ allowed:boolean, reasons:string[], price, economics }}
 */
export function evaluateAcceptanceRules({ offer = null, opportunity = null, score = null, hold = null, accepted_price = null, acceptance_basis = null } = {}) {
  const reasons = [];
  if (hold?.held) reasons.push(hold.fail_closed ? ACCEPTANCE_REVIEW_REASONS.HOLD_LOOKUP_FAILED : ACCEPTANCE_REVIEW_REASONS.AUTOMATION_HOLD);
  if (!opportunity) reasons.push(ACCEPTANCE_REVIEW_REASONS.OPPORTUNITY_MISSING);
  else {
    if (INACTIVE_OPPORTUNITY_STATUSES.has(lower(opportunity.opportunity_status))) reasons.push(`${ACCEPTANCE_REVIEW_REASONS.OPPORTUNITY_INACTIVE}:${lower(opportunity.opportunity_status)}`);
    if (INACTIVE_AUTOMATION_STATES.has(lower(opportunity.automation_state))) reasons.push(ACCEPTANCE_REVIEW_REASONS.OPPORTUNITY_AUTOMATION_CANCELLED);
  }
  const sellerAsk = clean(acceptance_basis) === "we_accepted_seller_ask";
  const isSellerCounter = lower(offer?.direction) === "inbound" || lower(offer?.offer_type) === "seller_counter";
  if (offer) {
    if (isOperatorOriginatedOffer(offer)) reasons.push(ACCEPTANCE_REVIEW_REASONS.OPERATOR_ORIGINATED);
    else if (!isSellerCounter && !clean(offer.ade_snapshot_id)) reasons.push(ACCEPTANCE_REVIEW_REASONS.ORIGIN_UNVERIFIED);
  }
  const price = (sellerAsk ? num(accepted_price) : null) ?? num(offer?.purchase_price) ?? num(accepted_price);
  const economics = resolveAcceptanceEconomics({ offer, score, opportunity });
  if (economics.valuation_mid === null || economics.mao === null || economics.ceiling === null || price === null) {
    reasons.push(ACCEPTANCE_REVIEW_REASONS.VALUATION_MISSING);
  }
  if (price !== null && economics.mao !== null && price > economics.mao) reasons.push(ACCEPTANCE_REVIEW_REASONS.ABOVE_MAO);
  if (price !== null && economics.ceiling !== null && price > economics.ceiling) reasons.push(ACCEPTANCE_REVIEW_REASONS.ABOVE_CEILING);
  return { allowed: reasons.length === 0, reasons, price, economics };
}

/**
 * Load everything the acceptance guard needs and evaluate it. Never throws; any
 * read failure is a review verdict (fail closed).
 */
export async function evaluateAutonomousAcceptance({
  opportunity_id = null,
  thread_key = null,
  property_id = null,
  master_owner_id = null,
  accepted_price = null,
  acceptance_basis = null,
  offer = undefined,
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  const failed = (detail) => ({ allowed: false, reasons: [ACCEPTANCE_REVIEW_REASONS.GUARD_LOOKUP_FAILED], detail, price: num(accepted_price), economics: null, hold: null, offer: offer || null, opportunity: null });
  if (!supabase || typeof supabase.from !== "function") return failed("missing_supabase");
  let opportunity = null;
  let activeOffer = offer;
  let score = null;
  try {
    const { data, error } = await supabase.from("acquisition_opportunities").select("*").eq("id", clean(opportunity_id)).maybeSingle();
    if (error) return failed(`opportunity:${error.message || error.code}`);
    opportunity = data || null;
    if (activeOffer === undefined) {
      const r = await supabase.from("seller_offers").select("*").eq("opportunity_id", clean(opportunity_id)).eq("status", "active").maybeSingle();
      if (r.error) return failed(`offer:${r.error.message || r.error.code}`);
      activeOffer = r.data || null;
    }
    const pid = clean(property_id) || clean(activeOffer?.property_id) || clean(opportunity?.primary_property_id);
    if (pid) {
      let q = supabase.from("property_acquisition_scores").select("*").eq("property_id", pid);
      if (typeof q.order === "function") q = q.order("computed_at", { ascending: false });
      if (typeof q.limit === "function") q = q.limit(1);
      const r = await q;
      if (r?.error) return failed(`score:${r.error.message || r.error.code}`);
      score = Array.isArray(r?.data) ? r.data[0] || null : r?.data || null;
    }
  } catch (error) {
    return failed(error?.message || "lookup_failed");
  }
  const hold = await resolveAutomationHold(
    {
      thread_key: clean(thread_key) || clean(activeOffer?.thread_key) || clean(opportunity?.primary_thread_key),
      property_id: clean(property_id) || clean(activeOffer?.property_id) || clean(opportunity?.primary_property_id),
      opportunity_id,
      master_owner_id: clean(master_owner_id) || clean(opportunity?.master_owner_id),
    },
    { capability: HOLD_CAPABILITIES.OFFER_ACCEPTANCE, supabase }
  );
  const verdict = evaluateAcceptanceRules({ offer: activeOffer, opportunity, score, hold, accepted_price, acceptance_basis });
  return { ...verdict, hold, offer: activeOffer || null, opportunity };
}

/**
 * Route a refused acceptance to human review: record the evidence, never
 * advance. Under a hold the opportunity row is not touched (the hold already
 * carries next_action human_review); the evidence goes to the audit table only.
 * Otherwise the opportunity gets next_action human_review and an
 * acceptance_review record, and negotiation_state.terms_accepted is reset so
 * the state never claims an acceptance nobody bound. Never throws.
 */
export async function routeAcceptanceToHumanReview({ verdict = {}, opportunity_id = null, thread_key = null, property_id = null, master_owner_id = null, acceptance_event_id = null, acceptance_at = null, source = null, supabase: injected = null } = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  const evidence = {
    outcome: ACCEPTANCE_REVIEW_OUTCOME,
    reasons: verdict.reasons || [],
    offer_id: verdict.offer?.offer_id || null,
    offer_price: num(verdict.offer?.purchase_price),
    evaluated_price: verdict.price ?? null,
    mao: verdict.economics?.mao ?? null,
    authorized_ceiling: verdict.economics?.ceiling ?? null,
    valuation_mid: verdict.economics?.valuation_mid ?? null,
    opportunity_status: verdict.opportunity?.opportunity_status || null,
    opportunity_automation_state: verdict.opportunity?.automation_state || null,
    acceptance_event_id: clean(acceptance_event_id) || null,
    acceptance_at: clean(acceptance_at) || null,
    source: clean(source) || null,
    recorded_at: new Date().toISOString(),
    guard_version: AUTOMATION_HOLD_VERSION,
  };
  const scope = { opportunity_id, thread_key, property_id, master_owner_id };
  const event = await recordAutomationHoldEvent({
    event_type: "acceptance_routed_to_human_review",
    scope,
    capability: HOLD_CAPABILITIES.OFFER_ACCEPTANCE,
    hold_ids: verdict.hold?.hold_ids || [],
    evidence,
    supabase,
  });
  let opportunity_flagged = false;
  if (!verdict.hold?.held && verdict.opportunity && supabase?.from) {
    try {
      const md = obj(verdict.opportunity.metadata);
      const ns = obj(md.negotiation_state);
      const metadata = {
        ...md,
        negotiation_state: Object.keys(ns).length ? { ...ns, terms_accepted: false, acceptance_pending_review: evidence } : ns,
        acceptance_review: evidence,
      };
      const { error } = await supabase
        .from("acquisition_opportunities")
        .update({ next_action: "human_review", metadata, updated_at: new Date().toISOString() })
        .eq("id", clean(opportunity_id));
      opportunity_flagged = !error;
      if (error) warn("[ACCEPTANCE_REVIEW_FLAG_FAILED]", { opportunity_id, error: error.message || error.code });
    } catch (error) {
      warn("[ACCEPTANCE_REVIEW_FLAG_FAILED]", { opportunity_id, error: error?.message });
    }
  }
  warn("[ACCEPTANCE_ROUTED_TO_HUMAN_REVIEW]", { opportunity_id, reasons: evidence.reasons, offer_id: evidence.offer_id });
  return { evidence, event_recorded: event.ok === true, opportunity_flagged };
}

export default resolveAutomationHold;
