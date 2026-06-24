// ─── stage6-seller-contract-engine.js ──────────────────────────────────────
// Stage 6 — Seller Contract Engine (DETERMINISTIC, NO AI).
//
// Takes a seller who reached agreement in Stage 5 and resolves contract +
// signer + authority + document + execution + title readiness, then routes to
// the right next state (still-waiting, contract lifecycle tracking, or handoff
// to disposition).
//
// No AI is used for classification, contract routing, signer validation,
// approval decisions, or stage progression — everything is heuristic + table
// driven.
//
// Same posture as Stages 2–5:
//   • pure module — no DB/queue writes, no side effects, not wired into inbound
//   • additive only — Stage 1–5 behavior untouched
//   • contract / legal routes are NEVER auto-sent (all REVIEW tier)
//
// Upstream (Stage 1/2) owns compliance + wrong-number suppression.

import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { SELLER_FLOW_SAFETY_TIERS } from "@/lib/domain/seller-flow/seller-flow-safety-policy.js";
import { CONVERSATION_STAGES } from "@/lib/domain/communications-engine/state-machine.js";
import {
  ACQUISITION_LIFECYCLE_EVENTS as EV,
  buildLifecycleEvent,
} from "@/lib/domain/seller-flow/acquisition-lifecycle-events.js";

const T = SELLER_FLOW_SAFETY_TIERS;
const S = SELLER_FLOW_STAGES;

// ══════════════════════════════════════════════════════════════════════════
// ENUMS
// ══════════════════════════════════════════════════════════════════════════

export const STAGE6_OUTCOMES = Object.freeze({
  CONTRACT_READY: "contract_ready",
  CONTRACT_REQUESTED: "contract_requested",
  CONTRACT_SENT: "contract_sent",
  CONTRACT_VIEWED: "contract_viewed",
  CONTRACT_OPENED: "contract_opened",
  CONTRACT_SIGNED: "contract_signed",
  CONTRACT_PARTIALLY_SIGNED: "contract_partially_signed",
  WAITING_ON_SELLER: "waiting_on_seller",
  WAITING_ON_CO_SIGNER: "waiting_on_co_signer",
  WAITING_ON_SPOUSE: "waiting_on_spouse",
  WAITING_ON_FAMILY: "waiting_on_family",
  WAITING_ON_LLC_AUTHORITY: "waiting_on_llc_authority",
  WAITING_ON_EXECUTOR: "waiting_on_executor",
  WAITING_ON_TRUSTEE: "waiting_on_trustee",
  EMAIL_REQUIRED: "email_required",
  SIGNER_VERIFICATION_REQUIRED: "signer_verification_required",
  OWNERSHIP_VERIFICATION_REQUIRED: "ownership_verification_required",
  AUTHORITY_VERIFICATION_REQUIRED: "authority_verification_required",
  TITLE_ISSUE_DETECTED: "title_issue_detected",
  PROBATE_DETECTED: "probate_detected",
  HEIRSHIP_DETECTED: "heirship_detected",
  CONTRACT_DECLINED: "contract_declined",
  CONTRACT_EXPIRED: "contract_expired",
  READY_FOR_DISPOSITION: "ready_for_disposition",
  HUMAN_REVIEW_REQUIRED: "human_review_required",
});

export const OWNERSHIP_STRUCTURE = Object.freeze({
  INDIVIDUAL: "individual",
  MARRIED_COUPLE: "married_couple",
  MULTIPLE_OWNERS: "multiple_owners",
  LLC: "llc",
  CORPORATION: "corporation",
  TRUST: "trust",
  ESTATE: "estate",
  HEIRS: "heirs",
  POWER_OF_ATTORNEY: "power_of_attorney",
});

export const AUTHORITY_TYPE = Object.freeze({
  INDIVIDUAL: "individual",
  SPOUSE: "spouse",
  CO_OWNER: "co_owner",
  LLC_MEMBER_MANAGER: "llc_member_manager",
  CORPORATE_OFFICER: "corporate_officer",
  TRUSTEE: "trustee",
  EXECUTOR: "executor",
  HEIR: "heir",
  ATTORNEY_IN_FACT: "attorney_in_fact",
});

