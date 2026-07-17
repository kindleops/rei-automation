// ─── acquisition-brain public surface (PR A) ───────────────────────────────
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
  FACT_CONTRACT_VERSION,
  CLAIM_STATUS,
  FACT_TYPES,
  createProvenancedFact,
  factPrecedenceScore,
  mergeFactIntoState,
  buildClassifierResultContract,
  resolveActiveFacts,
} from "./fact-provenance-contract.js";

