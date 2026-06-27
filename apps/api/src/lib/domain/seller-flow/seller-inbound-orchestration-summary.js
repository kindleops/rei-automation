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

export function summarizeSellerInboundOrchestration(orchestration = {}, extras = {}) {
  const contract = orchestration.contract || null;
  const intelligence_snapshot = orchestration.intelligence_snapshot || null;
  const decision = orchestration.decision || null;
  const execution = orchestration.execution || null;
  const follow_up = orchestration.follow_up || null;
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
    queued: Boolean(orchestration.queued ?? execution?.queued),
    followup_scheduled: Boolean(
      orchestration.followup_scheduled ?? follow_up?.followup_scheduled
    ),
    queue_row_created: Boolean(orchestration.queue_row_created ?? execution?.queue_row_created),
    followup_created: Boolean(orchestration.followup_created ?? follow_up?.followup_created),
    effective_action: orchestration.effective_action ?? execution?.effective_action ?? null,
    duplicate_suppressed: Boolean(orchestration.idempotent?.duplicate_suppressed),
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