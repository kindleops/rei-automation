// 8.5.20 part C operations — PACKAGE A (hotfix/research-runtime) exports: historical opportunity
// recovery, the Inbound Action Center, the operations supervisor and the daily operating brief.
// Not in Package A: pipeline.reconcile (stage-change approvals), the dead-deal correction plan, the
// MCP ops-intel capability and the auto-recovery sweeps.
export * from './operations-kinds.js'
export { buildOperationsHandlers, createRecoverySweepHandler, createActionCenterHandler, createOpsSupervisorHandler, sweepCursor } from './operations-handlers.js'
export { createOperationsPgSource, createOperationsSqlSource, createOperationsMemorySource } from './operations-source.js'
export { createOperationsPgStore, createOperationsMemoryStore } from './operations-store.js'
export { normalizeConversationFacts, verifyContactPermission } from './conversation-facts.js'
export { classifyRecoveryCandidate, detectRecoverySignals, recoveryPriority, RECOVERY_CLASSES, RECOVERY_PROGRAMS } from './recovery-classifier.js'
export { deriveActionState, isLostConversation, summarizeActionStates, ACTION_STATES, ACTION_STATE_LABELS, ACTIVE_QUEUE_STATES } from './action-center.js'
export { evaluateSupervisor, SUPERVISOR_THRESHOLDS } from './supervisor-checks.js'
export { buildOperatingBrief, renderBriefMarkdown, BRIEF_SECTIONS } from './operating-brief.js'
export { recoveryNextAction, recoveryLinkRequests, detectMisclassifiedCounteroffer, COUNTER_LOSING_INTENTS } from './recovery-linkage.js'
export { RESEARCH_VALUATION_SNAPSHOT_SQL } from './research-valuation-sql.js'
