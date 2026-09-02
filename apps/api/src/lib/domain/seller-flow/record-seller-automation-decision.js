// ─── record-seller-automation-decision.js ───────────────────────────────────
// The writer for the canonical, append-only decision ledger (supersprint §3/§4).
//
// ONE SELLER EVENT -> ONE CANONICAL DECISION -> ONE EXECUTION PLAN.
//
// Every processed inbound seller event is recorded here exactly once, keyed on
// the source event id. The row is immutable (the DB trigger rejects UPDATE and
// DELETE); a re-process of the same event is an idempotent no-op, and later
// information about the seller is a NEW inbound event, hence a NEW row.
//
// This is the lineage backbone the incident-detection, reconciliation, replay,
// shadow, and scorecard lanes read from:
//   event_id -> decision_id -> ade_snapshot_id -> offer_id/version
//   -> queue_row_id -> provider_message_id -> closing_case_id.
//
// It is NOT the intelligence audit (inbound_intelligence_audit is UPSERTed and
// therefore mutable). The two are siblings: the audit is the latest snapshot,
// this ledger is the immutable decision history.

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import { info, warn } from "@/lib/logging/logger.js";
import { POLICY_MANIFEST, POLICY_FINGERPRINT } from "@/lib/domain/seller-flow/policy-manifest.js";

export const DECISION_LEDGER_VERSION = "seller_automation_decision_ledger_v1";

// The canonical terminal/continuing actions. Every decision resolves to exactly
// one of these — there is no "unhandled" action.
export const DECISION_ACTIONS = Object.freeze({
  SEND: "send",
  SCHEDULE: "schedule",
  RETRY: "retry",
  SUPPRESS: "suppress",
  TERMINATE: "terminate",
  CLARIFY: "clarify",
  NEGOTIATE: "negotiate",
  ACCEPT: "accept",
  ESCALATE: "escalate",
  HOLD: "hold",
});

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isSchemaMissingError(error = null) {
  const message = clean(error?.message).toLowerCase();
  return (
    message.includes("does not exist") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("not found"))
  );
}

export function buildDecisionId(event_id) {
  const id = clean(event_id);
  return id ? `decision:${id}` : null;
}

/**
 * Derive the canonical action from a decision/snapshot. Deterministic and total:
 * every input resolves to exactly one DECISION_ACTIONS value, never null.
 */
export function deriveDecisionAction(d = {}) {
  const suppress = d.should_suppress_contact === true || clean(d.safety_status).toLowerCase() === "suppressed";
  const queued = d.execution?.queued === true || d.execution_result?.queued === true || d.queued === true || clean(d.immediate_next_action) === "queue_auto_reply";
  const accepted = d.terms_accepted === true || clean(d.next_action) === "collect_contract_facts" || Boolean(d.closing_case_id);
  const escalate = d.should_mark_human_review === true || Boolean(d.human_review_reason) || clean(d.safety_status).toLowerCase() === "review";
  const scheduled = Boolean(d.follow_up_at) || d.followup_created === true || clean(d.next_action) === "schedule_follow_up";
  const negotiate = Boolean(d.negotiation_strategy) || clean(d.next_action) === "generate_offer" || clean(d.next_action) === "generate_counter";
  const clarify = clean(d.next_action) === "ask_clarification" || Boolean(d.safe_fallback?.suggested_text);

  if (accepted) return DECISION_ACTIONS.ACCEPT;
  if (suppress) return DECISION_ACTIONS.SUPPRESS;
  if (queued && negotiate) return DECISION_ACTIONS.NEGOTIATE;
  if (queued) return DECISION_ACTIONS.SEND;
  if (escalate) return DECISION_ACTIONS.ESCALATE;
  if (scheduled) return DECISION_ACTIONS.SCHEDULE;
  if (clarify) return DECISION_ACTIONS.CLARIFY;
  return DECISION_ACTIONS.HOLD;
}

/**
 * Map a decision-input object to the immutable ledger row. Pure; no I/O. The
 * input is a superset carrying whatever lineage the caller has — missing ids are
 * recorded as null rather than fabricated.
 */
