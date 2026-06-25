function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function routeProfileCandidates(route_hint = null, primary_intent = null) {
  if (primary_intent) return [primary_intent];
  if (route_hint) return [route_hint];
  return [];
}

export function automationDecisionToLegacyPlan({
  decision,
  classification,
  selectedTemplate = null,
  renderedMessageText = null,
  queueResult = null,
} = {}) {
  const primary_intent =
    clean(decision?.canonical_intent) ||
    clean(classification?.primary_intent) ||
    "unclear";
  const suppression_reason = decision?.suppression_reason || null;
  const should_queue_reply = Boolean(decision?.should_queue_reply);
  const safety_tier = decision?.should_suppress_contact
    ? "suppress"
    : should_queue_reply
      ? "auto_send"
      : decision?.safety_status === "allowed"
        ? "auto_send"
        : "review";

  return {
    ok: true,
    inbound_intent: primary_intent,
    detected_intent: primary_intent,
    next_stage: decision?.route_hint || null,
    selected_use_case:
      clean(selectedTemplate?.use_case) ||
      routeProfileCandidates(decision?.route_hint, primary_intent)[0] ||
      null,
    selected_stage_code: clean(selectedTemplate?.stage_code) || null,
    selected_language: clean(selectedTemplate?.language) || clean(classification?.language) || "English",
    selected_template_id: clean(selectedTemplate?.template_id || selectedTemplate?.id) || null,
    fallback_reply: renderedMessageText || clean(selectedTemplate?.template_body) || null,
    should_queue_reply,
    suppression_reason,
    reply_mode: decision?.reply_mode || "none",
    reason: decision?.audit_reason || "automation_decision",
    route_hint: decision?.route_hint || null,
    stage_hint: decision?.stage_hint || null,
    allowed_template_stages: asArray(decision?.allowed_template_stages),
    queue_item_id: queueResult?.queue_item_id || null,
    queue_row_id: queueResult?.queue_row_id || null,
    routing_allowed: should_queue_reply || decision?.safety_status === "allowed",
    safety: {
      opt_out: suppression_reason === "opt_out",
      wrong_number: suppression_reason === "wrong_number",
      hostile_or_legal: primary_intent === "hostile_or_legal",
      not_interested: primary_intent === "not_interested",
      missing_context: decision?.audit_reason === "missing_context",
    },
    safety_tier,
    auto_send_eligible: should_queue_reply,
    automation_decision: decision,
  };
}

export default automationDecisionToLegacyPlan;