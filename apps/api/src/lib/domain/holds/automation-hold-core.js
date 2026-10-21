// ─── automation-hold-core.js ────────────────────────────────────────────────
// PURE half of the single hold authority (P0 2026-10-16): constants, the static permanent exclusions,
// the scope matcher (in-memory twin of public.automation_hold_for) and the acceptance rules. No I/O,
// no Supabase, no logger: safe to import from pure modules (conversation-ai/send-policy.js). The I/O
// half (registry lookup, audit writes, review routing) is automation-hold.js, which re-exports this.
import crypto from "node:crypto";

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
export function staticHoldRow(x) {
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

export function hasAnyKey(scope) {
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