export function buildDecisionLedgerRow(input = {}) {
  const event_id = clean(input.event_id);
  const decision_id = buildDecisionId(event_id);
  const conversation_id = clean(input.conversation_id) || null;
  // The conversation id column carries a CHECK for E.164; anything malformed is
  // stored as null (still a valid ledger row) rather than rejected.
  const conversation_ok = conversation_id && /^\+[1-9]\d{6,14}$/.test(conversation_id);

  return {
    decision_id,
    event_id,
    provider_message_sid: clean(input.provider_message_sid) || null,
    conversation_id: conversation_ok ? conversation_id : null,
    opportunity_id: clean(input.opportunity_id) || null,
    property_id: clean(input.property_id) || null,
    seller_id: clean(input.seller_id) || null,
    observed_at: input.observed_at || new Date().toISOString(),
    decision_version: clean(input.decision_version) || DECISION_LEDGER_VERSION,
    input_signal: clean(input.input_signal) || null,
    normalized_intent: clean(input.normalized_intent) || null,
    confidence: num(input.confidence),
    prior_stage: clean(input.prior_stage) || null,
    resulting_stage: clean(input.resulting_stage) || null,
    action: clean(input.action) || deriveDecisionAction(input),
    action_reason: clean(input.action_reason) || null,
    monetary_authority: input.monetary_authority && typeof input.monetary_authority === "object" ? input.monetary_authority : {},
    offer_id: clean(input.offer_id) || null,
    offer_version: Number.isFinite(Number(input.offer_version)) ? Number(input.offer_version) : null,
    terms_hash: clean(input.terms_hash) || null,
    ade_snapshot_id: clean(input.ade_snapshot_id) || null,
    policy_versions: input.policy_versions && typeof input.policy_versions === "object" ? input.policy_versions : {},
    required_next_event: clean(input.required_next_event) || null,
    execution_result: input.execution_result && typeof input.execution_result === "object" ? input.execution_result : {},
    queue_row_id: clean(input.queue_row_id) || null,
    provider_message_id: clean(input.provider_message_id) || null,
    closing_case_id: clean(input.closing_case_id) || null,
    lineage: input.lineage && typeof input.lineage === "object" ? input.lineage : {},
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

/**
 * Derive a decision-input from the inbound intelligence snapshot (+ its embedded
 * canonical_decision), so the ledger can be written at the same per-event hook as
 * the audit row with whatever lineage the snapshot carries.
 */
export function deriveDecisionInputFromSnapshot(snapshot = {}, overrides = {}) {
  const cd = snapshot.canonical_decision && typeof snapshot.canonical_decision === "object" ? snapshot.canonical_decision : {};
  const merged = {
    event_id: snapshot.source_event_id,
    provider_message_sid: snapshot.provider_message_sid,
    conversation_id: snapshot.source_thread_key || cd.thread_key,
    opportunity_id: cd.opportunity_id || snapshot.opportunity_id,
    property_id: snapshot.property_id || cd.property_id,
    seller_id: cd.master_owner_id || snapshot.master_owner_id,
    observed_at: snapshot.observed_at || cd.observed_at || snapshot.created_at,
    decision_version: snapshot.decision_version || cd.decision_version,
    input_signal: snapshot.canonical_intent || cd.normalized_intent,
    normalized_intent: snapshot.canonical_intent || cd.normalized_intent,
    confidence: snapshot.confidence ?? cd.confidence,
    prior_stage: cd.stage_before,
    resulting_stage: cd.stage_after || snapshot.universal_stage,
    action_reason: snapshot.execution_blocked_reason || cd.action_reason || cd.reasoning_code,
    offer_id: cd.offer_id,
    offer_version: cd.offer_version,
    terms_hash: cd.offer_terms_hash,
    ade_snapshot_id: cd.ade_snapshot_id,
    // The durable "what happens next" (§5/§10): the coverage net's scheduled
    // next action wins (it is the owned-workflow fallback when a human holds
    // the turn), then the resolver's next action.
    required_next_event:
      snapshot.coverage?.scheduled_next_action || cd.next_action || cd.required_next_event,
    queue_row_id: cd.queue_row_id,
    closing_case_id: cd.closing_case_id,
    // action-derivation signals lifted from the canonical decision
    should_suppress_contact: cd.should_suppress_contact,
    should_mark_human_review: cd.should_mark_human_review,
    human_review_reason: cd.review_reason,
    safety_status: snapshot.safety_status,
    immediate_next_action: cd.immediate_next_action,
    next_action: cd.next_action,
    follow_up_at: cd.follow_up_at,
    queued: Boolean(cd.queue_row_id),
    negotiation_strategy: cd.transition?.negotiation_strategy,
    execution_result: {
      queued: Boolean(cd.queue_row_id),
      rendered: Boolean(cd.rendered_message),
      block_reason: cd.block_reason || null,
    },
    // The policies in force when this decision was made (§15). Answers "why
    // did the system do this on date X" independent of later deployments.
    policy_versions: POLICY_MANIFEST,
    lineage: {
      policy_fingerprint: POLICY_FINGERPRINT,
      // Coverage verdict of the final post-override decision (§5): which owned
      // workflow holds the turn, its SLA, and whether coverage had to be forced.
      coverage_state: snapshot.coverage?.coverage_state || null,
      exception_workflow: snapshot.coverage?.exception_workflow?.key || null,
      exception_sla_deadline: snapshot.coverage?.exception_sla_deadline || null,
      coverage_forced: snapshot.coverage?.coverage_forced === true,
      // §6 identity provenance: how the property/owner were resolved for this turn
      context_resolution: snapshot.context_resolution || null,
      review_hold_tier: cd.transition?.review_hold_tier || null,
      source_event_id: snapshot.source_event_id,
      provider_message_sid: snapshot.provider_message_sid,
      thread_key: snapshot.source_thread_key,
      offer_id: cd.offer_id || null,
      queue_row_id: cd.queue_row_id || null,
      closing_case_id: cd.closing_case_id || null,
      ade_snapshot_id: cd.ade_snapshot_id || null,
    },
    ...overrides,
  };
  return merged;
}

/**
 * Append one immutable decision to the ledger. Idempotent by event_id
 * (onConflict do-nothing), failure-isolated, and tolerant of the table being
 * absent (returns a structured schema_missing rather than throwing).
 *
 * @returns {Promise<object>} { ok, decision_id, inserted } or { ok:false, reason }
 */
export async function recordSellerAutomationDecision({
  supabase: injected = null,
  input = null,
  dry_run = false,
} = {}) {
  if (!input) return { ok: false, reason: "missing_input" };
  const row = buildDecisionLedgerRow(input);
  if (!row.decision_id || !row.event_id) {
    return { ok: false, reason: "missing_event_id" };
  }
  if (dry_run) return { ok: true, dry_run: true, decision_id: row.decision_id, inserted: false };

  if (!injected && !hasSupabaseConfig()) {
    return { ok: false, reason: "missing_supabase" };
  }
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, reason: "missing_supabase" };

  try {
    // Append-only + idempotent: a duplicate event_id is ignored, never updated.
    const { data, error } = await supabase
      .from("seller_automation_decisions")
      .upsert(row, { onConflict: "event_id", ignoreDuplicates: true })
      .select("id,decision_id")
      .maybeSingle();
    if (error) throw error;
    const inserted = Boolean(data?.id);
    info("[SELLER_DECISION_LEDGER_RECORDED]", {
      decision_id: row.decision_id,
      event_id: row.event_id,
      action: row.action,
      inserted,
    });
    return { ok: true, decision_id: row.decision_id, inserted };
  } catch (error) {
    const schema_missing = isSchemaMissingError(error);
    warn("[SELLER_DECISION_LEDGER_FAILED]", {
      decision_id: row.decision_id,
      event_id: row.event_id,
      error: error?.message || "record_failed",
      schema_missing,
    });
    return {
      ok: false,
      reason: schema_missing ? "schema_missing" : "record_failed",
      schema_missing,
      decision_id: row.decision_id,
    };
  }
}

export default recordSellerAutomationDecision;