const RISK = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high" });
const RISK_ORDER = { low: 0, medium: 1, high: 2 };

// ══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════

function clean(value) {
  return String(value ?? "").trim();
}
function lower(value) {
  return clean(value).toLowerCase();
}
function includesAny(text, phrases = []) {
  return phrases.some((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(?:^|[^a-zA-Z0-9\\u00C0-\\u017F])${escaped}(?:$|[^a-zA-Z0-9\\u00C0-\\u017F])`,
      "i"
    );
    return regex.test(text);
  });
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function maxRisk(...risks) {
  return risks.reduce((acc, r) => (RISK_ORDER[r] > RISK_ORDER[acc] ? r : acc), RISK.LOW);
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const EMAIL_RE_G = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// ══════════════════════════════════════════════════════════════════════════
// AUTHORITY / OWNERSHIP STRUCTURE DETECTION
// ══════════════════════════════════════════════════════════════════════════

function detectAuthority({ message, entity_type, vesting_information, owner_count }) {
  const combined = `${lower(message)} ${lower(entity_type)} ${lower(vesting_information)}`;

  let structure = OWNERSHIP_STRUCTURE.INDIVIDUAL;
  let authority_type = AUTHORITY_TYPE.INDIVIDUAL;
  let confidence = 0.6;
  const from_entity = Boolean(clean(entity_type) || clean(vesting_information));

  if (includesAny(combined, ["trust", "trustee", "living trust", "family trust", "fideicomiso"])) {
    structure = OWNERSHIP_STRUCTURE.TRUST;
    authority_type = AUTHORITY_TYPE.TRUSTEE;
  } else if (includesAny(combined, ["estate", "executor", "executrix", "administrator", "probate", "albacea", "sucesión", "sucesion"])) {
    structure = OWNERSHIP_STRUCTURE.ESTATE;
    authority_type = AUTHORITY_TYPE.EXECUTOR;
  } else if (includesAny(combined, ["heir", "heirs", "heirship", "inherited it", "passed away", "heredero", "herederos"])) {
    structure = OWNERSHIP_STRUCTURE.HEIRS;
    authority_type = AUTHORITY_TYPE.HEIR;
  } else if (includesAny(combined, ["llc", "limited liability"])) {
    structure = OWNERSHIP_STRUCTURE.LLC;
    authority_type = AUTHORITY_TYPE.LLC_MEMBER_MANAGER;
  } else if (includesAny(combined, ["corporation", "corp", "incorporated", "inc"])) {
    structure = OWNERSHIP_STRUCTURE.CORPORATION;
    authority_type = AUTHORITY_TYPE.CORPORATE_OFFICER;
  } else if (includesAny(combined, ["power of attorney", "poa", "attorney in fact", "attorney-in-fact", "poder notarial"])) {
    structure = OWNERSHIP_STRUCTURE.POWER_OF_ATTORNEY;
    authority_type = AUTHORITY_TYPE.ATTORNEY_IN_FACT;
  } else if (includesAny(combined, ["my wife", "my husband", "spouse", "married", "wife also owns", "husband also owns", "mi esposa", "mi esposo", "esposa también", "esposa tambien"])) {
    structure = OWNERSHIP_STRUCTURE.MARRIED_COUPLE;
    authority_type = AUTHORITY_TYPE.SPOUSE;
  } else if (includesAny(combined, ["co-owner", "co owner", "two owners", "both own", "also owns", "on title", "on the title", "my brother is on", "my sister is on", "partner owns", "joint owners", "tenants in common", "co-dueño", "ambos dueños"])) {
    structure = OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS;
    authority_type = AUTHORITY_TYPE.CO_OWNER;
  }

  if (structure !== OWNERSHIP_STRUCTURE.INDIVIDUAL) {
    confidence = from_entity ? 0.9 : 0.7;
  } else if (from_entity) {
    confidence = 0.85;
  }

  let signer_count_required = 1;
  if (structure === OWNERSHIP_STRUCTURE.MARRIED_COUPLE) signer_count_required = 2;
  else if (structure === OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS) signer_count_required = Math.max(2, numberOrNull(owner_count) ?? 2);

  return { ownership_structure: structure, authority_type, authority_confidence: confidence, signer_count_required };
}

const ENTITY_STRUCTURES = new Set([
  OWNERSHIP_STRUCTURE.LLC,
  OWNERSHIP_STRUCTURE.CORPORATION,
  OWNERSHIP_STRUCTURE.TRUST,
  OWNERSHIP_STRUCTURE.ESTATE,
  OWNERSHIP_STRUCTURE.HEIRS,
  OWNERSHIP_STRUCTURE.POWER_OF_ATTORNEY,
]);

// ══════════════════════════════════════════════════════════════════════════
// EMAIL VERIFICATION
// ══════════════════════════════════════════════════════════════════════════

const RESEND_PHRASES = ["resend", "re-send", "send it again", "send again", "didn't get it", "didnt get it", "never received", "never got it", "haven't received", "send it over again", "reenvía", "reenviar", "no me llegó", "no me llego"];
const ALTERNATE_PHRASES = ["use this email", "send to this", "different email", "another email", "new email", "actually use", "instead use", "send it to", "use my other email", "mejor usa", "usa este correo", "envíalo a"];

function detectEmail({ message, seller_email }) {
  const text = lower(message);
  const in_message = (message.match(EMAIL_RE_G) || []).map((e) => e.toLowerCase());
  const resend_requested = includesAny(text, RESEND_PHRASES);
  const alternate_requested = includesAny(text, ALTERNATE_PHRASES);

  // A new email in the message supersedes the stored one (alternate / correction).
  const chosen = in_message[0] || clean(seller_email).toLowerCase() || null;
  const email_valid = Boolean(chosen) && EMAIL_RE.test(chosen);

  const attempted = /@/.test(message) || includesAny(text, ["email", "e-mail", "correo"]) || Boolean(clean(seller_email));
  const email_invalid = attempted && !email_valid;

  return {
    email: email_valid ? chosen : (chosen || null),
    email_verified: email_valid,
    email_invalid,
    resend_requested,
    alternate_requested,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CONTRACT STATUS NORMALIZATION
// ══════════════════════════════════════════════════════════════════════════

function normalizeContractStatus(input) {
  const raw = lower(input.contract_status || input.contract_metadata?.status);
  if (!raw) return null;
  if (["declined", "rejected", "voided"].includes(raw)) return "declined";
  if (["expired", "lapsed"].includes(raw)) return "expired";
  if (["completed", "executed", "fully_executed", "complete"].includes(raw)) return "completed";
  if (["signed", "all_signed"].includes(raw)) return "signed";
  if (["partially_signed", "partial", "partially-signed"].includes(raw)) return "partially_signed";
  if (["opened"].includes(raw)) return "opened";
  if (["viewed"].includes(raw)) return "viewed";
  if (["sent", "delivered", "out_for_signature"].includes(raw)) return "sent";
  if (["draft", "ready", "none", "not_sent"].includes(raw)) return null;
  return "unknown";
}

// ══════════════════════════════════════════════════════════════════════════
// TITLE / PROBATE / HEIRSHIP
// ══════════════════════════════════════════════════════════════════════════

function detectTitleRisk({ message, title_information }) {
  const text = lower(message);
  const ti = title_information || {};
  const has_issue =
    ti.has_issue === true ||
    includesAny(text, ["lien", "liens", "title issue", "cloud on title", "clouded title", "back taxes", "unpaid taxes", "judgment", "judgement", "title problem", "encumbrance", "gravamen", "embargo"]);
  const review = !has_issue && (ti.review === true || ti.status === "review");
  return {
    title_issue: has_issue,
    title_clearance_level: has_issue ? "blocked" : review ? "review" : "clear",
  };
}

function detectProbate({ message, ownership_structure }) {
  return includesAny(lower(message), ["probate", "in probate", "probate court", "en sucesión", "en sucesion"]) ||
    (ownership_structure === OWNERSHIP_STRUCTURE.ESTATE && includesAny(lower(message), ["passed", "died", "deceased"]));
}

function detectHeirship({ message, ownership_structure }) {
  return ownership_structure === OWNERSHIP_STRUCTURE.HEIRS ||
    includesAny(lower(message), ["heir", "heirs", "heirship", "multiple heirs", "heredero", "herederos"]);
}

// ══════════════════════════════════════════════════════════════════════════
// CONTRACT REQUEST SIGNAL
// ══════════════════════════════════════════════════════════════════════════

const CONTRACT_REQUEST_PHRASES = ["send the contract", "send contract", "send me the contract", "send the agreement", "send paperwork", "send the paperwork", "where do i sign", "where to sign", "ready to sign", "let's do the paperwork", "draw up the contract", "send the docs", "mándame el contrato", "manda el contrato", "dónde firmo", "donde firmo", "listo para firmar"];

// ══════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════

function route(stage_code, next_stage, brain_stage, status, template_use_case, inbox_bucket, acquisition_action, route_key, follow_up_policy = null) {
  return { stage_code, next_stage, brain_stage, status, template_use_case, inbox_bucket, acquisition_action, route: route_key, follow_up_policy };
}

const CONTRACT_BRAIN = CONVERSATION_STAGES.CONTRACT_OUT;
const SIGNED_BRAIN = CONVERSATION_STAGES.SIGNED_CLOSING;

// ══════════════════════════════════════════════════════════════════════════
// MAIN ENGINE
// ══════════════════════════════════════════════════════════════════════════

export function classifyStage6Contract(input = {}) {
  const message = clean(input.message);
  const context = input.context || {};
  const entities = {
    property_id: input.property_id ?? context.entities?.property_id ?? null,
    master_owner_id: input.master_owner_id ?? context.entities?.master_owner_id ?? null,
    prospect_id: input.prospect_id ?? context.entities?.prospect_id ?? null,
    contact_point_id: input.contact_point_id ?? context.entities?.contact_point_id ?? null,
  };
  const source_message_id = context.source_message_id ?? null;
  const now = context.now ?? null;

  // ── Structured + extracted facts ─────────────────────────────────────────
  const authority = detectAuthority({
    message,
    entity_type: input.entity_type,
    vesting_information: input.vesting_information,
    owner_count: input.owner_count ?? input.contract_metadata?.owner_count,
  });
  const email = detectEmail({ message, seller_email: input.seller_email });
  const title = detectTitleRisk({ message, title_information: input.title_information });
  const probate = detectProbate({ message, ownership_structure: authority.ownership_structure });
  const heirship = detectHeirship({ message, ownership_structure: authority.ownership_structure });
  const status = normalizeContractStatus(input);
  const contract_requested_signal = includesAny(lower(message), CONTRACT_REQUEST_PHRASES);

  const accepted_price = numberOrNull(input.accepted_price) ?? numberOrNull(input.seller_asking_price);
  const ownership_confidence = numberOrNull(input.ownership_confidence) ?? (clean(input.ownership_status) === "confirmed" ? 0.9 : 0.5);
  const ownership_verified = clean(input.ownership_status) === "confirmed" || ownership_confidence >= 0.7;

  // ── Signer plan ──────────────────────────────────────────────────────────
  const signer_count_required = authority.signer_count_required;
  const signer_count_confirmed =
    numberOrNull(input.signer_count_confirmed) ??
    numberOrNull(input.contract_metadata?.signers_confirmed) ??
    1;
  const signer_gap = Math.max(0, signer_count_required - signer_count_confirmed);
  const signer_status = signer_gap <= 0 ? "complete" : "pending";

  // ── Authority verification ───────────────────────────────────────────────
  let authority_verified;
  if (input.authority_verified === true || input.contract_metadata?.authority_doc === true) {
    authority_verified = true;
  } else if (authority.ownership_structure === OWNERSHIP_STRUCTURE.INDIVIDUAL) {
    authority_verified = true;
  } else if (
    authority.ownership_structure === OWNERSHIP_STRUCTURE.MARRIED_COUPLE ||
    authority.ownership_structure === OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS
  ) {
    authority_verified = signer_gap <= 0;
  } else {
    authority_verified = false; // entity structures need explicit authority
  }

  // ── Readiness flags ──────────────────────────────────────────────────────
  const email_verified = email.email_verified;
  const title_clear = title.title_clearance_level === "clear";
  const signer_ready = signer_gap <= 0;
  const contract_ready = Boolean(
    ownership_verified && authority_verified && email_verified && signer_ready &&
    title_clear && !probate && !heirship && accepted_price !== null
  );

  // ── Risk profile ─────────────────────────────────────────────────────────
  const ownership_risk = ownership_verified ? (ownership_confidence >= 0.85 ? RISK.LOW : RISK.MEDIUM) : RISK.HIGH;
  const signer_risk = signer_gap <= 0 ? RISK.LOW : signer_gap === 1 ? RISK.MEDIUM : RISK.HIGH;
  const authority_risk = authority_verified ? RISK.LOW : ENTITY_STRUCTURES.has(authority.ownership_structure) ? RISK.HIGH : RISK.MEDIUM;
  const title_risk = title.title_clearance_level === "blocked" ? RISK.HIGH : title.title_clearance_level === "review" ? RISK.MEDIUM : RISK.LOW;
  const probate_risk = probate || heirship ? RISK.HIGH : RISK.LOW;
  const overall_risk = maxRisk(ownership_risk, signer_risk, authority_risk, title_risk, probate_risk);

  const contract_risk_profile = { ownership_risk, signer_risk, authority_risk, title_risk, probate_risk, overall_risk };

  // ── Outcome + route resolution ───────────────────────────────────────────
  const resolved = resolveOutcomeAndRoute({
    status, title, probate, heirship, authority, authority_verified, email,
    signer_gap, signer_status, signer_count_required, ownership_verified,
    contract_ready, contract_requested_signal, accepted_price,
  });
  const { outcome, route: r, primary_events } = resolved;

  // ── Contract packet ──────────────────────────────────────────────────────
  const contract_packet = {
    accepted_price,
    seller_name: clean(input.seller_name) || null,
    signer_count_required,
    signer_count_confirmed,
    ownership_structure: authority.ownership_structure,
    authority_verified,
    email_verified,
    contract_ready,
    risk_level: overall_risk,
  };

  // ── Events: supporting verifications + primary routing events ────────────
  const evCommon = { entities, stage_code: r.stage_code, status: r.status, source_message_id, occurred_at: now };
  const events = [];
  if (email_verified) events.push(buildLifecycleEvent(EV.EMAIL_VERIFIED, { ...evCommon, data: { email: email.email } }));
  if (authority_verified && authority.ownership_structure !== OWNERSHIP_STRUCTURE.INDIVIDUAL) {
    events.push(buildLifecycleEvent(EV.AUTHORITY_VERIFIED, { ...evCommon, data: { authority_type: authority.authority_type } }));
  }
  for (const type of primary_events) {
    events.push(buildLifecycleEvent(type, {
      ...evCommon,
      data: {
        outcome,
        ownership_structure: authority.ownership_structure,
        authority_type: authority.authority_type,
        signer_count_required,
        signer_count_confirmed,
        signer_gap,
        risk_level: overall_risk,
      },
    }));
  }

  return {
    engine: "stage6_seller_contract",
    outcome,

    // Canonical stage routing
    stage_code: r.stage_code,
    next_stage: r.next_stage,
    brain_stage: r.brain_stage,
    status: r.status,
    route: r.route,
    inbox_bucket: r.inbox_bucket,
    template_use_case: r.template_use_case,
    follow_up_policy: r.follow_up_policy ?? null,
    acquisition_action: r.acquisition_action,

    // Readiness engine
    contract_ready,
    signer_ready,
    email_verified,
    authority_verified,
    ownership_verified,
    title_clearance_level: title.title_clearance_level,
    risk_level: overall_risk,

    // Authority detection
    ownership_structure: authority.ownership_structure,
    authority_type: authority.authority_type,
    authority_confidence: authority.authority_confidence,

    // Email
    email: email.email,
    email_invalid: email.email_invalid,
    resend_requested: email.resend_requested,
    alternate_email_requested: email.alternate_requested,

    // Signer validation
    signer_count_required,
    signer_count_confirmed,
    signer_gap,
    signer_status,

    // Reusable artifacts
    contract_packet,
    contract_risk_profile,

    // Safety — contract/legal never auto-send
    safety_tier: T.REVIEW,
    auto_send_eligible: false,
    should_queue_reply: Boolean(r.template_use_case),
    should_mark_human_review: true,

    // Canonical lifecycle events
    events,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// OUTCOME + ROUTE LADDER
// ══════════════════════════════════════════════════════════════════════════

function resolveOutcomeAndRoute(ctx) {
  const {
    status, title, probate, heirship, authority, authority_verified, email,
    signer_gap, ownership_verified, contract_ready, contract_requested_signal,
    accepted_price,
  } = ctx;
  const O = STAGE6_OUTCOMES;
  const struct = authority.ownership_structure;

  // 1. Active contract lifecycle status takes precedence (the doc is in flight).
  if (status === "declined") {
    return { outcome: O.CONTRACT_DECLINED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "contract_declined", "contract_declined_followup", "needs_review", "review_declined_contract", "contract_declined"), primary_events: [] };
  }
  if (status === "expired") {
    return { outcome: O.CONTRACT_EXPIRED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "contract_expired", "contract_resend", "needs_review", "resend_expired_contract", "contract_expired"), primary_events: [] };
  }
  if (status === "completed") {
    return { outcome: O.READY_FOR_DISPOSITION, route: route("S7", "disposition", SIGNED_BRAIN, "ready_for_disposition", "title_intro", "priority", "hand_to_disposition", "ready_for_disposition"), primary_events: [EV.READY_FOR_DISPOSITION] };
  }
  if (status === "signed") {
    if (signer_gap > 0) {
      return { outcome: O.CONTRACT_PARTIALLY_SIGNED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "partially_signed", "contract_not_signed_followup", "priority", "await_remaining_signers", "contract_partially_signed"), primary_events: [EV.CONTRACT_PARTIALLY_SIGNED, ...remainingSignerEvent(struct)] };
    }
    return { outcome: O.CONTRACT_SIGNED, route: route("S7", "disposition", SIGNED_BRAIN, "contract_signed", "title_intro", "priority", "hand_to_disposition", "ready_for_disposition"), primary_events: [EV.CONTRACT_SIGNED, EV.READY_FOR_DISPOSITION] };
  }
  if (status === "partially_signed") {
    return { outcome: O.CONTRACT_PARTIALLY_SIGNED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "partially_signed", "contract_not_signed_followup", "priority", "await_remaining_signers", "contract_partially_signed"), primary_events: [EV.CONTRACT_PARTIALLY_SIGNED, ...remainingSignerEvent(struct)] };
  }
  if (status === "opened") {
    return { outcome: O.CONTRACT_OPENED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "contract_opened", "contract_not_signed_followup", "priority", "nudge_signature", "contract_opened"), primary_events: [EV.CONTRACT_OPENED] };
  }
  if (status === "viewed") {
    return { outcome: O.CONTRACT_VIEWED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "contract_viewed", "contract_not_signed_followup", "priority", "nudge_signature", "contract_viewed"), primary_events: [EV.CONTRACT_VIEWED] };
  }
  if (status === "sent" || email.resend_requested) {
    return { outcome: O.CONTRACT_SENT, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "contract_sent", "contract_sent", "priority", email.resend_requested ? "resend_contract" : "await_signature", "contract_sent"), primary_events: [EV.CONTRACT_SENT] };
  }

  // 2. Pre-send blockers (title / probate / heirship are hard).
  if (title.title_issue) {
    return { outcome: O.TITLE_ISSUE_DETECTED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "title_issue", "title_issue_soft", "needs_review", "resolve_title_issue", "title_issue"), primary_events: [EV.TITLE_ISSUE_DETECTED] };
  }
  if (probate) {
    return { outcome: O.PROBATE_DETECTED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "probate", "probate_doc_needed", "needs_review", "resolve_probate", "probate"), primary_events: [EV.PROBATE_DETECTED] };
  }
  if (heirship) {
    return { outcome: O.HEIRSHIP_DETECTED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "heirship", "heirship_doc_needed", "needs_review", "resolve_heirship", "heirship"), primary_events: [EV.HEIRSHIP_DETECTED] };
  }

  // 3. Authority blockers by entity structure.
  if (!authority_verified) {
    if (struct === OWNERSHIP_STRUCTURE.LLC) {
      return { outcome: O.WAITING_ON_LLC_AUTHORITY, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "waiting_on_llc_authority", "llc_authority_request", "needs_review", "request_llc_authority", "waiting_on_llc_authority"), primary_events: [EV.WAITING_ON_LLC_AUTHORITY] };
    }
    if (struct === OWNERSHIP_STRUCTURE.TRUST) {
      return { outcome: O.WAITING_ON_TRUSTEE, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "waiting_on_trustee", "trustee_authority_request", "needs_review", "request_trustee_authority", "waiting_on_trustee"), primary_events: [EV.WAITING_ON_TRUSTEE] };
    }
    if (struct === OWNERSHIP_STRUCTURE.ESTATE) {
      return { outcome: O.WAITING_ON_EXECUTOR, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "waiting_on_executor", "executor_authority_request", "needs_review", "request_executor_authority", "waiting_on_executor"), primary_events: [EV.WAITING_ON_EXECUTOR] };
    }
    if (struct === OWNERSHIP_STRUCTURE.CORPORATION || struct === OWNERSHIP_STRUCTURE.POWER_OF_ATTORNEY) {
      return { outcome: O.AUTHORITY_VERIFICATION_REQUIRED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "authority_verification_required", "authority_doc_request", "needs_review", "verify_authority", "authority_verification_required"), primary_events: [] };
    }
    if (struct === OWNERSHIP_STRUCTURE.MARRIED_COUPLE) {
      return { outcome: O.WAITING_ON_SPOUSE, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "waiting_on_spouse", "need_spouse_signoff", "follow_up", "collect_spouse_signature", "waiting_on_spouse"), primary_events: [EV.WAITING_ON_SPOUSE_SIGNER] };
    }
    if (struct === OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS) {
      return { outcome: O.WAITING_ON_CO_SIGNER, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "waiting_on_co_signer", "co_signer_request", "follow_up", "collect_co_signer", "waiting_on_co_signer"), primary_events: [EV.WAITING_ON_CO_SIGNER] };
    }
  }

  // 4. Email required.
  if (!email.email_verified) {
    return { outcome: O.EMAIL_REQUIRED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "email_required", "email_for_docs", "priority", email.email_invalid ? "request_valid_email" : "request_email", "email_required"), primary_events: [] };
  }

  // 5. Remaining signer gap (verified-individual edge / generic).
  if (signer_gap > 0) {
    return { outcome: O.SIGNER_VERIFICATION_REQUIRED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "signer_verification_required", "co_signer_request", "needs_review", "verify_signers", "signer_verification_required"), primary_events: [] };
  }

  // 6. Ownership not verified.
  if (!ownership_verified) {
    return { outcome: O.OWNERSHIP_VERIFICATION_REQUIRED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "ownership_verification_required", "ownership_doc_request", "needs_review", "verify_ownership", "ownership_verification_required"), primary_events: [] };
  }

  // 7. All clear → request / ready (needs an agreed price to draft).
  if (contract_ready) {
    if (contract_requested_signal) {
      return { outcome: O.CONTRACT_REQUESTED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "contract_requested", "asks_contract", "priority", "generate_and_send_contract", "contract_requested"), primary_events: [EV.CONTRACT_REQUESTED] };
    }
    return { outcome: O.CONTRACT_READY, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "contract_ready", "asks_contract", "priority", "generate_contract", "contract_ready"), primary_events: [EV.CONTRACT_READY] };
  }

  // 8. Fallback — verified but no agreed price / ambiguous → human review.
  return { outcome: O.HUMAN_REVIEW_REQUIRED, route: route("S6", S.CLOSE_HANDOFF, CONTRACT_BRAIN, "needs_review", null, "needs_review", "human_review", "human_review"), primary_events: [] };
}

function remainingSignerEvent(structure) {
  if (structure === OWNERSHIP_STRUCTURE.MARRIED_COUPLE) return [EV.WAITING_ON_SPOUSE_SIGNER];
  if (structure === OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS) return [EV.WAITING_ON_CO_SIGNER];
  if (structure === OWNERSHIP_STRUCTURE.HEIRS) return [EV.WAITING_ON_FAMILY_SIGNER];
  return [];
}

export default classifyStage6Contract;
