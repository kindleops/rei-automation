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
  BURST_DEBOUNCE_MIN_MS,
  BURST_DEBOUNCE_MAX_MS,
  TIMING_POLICIES,
  seededUnit,
  seededInRange,
  evaluateContactWindowShadow,
  selectTimingPolicy,
  planShadowBurst,
} from "./shadow-burst-timing.js";
