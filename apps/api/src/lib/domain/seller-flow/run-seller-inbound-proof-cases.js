import { classify } from "@/lib/domain/classification/classify.js";
import { processSellerInboundMessage } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { resolveGuardedAutoReplyMode } from "@/lib/domain/seller-flow/auto-reply-mode.js";
import { summarizeSellerInboundOrchestration } from "@/lib/domain/seller-flow/seller-inbound-orchestration-summary.js";

export const DEFAULT_SELLER_INBOUND_PROOF_CONTEXT = Object.freeze({
  found: true,
  ids: {
    brain_item_id: 201,
    master_owner_id: "mo-proof-21",
    prospect_id: "pros-proof-31",
    property_id: "prop-proof-227",
    phone_item_id: "phone-proof-51",
  },
  summary: {
    conversation_stage: "ownership_check",
    seller_stage: "ownership_check",
    property_address: "123 Main St",
    seller_first_name: "Jane",
    language_preference: "English",
  },
});

export const DEFAULT_SELLER_INBOUND_PROOF_ROUTE = Object.freeze({
  stage: "ownership_check",
  use_case: "ownership_check",
});

export const DEFAULT_SELLER_INBOUND_PROOF_CASES = Object.freeze([
  { proof_case: "ownership_confirmed_yes", message: "Yes" },
  { proof_case: "s1_not_for_sale", message: "Not for sale!!!!" },
]);

function clean(value) {
  return String(value ?? "").trim();
}

export async function runSellerInboundProofCases({
  cases = DEFAULT_SELLER_INBOUND_PROOF_CASES,
  autoReplyMode = "live_limited",
  dryRun = true,
  proofRun = true,
  supabaseClient = null,
} = {}) {
  const mode_resolution = resolveGuardedAutoReplyMode({ requestedMode: autoReplyMode });
  const proof_results = [];

  for (const proofCase of cases) {
    const message = clean(proofCase.message);
    const classification =
      proofCase.classification ||
      (await classify(message, null, { heuristicOnly: true }));

    const orchestration = await processSellerInboundMessage({
      message,
      threadKey: proofCase.thread_key || "+15551234567",
      propertyId: proofCase.property_id || DEFAULT_SELLER_INBOUND_PROOF_CONTEXT.ids.property_id,
      prospectId: proofCase.prospect_id || DEFAULT_SELLER_INBOUND_PROOF_CONTEXT.ids.prospect_id,
      ownerId: proofCase.owner_id || DEFAULT_SELLER_INBOUND_PROOF_CONTEXT.ids.master_owner_id,
      phoneId: proofCase.phone_id || DEFAULT_SELLER_INBOUND_PROOF_CONTEXT.ids.phone_item_id,
      classification,
      context: proofCase.context || DEFAULT_SELLER_INBOUND_PROOF_CONTEXT,
      route: proofCase.route || DEFAULT_SELLER_INBOUND_PROOF_ROUTE,
      inboundFrom: proofCase.inbound_from || "+15551234567",
      inboundTo: proofCase.inbound_to || "+15559876543",
      inboundEventId: proofCase.inbound_event_id || `proof-${proofCase.proof_case || message}`,
      stageBefore:
        proofCase.stage_before ||
        proofCase.context?.summary?.conversation_stage ||
        DEFAULT_SELLER_INBOUND_PROOF_CONTEXT.summary.conversation_stage,
      autoReplyMode: mode_resolution.mode,
      executionAllowed: true,
      dryRun: Boolean(dryRun),
      proofRun: Boolean(proofRun),
      supabaseClient,
    });

    proof_results.push(
      summarizeSellerInboundOrchestration(orchestration, {
        message,
        proof_case: proofCase.proof_case || message,
        live_send_allowed: false,
        recovery_action: "proof_shadow",
        writes_suppressed: orchestration.writes_suppressed,
        notifications_dispatched: orchestration.side_effects?.notifications_dispatched,
        universal_state_dispatched: orchestration.side_effects?.universal_state_dispatched,
      })
    );
  }

  return {
    ok: true,
    dry_run: Boolean(dryRun),
    proof_run: Boolean(proofRun),
    proof_only: true,
    auto_reply_mode: mode_resolution.mode,
    proof_count: proof_results.length,
    proof_results,
  };
}

export default runSellerInboundProofCases;