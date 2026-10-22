// LeadCommand ACTION GATEWAY — shared constants (phase 1).
//
// Owner directive 2026-10-19: "AGNTEI THINKS, COORDINATES AND ACTS. LEADCOMMAND ENFORCES AUTHORITY AND
// EXECUTES." The durable half is supabase/migrations/PROPOSED_20261019160000_action_gateway.sql; every
// value here that the database also enforces is mirrored, and a test compares them.

export const ACTION_GATEWAY_VERSION = 'action-gateway.v1'

/** Graduated authority. A tier is a property of the ACTION (code review), never of a request. */
export const TIERS = Object.freeze({
  T1: 1, // autonomous internal: research, tasks, drafts, findings, reports
  T2: 2, // policy-authorized reversible operational mutations (supported lead states, follow-up intents, holds SET only)
  T3: 3, // seller-facing: only when that path's production capability is activated AND every dispatch guard passes
  T4: 4, // financial: prepare freely; communicate only inside an operator-authorized envelope; else an approval request
})
export const TIER_LABEL = Object.freeze({ 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T4' })

export const INTENT_STATES = Object.freeze(['received', 'awaiting_approval', 'authorized', 'executing', 'succeeded', 'failed', 'refused', 'expired', 'outcome_unknown'])
export const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'refused', 'expired', 'outcome_unknown'])
export const PENDING_STATES = Object.freeze(['received', 'awaiting_approval', 'authorized', 'executing'])
/** Mirror of action_gateway.intent_transition_ok (a pg test compares every pair). */
export const INTENT_TRANSITIONS = Object.freeze({
  received: ['awaiting_approval', 'authorized', 'refused'],
  awaiting_approval: ['authorized', 'refused', 'expired'],
  authorized: ['executing', 'refused'],
  executing: ['succeeded', 'failed', 'refused', 'outcome_unknown'],
  succeeded: [], failed: [], refused: [], expired: [], outcome_unknown: [],
})
export const canIntentTransition = (from, to) => (INTENT_TRANSITIONS[from] || []).includes(to)

export const RESOURCE_TYPES = Object.freeze(['thread', 'property', 'opportunity', 'campaign', 'work_item', 'system'])

/** system_control keys (absent ⇒ OFF). The gateway role can read exactly these + the draft-path keys. */
export const CONTROL_KEYS = Object.freeze({
  enabled: 'action_gateway_enabled',
  tiers: 'action_gateway_tiers',
  killed: 'action_gateway_killed_capabilities',
})

/** The approval capability the EXISTING operator approval path decides for gateway intents. */
export const APPROVAL_CAPABILITY_ID = 'agent_actions.authorize_action'
export const APPROVAL_CAPABILITY_VERSION = 1
/** How long an approved grant may be consumed after the human decision window opens. */
export const APPROVAL_GRANT_TTL_MS = 60 * 60 * 1000

/** Read scopes a principal must carry for a separately scoped read. */
export const READ_SCOPES = Object.freeze({ conversation_context: 'conversation_context.read' })

/** Domain-write executors (one SECURITY DEFINER function each; parameters come from the intent). */
export const DOMAIN_WRITES = Object.freeze({
  thread_hold: 'action_gateway_dw_thread_hold_set',
  operator_task: 'action_gateway_dw_operator_task',
  runtime_enqueue: 'action_gateway_dw_runtime_enqueue',
  // T3 / T4 (PROPOSED_20261020110000_action_gateway_t34.sql)
  handoff: 'action_gateway_dw_handoff',
  offer_envelope: 'action_gateway_dw_offer_envelope',
})

/** Keys a tool argument may never carry: identity, tenancy, authority and approvals come from the server. */
export const FORGED_CONTEXT_KEYS = /^(org|org_id|orgid|tenant|tenant_id|user|user_id|userid|principal|principal_id|agent|agent_id|operator|operator_id|actor|sponsor|sponsor_user_id|role|scope|scopes|approved|approval|approval_id|approval_ref|tier|identity|as_user|impersonate|grant|grant_id|capability|credential|token|policy|policy_id|override|automation_hold_override|lease|lease_token|intent_id)$/i
/** Keys that would turn a tool into a SQL / egress / proxy surface (agent/tools/prohibited.js + escalation). */
export const ESCALATION_KEYS = /^(sql|raw_sql|statement|query|query_sql|route|url|endpoint|method|headers|host|table|rpc|function|schema|set_role|role_name|search_path|grant_sql|exec|execute)$/i

export const LIMITS = Object.freeze({
  lease_seconds: 60,
  claim_busy_retries: 8,
  claim_busy_wait_ms: 250,
  per_agent_per_min: 60,
  call_timeout_ms: 45_000,
})
