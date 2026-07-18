// ─── acquisition-brain public surface ──────────────────────────────────────
export {
  ACQUISITION_BRAIN_VERSION,
  ACQUISITION_LIFECYCLE_STAGES,
  STAGE_NUMBERS,
  LIFECYCLE_REGISTRY,
  ORDERED_LIFECYCLE_STAGES,
  AUTHORITATIVE_TRANSACTION_EVENTS,
  LIFECYCLE_STAGE_ALIASES,
  normalizeLifecycleStage,
  getLifecycleStage,
  isTransactionGatedStage,
  canAdvanceLifecycleStage,
  recommendStageFromFacts,
  evaluateStage5Readiness,
  evaluateStage6Readiness,
} from "./lifecycle-registry.js";

export {
  NBA_ACTION_TYPES,
  NBA_REASON_CODES,
  STAGE_PRIMARY_USE_CASES,
  resolveNextBestAction,
} from "./next-best-action-registry.js";

export {
  SHADOW_EVENT_TYPE,
  SHADOW_COMPARISON,
  extractBrainFactsFromInbound,
  compareShadowDecisions,
  evaluateAcquisitionBrainShadow,
  emitAcquisitionBrainShadowDecision,
} from "./shadow-inbound-decision.js";

export {
  FACT_CONTRACT_VERSION,
  CLAIM_STATUS,
  FACT_TYPES,
  FACT_TYPE_SET,
  PRECEDENCE_BANDS,
  toJsonSafe,
  createProvenancedFact,
  factPrecedenceScore,
  applyHumanOverride,
  mergeFactIntoState,
  resolveActiveFacts,
  sortFactsDeterministically,
  buildClassifierResultContract,
  applyAuthoritativeEvent,
} from "./fact-provenance-contract.js";

export {
  SHADOW_FACT_STATE_EVENT,
  SHADOW_FACT_MAX_HISTORY,
  loadPriorShadowFacts,
  mapFactsToLifecycleGaps,
  buildShadowFactState,
  evaluateShadowWithFactState,
  emitShadowFactStateEvents,
} from "./shadow-fact-state.js";

export {
  SHADOW_BURST_EVENT,
  BURST_PLANNER_VERSION,
  BURST_DEBOUNCE_MIN_MS,
  BURST_DEBOUNCE_MAX_MS,
  MAX_BURST_DURATION_MS,
  BURST_LOOKBACK_MS,
  BURST_LOOKBACK_MAX_ROWS,
  TIMING_POLICIES,
  seededUnit,
  seededInRange,
  computeBurstId,
  computeBurstContentHash,
  orderInboundMessages,
  segmentInboundBursts,
  resolveShadowTimezone,
  evaluateContactWindowAt,
  evaluateContactWindowShadow,
  selectTimingPolicy,
  computeReplyTiming,
  planShadowBurst,
  planAllShadowBursts,
  loadRecentInboundForBurst,
  loadPriorBurstPlans,
  evaluateShadowBurstForInbound,
  emitShadowBurstPlan,
  evaluateAndEmitShadowBurst,
} from "./shadow-burst-timing.js";

export {
  SHADOW_FOLLOWUP_EVENT,
  SHADOW_FOLLOWUP_CANCELLED_EVENT,
  SHADOW_FOLLOWUP_COMPLETED_EVENT,
  FOLLOWUP_PLANNER_VERSION,
  FOLLOWUP_PLAN_STATES,
  CANCELLATION_REASONS,
  FOLLOWUP_POLICY_REGISTRY,
  FOLLOWUP_STAGE_ALIASES,
  STAGE_NUMBER_TO_CANONICAL,
  resolveCanonicalFollowupStage,
  normalizeDeliveryStatus,
  resolveFollowupPolicy,
  planShadowFollowup,
  cancelShadowFollowup,
  evaluateFollowupCancellations,
  proveStage1FollowupShadow,
  emitShadowFollowupEvent,
  evaluateAndEmitShadowFollowupAfterDelivery,
  evaluateAndEmitShadowFollowupCancellations,
} from "./shadow-followup-planner.js";

export {
  SHADOW_SELLER_INTEL_EVENT,
  SELLER_INTEL_VERSION,
  SELLER_INTEL_EXCLUSIONS,
  buildSellerIntelligenceProfile,
} from "./shadow-seller-intelligence.js";
