// ─── acquisition-lifecycle-events.js ───────────────────────────────────────
// Canonical event vocabulary for the event-driven acquisition lifecycle.
//
// These constants name the transitions that the deterministic stage engines
// emit. A single event is the source of truth that downstream consumers
// (property dossier, master owner, prospect, campaign target, inbox, queue,
// pipeline, map, analytics, acquisition cockpit) read to derive canonical
// stage/status. Engines BUILD events; persistence/fan-out is performed by the
// caller (no production writes happen here).
//
// This module is pure and has zero side effects so it can be unit tested and
// imported anywhere without pulling DB/provider dependencies.

export const ACQUISITION_LIFECYCLE_EVENTS = Object.freeze({
  // ── Stage 1 → Stage 2 entry ───────────────────────────────────────────────
  OWNER_CONFIRMED: "OWNER_CONFIRMED",

  // ── Stage 2 (Offer Interest) ──────────────────────────────────────────────
  OFFER_INTEREST_CONFIRMED: "OFFER_INTEREST_CONFIRMED",
  CONDITIONAL_INTEREST_DETECTED: "CONDITIONAL_INTEREST_DETECTED",
  SELLER_REQUESTED_OFFER: "SELLER_REQUESTED_OFFER",
  SELLER_ASKING_PRICE_CAPTURED: "SELLER_ASKING_PRICE_CAPTURED",
  SELLER_NOT_INTERESTED: "SELLER_NOT_INTERESTED",
  SELLER_FOLLOW_UP_REQUESTED: "SELLER_FOLLOW_UP_REQUESTED",
  SELLER_LISTED_WITH_AGENT: "SELLER_LISTED_WITH_AGENT",
  SELLER_NEEDS_SIGNOFF: "SELLER_NEEDS_SIGNOFF",
  SELLER_TRUST_QUESTION: "SELLER_TRUST_QUESTION",

  // ── Stage 3 (Asking Price / acquisition decision) ─────────────────────────
  ASKING_PRICE_EVALUATED: "ASKING_PRICE_EVALUATED",
  ADVANCED_TO_SELLER_CONTRACT: "ADVANCED_TO_SELLER_CONTRACT",
  OFFER_NEGOTIATION_OPENED: "OFFER_NEGOTIATION_OPENED",
  CONDITION_PROBE_REQUESTED: "CONDITION_PROBE_REQUESTED",
  CREATIVE_FINANCE_PROPOSED: "CREATIVE_FINANCE_PROPOSED",
  DEAL_NURTURE_TRIGGERED: "DEAL_NURTURE_TRIGGERED",

  // ── Stage 4 (Condition / Price Justification) ─────────────────────────────
  CONDITION_FACT_CAPTURED: "CONDITION_FACT_CAPTURED",
  REPAIR_ISSUE_CAPTURED: "REPAIR_ISSUE_CAPTURED",
  OCCUPANCY_STATUS_CAPTURED: "OCCUPANCY_STATUS_CAPTURED",
  CONDITION_INFO_REQUESTED: "CONDITION_INFO_REQUESTED",
  PRICE_JUSTIFICATION_REQUESTED: "PRICE_JUSTIFICATION_REQUESTED",
  PRICE_GAP_NARROWING_OPENED: "PRICE_GAP_NARROWING_OPENED",
  CREATIVE_TERMS_PROPOSED: "CREATIVE_TERMS_PROPOSED",
  READY_FOR_OFFER_REVEAL: "READY_FOR_OFFER_REVEAL",
  CONDITION_HUMAN_REVIEW_REQUIRED: "CONDITION_HUMAN_REVIEW_REQUIRED",

  // ── Stage 5 (Offer / Negotiation) ─────────────────────────────────────────
  OFFER_REVEALED: "OFFER_REVEALED",
  SELLER_COUNTER_OFFERED: "SELLER_COUNTER_OFFERED",
  COUNTER_OFFER_ACCEPTABLE: "COUNTER_OFFER_ACCEPTABLE",
  COUNTER_OFFER_TOO_HIGH: "COUNTER_OFFER_TOO_HIGH",
  NEGOTIATION_OPENED: "NEGOTIATION_OPENED",
  NEGOTIATION_NARROWED: "NEGOTIATION_NARROWED",
  SELLER_ACCEPTED_OFFER: "SELLER_ACCEPTED_OFFER",
  SELLER_REJECTED_OFFER: "SELLER_REJECTED_OFFER",
  SELLER_REQUESTED_BEST_AND_FINAL: "SELLER_REQUESTED_BEST_AND_FINAL",
  SELLER_REQUESTED_PROOF: "SELLER_REQUESTED_PROOF",
  CREATIVE_FINANCE_CANDIDATE: "CREATIVE_FINANCE_CANDIDATE",
  SELLER_FINANCE_CANDIDATE: "SELLER_FINANCE_CANDIDATE",
  SUBJECT_TO_CANDIDATE: "SUBJECT_TO_CANDIDATE",
  NOVATION_CANDIDATE: "NOVATION_CANDIDATE",
  READY_FOR_CONTRACT: "READY_FOR_CONTRACT",

  // ── Stage 6 (Seller Contract) ─────────────────────────────────────────────
  CONTRACT_READY: "CONTRACT_READY",
  CONTRACT_REQUESTED: "CONTRACT_REQUESTED",
  CONTRACT_SENT: "CONTRACT_SENT",
  CONTRACT_VIEWED: "CONTRACT_VIEWED",
  CONTRACT_OPENED: "CONTRACT_OPENED",
  CONTRACT_SIGNED: "CONTRACT_SIGNED",
  CONTRACT_PARTIALLY_SIGNED: "CONTRACT_PARTIALLY_SIGNED",
  WAITING_ON_CO_SIGNER: "WAITING_ON_CO_SIGNER",
  WAITING_ON_FAMILY_SIGNER: "WAITING_ON_FAMILY_SIGNER",
  WAITING_ON_SPOUSE_SIGNER: "WAITING_ON_SPOUSE_SIGNER",
  WAITING_ON_LLC_AUTHORITY: "WAITING_ON_LLC_AUTHORITY",
  WAITING_ON_EXECUTOR: "WAITING_ON_EXECUTOR",
  WAITING_ON_TRUSTEE: "WAITING_ON_TRUSTEE",
  EMAIL_VERIFIED: "EMAIL_VERIFIED",
  AUTHORITY_VERIFIED: "AUTHORITY_VERIFIED",
  TITLE_ISSUE_DETECTED: "TITLE_ISSUE_DETECTED",
  PROBATE_DETECTED: "PROBATE_DETECTED",
  HEIRSHIP_DETECTED: "HEIRSHIP_DETECTED",
  READY_FOR_DISPOSITION: "READY_FOR_DISPOSITION",
});

