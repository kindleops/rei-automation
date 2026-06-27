import { decisionToUniversalLeadStatePatch } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";

function clean(value) {
  return String(value ?? "").trim();
}

export function summarizeSellerInboundSideEffects(orchestration = {}, extras = {}) {
  const decision = orchestration.decision || null;
  const universal_state_patch =
    orchestration.universal_state_patch?.patch ||
    orchestration.universal_state_patch ||
    (decision ? decisionToUniversalLeadStatePatch(decision) : null);
  const writes_suppressed = Boolean(
    extras.writes_suppressed ?? orchestration.writes_suppressed ?? false
  );

  return {
    workflow_events: decision?.workflow_events || [],
    notification_events: decision?.notification_events || [],
    intelligence_message_event_patch: orchestration.intelligence_message_event_patch || null,
    universal_state_patch,
    universal_state_dry_run: orchestration.universal_state_patch?.dry_run ?? writes_suppressed,
    writes_suppressed,
    notifications_planned: (decision?.notification_events || []).length > 0,
    workflow_events_planned: (decision?.workflow_events || []).length > 0,
    notifications_dispatched: Boolean(extras.notifications_dispatched),
    universal_state_dispatched: Boolean(extras.universal_state_dispatched),
    workflow_events_count: (decision?.workflow_events || []).length,
    notification_events_count: (decision?.notification_events || []).length,
  };
}

function resolveCanonicalShouldQueueReply({
  intelligence_snapshot = null,
  decision = null,
  execution = null,
} = {}) {
  if (execution?.automation_decision?.should_queue_reply != null) {
    return Boolean(execution.automation_decision.should_queue_reply);
  }
  if (intelligence_snapshot?.canonical_decision?.should_queue_reply != null) {
    return Boolean(intelligence_snapshot.canonical_decision.should_queue_reply);
  }
  if (decision?.immediate_next_action === "queue_auto_reply") return true;
  return false;
}

export function summarizeSellerInboundOrchestration(orchestration = {}, extras = {}) {
  const contract = orchestration.contract || null;
  const intelligence_snapshot = orchestration.intelligence_snapshot || null;
  const decision = orchestration.decision || null;
  const execution = orchestration.execution || null;
  const follow_up = orchestration.follow_up || null;
  const canonical_should_queue_reply = resolveCanonicalShouldQueueReply({
    intelligence_snapshot,
    decision,
    execution,
  });
  const side_effects =
    orchestration.side_effects ||
    summarizeSellerInboundSideEffects(orchestration, {
      writes_suppressed: extras.writes_suppressed,
      notifications_dispatched: extras.notifications_dispatched,
      universal_state_dispatched: extras.universal_state_dispatched,
    });

  return {
    ok: orchestration.ok !== false,
    message: clean(extras.message) || null,
    proof_case: clean(extras.proof_case) || null,
    normalized_intent: contract?.normalized_intent || null,
    ownership_signal: contract?.ownership_signal || null,
    interest_signal: contract?.interest_signal || null,
    contract,
    intelligence_snapshot,
    decision,
    execution,
    follow_up,
    universal_state_patch: side_effects.universal_state_patch,
    side_effects,
    stage_before: decision?.stage_before || null,
    stage_after: decision?.stage_after || null,
    queued: Boolean(execution?.queued),
    followup_scheduled: Boolean(
      follow_up?.followup_created || follow_up?.scheduled_for || decision?.follow_up_at
    ),
    duplicate_suppressed: Boolean(orchestration.idempotent?.duplicate_suppressed),
    canonical_should_queue_reply,
    planned_queue_action:
      decision?.immediate_next_action ||
      intelligence_snapshot?.canonical_decision?.scheduled_next_action ||
      null,
    queues_s2_reply_preview: Boolean(
      canonical_should_queue_reply &&
        (execution?.selected_template?.use_case === "consider_selling" ||
          execution?.selected_template?.stage_code === "consider_selling" ||
          execution?.selected_template?.stage_code === "S2" ||
          decision?.template_key === "consider_selling" ||
          intelligence_snapshot?.recommended_use_case === "consider_selling")
    ),
    execution_should_queue_reply: canonical_should_queue_reply,
    execution_shadow_only: Boolean(
      orchestration.writes_suppressed ||
        execution?.dry_run ||
        intelligence_snapshot?.decision_layers?.execution?.shadow_only
    ),
    execution_template_use_case:
      execution?.selected_template?.use_case || decision?.template_key || null,
    execution_preview_message: execution?.rendered_message_text || null,
    auto_reply_mode: orchestration.auto_reply_mode || null,
    execution_allowed: orchestration.execution_allowed ?? null,
    live_send_allowed: extras.live_send_allowed ?? null,
    recovery_action: extras.recovery_action || null,
    message_event_id: extras.message_event_id || null,
    proof_run: orchestration.proof_run ?? null,
    writes_suppressed: side_effects.writes_suppressed,
  };
}

export default summarizeSellerInboundOrchestration;