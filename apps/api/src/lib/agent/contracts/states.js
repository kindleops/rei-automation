// LeadCommand Global AI Agent — shared lifecycle contracts (S1).
//
// Pure ESM, no imports, no Node-only APIs: the dashboard (S2 UI) may import or
// copy this file verbatim. Source of truth: global-ai-agent-architecture.md
// §5.1 (run), §5.2 (tool call) and entity-graph-deep-research-design.md §3.1
// (research job), §3.2 (research task), §1E (phases).
//
// Every transition table below is enforced server-side by
// lib/agent/runtime/lifecycle.js. The UI only renders states it receives in
// events; it never advances a state on its own.

/** @typedef {'conversation'|'task'|'research'} RunKind */
export const RUN_KINDS = Object.freeze(['conversation', 'task', 'research'])

/**
 * Agent run state (`agent.run.state`).
 * @typedef {'created'|'planning'|'awaiting_plan_approval'|'running'|'waiting_tool'|'awaiting_approval'|'needs_input'|'paused'|'completed'|'completed_partial'|'budget_exhausted'|'cancelled'|'failed'|'failed_retryable'|'expired'} RunState
 */
export const RUN_STATES = Object.freeze([
  'created',
  'planning',
  'awaiting_plan_approval',
  'running',
  'waiting_tool',
  'awaiting_approval',
  'needs_input',
  'paused',
  'completed',
  'completed_partial',
  'budget_exhausted',
  'cancelled',
  'failed',
  'failed_retryable',
  'expired',
])

export const RUN_TERMINAL_STATES = Object.freeze([
  'completed',
  'completed_partial',
  'budget_exhausted',
  'cancelled',
  'failed',
  'expired',
])

/** Allowed run transitions. `failed_retryable` is resumable (operator "Resume"). */
export const RUN_TRANSITIONS = Object.freeze({
  created: ['planning', 'running', 'cancelled', 'failed', 'expired'],
  planning: ['awaiting_plan_approval', 'running', 'cancelled', 'failed', 'failed_retryable', 'budget_exhausted'],
  awaiting_plan_approval: ['running', 'completed', 'cancelled', 'expired'],
  running: [
    'waiting_tool',
    'awaiting_approval',
    'needs_input',
    'paused',
    'completed',
    'completed_partial',
    'budget_exhausted',
    'cancelled',
    'failed',
    'failed_retryable',
  ],
  waiting_tool: ['running', 'paused', 'cancelled', 'failed', 'failed_retryable', 'budget_exhausted', 'completed_partial'],
  awaiting_approval: ['running', 'cancelled', 'expired', 'completed_partial'],
  needs_input: ['running', 'cancelled', 'expired', 'completed_partial'],
  paused: ['running', 'cancelled', 'expired'],
  failed_retryable: ['running', 'cancelled', 'failed', 'expired'],
  completed: [],
  completed_partial: [],
  budget_exhausted: [],
  cancelled: [],
  failed: [],
  expired: [],
})

/**
 * Tool-call state (`agent.tool_call.state`).
 * @typedef {'proposed'|'authorized'|'approval_requested'|'approved'|'denied'|'expired'|'invalidated'|'executing'|'succeeded'|'refused'|'failed'|'outcome_unknown'|'undone'} ToolCallState
 */
export const TOOL_CALL_STATES = Object.freeze([
  'proposed',
  'authorized',
  'approval_requested',
  'approved',
  'denied',
  'expired',
  'invalidated',
  'executing',
  'succeeded',
  'refused',
  'failed',
  'outcome_unknown',
  'undone',
])

export const TOOL_CALL_TRANSITIONS = Object.freeze({
  proposed: ['authorized', 'approval_requested', 'refused'],
  authorized: ['executing', 'refused'],
  approval_requested: ['approved', 'denied', 'expired', 'invalidated'],
  approved: ['executing', 'invalidated', 'expired'],
  executing: ['succeeded', 'refused', 'failed', 'outcome_unknown'],
  outcome_unknown: ['succeeded', 'failed'],
  succeeded: ['undone'],
  denied: [],
  expired: [],
  invalidated: [],
  refused: [],
  failed: [],
  undone: [],
})

/**
 * Deep Research job state (DR §3.1). A research job IS an agent run with
 * kind='research'; this is the research-facing projection of that run.
 * @typedef {'draft'|'queued'|'running'|'paused'|'synthesizing'|'completed'|'completed_partial'|'budget_exhausted'|'cancelled'|'failed'|'expired'} ResearchJobState
 */
export const RESEARCH_JOB_STATES = Object.freeze([
  'draft',
  'queued',
  'running',
  'paused',
  'synthesizing',
  'completed',
  'completed_partial',
  'budget_exhausted',
  'cancelled',
  'failed',
  'expired',
])

