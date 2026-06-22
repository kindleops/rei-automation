// Legacy seller-flow compatibility adapter — translates events; V2 owns decisions.

import { buildCanonicalWorkflowEvent, mapClassificationToSellerIntent } from '@/lib/domain/acquisition/canonical-workflow-event.js';
import { claimDualAuthorityProcessing } from '@/lib/domain/acquisition/dual-authority-guard.js';
import { normalizeCanonicalUseCase } from '@/lib/domain/templates/template-metadata-normalization.js';

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Translate a legacy seller-flow payload into the canonical workflow event contract.
 * Does NOT issue send decisions — callers must route through Workflow V2.
 */
export function translateLegacySellerFlowEvent(input = {}) {
  const classification =
    input.classify_result ?? input.classification ?? input.classifyResult ?? {};
  const canonical = buildCanonicalWorkflowEvent({
    ...input,
    classification,
    seller_intent: input.seller_intent ?? mapClassificationToSellerIntent(classification),
    template_use_case: normalizeCanonicalUseCase(
      input.use_case ?? input.template_use_case ?? input.flow?.use_case,
    ),
    current_stage: input.stage_code ?? input.stage ?? input.brain_state?.conversation_stage,
  });

  return {
    ok: true,
    canonical_event: canonical,
    legacy_adapter_only: true,
    v2_authority: true,
  };
}

/**
 * Wrap legacy flow_map output as a canonical next-action hint without executing it.
 */
export function adaptLegacyFlowResult(flowResult = {}, canonicalEvent = {}) {
  const useCase = normalizeCanonicalUseCase(flowResult.use_case);
  return {
    ok: true,
    adapter: 'legacy_seller_flow',
    action: clean(flowResult.action) || null,
    template_use_case: useCase,
    stage_code: clean(flowResult.stage_code) || null,
    human_review: Boolean(flowResult.human_review),
    reason: clean(flowResult.reason) || 'legacy_flow_adapted',
    canonical_event_id: canonicalEvent.event_id ?? canonicalEvent.source_event_id ?? null,
    authoritative_engine: 'workflow_v2',
    execute_send: false,
  };
}

/**
 * Entry for inbound handlers: claim idempotency, translate, return V2 routing envelope.
 */
export function prepareInboundForWorkflowV2(input = {}) {
  const sourceEventId = clean(input.source_event_id ?? input.inbound_event_id);
  const threadKey = clean(input.thread_key ?? input.phone_e164);
  const claim = claimDualAuthorityProcessing({
    source_event_id: sourceEventId,
    thread_key: threadKey,
    engine: 'workflow_v2',
  });

  if (!claim.ok) {
    return {
      ok: false,
      reason: claim.reason,
      blocked_by: 'dual_authority_guard',
    };
  }

  const translated = translateLegacySellerFlowEvent(input);
  return {
    ok: true,
    claim,
    ...translated,
    routing: {
      enroll_subworkflow: true,
      emit_canonical_event: true,
      allow_legacy_template_resolution: false,
      allow_legacy_send: false,
    },
  };
}

export default {
  translateLegacySellerFlowEvent,
  adaptLegacyFlowResult,
  prepareInboundForWorkflowV2,
};