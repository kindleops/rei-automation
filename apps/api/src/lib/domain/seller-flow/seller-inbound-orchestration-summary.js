import { decisionToUniversalLeadStatePatch } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";

function clean(value) {
  return String(value ?? "").trim();
}

export function summarizeSellerInboundOrchestration(orchestration = {}, extras = {}) {
  const contract = orchestration.contract || null;
  const intelligence_snapshot = orchestration.intelligence_snapshot || null;
  const decision = orchestration.decision || null;
  const execution = orchestration.execution || null;
  const follow_up = orchestration.follow_up || null;
  const universal_state_patch =
    orchestration.universal_state_patch?.patch ||
    orchestration.universal_state_patch ||
    (decision ? decisionToUniversalLeadStatePatch(decision) : null);

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
    universal_state_patch,
    stage_before: decision?.stage_before || null,
    stage_after: decision?.stage_after || null,
    queued: Boolean(execution?.queued),
    followup_scheduled: Boolean(follow_up?.followup_created),
    duplicate_suppressed: Boolean(orchestration.idempotent?.duplicate_suppressed),
    auto_reply_mode: orchestration.auto_reply_mode || null,
    execution_allowed: orchestration.execution_allowed ?? null,
    live_send_allowed: extras.live_send_allowed ?? null,
    recovery_action: extras.recovery_action || null,
    message_event_id: extras.message_event_id || null,
  };
}

export default summarizeSellerInboundOrchestration;