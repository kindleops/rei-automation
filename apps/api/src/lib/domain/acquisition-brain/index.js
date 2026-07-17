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