export const RESEARCH_JOB_TERMINAL_STATES = Object.freeze([
  'completed',
  'completed_partial',
  'budget_exhausted',
  'cancelled',
  'failed',
  'expired',
])

export const RESEARCH_JOB_TRANSITIONS = Object.freeze({
  draft: ['queued', 'expired', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['paused', 'synthesizing', 'budget_exhausted', 'cancelled', 'failed', 'completed_partial'],
  paused: ['running', 'cancelled'],
  synthesizing: ['completed', 'completed_partial', 'failed', 'cancelled', 'budget_exhausted'],
  completed: [],
  completed_partial: [],
  budget_exhausted: [],
  cancelled: [],
  failed: [],
  expired: [],
})

/**
 * Research task state (DR §3.2): one per property × finding_type × adapter.
 * `blocked` and `unavailable` are NEVER evidence of absence.
 * @typedef {'planned'|'skipped_fresh'|'queued'|'running'|'succeeded'|'blocked'|'unavailable'|'needs_input'|'failed'|'cancelled'|'budget_stopped'} ResearchTaskState
 */
export const RESEARCH_TASK_STATES = Object.freeze([
  'planned',
  'skipped_fresh',
  'queued',
  'running',
  'succeeded',
  'blocked',
  'unavailable',
  'needs_input',
  'failed',
  'cancelled',
  'budget_stopped',
])

export const RESEARCH_TASK_TRANSITIONS = Object.freeze({
  planned: ['skipped_fresh', 'queued', 'cancelled'],
  queued: ['running', 'cancelled', 'budget_stopped'],
  running: ['succeeded', 'blocked', 'unavailable', 'needs_input', 'failed', 'cancelled', 'budget_stopped'],
  unavailable: ['queued', 'cancelled'], // retry later per DR §6.4
  needs_input: ['queued', 'cancelled'],
  skipped_fresh: [],
  succeeded: [],
  blocked: [], // terminal; never retried automatically
  failed: [],
  cancelled: [],
  budget_stopped: [],
})

/**
 * Research phase pill (DR §1E). A phase is a job state, never a timer.
 * @typedef {'planning'|'researching'|'analyzing'|'cross_checking'|'synthesizing'|'complete'} ResearchPhase
 */
export const RESEARCH_PHASES = Object.freeze([
  'planning',
  'researching',
  'analyzing',
  'cross_checking',
  'synthesizing',
  'complete',
])

export const RESEARCH_PHASE_LABELS = Object.freeze({
  planning: 'Planning',
  researching: 'Researching',
  analyzing: 'Analyzing',
  cross_checking: 'Cross-checking',
  synthesizing: 'Synthesizing',
  complete: 'Complete',
})

/**
 * Research depth. Quick Scan is structurally $0 (no billable op can be planned).
 * @typedef {'quick'|'deep'|'diligence'} ResearchDepth
 */
export const RESEARCH_DEPTHS = Object.freeze(['quick', 'deep', 'diligence'])

export const RESEARCH_DEPTH_LABELS = Object.freeze({
  quick: 'Quick Scan',
  deep: 'Deep Research',
  diligence: 'Acquisition Diligence',
})

/**
 * Per-property state inside a batch job (`research.job_property`).
 * @typedef {'queued'|'running'|'completed'|'completed_partial'|'budget_stopped'|'cancelled'|'failed'|'skipped_fresh'} JobPropertyState
 */
export const JOB_PROPERTY_STATES = Object.freeze([
  'queued',
  'running',
  'completed',
  'completed_partial',
  'budget_stopped',
  'cancelled',
  'failed',
  'skipped_fresh',
])

/**
 * Side-effect tiers. T4 (prohibited) is deliberately NOT a value here: it is
 * not representable, so a T4 tool cannot be defined or registered.
 * @typedef {'T0'|'T1'|'T2'|'T3'} Tier
 */
export const TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3'])

/** @typedef {'read'|'draft'|'reversible_write'|'consequential'} SideEffectClass */
export const SIDE_EFFECT_CLASSES = Object.freeze(['read', 'draft', 'reversible_write', 'consequential'])

export const SIDE_EFFECT_TIER = Object.freeze({
  read: 'T0',
  draft: 'T1',
  reversible_write: 'T2',
  consequential: 'T3',
})

export const TIER_LABELS = Object.freeze({
  T0: 'Read',
  T1: 'Draft',
  T2: 'Reversible change',
  T3: 'Needs your approval',
})

/**
 * Pure helper: is `to` a legal next state from `from` in `table`?
 * @param {Record<string,string[]>} table
 * @param {string} from
 * @param {string} to
 */
export function canTransition(table, from, to) {
  const next = table[from]
  return Array.isArray(next) && next.includes(to)
}
