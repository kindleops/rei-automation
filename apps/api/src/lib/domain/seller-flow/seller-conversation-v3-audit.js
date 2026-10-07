// ─── seller-conversation-v3-audit.js ─────────────────────────────────────────
// Acquisition OS v1 §83 (audit trail per autonomous action) and §39 (uncertain
// classification research log) for SELLER CONVERSATION MACHINE v3.
//
// PURE builders (no I/O). The orchestrator emits them as automation_events
// (the canonical event store) and stamps the compact audit on the executor's
// automation_decision, so message_events.metadata carries "why" for the Inbox
// trail without reading app logs. Only built when the v3 flags are on.
//
// Why automation_events and not seller_automation_decisions: that ledger row is
// immutable and is written BEFORE the v3 plan and the send exist (it is keyed
// on the inbound event from the intelligence snapshot), so it cannot hold the
// stage after, template, send result or follow-up. A PROPOSED read view over
// automation_events joins the two (PROPOSED_20261007051000).

export const V3_AUDIT_EVENT = "SELLER_CONVERSATION_V3_TURN";
export const V3_UNCERTAIN_EVENT = "SELLER_CONVERSATION_V3_UNCERTAIN";
export const V3_AUDIT_VERSION = "seller_conversation_v3_audit_v1";

const clean = (v) => String(v ?? "").trim();
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Operator-facing objective for each stage (§20: stages are goals). */
export const STAGE_OBJECTIVE = Object.freeze({
  S1_ownership: "Confirm ownership or connection",
  S2_interest: "Confirm openness to a proposal",
  S3_asking_price: "Discover the asking price",
  S4_condition: "Collect condition and repairs",
  S4_confirm_basics: "Confirm occupancy and basics",
  S5_plus: "Underwriting and negotiation",
  unknown: "Confirm ownership or connection",
});

const FIELD_LABEL = Object.freeze({
  ownership: "ownership",
  interest: "interest",
  asking_price: "asking price",
  condition: "condition",
  major_repairs: "major repairs",
  update_years: "update years",
  occupancy: "occupancy",
  "condition+occupancy": "condition and occupancy",
});

/** What the machine is waiting to hear next (from the plan's asking_for, else the first missing field). */
export function nextExpectedInfo(plan = null) {
  if (!plan) return null;
  const f = clean(plan.asking_for) || (Array.isArray(plan.missing) ? plan.missing[0] : null);
  if (f) return FIELD_LABEL[f] || f;
  if (plan.action === "terminal") return null;
  return plan.lane === "negotiation_engine" ? "negotiation response" : null;
}

/**
 * The compact audit record (§83) for one autonomous turn. Fields that are not
 * known are null — never inferred. `quoted_number` is copied from the plan's
 * monetary block (the negotiation layer computed it; this module never does).
 */
export function buildV3AuditRecord({
  plan = null,
  message = "",
  classification = null,
  stage_before = null,
  execution = null,
  follow_up = null,
  inbound_event_id = null,
  thread_key = null,
  property_id = null,
  seller_situation = null,
  negotiation_state = null,
  observed_at = new Date().toISOString(),
} = {}) {
  if (!plan) return null;
  const d = execution?.automation_decision || {};
  const tpl = execution?.selected_template || null;
  const monetary = plan.monetary || null;
  const queued = execution?.queued === true;
  const reply_blocked = plan.action === "reply" && !queued;
  return {
    version: V3_AUDIT_VERSION,
    plan_version: plan.version || null,
    revision: plan.revision || null,
    inbound_event_id: clean(inbound_event_id) || null,
    thread_key: clean(thread_key) || null,
    property_id: clean(property_id) || null,
    observed_at,
    seller_said: String(message || "").slice(0, 500),
    classification: {
      intent: clean(classification?.primary_intent) || null,
      v2_intent: plan.v2_intent || null,
      language: clean(classification?.language) || null,
      confidence: num(classification?.confidence),
      rule_ids: Array.isArray(classification?.matched_rule_ids) ? classification.matched_rule_ids.slice(0, 8) : [],
    },
    stage_before: clean(stage_before) || null,
    stage: plan.stage || null,
    stage_after: plan.resume_stage || plan.stage || null,
    objective: STAGE_OBJECTIVE[plan.stage] || null,
    rule: plan.reasoning_code || null,
    action: plan.action || null,
    terminal_action: plan.terminal_action || plan.then || null,
    checklist: plan.checklist_state || null,
    missing: Array.isArray(plan.missing) ? plan.missing : [],
    next_expected: nextExpectedInfo(plan),
    identity: plan.identity || null,
    price_branch: plan.price_branch || null,
    evidence: {
      value_authority: plan.value_authority
        ? { trusted: plan.value_authority.trusted === true, reason: plan.value_authority.reason || null, snapshot_id: plan.value_authority.snapshot_id || null }
        : null,
      price_ratio: num(plan.price_ratio),
      seller_situation: seller_situation
        ? { situation: seller_situation.seller_situation || null, angle: seller_situation.conversation_angle || null, tier: seller_situation.opportunity_tier || null, score_version: seller_situation.score_version || null }
        : null,
    },
    template: tpl
      ? { template_id: clean(tpl.template_id || tpl.id) || null, use_case: clean(tpl.use_case) || null, language: clean(tpl.language) || null }
      : plan.template_use_case
        ? { template_id: null, use_case: plan.template_use_case, language: null }
        : null,
    quoted_number: monetary
      ? {
          kind: monetary.kind || null,
          amount: num(monetary.amount),
          per_door_low: num(monetary.per_door_low),
          per_door_high: num(monetary.per_door_high),
          ceiling: num(monetary.ceiling),
          rule: monetary.rule || null,
          comp_ids: Array.isArray(monetary.comp_ids) ? monetary.comp_ids.slice(0, 12) : [],
        }
      : null,
    negotiation_state: negotiation_state || null,
    send: {
      queued,
      queue_row_id: clean(execution?.queue_row_id || execution?.queue_item_id) || null,
      dedupe_identity: inbound_event_id ? `inbound:${clean(inbound_event_id)}` : null,
      blocked_reason: reply_blocked ? clean(d.human_review_reason || d.audit_reason || execution?.audit_reason) || "not_queued" : null,
      review: d.should_mark_human_review === true,
    },
    follow_up: follow_up
      ? { scheduled: follow_up.followup_created === true || (follow_up.ok === true && follow_up.skipped === false), at: follow_up.scheduled_for || follow_up.follow_up_at || null, reason: follow_up.reason || null }
      : null,
  };
}

