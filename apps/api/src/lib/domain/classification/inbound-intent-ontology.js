// ─── inbound-intent-ontology.js ──────────────────────────────────────────────
// CANONICAL seller-inbound intent ontology for the SMS acquisition engine.
//
// AUTHORITY: This registry is the single semantic source of truth for what an
// inbound seller message can MEAN, independent of which detector produced the
// label. It reconciles three existing vocabularies without breaking any:
//   1. classify.js INTENT_PRIORITY (LIVE production classifier labels)
//   2. seller-flow/coverage-net/canonical-intent-aliases.js (alias folding)
//   3. classify.js OBJECTION_MAP keys (objection/tone detectors)
// Every current classifier output label (including "unclear") appears in
// exactly ONE entry's classifier_aliases below. Both halves are load-time
// enforced against classify.js's EXPORTED INTENT_PRIORITY — not a copied
// list that can drift: duplicate alias registration throws, and a live
// classifier label with no alias registration throws. Entries whose
// classifier_aliases is EMPTY are known detector gaps: the ontology names
// the meaning before a detector exists for it.
//
// SEMANTIC CONTRACTS encoded here (do not weaken):
//   - not_interested is a TEMPORARY rejection, never a legal opt-out.
//   - opt_out (STOP/unsubscribe) is legally binding and blocks all future
//     contact; only fresh, human-verified written consent can undo it.
//   - wrong_number suppresses the PHONE, not the lead entity.
//   - re_engagement / changed_mind / asks_buyer_still_interested /
//     seller_initiated_after_stop SUPERSEDE stale not-interested state, but
//     seller_initiated_after_stop can never clear a legally binding opt-out.
//   - compound_intent preserves every component intent; never collapse.
//
// State-hint vocabulary is validated at load against the Universal Lead State
// Registry; terminal_hint is validated against the canonical inbound terminal
// dispositions (mirrors domain/inbound/terminal-disposition.js).