const KNOWN_EVENT_TYPES = new Set(Object.values(ACQUISITION_LIFECYCLE_EVENTS));

function cleanId(value) {
  if (value === null || value === undefined || value === "") return null;
  return value;
}

/**
 * Build a canonical lifecycle event payload.
 *
 * The payload preserves the full entity graph (property → master owner →
 * prospect → contact point) so a single event can universally update every
 * downstream consumer without re-deriving identity.
 *
 * @param {string} type - One of ACQUISITION_LIFECYCLE_EVENTS.
 * @param {object} params
 * @param {object} [params.entities] - { property_id, master_owner_id, prospect_id, contact_point_id }
 * @param {string} [params.stage_code] - Canonical stage code the event moves to (e.g. "S2").
 * @param {string} [params.status] - Canonical status (e.g. "awaiting_offer_interest").
 * @param {object} [params.data] - Event-specific facts (price, gap metrics, etc.).
 * @param {string|number} [params.source_message_id] - Inbound message that produced the event.
 * @param {string|Date} [params.occurred_at] - Injectable timestamp (deterministic tests).
 * @returns {object} Canonical event.
 */
export function buildLifecycleEvent(
  type,
  {
    entities = {},
    stage_code = null,
    status = null,
    data = {},
    source_message_id = null,
    occurred_at = null,
  } = {}
) {
  const resolved_at =
    occurred_at instanceof Date
      ? occurred_at.toISOString()
      : occurred_at || new Date().toISOString();

  return {
    type,
    is_known_type: KNOWN_EVENT_TYPES.has(type),
    occurred_at: resolved_at,
    stage_code: stage_code || null,
    status: status || null,
    entities: {
      property_id: cleanId(entities.property_id),
      master_owner_id: cleanId(entities.master_owner_id),
      prospect_id: cleanId(entities.prospect_id),
      contact_point_id: cleanId(entities.contact_point_id),
    },
    source_message_id: cleanId(source_message_id),
    data: data || {},
  };
}

export function isKnownLifecycleEvent(type) {
  return KNOWN_EVENT_TYPES.has(type);
}

export default {
  ACQUISITION_LIFECYCLE_EVENTS,
  buildLifecycleEvent,
  isKnownLifecycleEvent,
};
