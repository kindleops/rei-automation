// Persistent missions (8.5.18) — the kinds, ceilings and schedule definitions.
//
// Every mission is a row of agent.research_job run by the R2 runtime tick
// (runtime/runtime-tick.js). Runtime kinds may NOT start with 'research.' (that
// prefix is reserved for the S3 Quick Scan jobs: agent.runtime_kind_valid), so the
// research mission kind is 'mission.research'.
//
// No kind here can send anything: the handlers read, research, record findings,
// create DRAFT campaigns through campaigns.create_draft and pending approvals
// through approval-tier capabilities. Nothing ever launches without a human.

export const MISSION_RESEARCH_KIND = 'mission.research'
export const MISSION_SUPERVISOR_KIND = 'mission.supervisor'
export const DISCOVERY_KIND = 'acquisition.discovery'
export const REVIEW_DIGEST_KIND = 'conversation.review_digest'
export const OPS_HEALTH_KIND = 'ops.health_check'
/** 8.5.20-b: autonomous property research (event + sweep enqueue only; OFF by default). */
export const PROPERTY_RESEARCH_KIND = 'property.research'

/** Kinds the Missions API lists / creates (operator missions). */
export const OPERATOR_MISSION_KINDS = Object.freeze([MISSION_RESEARCH_KIND, MISSION_SUPERVISOR_KIND])
/** Every kind this release adds a handler for. */
export const MISSION_HANDLER_KINDS = Object.freeze([MISSION_RESEARCH_KIND, MISSION_SUPERVISOR_KIND, DISCOVERY_KIND, REVIEW_DIGEST_KIND, PROPERTY_RESEARCH_KIND])

export const MISSIONS_FLAG = 'AGENT_MISSIONS_ENABLED'

/** Per-mission ceilings (USD). The DB CHECK caps any job at 2.50 (= research_limits.run_usd ceiling). */
export const MISSION_LIMITS = Object.freeze({
  research_default_usd: 0.5,
  research_max_usd: 2.5,
  supervisor_default_usd: 0.25, // split + consolidation calls only
  supervisor_max_children: 3,
  child_default_usd: 0.5,
  child_max_usd: 1.0,
  discovery_default_usd: 0.25,
  min_ask_ms: 18_000, // an ask step needs at least this much of the tick left, else the job yields
  ask_max_model_calls: 4, // a mission ask fits one bounded tick
  answer_store_chars: 6000,
})

/**
 * Schedule definitions. Created ONLY by the owner path (agent.runtime_upsert_schedule,
 * service_role) and born DISABLED: supabase/migrations/PROPOSED_20261014120100_persistent_missions_schedules.sql.
 * ops.health_check: definition only — its handler (and 8.5.15's heartbeat thresholds) are untouched.
 */
export const SCHEDULE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'acquisition-discovery', kind: DISCOVERY_KIND, interval_seconds: 6 * 3600, budget_cap_usd: 0.25, input: Object.freeze({ scan_limit: 400, rank_top_n: 12, draft: true }) }),
  Object.freeze({ name: 'ops-health-check', kind: OPS_HEALTH_KIND, interval_seconds: 15 * 60, budget_cap_usd: 0, input: Object.freeze({}) }),
  Object.freeze({ name: 'conversation-review-digest', kind: REVIEW_DIGEST_KIND, interval_seconds: 24 * 3600, budget_cap_usd: 0, input: Object.freeze({ window_hours: 24 }) }),
])

const ON = new Set(['1', 'true', 'on', 'yes'])
export function missionsEnabled(env = process.env) {
  return ON.has(String(env?.[MISSIONS_FLAG] ?? '').trim().toLowerCase())
}

/**
 * The principal a headless mission acts as: the named operator who requested it
 * (verified by the API route when it was enqueued, or the owner who created the
 * schedule). The runtime only ever claims jobs whose requested_by is a named
 * operator uuid (agent.runtime_is_named_operator); membership is re-checked by the
 * capability plane on every call.
 */
export function missionIdentity(requested_by) {
  const ok = typeof requested_by === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requested_by)
  return Object.freeze({ verified: ok, named: ok, user_id: ok ? requested_by : null, method: 'runtime_mission', authenticated_at: null, display_name: null, reason: ok ? null : 'REQUESTED_BY_NOT_NAMED' })
}