import {
  DISPOSITION_CODES,
  LIFECYCLE_STAGE_CODES,
  LEAD_TEMPERATURE_CODES,
  OPERATIONAL_STATUS_CODES,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { INTENT_PRIORITY as LIVE_CLASSIFIER_INTENT_PRIORITY } from "@/lib/domain/classification/classify.js";

export const ONTOLOGY_VERSION = "inbound_intent_ontology_v1";

export const INTENT_CATEGORIES = Object.freeze([
  "identity",
  "ownership_authority",
  "engagement",
  "negotiation",
  "compliance",
  "logistics",
  "property_facts",
  "legal_financial",
  "meta_signal",
]);

// Canonical inbound terminal dispositions (kept in lockstep with
// domain/inbound/terminal-disposition.js — hardcoded here so this registry
// depends only on stable modules).
export const TERMINAL_DISPOSITION_HINTS = Object.freeze([
  "reply_sent",
  "reply_deferred_compliance",
  "suppressed_opt_out",
  "suppressed_wrong_number",
  "suppressed_policy",
  "human_review_required",
  "duplicate_ignored",
  "no_reply_required",
  "failed_retriable",
  "failed_terminal",
]);

// Non-terminal: the inbound is parked awaiting burst finalization. Kept
// separate from TERMINAL_DISPOSITION_HINTS so nothing treats a scheduling
// handoff as a finished outcome (see domain/inbound/terminal-disposition.js).
export const PENDING_DISPOSITION_HINTS = Object.freeze(["reply_deferred_burst"]);

const AUTOMATION_MODES = new Set(["continue", "pause", "stop"]);

const NO_COMPLIANCE = { legally_binding_opt_out: false, blocks_all_future_contact: false };

// ─── Raw definitions (intent slug is injected from the key) ──────────────────

const RAW = {
  // ═══ IDENTITY ══════════════════════════════════════════════════════════════
  wrong_number: {
    category: "identity",
    description:
      "This phone does not reach the intended person. Suppresses THIS PHONE NUMBER only — the lead entity/property remains valid and reachable via other contacts.",
    terminal_hint: "suppressed_wrong_number",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: false, objective: "Suppress this phone number; no further outreach to it." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "wrong_number", automation: "stop" },
    classifier_aliases: ["wrong_number", "wrong_person", "wrong person", "wrong number", "wrong_num", "invalid_number"],
    compliance: NO_COMPLIANCE,
  },
  family_member: {
    category: "identity",
    description: "A family member of the owner is replying (spouse, child, sibling). Non-terminal relationship lane — scoped review, not global suppression.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Acknowledge, capture the relationship, ask for the owner's preferred contact path." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "needs_review", lead_temperature: "unscored", disposition: "referred", automation: "pause" },
    classifier_aliases: ["family_member_respondent"],
    compliance: NO_COMPLIANCE,
  },
  tenant: {
    category: "identity",
    description: "The respondent is a tenant at the property, not the owner. Never pitch the occupant; owner discovery is a human lane.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: true, objective: "Do not pitch the occupant; route owner discovery to a human." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "needs_review", lead_temperature: "cold", disposition: "wrong_person", automation: "pause" },
    classifier_aliases: ["tenant_respondent"],
    compliance: NO_COMPLIANCE,
  },
  property_manager: {
    category: "identity",
    description: "A property manager replying on the owner's behalf. May hold a contact path to the owner but cannot bind a sale.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Capture the management relationship and the owner contact path." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "needs_review", lead_temperature: "unscored", disposition: "referred", automation: "pause" },
    classifier_aliases: ["property_manager_respondent"],
    compliance: NO_COMPLIANCE,
  },
  partner_co_owner: {
    category: "identity",
    description: "A partner or co-owner is replying. A legitimate owner-side party — engagement continues, but binding terms need all owners on title.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Engage the co-owner; note that binding terms require all owners." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "active_communication", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["co_owner_respondent"],
    compliance: NO_COMPLIANCE,
  },
  agent_represents_owner: {
    category: "identity",
    description: "A real-estate agent or other representative is answering for the owner. Represented-party conversations are a human lane.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Route represented-owner conversations to a human." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "referred", automation: "pause" },
    classifier_aliases: ["agent_representative_respondent"],
    compliance: NO_COMPLIANCE,
  },
  business_office: {
    category: "identity",
    description: "The number reaches a business/office line (front desk, answering service) rather than a decision maker.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: true, objective: "Verify whether this line can reach a decision maker." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  spam_unrelated: {
    category: "identity",
    description: "Inbound junk: solicitation, phishing, or content wholly unrelated to the outreach. Not a seller signal.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: false, objective: "Ignore junk/unrelated inbound; no reply." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "unqualified", automation: "pause" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  unclear_identity: {
    category: "identity",
    description: "Cannot yet tell WHO is replying (owner, relative, tenant, stranger). One clarifying question resolves the lane.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Ask one clarifying question to establish who is replying." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  who_is_this: {
    category: "identity",
    description: "Seller asks who is texting them ('who is this?'). Legacy classifier-aligned entry; answer with transparent identification.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Identify ourselves and restate why we reached out." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["who_is_this", "who_is_this_"],
    compliance: NO_COMPLIANCE,
  },
  asks_who_we_are: {
    category: "identity",
    description: "Seller asks about the company/buyer entity itself ('what company is this? are you an investor?'). Richer twin of who_is_this.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Introduce the company and purpose transparently." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },

  // ═══ OWNERSHIP / AUTHORITY ═════════════════════════════════════════════════
  owner_confirmation: {
    category: "ownership_authority",
    description: "Respondent confirms they own the property in question. Anchors Stage 1 and unlocks the interest probe.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Confirm ownership on record and advance to the interest probe." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "active_communication", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["ownership_confirmed", "ownership confirmed", "ownership confirmation", "owner_confirmed"],
    compliance: NO_COMPLIANCE,
  },
  not_owner: {
    category: "ownership_authority",
    description: "Respondent states they are not (and never were) the owner of this property. Phone-level suppression for this property; no lifecycle advance.",
    terminal_hint: "suppressed_wrong_number",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: false, objective: "Suppress this phone for this property; do not advance." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "wrong_person", automation: "stop" },
    classifier_aliases: ["property_specific_non_owner", "not_the_owner", "never_been_owner", "never_owned"],
    compliance: NO_COMPLIANCE,
  },
  former_owner: {
    category: "ownership_authority",
    description: "Respondent used to own the property but no longer does. Ownership has passed; suppress this pairing.",
    terminal_hint: "suppressed_wrong_number",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: false, objective: "Suppress; ownership has passed to someone else." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "sold", automation: "stop" },
    classifier_aliases: ["former_owner", "former_owner_respondent", "no_longer_owner"],
    compliance: NO_COMPLIANCE,
  },
  sold_property: {
    category: "ownership_authority",
    description: "Seller reports the property has already been sold. Terminal for this opportunity; suppress the pairing.",
    terminal_hint: "suppressed_wrong_number",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: false, objective: "Suppress; the property has already sold." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "sold", automation: "stop" },
    classifier_aliases: ["already_sold", "sold_it"],
    compliance: NO_COMPLIANCE,
  },
  authority_question: {
    category: "ownership_authority",
    description: "It is unclear whether the respondent has legal authority to sell (divorce, disputed title, split ownership). Resolve authority before negotiating.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Clarify who has legal authority to sell before negotiating." },
    state_hints: { lifecycle_stage: "ownership_confirmation", operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: ["divorce"],
    compliance: NO_COMPLIANCE,
  },
  awaiting_spouse_cosigner: {
    category: "ownership_authority",
    description: "Progress is gated on a spouse/co-signer who must agree or sign. Hold in a waiting lane with scheduled follow-up.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Acknowledge and schedule follow-up until the co-signer weighs in." },
    state_hints: { lifecycle_stage: null, operational_status: "waiting_on_seller", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  awaiting_executor_trustee: {
    category: "ownership_authority",
    description: "Progress is gated on an executor or trustee decision. Authority verification is a human/legal lane.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Hold for the executor/trustee; a human confirms authority." },
    state_hints: { lifecycle_stage: null, operational_status: "waiting_on_seller", lead_temperature: "warm", disposition: "none", automation: "pause" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  referral_new_decision_maker: {
    category: "ownership_authority",
    description: "Respondent redirects to the real decision maker ('talk to my daughter, she handles it'). Capture the referral and re-target.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Thank, capture the referred decision maker, re-target outreach." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "referred", automation: "pause" },
    classifier_aliases: ["non_owner_referral"],
    compliance: NO_COMPLIANCE,
  },

  // ═══ ENGAGEMENT ════════════════════════════════════════════════════════════
  interested: {
    category: "engagement",
    description: "Seller signals willingness to sell / openness to an offer. Primary positive engagement intent.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Advance interest into the price conversation." },
    state_hints: { lifecycle_stage: "offer_interest", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    // "positive_interest" is the V1 auto-reply planner's label for the same
    // meaning (resolve-seller-auto-reply-plan.js) and a follow-up policy key
    // (ACTIVE_INTENTS) — bridged here so no policy key is orphaned.
    classifier_aliases: ["seller_interested", "interested", "open_to_offer", "open_to_selling", "property_interest", "motivated", "positive_interest"],
    compliance: NO_COMPLIANCE,
  },
  conditionally_interested: {
    category: "engagement",
    description: "Interest with a stated condition ('if the price is right', 'depends'). Latent/qualified interest — advance while surfacing the condition.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Surface the stated condition and advance the conversation." },
    state_hints: { lifecycle_stage: "offer_interest", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    // "conditional_interest" / "maybe_depends_on_price" are the V1 planner and
    // follow-up nurture-policy labels for exactly this meaning (NURTURE_DAYS,
    // resolve-deferred-queue-message candidates) — bridged so the policy keys
    // resolve to a canonical slug instead of orphaning.
    classifier_aliases: ["latent_interest", "curious", "conditional_interest", "maybe_depends_on_price"],
    compliance: NO_COMPLIANCE,
  },
  not_interested: {
    category: "engagement",
    description: "TEMPORARY rejection ('no thanks', 'not selling'). NOT a legal opt-out: the lead remains legally contactable and future re-engagement is allowed. Never conflate with opt_out.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "Soft close politely; leave the door open for later re-engagement." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "not_interested", automation: "pause" },
    classifier_aliases: ["not_interested"],
    compliance: NO_COMPLIANCE,
  },
  follow_up_later: {
    category: "engagement",
    description: "Seller asks to be contacted at a later, often specific, time ('text me in the spring'). Schedule the requested follow-up window.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Acknowledge and schedule the requested follow-up window." },
    state_hints: { lifecycle_stage: null, operational_status: "follow_up_due", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["text_me_later"],
    compliance: NO_COMPLIANCE,
  },
  need_time: {
    category: "engagement",
    description: "Seller needs time to think / is not ready yet. Legacy classifier-aligned entry; low-pressure defer, not a rejection.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Give space and confirm a low-pressure follow-up." },
    state_hints: { lifecycle_stage: null, operational_status: "follow_up_due", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["need_time", "not_ready", "overwhelmed"],
    compliance: NO_COMPLIANCE,
  },
  already_listed: {
    category: "engagement",
    description: "Property is already listed on the market or under contract with another party. Stand down; optional long-cycle follow-up.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "Stand down while listed; optional long-cycle follow-up." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "not_interested", automation: "pause" },
    classifier_aliases: ["already_listed", "listed_or_unavailable", "under_contract"],
    compliance: NO_COMPLIANCE,
  },
  agent_involved: {
    category: "engagement",
    description: "Seller directs us to their agent ('talk to my realtor'). Represented negotiation is a human lane.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: true, objective: "Route agent-represented negotiation to a human." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "cold", disposition: "referred", automation: "pause" },
    classifier_aliases: ["listed_with_agent"],
    compliance: NO_COMPLIANCE,
  },
  trust_concern: {
    category: "engagement",
    description: "Seller doubts legitimacy ('is this a scam?', 'prove you're real', proof-of-funds demands). Answer with transparency, not pressure.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Reassure with transparency and verifiable legitimacy." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["skeptical", "wants_proof_of_funds"],
    compliance: NO_COMPLIANCE,
  },
  family_approval_needed: {
    category: "engagement",
    description: "Seller must check with family before deciding ('need to ask my kids'). Waiting lane with scheduled follow-up.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Acknowledge the family decision loop; schedule follow-up." },
    state_hints: { lifecycle_stage: null, operational_status: "waiting_on_seller", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["need_family_ok"],
    compliance: NO_COMPLIANCE,
  },
  re_engagement: {
    category: "engagement",
    description: "A previously cold/inactive seller re-opens the conversation. SUPERSEDES stale not-interested state — automation resumes.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Re-open the thread; supersede stale not-interested state." },
    state_hints: { lifecycle_stage: "offer_interest", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  changed_mind: {
    category: "engagement",
    description: "Seller explicitly reverses a prior refusal ('changed my mind, I'll sell'). SUPERSEDES stale not-interested state; treat as hot.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Restart the sell conversation immediately." },
    state_hints: { lifecycle_stage: "offer_interest", operational_status: "active_communication", lead_temperature: "hot", disposition: "interested", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  asks_buyer_still_interested: {
    category: "engagement",
    description: "Seller asks whether WE are still interested in buying ('you still want the house?'). SUPERSEDES stale not-interested state.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Confirm continued interest and advance." },
    state_hints: { lifecycle_stage: "offer_interest", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: ["asks_buyer_still_interested"],
    compliance: NO_COMPLIANCE,
  },
  info_request: {
    category: "engagement",
    description: "Seller asks a general process/terms question ('how does this work?', cash-offer mechanics). Legacy classifier-aligned entry.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Answer the question plainly; keep the thread moving." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["info_request", "cash_aware"],
    compliance: NO_COMPLIANCE,
  },

  // ═══ NEGOTIATION ═══════════════════════════════════════════════════════════
  requests_offer: {
    category: "negotiation",
    description: "Seller asks us to make/send an offer ('what's your offer?', 'send me numbers'). Strong buying signal.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Move to offer construction." },
    state_hints: { lifecycle_stage: "offer", operational_status: "active_communication", lead_temperature: "hot", disposition: "interested", automation: "continue" },
    classifier_aliases: ["asks_offer", "send_offer_first"],
    compliance: NO_COMPLIANCE,
  },
  asks_price: {
    category: "negotiation",
    description: "Seller asks what we would pay ('how much are you offering?'). Handle per stage playbook without anchoring badly.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Handle the price question per the stage playbook." },
    state_hints: { lifecycle_stage: "asking_price", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: ["price_curious"],
    compliance: NO_COMPLIANCE,
  },
  gives_asking_price: {
    category: "negotiation",
    description: "Seller states their asking price / bottom line. Record it verbatim; advance toward condition and offer.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Record the asking price; advance to condition/offer." },
    state_hints: { lifecycle_stage: "asking_price", operational_status: "active_communication", lead_temperature: "hot", disposition: "interested", automation: "continue" },
    classifier_aliases: ["asking_price_provided", "asking_price_value", "asking_price", "price_given", "seller_asking_price"],
    compliance: NO_COMPLIANCE,
  },
  price_negotiation: {
    category: "negotiation",
    description: "Active price back-and-forth: counteroffers, 'need more money', retail-price expectations, competing-buyer leverage.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Negotiate within ADE bounds." },
    state_hints: { lifecycle_stage: "offer", operational_status: "active_communication", lead_temperature: "hot", disposition: "interested", automation: "continue" },
    classifier_aliases: ["need_more_money", "wants_retail", "has_other_buyer"],
    compliance: NO_COMPLIANCE,
  },
  timeline_negotiation: {
    category: "negotiation",
    description: "Negotiation over WHEN: close date, urgency to sell fast, or need to delay. Align the timeline with the seller's constraint.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Align the close timeline with the seller's constraint." },
    state_hints: { lifecycle_stage: "offer", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: ["urgency"],
    compliance: NO_COMPLIANCE,
  },
  contract_request: {
    category: "negotiation",
    description: "Seller asks for the contract / a written formal offer. Binding paperwork is prepared and sent by a human.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human prepares and sends binding paperwork." },
    state_hints: { lifecycle_stage: "formal_contract", operational_status: "needs_review", lead_temperature: "hot", disposition: "interested", automation: "pause" },
    classifier_aliases: ["wants_written_offer"],
    compliance: NO_COMPLIANCE,
  },
  contract_question: {
    category: "negotiation",
    description: "Seller asks about contract terms, clauses, or process. Answers may carry binding weight — human lane.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human answers questions about binding terms." },
    state_hints: { lifecycle_stage: "formal_contract", operational_status: "needs_review", lead_temperature: "hot", disposition: "interested", automation: "pause" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  contract_declined: {
    category: "negotiation",
    description: "Seller declines to sign the presented contract. A human assesses salvage (renegotiate) vs close-out.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: true, objective: "A human assesses salvage vs close-out after the declined contract." },
    state_hints: { lifecycle_stage: "formal_contract", operational_status: "needs_review", lead_temperature: "warm", disposition: "none", automation: "pause" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },

  // ═══ COMPLIANCE ════════════════════════════════════════════════════════════
  opt_out: {
    category: "compliance",
    description: "Legally binding opt-out (STOP/unsubscribe/DNC). Blocks ALL future contact. Contactability=opted_out is the authoritative record; only fresh, human-verified written consent can undo it.",
    terminal_hint: "suppressed_opt_out",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: false, objective: "Honor STOP immediately; carrier-level acknowledgement only." },
    state_hints: { lifecycle_stage: null, operational_status: "paused", lead_temperature: "cold", disposition: "not_interested", automation: "stop" },
    classifier_aliases: ["opt_out", "stop", "unsubscribe", "dnc", "do_not_contact", "opted_out", "stop_texting"],
    compliance: { legally_binding_opt_out: true, blocks_all_future_contact: true },
  },
  hostile: {
    category: "compliance",
    description: "Hostility, threats, harassment claims, or legal escalation (attorney, lawsuit). Never a bare automated reply — compliance hold with policy suppression.",
    terminal_hint: "suppressed_policy",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: true, objective: "No automated reply; compliance/human review of the hostility or legal claim." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "cold", disposition: "unqualified", automation: "stop" },
    // "timing_complaint" (V1 planner label for "why are you texting me at
    // 6am"-class messages) is policy-suppressed exactly like hostility:
    // SUPPRESSED_INTENTS treats it as permanent suppression, the stage map
    // routes it to the hostile_or_legal lane with manual review, and
    // exception-workflows maps it to legal_compliance_hold — bridged here so
    // the policy key resolves instead of orphaning.
    classifier_aliases: ["hostile_or_legal", "hostile", "legal", "attorney", "harassment", "legal_threat", "hostile_legal", "frustrated", "timing_complaint"],
    compliance: { legally_binding_opt_out: false, blocks_all_future_contact: true },
  },
  seller_initiated_after_stop: {
    category: "compliance",
    description: "A seller who previously sent STOP now texts in on their own. Supersedes stale not-interested state, but MUST NOT clear a legally binding opt-out — the prior STOP still blocks automated outbound until a human records fresh written re-consent.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human verifies re-consent; automation may not resume outbound on its own." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  asks_how_number_obtained: {
    category: "compliance",
    description: "Seller asks where we got their number/info. Compliance-sensitive provenance question — answer transparently (public records).",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Answer data provenance transparently (public records)." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["how_got_number", "info_source"],
    compliance: NO_COMPLIANCE,
  },

  // ═══ LOGISTICS ═════════════════════════════════════════════════════════════
  requests_call: {
    category: "logistics",
    description: "Seller asks for a phone call. Acknowledge by SMS; a human places the call.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Acknowledge and hand off to a human caller." },
    state_hints: { lifecycle_stage: null, operational_status: "follow_up_due", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: ["callback_requested", "needs_call", "wants_call"],
    compliance: NO_COMPLIANCE,
  },
  requests_email: {
    category: "logistics",
    description: "Seller prefers email or asks for material by email. Collect/confirm the address and move the material over.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Collect/confirm email and move the material over." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["needs_email", "requests_email"],
    compliance: NO_COMPLIANCE,
  },
  voicemail_call_request: {
    category: "logistics",
    description: "Seller references a voicemail or asks for a call back after one. A human returns the call; SMS acknowledges.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Acknowledge the voicemail ask; a human returns the call." },
    state_hints: { lifecycle_stage: null, operational_status: "follow_up_due", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["voicemail_call_request"],
    compliance: NO_COMPLIANCE,
  },
  language_switch: {
    category: "logistics",
    description: "Seller replies in (or requests) a different language. Continue in the seller's language via the language registry.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Continue in the seller's language via the language registry." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["language_switch"],
    compliance: NO_COMPLIANCE,
  },
  asks_which_property: {
    category: "logistics",
    description: "Seller asks which property we mean ('which house?'). State the exact address being referenced.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "State the exact property address being referenced." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },

  // ═══ PROPERTY FACTS ════════════════════════════════════════════════════════
  property_correction: {
    category: "property_facts",
    description: "Seller corrects a property fact we stated (type, beds, address detail). Correct the record and confirm.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Correct the property record and confirm back." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["property_correction"],
    compliance: NO_COMPLIANCE,
  },
  condition_disclosure: {
    category: "property_facts",
    description: "Seller volunteers property-condition facts (roof, foundation, 'needs work', as-is willingness). Feed underwriting.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Capture condition facts; feed underwriting." },
    state_hints: { lifecycle_stage: "property_condition", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: ["condition_bad", "as_is_willing"],
    compliance: NO_COMPLIANCE,
  },
  condition_disclosed: {
    category: "property_facts",
    description: "Legacy classifier-aligned twin of condition_disclosure (classify.js label). Same semantics: condition facts disclosed.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Capture condition facts; feed underwriting." },
    state_hints: { lifecycle_stage: "property_condition", operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: ["condition_disclosed", "condition_signal", "condition_mentioned"],
    compliance: NO_COMPLIANCE,
  },
  occupancy_disclosure: {
    category: "property_facts",
    description: "Seller discloses occupancy status (vacant, owner lives elsewhere/absentee). Underwriting- and outreach-relevant.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Record the occupancy status." },
    state_hints: { lifecycle_stage: "property_condition", operational_status: "active_communication", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["vacant_property", "absentee_owner"],
    compliance: NO_COMPLIANCE,
  },
  tenant_occupied: {
    category: "property_facts",
    description: "Legacy classifier-aligned entry: the PROPERTY is tenant-occupied (distinct from the 'tenant' identity intent, where the tenant is the one replying).",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Record tenancy; factor tenants into offer/logistics." },
    state_hints: { lifecycle_stage: "property_condition", operational_status: "active_communication", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["tenant_occupied", "tenant_or_occupancy", "occupancy", "occupant", "renter", "renter_occupant"],
    compliance: NO_COMPLIANCE,
  },
  tenant_issue: {
    category: "property_facts",
    description: "Seller reports tenant problems (non-payment, damage, tired landlord). Strong motivation signal.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Empathize with landlord pain; strong motivation signal." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "warm", disposition: "interested", automation: "continue" },
    classifier_aliases: ["tenant_issue", "tired_landlord"],
    compliance: NO_COMPLIANCE,
  },
  multiple_properties: {
    category: "property_facts",
    description: "Seller owns or references multiple properties ('which one? I have three'). Clarify the target; capture portfolio opportunity.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Clarify which property; capture the portfolio opportunity." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "warm", disposition: "none", automation: "continue" },
    classifier_aliases: ["multiple_properties"],
    compliance: NO_COMPLIANCE,
  },

  // ═══ LEGAL / FINANCIAL ═════════════════════════════════════════════════════
  probate_estate: {
    category: "legal_financial",
    description: "Probate/estate/inheritance context (deceased owner, heirs, executor replying, grief). Legal representation may be needed — human lane with empathetic tone.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Empathetic acknowledgement; a human handles estate/probate specifics." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "warm", disposition: "none", automation: "pause" },
    classifier_aliases: ["probate", "inherited", "grieving", "executor_heir_respondent"],
    compliance: NO_COMPLIANCE,
  },
  trust_ownership: {
    category: "legal_financial",
    description: "Property is held in a trust; trustee authority governs the sale. Legal verification is a human lane.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human verifies trustee authority before negotiating." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: ["trust_ownership"],
    compliance: NO_COMPLIANCE,
  },
  llc_corporation: {
    category: "legal_financial",
    description: "Property is owned by an LLC/corporation; respondent may be an entity representative. Signing authority must be verified — human lane.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human verifies entity signing authority." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: ["entity_representative_respondent", "llc_corporation"],
    compliance: NO_COMPLIANCE,
  },
  title_issue: {
    category: "legal_financial",
    description: "Seller reports title problems (clouded title, missing heirs on deed, boundary dispute). Legal lane before any offer.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human scopes the title issue before advancing." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: ["title_issue"],
    compliance: NO_COMPLIANCE,
  },
  lien_tax_issue: {
    category: "legal_financial",
    description: "Liens, back taxes, or judgments encumber the property. Payoff math and legal exposure need a human.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human scopes liens/taxes and payoff feasibility." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: ["lien_tax_issue"],
    compliance: NO_COMPLIANCE,
  },
  foreclosure_urgency: {
    category: "legal_financial",
    description: "Foreclosure or acute financial distress with a legal clock. Time-critical — a human engages immediately.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "Time-critical distress; a human engages immediately." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "hot", disposition: "interested", automation: "pause" },
    classifier_aliases: ["financial_distress", "financial_pressure"],
    compliance: NO_COMPLIANCE,
  },
  bankruptcy: {
    category: "legal_financial",
    description: "Seller discloses a bankruptcy (filed or pending, ch. 7/11/13). Automatic-stay and trustee-approval implications — a human verifies what can legally be sold before any offer.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: true, objective: "A human verifies bankruptcy posture (automatic stay, trustee approval) before advancing." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "warm", disposition: "none", automation: "pause" },
    classifier_aliases: ["bankruptcy_disclosed"],
    compliance: NO_COMPLIANCE,
  },

  // ═══ META SIGNALS ══════════════════════════════════════════════════════════
  ambiguous_question: {
    category: "meta_signal",
    description: "A question whose referent or meaning is ambiguous. One clarifying question resolves it.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Ask one clarifying question." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  compound_intent: {
    category: "meta_signal",
    description: "Marker for multi-intent messages ('not the owner, but my sister might sell — how much?'). PRESERVE every component intent; respond to the highest-priority one WITHOUT discarding the rest.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Preserve all component intents; respond to the highest-priority one." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["compound_intent"],
    compliance: NO_COMPLIANCE,
  },
  sarcasm: {
    category: "meta_signal",
    description: "Sarcastic/ironic tone ('sure, I'd LOVE to give it away'). A literal reading is unsafe — human interprets tone.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: true, objective: "Literal reading unsafe; a human interprets the tone." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  typo_heavy: {
    category: "meta_signal",
    description: "Message is heavily misspelled/garbled but intent may still be recoverable. Interpret charitably.",
    terminal_hint: "reply_sent",
    reply_policy: { reply_required: true, reply_permitted: true, escalate_to_human: false, objective: "Interpret charitably; reply if intent is still clear." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  single_word_response: {
    category: "meta_signal",
    description: "One-word reply ('ok', 'yes', 'maybe') whose meaning depends entirely on thread context.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "Interpret from thread context; reply only if context demands it." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  emoji_only: {
    category: "meta_signal",
    description: "Message is only emoji (👍, 🙏). Lightweight reaction; no reply needed.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "Treat as a lightweight reaction; no reply needed." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["emoji_only"],
    compliance: NO_COMPLIANCE,
  },
  reaction_only: {
    category: "meta_signal",
    description: "Legacy classifier-aligned entry: a bare reaction (tapback, 'lol', 'wow') carrying no actionable intent.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "No action; thread state unchanged." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["reaction_only", "reaction"],
    compliance: NO_COMPLIANCE,
  },
  acknowledgement: {
    category: "meta_signal",
    description: "Legacy classifier-aligned entry: a simple acknowledgement ('ok', 'got it', affirmative) that closes the loop without new information.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "No action required; loop already closed." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: ["acknowledgement", "ack", "affirmative"],
    compliance: NO_COMPLIANCE,
  },
  retraction_correction: {
    category: "meta_signal",
    description: "Seller retracts or corrects their own previous message ('ignore that', 'I meant 250k'). Re-interpret the prior turn with the correction applied.",
    terminal_hint: "no_reply_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "Apply the correction to the prior message's interpretation." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "none", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  duplicate_replayed_webhook: {
    category: "meta_signal",
    description: "The same inbound event delivered more than once (provider webhook replay). Idempotency: drop the duplicate; never double-process.",
    terminal_hint: "duplicate_ignored",
    reply_policy: { reply_required: false, reply_permitted: false, escalate_to_human: false, objective: "Idempotency: drop the duplicate event." },
    state_hints: { lifecycle_stage: null, operational_status: "active_communication", lead_temperature: "unscored", disposition: "duplicate", automation: "continue" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  delayed_old_campaign_reply: {
    category: "meta_signal",
    description: "A reply arriving long after the originating campaign (stale backlog). Context may have changed — a human confirms before any automated resume.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: true, objective: "Stale-campaign reply; a human confirms context before automated resume." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: [],
    compliance: NO_COMPLIANCE,
  },
  unclear: {
    category: "meta_signal",
    description: "Fallback: no confident intent could be assigned. Coverage-net review; never auto-advance on an unknown signal.",
    terminal_hint: "human_review_required",
    reply_policy: { reply_required: false, reply_permitted: true, escalate_to_human: false, objective: "Coverage-net review; do not auto-advance on an unknown signal." },
    state_hints: { lifecycle_stage: null, operational_status: "needs_review", lead_temperature: "unscored", disposition: "none", automation: "pause" },
    classifier_aliases: ["unclear"],
    compliance: NO_COMPLIANCE,
  },
};

// ─── Build, validate, and freeze ─────────────────────────────────────────────

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const CATEGORY_SET = new Set(INTENT_CATEGORIES);
const TERMINAL_SET = new Set(TERMINAL_DISPOSITION_HINTS);
const LIFECYCLE_SET = new Set(Object.values(LIFECYCLE_STAGE_CODES));
const OPERATIONAL_SET = new Set(Object.values(OPERATIONAL_STATUS_CODES));
const TEMPERATURE_SET = new Set(Object.values(LEAD_TEMPERATURE_CODES));
const DISPOSITION_SET = new Set(Object.values(DISPOSITION_CODES));

const ALIAS_INDEX = new Map();

for (const [slug, def] of Object.entries(RAW)) {
  if (!CATEGORY_SET.has(def.category)) {
    throw new Error(`inbound-intent-ontology: ${slug} has unknown category ${def.category}`);
  }
  if (!TERMINAL_SET.has(def.terminal_hint)) {
    throw new Error(`inbound-intent-ontology: ${slug} has unknown terminal_hint ${def.terminal_hint}`);
  }
  const hints = def.state_hints;
  if (hints.lifecycle_stage !== null && !LIFECYCLE_SET.has(hints.lifecycle_stage)) {
    throw new Error(`inbound-intent-ontology: ${slug} has unknown lifecycle_stage ${hints.lifecycle_stage}`);
  }
  if (!OPERATIONAL_SET.has(hints.operational_status)) {
    throw new Error(`inbound-intent-ontology: ${slug} has unknown operational_status ${hints.operational_status}`);
  }
  if (!TEMPERATURE_SET.has(hints.lead_temperature)) {
    throw new Error(`inbound-intent-ontology: ${slug} has unknown lead_temperature ${hints.lead_temperature}`);
  }
  if (!DISPOSITION_SET.has(hints.disposition)) {
    throw new Error(`inbound-intent-ontology: ${slug} has unknown disposition ${hints.disposition}`);
  }
  if (!AUTOMATION_MODES.has(hints.automation)) {
    throw new Error(`inbound-intent-ontology: ${slug} has unknown automation mode ${hints.automation}`);
  }
  for (const alias of def.classifier_aliases) {
    const key = String(alias).trim().toLowerCase();
    if (ALIAS_INDEX.has(key)) {
      throw new Error(
        `inbound-intent-ontology: alias "${key}" registered on both ${ALIAS_INDEX.get(key)} and ${slug}`
      );
    }
    ALIAS_INDEX.set(key, slug);
  }
}

// Load-time classifier coverage: every label the LIVE classifier can emit
// (classify.js's exported INTENT_PRIORITY — the real output vocabulary, not a
// copied mirror) must resolve to exactly ONE ontology entry. "Exactly one" is
// the pairing of this membership check with the duplicate-registration throw
// above.
for (const label of LIVE_CLASSIFIER_INTENT_PRIORITY) {
  const key = String(label).trim().toLowerCase();
  if (!ALIAS_INDEX.has(key)) {
    throw new Error(
      `inbound-intent-ontology: live classifier label "${key}" is not registered in any entry's classifier_aliases`
    );
  }
}

export const INBOUND_INTENT_ONTOLOGY = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW).map(([slug, def]) => [slug, deepFreeze({ intent: slug, ...def })])
  )
);

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fold ANY current classifier label or legacy alias onto its canonical
 * ontology slug. Lowercases/trims; unknown labels collapse to "unclear".
 */
export function normalizeToCanonicalIntent(label = null) {
  const value = String(label ?? "").trim().toLowerCase();
  if (!value) return "unclear";
  if (Object.prototype.hasOwnProperty.call(INBOUND_INTENT_ONTOLOGY, value)) return value;
  if (ALIAS_INDEX.has(value)) return ALIAS_INDEX.get(value);
  // Snake-case fold of free text (e.g. "Wrong Person!" → "wrong_person").
  const folded = value.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (Object.prototype.hasOwnProperty.call(INBOUND_INTENT_ONTOLOGY, folded)) return folded;
  if (ALIAS_INDEX.has(folded)) return ALIAS_INDEX.get(folded);
  return "unclear";
}

/** Ontology entry lookup with unclear fallback. Accepts slugs or aliases. */
export function getIntentDefinition(slug = null) {
  return (
    INBOUND_INTENT_ONTOLOGY[normalizeToCanonicalIntent(slug)] ??
    INBOUND_INTENT_ONTOLOGY.unclear
  );
}

/**
 * Canonical intents with NO live detector today (classifier_aliases empty).
 * This is the detector-gap worklist for classifier expansion.
 */
export function listIntentsWithoutClassifierCoverage() {
  return Object.values(INBOUND_INTENT_ONTOLOGY)
    .filter((def) => def.classifier_aliases.length === 0)
    .map((def) => def.intent);
}

export default {
  ONTOLOGY_VERSION,
  INTENT_CATEGORIES,
  TERMINAL_DISPOSITION_HINTS,
  INBOUND_INTENT_ONTOLOGY,
  normalizeToCanonicalIntent,
  getIntentDefinition,
  listIntentsWithoutClassifierCoverage,
};