/** The slice the Inbox trail renders (kept small: it rides on message_events.metadata). */
export function compactV3AuditForInbox(audit = null) {
  if (!audit) return null;
  return {
    version: audit.version,
    stage: audit.stage,
    objective: audit.objective,
    checklist: audit.checklist,
    next_expected: audit.next_expected,
    rule: audit.rule,
    action: audit.action,
    terminal_action: audit.terminal_action,
    price_branch: audit.price_branch,
    identity: audit.identity ? { claim: audit.identity.claim || null, ownership_confidence: audit.identity.ownership_confidence || null } : null,
    seller_situation: audit.evidence?.seller_situation || null,
    negotiation_state: audit.negotiation_state
      ? { position: audit.negotiation_state.position || audit.negotiation_state.state || null, quote_type: audit.negotiation_state.quote_type || null }
      : null,
    template_use_case: audit.template?.use_case || null,
    quoted: audit.quoted_number ? { kind: audit.quoted_number.kind, amount: audit.quoted_number.amount } : null,
  };
}

/**
 * §39: is this turn uncertain (worth a research-log row)? True when the
 * classifier could not read the message, or the plan only re-asked / archived
 * because it did not understand, or the turn needs review.
 */
export function isUncertainTurn(plan = null, classification = null) {
  if (!plan) return false;
  const intent = clean(classification?.primary_intent).toLowerCase();
  const code = clean(plan.reasoning_code);
  return (
    plan.action === "review" ||
    (intent === "unclear" && !/^v3_(sign_off|acknowledgement)/.test(code)) ||
    /unclear|repeat_guard_exhausted|number_not_a_price/.test(code)
  );
}

/** §39 research-log record: raw reply, language, stage, candidates, reason. Never a guess. */
export function buildV3ResearchRecord({ plan = null, message = "", classification = null, conversation_context = null, inbound_event_id = null, thread_key = null } = {}) {
  if (!plan) return null;
  const candidates = [
    ...(Array.isArray(classification?.matched_intents) ? classification.matched_intents : []),
    ...(Array.isArray(classification?.secondary_intents) ? classification.secondary_intents : []),
  ];
  return {
    version: V3_AUDIT_VERSION,
    inbound_event_id: clean(inbound_event_id) || null,
    thread_key: clean(thread_key) || null,
    raw_reply: String(message || "").slice(0, 1000),
    language: clean(classification?.language) || null,
    stage: plan.stage || null,
    last_question_use_case: clean(conversation_context?.last_outbound_template_use_case || conversation_context?.last_outbound_use_case) || null,
    classifier_intent: clean(classification?.primary_intent) || null,
    v2_intent: plan.v2_intent || null,
    candidate_intents: [...new Set(candidates.map(clean).filter(Boolean))].slice(0, 10),
    confidence: num(classification?.confidence),
    reason: plan.review_reason || plan.reasoning_code || null,
    action_taken: plan.action || null,
    replay_status: "pending_rule",
  };
}
