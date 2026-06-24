// ─── ensure-inbound-coverage.js ──────────────────────────────────────────
// The SAFE NET (audit §8/§9/§16). Takes a raw automation decision and
// guarantees every inbound message ends with:
//   1. a canonical intent
//   2. a contact-identity class
//   3. a safety status
//   4. a reply-or-suppress-or-no-reply disposition
//   5. a next action AND a scheduled next action (never a bare dead end)
//   6. an owned exception workflow (owner + SLA) whenever a human is involved
//   7. a stage-aware safe fallback whenever the message is ambiguous
//   8. a coverage_state proving the above
//
// IMPORTANT: this layer is ADDITIVE. It never flips should_queue_reply,
// should_suppress_contact, or reply_mode, so it introduces NO new automated
// sends — it only attaches owned-workflow + SLA + prepared-fallback metadata and
// a guaranteed scheduled next action. Actual dispatch remains behind the
// existing auto-reply gates.

import { normalizeCanonicalIntent, isSuppressionIntent } from "./canonical-intent-aliases.js";
import { resolveExceptionWorkflow, exceptionSlaDeadline } from "./exception-workflows.js";
import { buildSafeFallback, uncertaintyTypeForReason } from "./safe-fallback.js";
import { assessCoverage, COVERAGE_STATES } from "./coverage-contract.js";

function clean(value) {
  return String(value ?? "").trim();
}

function deriveSafetyStatus(decision = {}, canonical_intent = "unclear") {
  if (decision.should_suppress_contact) return "suppressed";
  if (isSuppressionIntent(canonical_intent)) return "suppressed";
  if (decision.should_mark_human_review) return "review";
  if (decision.should_queue_reply) return "allowed";
  return "review";
}

function deriveReplyDisposition(decision = {}) {
  if (decision.should_suppress_contact) return "suppress";
  if (decision.should_queue_reply) return "reply";
  return "no_reply";
}

// When the raw decision's next_action is a bare review/none, pick a concrete
// scheduled next action from the owned workflow's fallback so nothing stalls.
function deriveScheduledNextAction(decision = {}, workflow = null) {
  const existing = clean(decision.next_action);
  if (existing && !["mark_human_review", "none", ""].includes(existing)) {
    // Already a concrete action (e.g. schedule_later_followup, queue_auto_reply,
    // suppress_contact, do_not_reply, archive_wrong_number) — keep it, but make
    // the SLA-bound fallback explicit too.
    if (existing === "do_not_reply") {
      return "nurture_or_close_per_followup_policy";
    }
    return existing;
  }
  // Bare review/none → the workflow's automatic fallback action, SLA-bound.
  return workflow?.fallback_action || "send_safe_clarifier";
}

/**
 * @param {object} decision  raw result from applyInboundAutomationDecision
 * @param {object} ctx       { stage, contact_identity, classification, now }
 * @returns enriched decision (new object) — guaranteed covered or annotated.
 */
export function ensureInboundCoverage(decision = {}, ctx = {}) {
  const now = ctx.now instanceof Date ? ctx.now : (ctx.now ? new Date(ctx.now) : new Date());
  const classification = ctx.classification || {};
  const canonical_intent = normalizeCanonicalIntent(
    decision.canonical_intent ||
      classification.primary_intent ||
      classification.detected_intent ||
      classification.source
  );
  const contact_identity = clean(ctx.contact_identity) || "unknown";
  const reason =
    clean(decision.human_review_reason) ||
    clean(decision.suppression_reason) ||
    clean(decision.audit_reason) ||
    canonical_intent;

  const safety_status = deriveSafetyStatus(decision, canonical_intent);
  const reply_disposition = deriveReplyDisposition(decision);

  // Attach an owned exception workflow whenever the message is suppressed or
  // routed to a human — so it is tracked with owner + SLA + fallback + terminal.
  let exception_workflow = null;
  let exception_sla_deadline = null;
  if (decision.should_mark_human_review || decision.should_suppress_contact || safety_status !== "allowed") {
    exception_workflow = resolveExceptionWorkflow(reason);
    exception_sla_deadline = exceptionSlaDeadline(exception_workflow, now);
  }

  // Prepare a stage-aware safe fallback for ambiguous (non-suppressed,
  // non-confident) messages so the dead-end review path is eliminated.
  // EXCEPTION: when the owned workflow blocks outreach (legal / safety holds), a
  // clarifier is inappropriate — those route to human_exception_with_owned_workflow.
  let safe_fallback = null;
  const ambiguous =
    !decision.should_suppress_contact &&
    !decision.should_queue_reply &&
    !isSuppressionIntent(canonical_intent) &&
    !exception_workflow?.blocks_outreach;
  if (ambiguous) {
    safe_fallback = buildSafeFallback({
      stage: ctx.stage,
      uncertainty_type: uncertaintyTypeForReason(reason, canonical_intent),
    });
  }

  const scheduled_next_action = deriveScheduledNextAction(decision, exception_workflow);

  const enriched = {
    ...decision,
    canonical_intent,
    contact_identity,
    safety_status,
    reply_disposition,
    exception_workflow,
    exception_sla_deadline,
    safe_fallback,
    scheduled_next_action,
    audit_reason: clean(decision.audit_reason) || reason || "covered",
  };

  enriched.coverage_state = assessCoverage(enriched);

  // Defense-in-depth: if somehow still missing, force the ambiguous_context
  // owned workflow + safe fallback so coverage can never be MISSING in prod.
  if (enriched.coverage_state === COVERAGE_STATES.MISSING) {
    enriched.exception_workflow = resolveExceptionWorkflow("ambiguous_intent");
    enriched.exception_sla_deadline = exceptionSlaDeadline(enriched.exception_workflow, now);
    enriched.safe_fallback =
      enriched.safe_fallback ||
      buildSafeFallback({ stage: ctx.stage, uncertainty_type: "intent" });
    enriched.scheduled_next_action =
      enriched.scheduled_next_action || enriched.exception_workflow.fallback_action;
    enriched.should_mark_human_review = true;
    enriched.coverage_forced = true;
    enriched.coverage_state = assessCoverage(enriched);
  }

  return enriched;
}

export default { ensureInboundCoverage };
